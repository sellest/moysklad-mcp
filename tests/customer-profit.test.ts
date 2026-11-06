import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn() }));
import { moyskladGet } from "../src/client.js";
import {
  customerProfitMarketplaceMapping,
  customerProfitSchema,
  handleGetCustomerProfitReport,
} from "../src/tools/customer-profit.js";

const mockGet = vi.mocked(moyskladGet);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, sales: number, returns = 0, profit = 0, name = "Synthetic customer") => ({
  counterparty: {
    name,
    meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/counterparty/${id(n)}`, type: "counterparty" },
  },
  sellSum: sales,
  returnSum: returns,
  profit,
});
const params = (extra = {}) =>
  customerProfitSchema.parse({
    moment_from: "2026-08-01",
    moment_to: "2026-11-01",
    marketplace_counterparty_ids: { wildberries: [id(90)], ozon: [id(91)] },
    ...extra,
  });
beforeEach(() => mockGet.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe("native customer profitability ranking", () => {
  it("reads every page before global top N, separates marketplace IDs and preserves total money", async () => {
    mockGet.mockResolvedValueOnce({
      meta: { size: 6, offset: 0 },
      rows: [
        row(1, 10000, 9000, 123),
        row(90, 1000000, 10000, 50000, "Renamed shared account"),
        row(2, 30000, 0, 7000),
      ],
    });
    mockGet.mockResolvedValueOnce({
      meta: { size: 6, offset: 3 },
      rows: [
        row(3, 40000, 2000, 8000),
        row(91, 500000, 1000, 10000),
        row(4, 20000, 0, 6000, "Ozon is part of this ordinary customer's name"),
      ],
    });
    const result = JSON.parse(await handleGetCustomerProfitReport(params({ top_n: 2 })));
    expect(result.ranking.map((r: any) => r.counterparty_id)).toEqual([id(3), id(2)]);
    expect(result.ranking[0]).toMatchObject({
      rank: 1,
      sell_sum_rubles: 400,
      return_sum_rubles: 20,
      net_sum_rubles: 380,
      profit_rubles: 80,
    });
    expect(result.marketplaces.map((r: any) => r.counterparty_id)).toEqual([id(90), id(91)]);
    expect(result.totals.all).toEqual({
      sell_sum_rubles: 16000,
      return_sum_rubles: 220,
      net_sum_rubles: 15780,
      profit_rubles: 811.23,
    });
    expect(result.totals.customers.net_sum_rubles).toBe(890);
    expect(result.totals.marketplaces.net_sum_rubles).toBe(14890);
    expect(result.totals.ranking.net_sum_rubles).toBe(680);
    expect(result.counterparties).toEqual({ all: 6, customers: 4, marketplaces: 2 });
    expect(result.source_complete).toBe(true);
    expect(result.upstream_pages).toBe(2);
    const urls = mockGet.mock.calls.map(([path]) => new URL(path, "https://example.com"));
    expect(urls.map((url) => url.pathname)).toEqual(["/report/profit/bycounterparty", "/report/profit/bycounterparty"]);
    expect(urls.map((url) => url.searchParams.get("offset"))).toEqual(["0", "3"]);
    expect(urls[0].searchParams.get("limit")).toBe("1000");
    expect(urls[0].searchParams.get("momentFrom")).toBe("2026-08-01 00:00:00");
    expect(urls[0].searchParams.get("momentTo")).toBe("2026-11-01 23:59:59.999");
  });

  it("sorts before rounding and resolves equal net sales by stable UUID", async () => {
    mockGet.mockResolvedValue({
      meta: { size: 4 },
      rows: [row(2, 100.1), row(1, 100.1), row(3, 100.2), row(4, 0, 50, -10)],
    });
    const result = JSON.parse(await handleGetCustomerProfitReport(params()));
    expect(result.ranking.map((r: any) => r.counterparty_id)).toEqual([id(3), id(1), id(2), id(4)]);
    expect(result.ranking[0].net_sum_rubles).toBe(1);
    expect(result.ranking[3]).toMatchObject({ net_sum_rubles: -0.5, profit_rubles: -0.1 });
    expect(result.totals.all.net_sum_rubles).toBe(2.5);
  });

  it("uses only report identity/name and the authoritative profit field without card/document fetches", async () => {
    mockGet.mockResolvedValue({
      meta: { size: 1 },
      rows: [{ ...row(1, 1000, 100, 456), sellCostSum: 1, returnCostSum: 0 }],
    });
    const result = JSON.parse(await handleGetCustomerProfitReport(params()));
    expect(result.ranking[0].profit_rubles).toBe(4.56);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(result.marketplace_policy.configured_ids_absent_from_report).toEqual([id(90), id(91)]);
  });

  it("applies supported organization/store filters and preserves explicit times", async () => {
    mockGet.mockResolvedValue({ meta: { size: 0 }, rows: [] });
    const organization = `https://api.moysklad.ru/api/remap/1.2/entity/organization/${id(1)}`;
    const store = `https://api.moysklad.ru/api/remap/1.2/entity/store/${id(2)}`;
    await handleGetCustomerProfitReport(
      params({
        moment_from: "2026-08-01T10:00:00.123",
        moment_to: "2026-11-01 19:30:00",
        organization_href: organization,
        store_href: store,
      }),
    );
    const query = new URL(mockGet.mock.calls[0][0], "https://example.com").searchParams;
    expect(query.get("filter")).toBe(`organization=${organization};store=${store}`);
    expect(query.get("momentFrom")).toBe("2026-08-01 10:00:00.123");
    expect(query.get("momentTo")).toBe("2026-11-01 19:30:00");
    await expect(handleGetCustomerProfitReport(params({ moment_from: "2026-12-01" }))).rejects.toThrow("moment_from");
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("does not pretend a changed or incomplete source is a complete ranking", async () => {
    mockGet
      .mockResolvedValueOnce({ meta: { size: 2 }, rows: [row(1, 1)] })
      .mockResolvedValueOnce({ meta: { size: 3 }, rows: [row(2, 2)] });
    await expect(handleGetCustomerProfitReport(params())).rejects.toThrow("SOURCE_CHANGED");
    mockGet
      .mockReset()
      .mockResolvedValueOnce({ meta: { size: 2 }, rows: [row(1, 1)] })
      .mockResolvedValueOnce({ meta: { size: 2 }, rows: [] });
    await expect(handleGetCustomerProfitReport(params())).rejects.toThrow("INCOMPLETE_PAGE");
    mockGet.mockReset().mockResolvedValue({ meta: { size: 2 }, rows: [row(1, 1), row(1, 1)] });
    await expect(handleGetCustomerProfitReport(params())).rejects.toThrow("SOURCE_CHANGED");
  });

  it.each([undefined, null, "", "NaN", Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects missing/unsafe money %s without treating it as zero",
    async (profit) => {
      mockGet.mockResolvedValue({ meta: { size: 1 }, rows: [{ ...row(1, 100), profit }] });
      await expect(handleGetCustomerProfitReport(params())).rejects.toThrow("INCOMPLETE_SOURCE");
    },
  );

  it("rejects unidentifiable buyers and oversized reports", async () => {
    mockGet.mockResolvedValueOnce({ meta: { size: 1 }, rows: [{ ...row(1, 100), counterparty: { name: "No ID" } }] });
    await expect(handleGetCustomerProfitReport(params())).rejects.toThrow("REPORT_ID");
    mockGet.mockResolvedValueOnce({ meta: { size: 50001 }, rows: [row(1, 100)] });
    await expect(handleGetCustomerProfitReport(params())).rejects.toThrow("STORAGE_LIMIT");
  });

  it("permits an explicit inclusive ranking without marketplace separation", async () => {
    mockGet.mockResolvedValue({ meta: { size: 1 }, rows: [row(90, 100)] });
    const result = JSON.parse(await handleGetCustomerProfitReport(params({ separate_marketplaces: false })));
    expect(result.ranking[0].counterparty_id).toBe(id(90));
    expect(result.marketplaces).toEqual([]);
    expect(result.marketplace_policy.separate).toBe(false);
  });

  it("requires valid dates and bounds top_n", () => {
    expect(customerProfitSchema.safeParse({ moment_from: "2026-08-01" }).success).toBe(false);
    expect(customerProfitSchema.safeParse({ moment_from: "2026-08-01", moment_to: "2026-02-30" }).success).toBe(false);
    for (const top_n of [0, 101, 2.5]) expect(() => params({ top_n })).toThrow();
    expect(() => params({ store_href: "https://example.com/invalid;filter=bad" })).toThrow();
  });
});

describe("explicit marketplace UUID policy", () => {
  it("loads and canonicalizes the operator file; errors do not reveal its path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "customer-profit-policy-"));
    const path = join(directory, "policy.json");
    vi.stubEnv("MCP_PROFIT_MARKETPLACES_FILE", path);
    try {
      await writeFile(path, JSON.stringify({ wildberries: [id(90), id(90)], ozon: [id(91)] }));
      expect(await customerProfitMarketplaceMapping({ separate_marketplaces: true })).toEqual({
        wildberries: [id(90)],
        ozon: [id(91)],
      });
      await writeFile(path, "{bad-json");
      await expect(customerProfitMarketplaceMapping({ separate_marketplaces: true })).rejects.toThrow(
        "CUSTOMER_PROFIT_POLICY_UNAVAILABLE",
      );
      await rm(path);
      await expect(customerProfitMarketplaceMapping({ separate_marketplaces: true })).rejects.not.toThrow(directory);
      await expect(customerProfitMarketplaceMapping({ separate_marketplaces: true })).rejects.toThrow(
        "CUSTOMER_PROFIT_POLICY_UNAVAILABLE",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses conflicting identities and unknown brands", async () => {
    await expect(
      customerProfitMarketplaceMapping({
        separate_marketplaces: true,
        marketplace_counterparty_ids: { wildberries: [id(90)], ozon: [id(90)] },
      }),
    ).rejects.toThrow("CUSTOMER_PROFIT_POLICY_UNAVAILABLE");
    await expect(
      customerProfitMarketplaceMapping({
        separate_marketplaces: true,
        marketplace_counterparty_ids: { wildberries: ["invalid"], ozon: [] },
      }),
    ).rejects.toThrow("CUSTOMER_PROFIT_POLICY_UNAVAILABLE");
  });
});
