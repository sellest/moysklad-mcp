import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn() }));
import { moyskladGet } from "../src/client.js";
import { getStockSchema, getStockByStoreSchema, handleGetStock, handleGetStockByStore } from "../src/tools/stock.js";
import { handleGetStockCurrent } from "../src/tools/reports_extra.js";
import { getStockAtDateSchema, handleGetStockAtDate, historicalStockMoment } from "../src/tools/stock.js";
const get = vi.mocked(moyskladGet);
const root = "https://api.moysklad.ru/api/remap/1.2/entity/";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const variant = (n: number) => ({
  id: id(n),
  meta: { type: "variant", href: root + "variant/" + id(n) },
  name: "Invented variant",
  characteristics: [{ name: "Размер", value: "38" }],
  product: {
    id: id(99),
    meta: { type: "product", href: root + "product/" + id(99) },
    article: "DEMO",
    name: "Invented parent",
  },
});
beforeEach(() => get.mockReset());
describe("historical physical stock", () => {
  it("uses the date's final millisecond, keeps identifiers and zero stock, and omits unverified historical fields", async () => {
    get.mockResolvedValueOnce({
      meta: { size: 2 },
      rows: [{ meta: variant(1).meta, stock: 0, reserve: 20, inTransit: 30, quantity: 10, salePrice: 10000 }],
    });
    get.mockResolvedValueOnce({ meta: { size: 1 }, rows: [variant(1)] });
    const r = JSON.parse(await handleGetStockAtDate(getStockAtDateSchema.parse({ date: "2026-09-14", limit: 1 })));
    const q = new URL(get.mock.calls[0][0], "https://example.com").searchParams;
    expect(q.get("filter")).toBe(
      "stockMode=all;quantityMode=all;moment=2026-09-14 23:59:59.999;archived=true;archived=false",
    );
    expect(r).toMatchObject({
      date: "2026-09-14",
      as_of: "2026-09-14 23:59:59.999",
      timezone: "Europe/Moscow",
      catalog_as_of: "current",
      by_store: false,
      next_offset: 1,
    });
    expect(r.items[0]).toMatchObject({ stock: 0, size: 38, article: "DEMO", assortment_id: id(1) });
    for (const key of ["reserve", "quantity", "inTransit", "free_stock", "sale_price_rubles"])
      expect(r.items[0]).not.toHaveProperty(key);
  });
  it("applies the identical historical moment to warehouse and assortment filters", async () => {
    get.mockResolvedValueOnce({
      meta: { size: 1 },
      rows: [
        {
          meta: variant(1).meta,
          stockByStore: [
            { meta: { href: root + "store/" + id(8) }, name: "Demo", stock: 2, reserve: 99, inTransit: 8 },
          ],
        },
      ],
    });
    get.mockResolvedValueOnce({ id: id(8), name: "Demo" });
    get.mockResolvedValueOnce({ meta: { size: 1 }, rows: [{ meta: variant(1).meta, stock: 2 }] });
    get.mockResolvedValueOnce({ meta: { size: 1 }, rows: [variant(1)] });
    const r = JSON.parse(
      await handleGetStockAtDate(
        getStockAtDateSchema.parse({
          date: "2026-09-14",
          by_store: true,
          store_href: root + "store/" + id(8),
          variant_href: root + "variant/" + id(1),
          offset: 2,
        }),
      ),
    );
    const u = new URL(get.mock.calls[0][0], "https://example.com");
    expect(u.pathname).toBe("/report/stock/all");
    expect(u.searchParams.get("offset")).toBe("2");
    expect(u.searchParams.get("filter")).toBe(
      "stockMode=all;quantityMode=all;moment=2026-09-14 23:59:59.999;archived=true;archived=false;store=" +
        root +
        "store/" +
        id(8) +
        ";variant=" +
        root +
        "variant/" +
        id(1),
    );
    expect(r.items[0].by_store[0]).toEqual({
      store: "Demo",
      store_id: id(8),
      store_href: root + "store/" + id(8),
      stock: 2,
      stock_status: "reported",
    });
  });
  it("includes archived warehouses and keeps a missing per-warehouse row unknown rather than zero", async () => {
    get.mockResolvedValueOnce({ meta: { size: 1 }, rows: [{ meta: variant(1).meta, stock: 1 }] });
    get.mockResolvedValueOnce({
      meta: { size: 2 },
      rows: [
        { id: id(8), name: "Active" },
        { id: id(9), name: "Archived", archived: true },
      ],
    });
    get.mockResolvedValueOnce({ meta: { size: 1 }, rows: [{ meta: variant(1).meta, stock: 1 }] });
    get.mockResolvedValueOnce({ meta: { size: 0 }, rows: [] });
    get.mockResolvedValueOnce({ meta: { size: 1 }, rows: [variant(1)] });
    const r = JSON.parse(
      await handleGetStockAtDate(getStockAtDateSchema.parse({ date: "2026-09-14", by_store: true })),
    );
    expect(r.items[0].by_store.map((x: any) => x.stock)).toEqual([1, null]);
    expect(r.items[0].by_store[1].stock_status).toBe("not_returned");
    expect(get.mock.calls[1][0]).toContain("archived%3Dtrue%3Barchived%3Dfalse");
    expect(get.mock.calls.every((call) => !call[0].startsWith("/report/stock/bystore"))).toBe(true);
  });
  it("validates real calendar dates, leap years and completed days before fetching", () => {
    const now = new Date("2026-10-14T10:00:00Z");
    for (const date of [
      "2026-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-10-14",
      "2026-10-15",
      "2026-09-14 10:00:00",
      "2026-09-14Z",
    ])
      expect(() => historicalStockMoment(date, now)).toThrow("INVALID_ARGUMENT");
    expect(historicalStockMoment("2024-02-29", now).moment).toBe("2024-02-29 23:59:59.999");
    expect(get).not.toHaveBeenCalled();
  });
  it("uses the configured API day rather than the host UTC day at midnight", () => {
    expect(historicalStockMoment("2026-10-14", new Date("2026-10-14T21:30:00Z")).date).toBe("2026-10-14");
    expect(() => historicalStockMoment("2026-10-15", new Date("2026-10-14T21:30:00Z"))).toThrow("completed day");
  });
});
describe("stock identity and quantity semantics", () => {
  it("retains zero, one and two rows, joins explicit sizes in one batch, and exposes pagination", async () => {
    get.mockResolvedValueOnce({
      meta: { size: 4 },
      rows: [0, 1, 2].map((stock, i) => ({
        ...variant(i + 1),
        characteristics: undefined,
        product: undefined,
        stock,
        reserve: 1,
        inTransit: 2,
        quantity: stock + 1,
      })),
    });
    get.mockResolvedValueOnce({ meta: { size: 3 }, rows: [variant(1), variant(2), variant(3)] });
    const r = JSON.parse(await handleGetStock(getStockSchema.parse({ limit: 3 })));
    expect(r.items.map((x: any) => x.stock)).toEqual([0, 1, 2]);
    expect(r.items[0]).toMatchObject({
      assortment_id: id(1),
      parent_product_id: id(99),
      article: "DEMO",
      size: 38,
      size_raw: "38",
      reserve: 1,
      free_stock: -1,
      quantity: 1,
    });
    expect(r.next_offset).toBe(3);
    expect(get).toHaveBeenCalledTimes(2);
    const q = new URL(get.mock.calls[0][0], "https://example.com").searchParams;
    expect(q.get("groupBy")).toBe("variant");
    expect(q.get("filter")).toBe("stockMode=all;quantityMode=all");
    expect(get.mock.calls[1][0]).toContain("expand=product");
  });
  it("does not invent sizes from names or missing cards, or replace unknown quantities with zero", async () => {
    get.mockResolvedValueOnce({
      meta: { size: 1 },
      rows: [{ meta: variant(1).meta, name: "Model size 40", stock: 0 }],
    });
    get.mockResolvedValueOnce({ meta: { size: 0 }, rows: [] });
    const r = JSON.parse(await handleGetStock(getStockSchema.parse({})));
    expect(r.items[0]).toMatchObject({
      assortment_id: id(1),
      size: null,
      size_raw: null,
      catalog_status: "unavailable",
      stock: 0,
      reserve: null,
      free_stock: null,
      quantity: null,
    });
  });
  it("preserves warehouse IDs and calculates available stock using reserves and transit", async () => {
    get.mockResolvedValueOnce({
      meta: { size: 1 },
      rows: [
        {
          meta: variant(1).meta,
          stockByStore: [
            { meta: { href: root + "store/" + id(8) }, name: "Demo store", stock: 2, reserve: 1, inTransit: 3 },
          ],
        },
      ],
    });
    get.mockResolvedValueOnce({ meta: { size: 1 }, rows: [variant(1)] });
    const r = JSON.parse(
      await handleGetStockByStore(getStockByStoreSchema.parse({ store_href: root + "store/" + id(8) })),
    );
    expect(r.items[0]).toMatchObject({ article: "DEMO", size: 38 });
    expect(r.items[0].by_store[0]).toMatchObject({
      store_id: id(8),
      stock: 2,
      reserve: 1,
      free_stock: 1,
      quantity: 4,
      in_transit: 3,
    });
    expect(new URL(get.mock.calls[0][0], "https://example.com").searchParams.get("filter")).toBe(
      "stockMode=all;store=" + root + "store/" + id(8),
    );
  });
  it("bounds bulk catalog requests to twenty IDs", async () => {
    get.mockResolvedValueOnce({
      meta: { size: 21 },
      rows: Array.from({ length: 21 }, (_, i) => ({ meta: variant(i + 1).meta, stock: 1 })),
    });
    get.mockResolvedValueOnce({ meta: { size: 20 }, rows: Array.from({ length: 20 }, (_, i) => variant(i + 1)) });
    get.mockResolvedValueOnce({ meta: { size: 1 }, rows: [variant(21)] });
    const r = JSON.parse(await handleGetStock(getStockSchema.parse({ limit: 21 })));
    expect(r.items).toHaveLength(21);
    expect(get).toHaveBeenCalledTimes(3);
  });
  it("rejects mismatched catalog identities instead of silently joining the wrong size", async () => {
    get.mockResolvedValueOnce({ meta: { size: 1 }, rows: [{ meta: variant(1).meta }] });
    get.mockResolvedValueOnce({ meta: { size: 1 }, rows: [variant(2)] });
    await expect(handleGetStock(getStockSchema.parse({}))).rejects.toThrow("identity mismatch");
  });
  it("rejects conflicting filters and negative offsets before upstream requests", async () => {
    expect(() => getStockSchema.parse({ offset: -1 })).toThrow();
    await expect(
      handleGetStock(getStockSchema.parse({ search: "Demo", product_href: root + "product/" + id(1) })),
    ).rejects.toThrow("choose only one");
    expect(get).not.toHaveBeenCalled();
  });
});
describe("fast stock", () => {
  it("requests explicit zero lines and the selected metric while preserving ID-based payload", async () => {
    get.mockResolvedValue([{ assortmentId: id(1), freeStock: 0 }]);
    expect(JSON.parse(await handleGetStockCurrent({ stock_type: "freeStock" }))).toEqual([
      { assortmentId: id(1), freeStock: 0 },
    ]);
    const q = new URL(get.mock.calls[0][0], "https://example.com").searchParams;
    expect(q.get("include")).toBe("zeroLines");
    expect(q.get("stockType")).toBe("freeStock");
  });
  it("uses warehouse endpoint and UUID filter for warehouse-specific fast stock", async () => {
    get.mockResolvedValue([]);
    await handleGetStockCurrent({ store_href: root + "store/" + id(8), include_zero: false });
    const u = new URL(get.mock.calls[0][0], "https://example.com");
    expect(u.pathname).toBe("/report/stock/bystore/current");
    expect(u.searchParams.get("filter")).toBe("storeId=" + id(8));
    expect(u.searchParams.has("include")).toBe(false);
  });
});
