import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn(), moyskladPost: vi.fn(), moyskladPut: vi.fn() }));
import { moyskladGet } from "../src/client.js";
import {
  cachedEntity,
  catalogVersion,
  clearCatalogCache,
  clearSourceCache,
  fetchAllPages,
  loadSourceLines,
  type SourceLine,
} from "../src/analytics-data.js";
import {
  aggregatePrices,
  aggregateSizes,
  priceReportSchema,
  renderAnalytics,
  sizeReportSchema,
  validateBands,
} from "../src/tools/analytics.js";
import { handleReconciliation, reconciliationSchema } from "../src/tools/reconciliation.js";
import { classify } from "../src/classification.js";
import { handleReadExport, readExport } from "../src/output.js";

const mockGet = vi.mocked(moyskladGet);
const period = { moment_from: "2026-09-01", moment_to: "2026-09-30" };
const product = {
  id: "p1",
  name: "Купальник женский без рукава",
  pathName: "",
  meta: { type: "product" },
  updated: "v1",
};
function line(overrides: Partial<SourceLine> = {}, position = {}): SourceLine {
  return {
    document_id: "d1",
    document_type: "demand",
    moment: "2026-09-15 12:00:00",
    kind: "sold",
    position: { id: "l1", quantity: 1, price: "200000", discount: 0, ...position },
    product,
    parent_product_id: "p1",
    assortment: {
      id: "v1",
      name: "variant",
      meta: { type: "variant" },
      characteristics: [{ name: "Размер", value: "36 (140-145)" }],
      product,
    },
    ...overrides,
  };
}
const band = {
  id: "b1",
  category: "female_sleeveless" as const,
  min: "1000",
  max: "2000",
  include_min: true,
  include_max: false,
};
beforeEach(() => {
  mockGet.mockReset();
  clearCatalogCache();
  clearSourceCache();
  vi.unstubAllEnvs();
});

