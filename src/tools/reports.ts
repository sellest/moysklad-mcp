import { z } from "zod";
import { moyskladGet } from "../client.js";
import { json, kopToRub } from "../lib.js";
import {
  assortmentFields,
  projectAssortment,
  reportPage,
  reportPeriodSchema,
  reportQuery,
  type ReportPeriod,
} from "../report-lib.js";
import { cachedEntity, entityId } from "../analytics-data.js";
import type { ToolDef } from "../types.js";
import { outputResult, outputSchema, type OutputOptions } from "../output.js";

// --- get_profit_report ---
export const getProfitReportSchema = z.object({ ...reportPeriodSchema, ...outputSchema });

export async function handleGetProfitReport(params: z.infer<typeof getProfitReportSchema>): Promise<string> {
  const qs = reportQuery(params);
  const result = await moyskladGet(`/report/profit/byproduct?${qs}`);
  return renderReport(result, params, true);
}

// --- get_sales_report ---
export const getSalesReportSchema = z.object({ ...reportPeriodSchema, ...outputSchema });

export async function handleGetSalesReport(params: z.infer<typeof getSalesReportSchema>): Promise<string> {
  const qs = reportQuery(params);
  const result = await moyskladGet(`/report/profit/byproduct?${qs}`);
  return renderReport(result, params, false);
}

async function renderReport(raw: unknown, params: ReportPeriod & OutputOptions, profit: boolean) {
  if (params.detail !== "raw" && (params.detail !== "summary" || params.output === "file")) {
    const data = raw as { rows?: { assortment?: Record<string, any> }[] };
    const rows = data.rows ?? [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(5, rows.length) }, async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          const item = row.assortment,
            id = entityId(item),
            type = item?.meta?.type;
          if (id && item && !("article" in item) && (type === "product" || type === "variant")) {
            const card = await cachedEntity(type, id, item);
            row.assortment = { ...item, article: typeof card.article === "string" ? card.article : null };
          }
        }
      }),
    );
  }
  const formatted = JSON.parse(profit ? formatProfitReport(raw, params) : formatSalesReport(raw, params));
  if (params.fields === "quantity")
    formatted.items = formatted.items.map((item: Record<string, unknown>) => ({
      id: item.id,
      type: item.type,
      name: item.name,
      article: item.article,
      sell_quantity: item.sell_quantity,
      return_quantity: item.return_quantity,
      net_quantity:
        item.net_quantity ??
        (typeof item.sell_quantity === "number" && typeof item.return_quantity === "number"
          ? item.sell_quantity - item.return_quantity
          : null),
    }));
  const { items, ...metadata } = formatted;
  const sum = (field: string) =>
    items.reduce(
      (total: number, row: Record<string, unknown>) => total + (typeof row[field] === "number" ? row[field] : 0),
      0,
    );
  const summary = {
    ...metadata,
    summary_scope: "requested page, not all pages",
    totals: {
      sold: sum("sell_quantity"),
      returned: sum("return_quantity"),
      net: sum("sell_quantity") - sum("return_quantity"),
    },
  };
  const value =
    params.detail === "raw" ? raw : params.detail === "summary" && params.output !== "file" ? summary : formatted;
  return outputResult(value, summary, params);
}

function formatProfitReport(raw: unknown, params: ReportPeriod & OutputOptions): string {
  const data = (raw ?? {}) as { meta?: { size?: number }; rows?: unknown[] };
  return json({
    ...reportPage(raw, params),
    return_price_basis: "api_profitability_report",
    items: (data.rows ?? []).map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      const assortment = r.assortment as Record<string, unknown> | undefined;
      return {
        ...(params.fields === "full"
          ? { ...assortmentFields(assortment), article: assortment?.article ?? null }
          : projectAssortment(assortment, "quantity")),
        sell_quantity: r.sellQuantity,
        sell_sum_rubles: kopToRub(r.sellSum),
        sell_cost_sum_rubles: kopToRub(r.sellCostSum),
        return_quantity: r.returnQuantity,
        return_sum_rubles: kopToRub(r.returnSum),
        profit_rubles: kopToRub(r.profit),
        margin: r.margin,
      };
    }),
  });
}

function formatSalesReport(raw: unknown, params: ReportPeriod & OutputOptions): string {
  const data = (raw ?? {}) as { meta?: { size?: number }; rows?: unknown[] };
  return json({
    ...reportPage(raw, params),
    quantity_basis:
      "sell_quantity is gross sales; net_quantity subtracts returns. Products, bundles and services are included; variants are aggregated into products.",
    return_price_basis: "api_profitability_report",
    items: (data.rows ?? []).map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      const assortment = r.assortment as Record<string, unknown> | undefined;
      return {
        ...(params.fields === "full"
          ? { ...assortmentFields(assortment), article: assortment?.article ?? null }
          : projectAssortment(assortment, "quantity")),
        sell_quantity: r.sellQuantity,
        sell_sum_rubles: kopToRub(r.sellSum),
        return_quantity: r.returnQuantity,
        return_sum_rubles: kopToRub(r.returnSum),
        net_quantity:
          typeof r.sellQuantity === "number" && typeof r.returnQuantity === "number"
            ? r.sellQuantity - r.returnQuantity
            : null,
        net_sum_rubles:
          typeof r.sellSum === "number" && typeof r.returnSum === "number" ? kopToRub(r.sellSum - r.returnSum) : null,
      };
    }),
  });
}

export const tools: ToolDef[] = [
  {
    name: "get_profit_report",
    description:
      "Get MoySklad profitability by product, bundle and service; variants aggregate into products. Sales, costs and returns shown separately. All accessible organizations unless organization_href is set. Paginated: follow next_offset.",
    schema: getProfitReportSchema,
    handler: handleGetProfitReport,
  },
  {
    name: "get_sales_report",
    description:
      "Product-level gross sales, returns and net totals; variants aggregate into products. Includes services/bundles. Page summary via detail=summary; follow next_offset. For sizes or price distributions use get_sales_by_size/get_sales_by_price; average product price cannot classify individual sales.",
    schema: getSalesReportSchema,
    handler: handleGetSalesReport,
  },
];
