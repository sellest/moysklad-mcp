import { readFile } from "node:fs/promises";
import { z } from "zod";
import { buildFilter } from "../lib.js";
import { outputResult } from "../output.js";
import { decimal, Exact } from "../precision.js";
import { reportProgress } from "../report-context.js";
import { normalizeReportMoment, reportPeriodSchema, reportQuery } from "../report-lib.js";
import { sourcePages } from "../streaming-source.js";
import type { ToolDef } from "../types.js";

const uuidList = z.array(z.string().uuid()).max(100);
export const customerProfitMarketplacesSchema = z
  .object({ wildberries: uuidList.default([]), ozon: uuidList.default([]) })
  .strict();
type Marketplaces = z.infer<typeof customerProfitMarketplacesSchema>;
const entityHref = (entity: string) =>
  z.string().regex(new RegExp(`^https://api\\.moysklad\\.ru/api/remap/1\\.2/entity/${entity}/[0-9a-fA-F-]{36}$`));

export const customerProfitSchema = z.object({
  moment_from: reportPeriodSchema.moment_from.unwrap(),
  moment_to: reportPeriodSchema.moment_to.unwrap(),
  organization_href: entityHref("organization").optional(),
  store_href: entityHref("store").optional(),
  top_n: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Global top N customers after reading every report page; maximum 100."),
  separate_marketplaces: z
    .boolean()
    .default(true)
    .describe(
      "Separate the configured shared Wildberries/Ozon counterparties from the customer ranking, preserving them in overall totals.",
    ),
  marketplace_counterparty_ids: customerProfitMarketplacesSchema
    .optional()
    .describe(
      "Optional confirmed counterparty UUIDs grouped as wildberries/ozon; overrides the operator reference. Never infer IDs or classify by a name substring.",
    ),
  refresh_source: z
    .boolean()
    .default(false)
    .describe(
      "Reload a completed report instead of reusing its result (normally cached for up to 5 minutes). An active identical job is still reused.",
    ),
  output: z
    .enum(["inline", "file"])
    .default("inline")
    .describe("Return a compact ranking by default. file is only for an explicitly requested export."),
});
export type CustomerProfitParams = z.infer<typeof customerProfitSchema>;

export async function customerProfitMarketplaceMapping(
  params: Pick<CustomerProfitParams, "separate_marketplaces" | "marketplace_counterparty_ids">,
): Promise<Marketplaces> {
  if (!params.separate_marketplaces) return { wildberries: [], ozon: [] };
  let raw: unknown = params.marketplace_counterparty_ids;
  if (!raw) {
    try {
      raw = JSON.parse(
        await readFile(
          process.env.MCP_PROFIT_MARKETPLACES_FILE ?? "/run/mcp-reference/profit-marketplaces.json",
          "utf8",
        ),
      );
    } catch {
      throw new Error(
        "CUSTOMER_PROFIT_POLICY_UNAVAILABLE: Configure the marketplace counterparty reference or provide confirmed IDs.",
      );
    }
  }
  const parsed = customerProfitMarketplacesSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error("CUSTOMER_PROFIT_POLICY_UNAVAILABLE: Invalid marketplace counterparty reference.");
  const mapping = {
    wildberries: [...new Set(parsed.data.wildberries.map((id) => id.toLowerCase()))].sort(),
    ozon: [...new Set(parsed.data.ozon.map((id) => id.toLowerCase()))].sort(),
  };
  if (mapping.wildberries.some((id) => mapping.ozon.includes(id)))
    throw new Error("CUSTOMER_PROFIT_POLICY_UNAVAILABLE: A counterparty cannot belong to two marketplaces.");
  return mapping;
}

type Money = {
  sales: InstanceType<typeof Exact>;
  returns: InstanceType<typeof Exact>;
  net: InstanceType<typeof Exact>;
  profit: InstanceType<typeof Exact>;
};
type Customer = Money & { id: string; name: string; marketplace: "wildberries" | "ozon" | null };
const zero = (): Money => ({ sales: new Exact(0), returns: new Exact(0), net: new Exact(0), profit: new Exact(0) });
function add(total: Money, row: Money) {
  for (const key of ["sales", "returns", "net", "profit"] as const) total[key] = total[key].plus(row[key]);
}
function money(value: unknown) {
  const amount = decimal(value);
  if (!amount || amount.abs().gt(Number.MAX_SAFE_INTEGER))
    throw new Error("INCOMPLETE_SOURCE: Missing, non-finite or unsafe report money.");
  return amount;
}
function rubles(value: InstanceType<typeof Exact>) {
  if (value.abs().gt(Number.MAX_SAFE_INTEGER))
    throw new Error("INCOMPLETE_SOURCE: Report money exceeds the safe output range.");
  return Number(value.div(100).toFixed(2));
}
const amounts = (row: Money) => ({
  sell_sum_rubles: rubles(row.sales),
  return_sum_rubles: rubles(row.returns),
  net_sum_rubles: rubles(row.net),
  profit_rubles: rubles(row.profit),
});
const compare = (a: Customer, b: Customer) => b.net.comparedTo(a.net) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const present = (row: Customer) => ({ counterparty_id: row.id, name: row.name, ...amounts(row) });