describe("exact analytics", () => {
  it("separates discounts, several prices and the return document price", () => {
    const data = aggregatePrices(
      [
        line({}, { price: 250000, discount: 20, quantity: 2 }),
        line({}, { price: 199999 }),
        line({ kind: "returned" }, { price: 100000 }),
      ],
      priceReportSchema.parse({ ...period, bands: [band] }),
    );
    expect(data.rows[0]).toMatchObject({ sold: 1, returned: 1, net: 0 });
    expect(data.outside.female_sleeveless.sold).toBe(2);
    expect(data.accounting.in_scope).toMatchObject({ sold: 3, returned: 1 });
  });
  it("compares 12500.006 before rounding and preserves both units outside", () => {
    const data = aggregatePrices(
      [line({}, { price: "1250000.6", quantity: 2 }), line({}, { price: 1250000 })],
      priceReportSchema.parse({ ...period, bands: [{ ...band, max: "12500", include_max: true }] }),
    );
    expect(data.rows[0].sold).toBe(1);
    expect(data.outside.female_sleeveless.sold).toBe(2);
  });
  it("rejects overlapping boundaries but allows adjacent exclusive boundaries", () => {
    expect(() =>
      validateBands([
        { ...band, include_max: true },
        { ...band, id: "b2", min: "2000", max: "3000" },
      ]),
    ).toThrow("BAND_OVERLAP");
    expect(() => validateBands([band, { ...band, id: "b2", min: "2000", max: "3000" }])).not.toThrow();
  });
  it("accounts for unknown prices, categories, sizes, services, sets and swimming", () => {
    const lines = [
      line(),
      line({}, { discount: undefined }),
      line({ assortment: { id: "v2", name: "36", meta: { type: "variant" } } }),
      line({
        assortment: { id: "s", name: "Купальник услуга", meta: { type: "service" } },
        product: null,
        parent_product_id: null,
      }),
      line({
        assortment: { id: "b", name: "Купальник комплект", meta: { type: "bundle" } },
        product: null,
        parent_product_id: null,
      }),
      line({ product: { ...product, id: "p2", pathName: "Плавание" }, parent_product_id: "p2" }),
      line({ product: { ...product, id: "p3", name: "Купальник женский Demo" }, parent_product_id: "p3" }),
    ];
    const sizes = aggregateSizes(lines, sizeReportSchema.parse(period));
    expect(sizes.rows).toHaveLength(12);
    expect(sizes.unresolved.size_unknown.sold).toBe(1);
    expect(sizes.unresolved.sleeve_not_explicit.sold).toBe(1);
    expect(sizes.accounting.in_scope.sold).toBe(7);
    expect(sizes.accounting.excluded.sold).toBe(3);
    const prices = aggregatePrices(
      lines,
      priceReportSchema.parse({ ...period, bands: [{ ...band, include_max: true }] }),
    );
    expect(prices.accounting.in_scope.sold).toBe(7);
    expect(prices.unresolved["female_sleeveless:price_unknown"].sold).toBe(1);
  });
  it("does not infer sleeve from brand; an override requires evidence", () => {
    const unknown = line({ product: { ...product, name: "Купальник женский Demo" } });
    expect(classify(unknown, {})).toMatchObject({ status: "unresolved", reason: "sleeve_not_explicit" });
    expect(
      classify(unknown, {
        category_overrides: [{ product_id: "p1", category: "female_sleeveless", evidence: "verified photo" }],
      }),
    ).toMatchObject({ status: "included", evidence: "verified photo" });
    expect(sizeReportSchema.safeParse({ ...period, categories: ["male", "male"] }).success).toBe(false);
  });
  it("aborts on invalid quantities instead of silently losing rows", () => {
    expect(() => aggregateSizes([line({}, { quantity: undefined })], sizeReportSchema.parse(period))).toThrow(
      "QUANTITY_UNRESOLVED",
    );
  });
  it("provides projected audit, separate dictionary and readable file pages", async () => {
    const source = { lines: [line(), line({}, { quantity: 2 })], documents: { demand: 1 }, catalog: catalogVersion() };
    const response = JSON.parse(
      await renderAnalytics(sizeReportSchema.parse({ ...period, output: "file", fields: "quantity" }), "sizes", source),
    );
    expect(response.detail).toBeUndefined();
    const saved = JSON.parse(await readExport(response.export.uri));
    expect(saved.detail).toHaveLength(2);
    expect(Object.keys(saved.dictionary)).toHaveLength(1);
    expect(saved.detail[0]).not.toHaveProperty("net_unit_price");
    expect(saved.detail[0]).not.toHaveProperty("characteristics");
    const page = JSON.parse(
      await handleReadExport({ uri: response.export.uri, section: "detail", offset: 0, limit: 1 }),
    );
    expect(page).toMatchObject({ total: 2, returned: 1, next_offset: 1, complete: false });
    const dict = JSON.parse(
      await handleReadExport({ uri: response.export.uri, section: "dictionary", offset: 0, limit: 25 }),
    );
    expect(dict.items[0].value.size).toBe(36);
  });
});

