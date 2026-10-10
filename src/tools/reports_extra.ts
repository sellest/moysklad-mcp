import { z } from "zod";
import { moyskladGet } from "../client.js";
import { formatList, json, kopToRub } from "../lib.js";
import { assortmentFields, projectAssortment, reportPage, reportPeriodSchema, reportQuery } from "../report-lib.js";
import type { ToolDef } from "../types.js";
import { outputResult, outputSchema } from "../output.js";

// --- get_dashboard ---
export const getDashboardSchema = z.object({
  period: z.enum(["day", "week", "month"]).default("day").describe("Aggregation period for the dashboard metrics"),
});
export async function handleGetDashboard(p: z.infer<typeof getDashboardSchema>): Promise<string> {
  // Money figures in the dashboard are in kopecks (per MoySklad).
  const result = await moyskladGet(`/report/dashboard/${p.period}`);
  return json(result);
}

// --- get_turnover (обороты товаров) ---
export const getTurnoverSchema = z.object({ ...reportPeriodSchema, ...outputSchema });
export async function handleGetTurnover(p: z.infer<typeof getTurnoverSchema>): Promise<string> {
  const qs = reportQuery(p);
  const result = await moyskladGet(`/report/turnover/all?${qs}`);
  const section = (s: unknown) => {
    const x = (s ?? {}) as Record<string, unknown>;
    return { quantity: x.quantity, ...(p.fields === "quantity" ? {} : { sum_rubles: kopToRub(x.sum) }) };
  };
  const formatted = JSON.parse(
    formatList(result, "items", (row) => {
      const assortment = row.assortment as Record<string, unknown> | undefined;
      return {
        ...(p.fields === "full" ? assortmentFields(assortment) : projectAssortment(assortment, p.fields)),
        on_period_start: section(row.onPeriodStart),
        income: section(row.income),
        outcome: section(row.outcome),
        on_period_end: section(row.onPeriodEnd),
      };
    }),
  );
  const summary = { ...reportPage(result, p), summary_scope: "requested page, not all pages" };
  return outputResult(
    p.detail === "raw"
      ? result
      : p.detail === "summary" && p.output !== "file"
        ? summary
        : { ...formatted, ...summary },
    summary,
    p,
  );
}

// --- get_money_report (остатки денег по счетам/кассам) ---
export const getMoneyReportSchema = z.object({});
export async function handleGetMoneyReport(): Promise<string> {
  const result = await moyskladGet("/report/money/byaccount");
  return formatList(result, "accounts", (row) => {
    const account = row.account as Record<string, unknown> | undefined;
    const org = row.organization as Record<string, unknown> | undefined;
    return {
      account: account?.name ?? (account ? "bank account" : "cash"),
      organization: org?.name ?? null,
      balance_rubles: kopToRub(row.balance),
    };
  });
}

// --- get_stock_current (fast current stock) ---
export const getStockCurrentSchema = z.object({
  store_href: z.string().optional().describe("Limit to one warehouse (meta href). Omit for all."),
});
export async function handleGetStockCurrent(p: z.infer<typeof getStockCurrentSchema>): Promise<string> {
  const q = new URLSearchParams();
  if (p.store_href) q.set("filter", `store=${p.store_href}`);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  // The "current" endpoints are the lightweight, non-paginated stock reports.
  const result = await moyskladGet(`/report/stock/all/current${suffix}`);
  return json(result);
}

export const tools: ToolDef[] = [
  {
    name: "get_dashboard",
    description: "Get dashboard metrics (sales, orders, money) for a day/week/month. Money values are in kopecks.",
    schema: getDashboardSchema,
    handler: handleGetDashboard,
  },
  {
    name: "get_turnover",
    description: "Get product turnover (обороты) over a period: opening, income, outcome, closing. Sums in RUBLES.",
    schema: getTurnoverSchema,
    handler: handleGetTurnover,
  },
  {
    name: "get_money_report",
    description: "Get current money balances by bank account and cash register. Balances in RUBLES.",
    schema: getMoneyReportSchema,
    handler: handleGetMoneyReport,
  },
  {
    name: "get_stock_current",
    description: "Fast current stock report (assortment id -> stock), optionally for one warehouse.",
    schema: getStockCurrentSchema,
    handler: handleGetStockCurrent,
  },
];
