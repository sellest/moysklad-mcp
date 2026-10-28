import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn() }));
import { moyskladGet } from "../src/client.js";
import { getProductsByIdsSchema, handleGetProductsByIds } from "../src/tools/product-lookup.js";
const get = vi.mocked(moyskladGet);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const run = async (params: unknown) => JSON.parse(await handleGetProductsByIds(getProductsByIdsSchema.parse(params)));

describe("batch product lookup", () => {
  beforeEach(() => {
    get.mockReset();
  });
  it("joins unordered API rows by UUID, preserves exact articles and includes archived and missing products", async () => {
    get.mockResolvedValue({
      meta: { size: 2 },
      rows: [
        { id: id(2), article: "0007", name: "Archived", archived: true, salePrices: [{ value: 12345 }] },
        { id: id(1), article: "0007", name: "Active", archived: false },
      ],
    });
    const r = await run({ ids: [id(1), id(2), id(3)] });
    expect(r.products.map((p: { id: string }) => p.id)).toEqual([id(1), id(2), id(3)]);
    expect(r.products[0]).toMatchObject({ article: "0007", archived: false, status: "found" });
    expect(r.products[1]).toMatchObject({ article: "0007", archived: true, sale_price_rubles: 123.45 });
    expect(r.products[2]).toMatchObject({ status: "not_found", article: null, archived: null });
    expect(r).toMatchObject({ total: 3, returned: 3, found: 2, not_found: 1, next_offset: null, complete: true });
    expect(get).toHaveBeenCalledTimes(1);
    const filter = new URL(get.mock.calls[0][0], "https://fixture.invalid").searchParams.get("filter");
    expect(filter).toBe(`id=${id(1)};id=${id(2)};id=${id(3)};archived=true;archived=false`);
  });
  it("deduplicates UUID case before paginating; only queries the requested page", async () => {
    const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ids = [first.toUpperCase(), first, ...Array.from({ length: 101 }, (_, i) => id(i))];
    get.mockResolvedValue({ meta: { size: 0 }, rows: [] });
    const a = await run({ ids });
    expect(a).toMatchObject({
      requested_count: 103,
      duplicates_removed: 1,
      total: 102,
      returned: 100,
      next_offset: 100,
      complete: false,
    });
    expect(a.products[0].id).toBe(first);
    const b = await run({ ids, offset: a.next_offset });
    expect(b.products.map((p: { id: string }) => p.id)).toEqual([id(99), id(100)]);
    expect(b).toMatchObject({ returned: 2, next_offset: null, complete: true });
    const filter = new URL(get.mock.calls[1][0], "https://fixture.invalid").searchParams.get("filter");
    expect(filter).toBe(`id=${id(99)};id=${id(100)};archived=true;archived=false`);
  });
  it("does not query MoySklad past the last input page", async () => {
    expect(await run({ ids: [id(1)], offset: 1 })).toMatchObject({
      products: [],
      returned: 0,
      total: 1,
      complete: true,
    });
    expect(get).not.toHaveBeenCalled();
  });
  it("propagates API failures instead of reporting missing products", async () => {
    get.mockRejectedValue(new Error("API_HTTP_403"));
    await expect(run({ ids: [id(1)] })).rejects.toThrow("API_HTTP_403");
  });
  it("rejects a truncated, malformed or unfiltered API response", async () => {
    for (const value of [
      {},
      { rows: [{}] },
      { rows: [{ id: id(2) }] },
      { meta: { size: 2 }, rows: [{ id: id(1) }] },
      { rows: [{ id: id(1) }, { id: id(1) }] },
    ]) {
      get.mockResolvedValueOnce(value);
      await expect(run({ ids: [id(1)] })).rejects.toThrow("UPSTREAM_RESPONSE");
    }
  });
  it("validates UUID arrays and the advertised page bounds", () => {
    for (const p of [
      { ids: [] },
      { ids: ["not-a-uuid"] },
      { ids: [id(1)], limit: 101 },
      { ids: [id(1)], offset: -1 },
      { ids: [id(1)], limit: 0 },
      { ids: Array(1001).fill(id(1)) },
    ]) {
      expect(getProductsByIdsSchema.safeParse(p).success).toBe(false);
    }
  });
});