export async function handleGetCustomerProfitReport(params: CustomerProfitParams): Promise<string> {
  const query = new URLSearchParams(reportQuery({ ...params, limit: 1000, offset: 0 }));
  query.delete("limit");
  query.delete("offset");
  const filter = buildFilter([
    ["organization", params.organization_href ?? ""],
    ["store", params.store_href ?? ""],
  ]);
  if (filter) query.set("filter", filter);
  const mapping = await customerProfitMarketplaceMapping(params);
  const brands = new Map<string, "wildberries" | "ozon">();
  for (const brand of ["wildberries", "ozon"] as const) for (const id of mapping[brand]) brands.set(id, brand);
  const ranking: Customer[] = [],
    marketplaces: Customer[] = [];
  const totals = { all: zero(), customers: zero(), marketplaces: zero(), ranking: zero() };
  const seen = new Set<string>();
  let pages = 0,
    customerCount = 0;
  const startedAt = new Date().toISOString();
  for await (const page of sourcePages(`/report/profit/bycounterparty?${query}`, { limit: 1000 })) {
    if (page.expected > 50000)
      throw new Error("STORAGE_LIMIT: Customer report exceeds 50000 counterparties; narrow the period or filters.");
    for (const row of page.rows) {
      const counterparty = row.counterparty;
      const match =
        typeof counterparty?.meta?.href === "string"
          ? /^https:\/\/api\.moysklad\.ru\/api\/remap\/1\.2\/entity\/counterparty\/([0-9a-f-]{36})$/i.exec(
              counterparty.meta.href,
            )
          : null;
      const parsedId = z.string().uuid().safeParse(match?.[1]);
      if (!parsedId.success || typeof counterparty?.name !== "string" || !counterparty.name.trim())
        throw new Error("REPORT_ID: Report row lacks a valid counterparty identity/name.");
      const id = parsedId.data.toLowerCase();
      if (seen.has(id)) throw new Error("SOURCE_CHANGED: Duplicate counterparty across report pages.");
      seen.add(id);
      const sales = money(row.sellSum),
        returns = money(row.returnSum);
      const item: Customer = {
        id,
        name: counterparty.name,
        sales,
        returns,
        net: sales.minus(returns),
        profit: money(row.profit),
        marketplace: brands.get(id) ?? null,
      };
      add(totals.all, item);
      if (item.marketplace) {
        marketplaces.push(item);
        add(totals.marketplaces, item);
      } else {
        customerCount++;
        add(totals.customers, item);
        ranking.push(item);
        ranking.sort(compare);
        if (ranking.length > params.top_n) ranking.pop();
      }
    }
    pages++;
    await reportProgress("aggregate_customer_profit", {
      processed_counterparties: page.rows.length,
      expected_counterparties: page.expected,
      pages: 1,
    });
  }
  for (const item of ranking) add(totals.ranking, item);
  marketplaces.sort(compare);
  const metadata = {
    source: "moysklad/report/profit/bycounterparty",
    period: {
      moment_from: normalizeReportMoment(params.moment_from),
      moment_to: normalizeReportMoment(params.moment_to, true),
      end_inclusive: true,
      timezone: "Europe/Moscow",
    },
    filters: { organization_href: params.organization_href ?? null, store_href: params.store_href ?? null },
    currency: "RUB",
    money_basis:
      "MoySklad profitability API; source amounts in kopecks. Gross profit uses the API profit field, not order totals or a local cost estimate.",
    arithmetic:
      "Exact decimal sums and ranking before display rounding; RUB output rounded half-up to 2 decimals after aggregation.",
    sort: { field: "net_sum_rubles", direction: "desc", tie_breaker: "counterparty_id asc" },
    top_n: params.top_n,
    returned: ranking.length,
    totals_scope: "all report pages, not only top N; ranking totals are explicitly separate",
    totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, amounts(value)])),
    counterparties: { all: seen.size, customers: customerCount, marketplaces: marketplaces.length },
    marketplace_policy: {
      separate: params.separate_marketplaces,
      basis: "explicit counterparty UUID reference; no name matching",
      configured_ids_absent_from_report: [...brands.keys()].filter((id) => !seen.has(id)),
    },
    source_complete: true,
    upstream_pages: pages,
    captured_from: startedAt,
    captured_to: new Date().toISOString(),
    consistency:
      "Sequential API pages with fixed count and unique counterparty IDs; not a transactional database snapshot.",
  };
  const result = {
    ...metadata,
    ranking: ranking.map((row, index) => ({ rank: index + 1, ...present(row) })),
    marketplaces: marketplaces.map((row) => ({ marketplace: row.marketplace, ...present(row) })),
  };
  return outputResult(result, metadata, params);
}

export const tools: ToolDef[] = [
  {
    name: "get_customer_profit_report",
    description:
      "Прибыльность → По покупателям / customer profitability. Reads ALL native report pages server-side and returns global top 20 (top_n 1..100), sorted by sales minus returns descending. Includes exact counterparty UUID/name, sales, returns, net sales and gross profit in RUB. Separate confirmed shared Wildberries/Ozon counterparties using the operator UUID reference (no name guessing); their totals remain in totals.all. Required inclusive dates, Moscow accounting time; optional organization/store filters. No document downloads or parallel pagination needed. May return a report job: poll get_report_job. Never equate customer orders with realized sales/profit.",
    schema: customerProfitSchema,
    handler: handleGetCustomerProfitReport,
  },
];
