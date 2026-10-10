import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn(), moyskladPost: vi.fn(), moyskladPut: vi.fn() }));
import { moyskladGet } from "../src/client.js";
import { handleGetDocument } from "../src/tools/documents.js";
import { handleSearchVariants, handleSearchServices } from "../src/tools/catalog.js";
import { handleSearchProducts } from "../src/tools/products.js";
import { assortmentFields } from "../src/report-lib.js";
import { netUnitPrice, displayPrice } from "../src/precision.js";
import { readExport } from "../src/output.js";
import { wrap } from "../src/index.js";

const mockGet = vi.mocked(moyskladGet);
const product = { meta: { href: "https://api.moysklad.ru/api/remap/1.2/entity/product/parent", type: "product" } };
const variant = {
  id: "v1",
  name: "Variant",
  meta: { type: "variant", href: "https://api.moysklad.ru/api/remap/1.2/entity/variant/v1" },
  product,
  characteristics: [
    { name: "Размер", value: "36 (140-145)" },
    { name: "Цвет", value: "red" },
  ],
};
beforeEach(() => mockGet.mockReset());
describe("compact contract", () => {
  it("returns parent, size and selected characteristics without guessing", () => {
    expect(assortmentFields(variant)).toMatchObject({
      assortment_id: "v1",
      assortment_type: "variant",
      product_id: "v1",
      parent_product_id: "parent",
      size: 36,
      size_raw: "36 (140-145)",
      characteristics: [{ name: "Размер", value: "36 (140-145)" }],
    });
    expect(assortmentFields({ name: "Model 36", meta: { type: "variant" } })).toMatchObject({
      size: null,
      parent_product_id: null,
      characteristics: null,
    });
  });
  it("does not duplicate positions; raw is explicit", async () => {
    mockGet.mockResolvedValue({
      id: "d1",
      description: "unneeded",
      positions: { meta: { size: 1 }, rows: [{ assortment: variant, quantity: 2, price: 1250000.6, discount: 0 }] },
    });
    const params = { entity_type: "demand", id: "d1" };
    const compact = JSON.parse(await handleGetDocument(params));
    expect(compact.positions).toBeUndefined();
    expect(compact.description).toBeUndefined();
    expect(compact.positions_export.items[0].net_unit_price).toBe("12500.006");
    const raw = JSON.parse(await handleGetDocument({ ...params, detail: "raw" }));
    expect(raw.positions.rows).toHaveLength(1);
    expect(raw.positions_export).toBeUndefined();
    const summary = JSON.parse(await handleGetDocument({ ...params, detail: "summary" }));
    expect(summary.returned).toBe(1);
    expect(summary.positions_export).toBeUndefined();
  });
  it("returns variant sizes and quantity projection", async () => {
    mockGet.mockResolvedValue({ meta: { size: 1 }, rows: [variant] });
    const result = JSON.parse(await handleSearchVariants({ limit: 25, offset: 0, fields: "quantity" }));
    expect(result.variants[0]).toMatchObject({ size: 36, parent_product_id: "parent" });
    expect(result.variants[0].sale_price_rubles).toBeUndefined();
    expect(result.complete).toBe(true);
  });
  it("returns a real resource link and no duplicate structuredContent", async () => {
    mockGet.mockResolvedValue({
      id: "d1",
      positions: { meta: { size: 1 }, rows: [{ assortment: variant, quantity: 1 }] },
    });
    const result = await wrap(handleGetDocument)({ entity_type: "demand", id: "d1", output: "file" });
    expect(result.content).toHaveLength(2);
    expect(result).not.toHaveProperty("structuredContent");
    const summary = JSON.parse(result.content[0].text);
    expect(summary.positions_export).toBeUndefined();
    expect(JSON.parse(await readExport(summary.export.uri)).positions_export.items).toHaveLength(1);
  });
  it("keeps decimal price precision and rounds display separately", () => {
    expect(netUnitPrice(1250000.6, 0)).toBe("12500.006");
    expect(displayPrice("12500.006")).toBe("12500.01");
    expect(netUnitPrice(250000, 20)).toBe("2000");
    expect(netUnitPrice(100, undefined)).toBeNull();
  });
  it("keeps full file rows even when inline detail is summary", async () => {
    mockGet.mockResolvedValue({
      meta: { size: 1 },
      rows: [{ id: "s1", name: "service", meta: { type: "service" }, salePrices: [{ value: 10000 }] }],
    });
    const response = JSON.parse(
      await handleSearchServices({ limit: 25, offset: 0, detail: "summary", output: "file", fields: "quantity" }),
    );
    expect(response.services).toBeUndefined();
    const saved = JSON.parse(await readExport(response.export.uri));
    expect(saved.services[0]).toMatchObject({
      id: "s1",
      type: "service",
    });
    expect(saved.services[0].sale_price_rubles).toBeUndefined();
  });
  it("publishes product paging and omits money in quantity projection", async () => {
    mockGet.mockResolvedValue({
      meta: { size: 2 },
      rows: [{ id: "p1", name: "product", meta: { type: "product" }, salePrices: [{ value: 10000 }] }],
    });
    const response = JSON.parse(await handleSearchProducts({ limit: 1, offset: 0, fields: "quantity" }));
    expect(response).toMatchObject({ total: 2, returned: 1, next_offset: 1, complete: false });
    expect(response.products[0]).not.toHaveProperty("sale_price_rubles");
  });
  it("uses an explicit parent size only when the variant has none", () => {
    const parentWithSize = { ...product, attributes: [{ name: "Размер", value: "38" }] };
    expect(assortmentFields({ ...variant, product: parentWithSize }).size).toBe(36);
    expect(assortmentFields({ ...variant, characteristics: [], product: parentWithSize }).size).toBe(38);
  });
  it("isolates export credentials and refuses expired exports", async () => {
    mockGet.mockResolvedValue({ id: "d1", positions: { meta: { size: 0 }, rows: [] } });
    const response = JSON.parse(
      await handleGetDocument({ entity_type: "demand", id: "d1", output: "file", detail: "summary" }),
    );
    expect(JSON.parse(await readExport(response.export.uri)).positions_export.items).toEqual([]);
    vi.stubEnv("MOYSKLAD_TOKEN", "different-test-credential");
    await expect(readExport(response.export.uri)).rejects.toThrow("EXPORT_NOT_FOUND");
    vi.unstubAllEnvs();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600001);
    await expect(readExport(response.export.uri)).rejects.toThrow("EXPORT_NOT_FOUND");
    now.mockRestore();
  });
});
