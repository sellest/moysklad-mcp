import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn(), moyskladPost: vi.fn(), moyskladPut: vi.fn() }));
import { moyskladGet } from "../src/client.js";
import {
  cachedEntity,
  catalogVersion,
  clearCatalogCache,
  clearSourceCache,
  loadSourceLines,
  type SourceLine,
} from "../src/analytics-data.js";
import {
  aggregateCategoriesAndArticles,
  articleRankingSchema,
  categoryReportSchema,
  renderCategoryOrRanking,
} from "../src/tools/rankings.js";
import { handleSearchProducts } from "../src/tools/products.js";
import { handleGetSalesReport } from "../src/tools/reports.js";
import { readExport } from "../src/output.js";
import { wrap } from "../src/index.js";
const mockGet = vi.mocked(moyskladGet);
const period = { moment_from: "2026-09-01", moment_to: "2026-09-30", limit: 100, offset: 0 };
function line(
  id: string,
  article: string | null,
  quantity = 1,
  kind: "sold" | "returned" = "sold",
  name = "Купальник женский без рукава",
): SourceLine {
  const product = { id, article, name, pathName: "", meta: { type: "product" } };
  return {
    document_id: "d",
    document_type: "demand",
    moment: "2026-09-01",
    position: { quantity, assortment: product },
    assortment: product,
    product,
    parent_product_id: id,
    kind,
  };
}
const source = (lines: SourceLine[]) => ({ lines, documents: { demand: 1 }, catalog: catalogVersion() });
beforeEach(() => {
  mockGet.mockReset();
  clearCatalogCache();
  clearSourceCache();
  vi.unstubAllEnvs();
});
describe("article and category reports", () => {
  it("combines products/variants by real article, retains zeros/spelling and orders ties", () => {
    const data = aggregateCategoriesAndArticles(
      source([
        line("p1", "001", 3),
        line("p2", "001", 2),
        line("p3", "A", 5),
        line("p4", null, 2),
        line("p5", "B", 1, "returned"),
      ]),
      articleRankingSchema.parse({ ...period, top_n: 2 }),
      "articles",
    ).result;
    expect(data.rows.map((row) => ("article" in row ? row.article : null))).toEqual(["001", "A"]);
    expect(data).toMatchObject({
      total: 3,
      returned: 2,
      next_offset: 2,
      complete: false,
      source_complete: true,
      missing_articles: { sold: 2 },
      returns_only_products: 1,
    });
    expect(data.page_quantity).toBe(10);
  });
  it("returns three unrestricted unit percentages with an explicit denominator", () => {
    const data = aggregateCategoriesAndArticles(
      source([
        line("a", "a", 1117),
        line("b", "b", 166, "sold", "Купальник женский с рукавом"),
        line("c", "c", 372, "sold", "Купальник мужской"),
        line("c", "c", 7, "returned", "Купальник мужской"),
        line("unknown", "u", 20, "sold", "Купальник женский Quatro"),
      ]),
      categoryReportSchema.parse(period),
      "categories",
    ).result;
    expect(data.rows.map((row) => ("percentage" in row ? row.percentage : null))).toEqual([67.49, 10.03, 22.48]);
    expect(data.denominator?.quantity).toBe(1655);
    expect(data.unresolved.sleeve_not_explicit.sold).toBe(20);
    expect(data.accounting.in_scope.sold).toBe(1675);
  });
  it("keeps zero/negative net denominators explicit rather than silently treating net as gross", () => {
    const zero = aggregateCategoriesAndArticles(
      source([line("p", "a", 1), line("p", "a", 1, "returned")]),
      categoryReportSchema.parse({ ...period, quantity_basis: "net" }),
      "categories",
    ).result;
    expect(zero.rows.every((row) => "percentage" in row && row.percentage === null)).toBe(true);
    const negative = aggregateCategoriesAndArticles(
      source([line("p", "a", 2, "returned")]),
      categoryReportSchema.parse({ ...period, quantity_basis: "net" }),
      "categories",
    ).result;
    expect(negative.denominator?.quantity).toBe(-2);
    expect(negative.quantity_basis).toBe("net");
  });
  it("exports supporting records without duplicating the audit inline", async () => {
    const result = await wrap((p) => renderCategoryOrRanking(source([line("p", "a")]), p, "articles"))(
      articleRankingSchema.parse({ ...period, output: "file" }),
    );
    const inline = JSON.parse(result.content[0].text);
    expect(inline.detail).toBeUndefined();
    expect(result.content).toHaveLength(2);
    const file = JSON.parse(await readExport(inline.export.uri));
    expect(file.detail).toHaveLength(1);
    expect(file.ranking).toHaveLength(1);
  });
  it("returns a short error without a partial report or stack", async () => {
    const result = await wrap(async () => {
      throw new Error("API_HTTP_429: Retry later.");
    })({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("API_HTTP_429");
    expect(result.content[0].text).not.toContain("stack");
  });
  it("reports a missing scope name as unresolved instead of discarding it", () => {
    const unknown = line("unknown", null);
    unknown.product = null;
    unknown.assortment = {};
    unknown.parent_product_id = null;
    const result = aggregateCategoriesAndArticles(
      source([unknown]),
      categoryReportSchema.parse(period),
      "categories",
    ).result;
    expect(result.unresolved.scope_unknown.sold).toBe(1);
    expect(result.accounting.in_scope.sold).toBe(1);
  });
});
describe("projection and monthly snapshots", () => {
  it("does not leak expanded ownership, duplicate identity or URLs at small limits", async () => {
    const raw = {
      ...line("p", "001").product,
      productFolder: { id: "f", owner: { accountId: "private" }, group: { meta: { href: "private-url" } } },
      meta: { type: "product", href: "private-url" },
    };
    mockGet.mockResolvedValue({ meta: { size: 1 }, rows: [raw] });
    const quantity = JSON.parse(await handleSearchProducts({ limit: 25, offset: 0, fields: "quantity" }));
    expect(Object.keys(quantity.products[0]).sort()).toEqual(["article", "id", "name", "type"]);
    expect(mockGet.mock.calls[0][0]).not.toContain("expand=");
    expect(JSON.stringify(quantity)).not.toMatch(/owner|group|accountId|private-url|product_folder|assortment_id/);
    const full = JSON.parse(await handleSearchProducts({ limit: 25, offset: 0, fields: "full" }));
    expect(full.products[0].product_folder.owner.accountId).toBe("private");
  });
  it("hydrates the real article for compact sales without inferring it from name/code", async () => {
    await cachedEntity("product", "p", { ...line("p", "0007").product });
    mockGet.mockResolvedValue({
      meta: { size: 1 },
      rows: [
        {
          assortment: { id: "p", name: "wrong 999", code: "999", meta: { type: "product" } },
          sellQuantity: 1,
          returnQuantity: 0,
        },
      ],
    });
    const result = JSON.parse(await handleGetSalesReport({ ...period, fields: "quantity" }));
    expect(result.items[0]).toMatchObject({ id: "p", name: "wrong 999", article: "0007", sell_quantity: 1 });
    expect(result.items[0].product_id).toBeUndefined();
  });
  it("shares concurrent captures and repeats, isolates scope, honors refresh and expiry", async () => {
    mockGet.mockResolvedValue({ meta: { size: 0 }, rows: [] });
    const [first, concurrent] = await Promise.all([loadSourceLines(period), loadSourceLines(period)]);
    expect(first.snapshot?.id).toBe(concurrent.snapshot?.id);
    expect(mockGet).toHaveBeenCalledTimes(4);
    const second = await loadSourceLines(period);
    expect(second.snapshot?.reused).toBe(true);
    expect(mockGet).toHaveBeenCalledTimes(4);
    await loadSourceLines({ ...period, refresh_catalog: true });
    expect(mockGet).toHaveBeenCalledTimes(4);
    await loadSourceLines({ ...period, refresh_source: true });
    expect(mockGet).toHaveBeenCalledTimes(8);
    await loadSourceLines({ ...period, organization_hrefs: ["org1"] });
    expect(mockGet).toHaveBeenCalledTimes(12);
    vi.stubEnv("MOYSKLAD_TOKEN", "other-test-account");
    await loadSourceLines(period);
    expect(mockGet).toHaveBeenCalledTimes(16);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
    await loadSourceLines(period);
    clock.mockRestore();
    expect(mockGet).toHaveBeenCalledTimes(20);
  });
  it("does not cache partial or failed sources", async () => {
    mockGet.mockRejectedValueOnce(new Error("API_HTTP_429: Retry later."));
    await expect(loadSourceLines(period)).rejects.toThrow("API_HTTP_429");
    mockGet.mockResolvedValue({ meta: { size: 0 }, rows: [] });
    expect((await loadSourceLines(period)).snapshot?.reused).toBe(false);
  });
  it("honors catalog refresh arriving during an in-flight capture without downloading documents twice", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const oldCard = { ...line("p", "old").product };
    mockGet.mockImplementation(async (path) => {
      if (path.startsWith("/entity/demand?")) return gate;
      if (path === "/entity/product/p") return { ...oldCard, article: "new" };
      return { meta: { size: 0 }, rows: [] };
    });
    const capture = loadSourceLines(period);
    const refresh = loadSourceLines({ ...period, refresh_catalog: true });
    release({
      meta: { size: 1 },
      rows: [{ id: "d", positions: { meta: { size: 1 }, rows: [{ quantity: 1, assortment: oldCard }] } }],
    });
    const [first, second] = await Promise.all([capture, refresh]);
    expect(first.lines[0].product?.article).toBe("old");
    expect(second.lines[0].product?.article).toBe("new");
    expect(mockGet.mock.calls.filter(([path]) => path.startsWith("/entity/demand?")).length).toBe(1);
    expect(mockGet).toHaveBeenCalledTimes(5);
  });
});
