import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn(), moyskladPost: vi.fn(), moyskladPut: vi.fn() }));
import { moyskladGet } from "../src/client.js";
import { normalizeReportMoment } from "../src/report-lib.js";
import { getProfitReportSchema, handleGetProfitReport, handleGetSalesReport } from "../src/tools/reports.js";
import { handleGetTurnover } from "../src/tools/reports_extra.js";
import { handleSearchProducts } from "../src/tools/products.js";
import { getDocumentsSchema, handleGetDocument, handleGetDocuments } from "../src/tools/documents.js";

const mockGet = vi.mocked(moyskladGet);
const href = "https://api.moysklad.ru/api/remap/1.2/entity/product/p1";
beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockResolvedValue({ meta: { size: 0 }, rows: [] });
});

describe("report period regressions", () => {
  const handlers = [handleGetProfitReport, handleGetSalesReport, handleGetTurnover];
  for (const handler of handlers) {
    it(`${handler.name} sends period as query parameters, with pagination and organization filter`, async () => {
      await handler({
        limit: 1000,
        offset: 1000,
        moment_from: "2026-09-01",
        moment_to: "2026-09-30",
        organization_href: "org",
      });
      const url = new URL(mockGet.mock.calls[0][0], "https://example.com");
      expect(url.searchParams.get("momentFrom")).toBe("2026-09-01 00:00:00");
      expect(url.searchParams.get("momentTo")).toBe("2026-09-30 23:59:59.999");
      expect(url.searchParams.get("filter")).toBe("organization=org");
      expect(url.searchParams.get("offset")).toBe("1000");
      expect(url.pathname).toBe(handler === handleGetTurnover ? "/report/turnover/all" : "/report/profit/byproduct");
    });
    it(`${handler.name} preserves full timestamps without duplicated time`, async () => {
      await handler({ limit: 25, offset: 0, moment_from: "2026-09-01 10:15:30", moment_to: "2026-09-30T17:00:00.123" });
      const query = new URL(mockGet.mock.calls[0][0], "https://example.com").searchParams;
      expect(query.get("momentFrom")).toBe("2026-09-01 10:15:30");
      expect(query.get("momentTo")).toBe("2026-09-30 17:00:00.123");
      expect(query.has("filter")).toBe(false);
    });
  }
  it.each(["2026-02-30", "2026-09-01 24:00:00", "2026-09-01 00:00:00 00:00:00", "2026-09-01T00:00:00Z"])(
    "rejects invalid or ambiguous moment %s",
    (value) => {
      expect(getProfitReportSchema.safeParse({ moment_from: value }).success).toBe(false);
      expect(() => normalizeReportMoment(value)).toThrow();
    },
  );
  it("supports leap days and rejects reversed periods before calling the API", async () => {
    expect(normalizeReportMoment("2024-02-29")).toBe("2024-02-29 00:00:00");
    await expect(
      handleGetProfitReport({ limit: 25, offset: 0, moment_from: "2026-10-01", moment_to: "2026-09-30" }),
    ).rejects.toThrow("moment_from");
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("report reconciliation", () => {
  it("keeps same-name products and services distinguishable and returns gross, return and net totals", async () => {
    mockGet.mockResolvedValue({
      meta: { size: 3 },
      rows: [
        {
          assortment: { name: "Same", meta: { href, type: "product" } },
          sellQuantity: 10,
          returnQuantity: 2,
          sellSum: 50000,
          returnSum: 10000,
        },
        {
          assortment: { name: "Same", meta: { href: href.replace("product/p1", "service/s1"), type: "service" } },
          sellQuantity: 1,
          returnQuantity: 0,
          sellSum: 1000,
          returnSum: 0,
        },
      ],
    });
    const result = JSON.parse(await handleGetSalesReport({ limit: 2, offset: 0 }));
    expect(result.next_offset).toBe(2);
    expect(result.items[0]).toMatchObject({
      id: "p1",
      type: "product",
      net_quantity: 8,
      net_sum_rubles: 400,
      sell_sum_rubles: 500,
      return_sum_rubles: 100,
    });
    expect(result.items[1]).toMatchObject({ id: "s1", type: "service" });
    const final = JSON.parse(await handleGetSalesReport({ limit: 2, offset: 2 }));
    expect(final.next_offset).toBeNull();
  });
  it("retains nested category and archive data in product search", async () => {
    mockGet.mockResolvedValue({
      rows: [{ id: "p1", pathName: "Parent/Child", productFolder: { id: "child" }, archived: true }],
    });
    const result = JSON.parse(await handleSearchProducts({ limit: 25, offset: 0, archived: true, fields: "full" }));
    expect(result.products[0]).toMatchObject({
      path_name: "Parent/Child",
      product_folder: { id: "child" },
      archived: true,
    });
    const query = new URL(mockGet.mock.calls[0][0], "https://example.com").searchParams;
    expect(query.get("filter")).toBe("archived=true");
    expect(query.get("expand")).toBe("productFolder");
  });
});

describe("document positions", () => {
  const positions = {
    meta: { size: 2, offset: 0 },
    rows: [{ id: "line1", quantity: 3, price: 12500, assortment: { meta: { href, type: "product" } } }],
  };
  it("flags incomplete expanded lists and exports stable assortment identity", async () => {
    mockGet.mockResolvedValue({ meta: { size: 2 }, rows: [{ id: "d1", positions }] });
    const result = JSON.parse(
      await handleGetDocuments({ entity_type: "demand", limit: 25, offset: 0, expand: "positions.assortment" }),
    );
    expect(result.documents[0].positions_export).toMatchObject({
      total: 2,
      returned: 1,
      complete: false,
      next_offset: 1,
    });
    expect(result.documents[0].positions_export.items[0]).toMatchObject({
      id: "p1",
      quantity: 3,
      price_rubles: 125,
    });
    expect(result.next_offset).toBe(1);
  });
  it("fetches a requested positions page and marks the last page", async () => {
    mockGet.mockResolvedValueOnce({ id: "d1" }).mockResolvedValueOnce({ ...positions, meta: { size: 2, offset: 1 } });
    const result = JSON.parse(
      await handleGetDocument({ entity_type: "demand", id: "d1", positions_limit: 1, positions_offset: 1 }),
    );
    expect(mockGet.mock.calls[1][0]).toBe("/entity/demand/d1/positions?limit=1&offset=1&expand=assortment");
    expect(result.positions_export).toMatchObject({ offset: 1, next_offset: null, complete: false });
  });
  it("allows only supported expansion paths and rejects excessive expanded page sizes", async () => {
    expect(getDocumentsSchema.safeParse({ entity_type: "demand", expand: "arbitrary" }).success).toBe(false);
    await expect(
      handleGetDocuments({ entity_type: "demand", limit: 1000, offset: 0, expand: "positions" }),
    ).rejects.toThrow("limit <= 100");
    expect(mockGet).not.toHaveBeenCalled();
  });
});