describe("complete API loading and cache", () => {
  it("follows short pages to the declared total and rejects a changing total", async () => {
    mockGet
      .mockResolvedValueOnce({ meta: { size: 2, offset: 0 }, rows: [{ id: "a" }] })
      .mockResolvedValueOnce({ meta: { size: 2, offset: 1 }, rows: [{ id: "b" }] });
    expect(await fetchAllPages("/entity/demand")).toHaveLength(2);
    expect(mockGet.mock.calls[1][0]).toContain("offset=1");
    mockGet
      .mockResolvedValueOnce({ meta: { size: 2 }, rows: [{ id: "a" }] })
      .mockResolvedValueOnce({ meta: { size: 3 }, rows: [] });
    await expect(fetchAllPages("/entity/demand")).rejects.toThrow("SOURCE_CHANGED");
  });
  it("rejects missing or stalled pagination metadata", async () => {
    mockGet.mockResolvedValue({ rows: [] });
    await expect(fetchAllPages("/entity/demand")).rejects.toThrow("INCOMPLETE_PAGE");
    mockGet.mockResolvedValue({ meta: { size: 1 }, rows: [] });
    await expect(fetchAllPages("/entity/demand")).rejects.toThrow("INCOMPLETE_PAGE");
  });
  it("uses full day, multiple organizations, posted documents and position pagination", async () => {
    mockGet.mockImplementation(async (path) => {
      const url = new URL(path, "https://local");
      if (url.pathname === "/entity/demand")
        return { meta: { size: 1 }, rows: [{ id: "d1", positions: { meta: { size: 2 }, rows: [line().position] } }] };
      if (url.pathname.endsWith("/positions")) {
        const offset = Number(url.searchParams.get("offset"));
        return {
          meta: { size: 2, offset },
          rows: [{ ...line().position, id: `l${offset}`, assortment: line().assortment }],
        };
      }
      return { meta: { size: 0 }, rows: [] };
    });
    const source = await loadSourceLines({ ...period, organization_hrefs: ["org1", "org2"], limit: 100, offset: 0 });
    expect(source.lines).toHaveLength(2);
    expect(source.documents.demand).toBe(1);
    const filter = new URL(mockGet.mock.calls[0][0], "https://local").searchParams.get("filter");
    expect(filter).toContain("moment>=2026-09-01 00:00:00");
    expect(filter).toContain("moment<=2026-09-30 23:59:59.999");
    expect(filter).toContain("organization=org1");
    expect(filter).toContain("applicable=true");
    expect(mockGet.mock.calls.some(([path]) => path.includes("organization%3Dorg2"))).toBe(true);
  });
  it("rejects reversed periods before making API calls", async () => {
    await expect(
      loadSourceLines({ moment_from: "2026-10-01", moment_to: "2026-09-01", limit: 100, offset: 0 }),
    ).rejects.toThrow("PERIOD_ORDER");
    expect(mockGet).not.toHaveBeenCalled();
  });
  it("coalesces requests, reuses cards, refreshes, expires and isolates credentials", async () => {
    mockGet.mockResolvedValue(product);
    await Promise.all([cachedEntity("product", "p1"), cachedEntity("product", "p1")]);
    await cachedEntity("product", "p1");
    expect(mockGet).toHaveBeenCalledTimes(1);
    const version = catalogVersion().version;
    mockGet.mockResolvedValue({ ...product, updated: "v2" });
    await cachedEntity("product", "p1", undefined, true);
    expect(catalogVersion().version).not.toBe(version);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301000);
    await cachedEntity("product", "p1");
    now.mockRestore();
    vi.stubEnv("MOYSKLAD_TOKEN", "test-other-account");
    await cachedEntity("product", "p1");
    expect(mockGet).toHaveBeenCalledTimes(4);
  });
  it("returns compact reconciliation with bounded examples", async () => {
    mockGet.mockImplementation(async (path) => {
      if (path.startsWith("/entity/demand?"))
        return {
          meta: { size: 1 },
          rows: [
            {
              id: "d1",
              positions: { meta: { size: 1 }, rows: [{ ...line().position, assortment: line().assortment }] },
            },
          ],
        };
      if (path.startsWith("/report/"))
        return {
          meta: { size: 1 },
          rows: [{ assortment: product, sellQuantity: 2, returnQuantity: 0, sellSum: 400000, returnSum: 0 }],
        };
      return { meta: { size: 0 }, rows: [] };
    });
    const result = JSON.parse(await handleReconciliation(reconciliationSchema.parse({ ...period, example_limit: 1 })));
    expect(result).toMatchObject({ complete: true, mismatches: 1, compared_products: 1 });
    expect(result.examples).toHaveLength(1);
    expect(result.items).toBeUndefined();
  });
});
