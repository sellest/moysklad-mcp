import { z } from "zod";
import { fetchAllPages, loadSourceLines, type SourceLine } from "../analytics-data.js";
import { buildFilter } from "../lib.js";
import { reportPeriodSchema, reportQuery } from "../report-lib.js";
import { Exact, netUnitPrice } from "../precision.js";
import { addCount, emptyCounts } from "./analytics.js";
import type { ToolDef } from "../types.js";

export const reconciliationSchema = z.object({
  moment_from: reportPeriodSchema.moment_from.unwrap(),
  moment_to: reportPeriodSchema.moment_to.unwrap(),
  organization_hrefs: z.array(z.string()).optional(),
  refresh_catalog: z.boolean().optional(),
  refresh_source: z.boolean().optional(),
  compare_money: z.boolean().default(false),
  money_tolerance_rubles: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .max(50)
    .default("0.011"),
  example_limit: z.number().int().min(0).max(10).default(3),
});

type ProductTotal = {
  sold: number;
  returned: number;
  net: number;
  rows: number;
  sell_sum: string;
  return_sum: string;
  unknown_prices: number;
};
const empty = (): ProductTotal => ({ ...emptyCounts(), sell_sum: "0", return_sum: "0", unknown_prices: 0 });
export function documentProductTotals(lines: SourceLine[]): Map<string, ProductTotal> {
  const totals = new Map<string, ProductTotal>();
  for (const line of lines) {
    const id = line.parent_product_id ?? line.assortment.id ?? line.assortment.meta?.href?.split("/").pop();
    if (!id) throw new Error("ASSORTMENT_ID: cannot reconcile an unidentified position.");
    const total = totals.get(id) ?? empty();
    addCount(total, line);
    const price = netUnitPrice(line.position.price, line.position.discount);
    if (price === null) total.unknown_prices++;
    else {
      const field = line.kind === "sold" ? "sell_sum" : "return_sum";
      total[field] = new Exact(total[field]).plus(new Exact(price).mul(String(line.position.quantity))).toFixed();
    }
    totals.set(id, total);
  }
  return totals;
}

export async function handleReconciliation(params: z.infer<typeof reconciliationSchema>) {
  const source = await loadSourceLines({ ...params, limit: 100, offset: 0 });
  const actual = documentProductTotals(source.lines);
  const expected = new Map<string, ProductTotal>();
  for (const organization of params.organization_hrefs?.length
    ? [...new Set(params.organization_hrefs)]
    : [undefined]) {
    const query = new URLSearchParams(reportQuery({ ...params, limit: 1000, offset: 0 }));
    query.delete("limit");
    query.delete("offset");
    const filter = buildFilter([["organization", organization ?? ""]]);
    const rows = await fetchAllPages(`/report/profit/byproduct?${query}`, { filter });
    for (const row of rows) {
      const id = row.assortment?.id ?? row.assortment?.meta?.href?.split("/").pop();
      if (!id) throw new Error("REPORT_ID: unidentified profitability row.");
      const total = expected.get(id) ?? empty();
      total.sold = new Exact(total.sold).plus(row.sellQuantity).toNumber();
      total.returned = new Exact(total.returned).plus(row.returnQuantity).toNumber();
      total.net = new Exact(total.sold).minus(total.returned).toNumber();
      total.sell_sum = new Exact(total.sell_sum).plus(new Exact(row.sellSum).div(100)).toFixed();
      total.return_sum = new Exact(total.return_sum).plus(new Exact(row.returnSum).div(100)).toFixed();
      expected.set(id, total);
    }
  }
  let mismatches = 0;
  const examples: object[] = [];
  for (const id of new Set([...actual.keys(), ...expected.keys()])) {
    const a = actual.get(id) ?? empty(),
      b = expected.get(id) ?? empty();
    const quantityDiff = a.sold !== b.sold || a.returned !== b.returned;
    const moneyDiff =
      params.compare_money &&
      (a.unknown_prices > 0 ||
        new Exact(a.sell_sum).minus(b.sell_sum).abs().gt(params.money_tolerance_rubles) ||
        new Exact(a.return_sum).minus(b.return_sum).abs().gt(params.money_tolerance_rubles));
    if (quantityDiff || moneyDiff) {
      mismatches++;
      if (examples.length < params.example_limit)
        examples.push({
          product_id: id,
          document: { sold: a.sold, returned: a.returned },
          report: { sold: b.sold, returned: b.returned },
          quantity_mismatch: quantityDiff,
          money_mismatch: moneyDiff,
        });
    }
  }
  const sum = (map: Map<string, ProductTotal>, field: "sold" | "returned") =>
    [...map.values()].reduce((total, row) => new Exact(total).plus(row[field]).toNumber(), 0);
  return JSON.stringify({
    complete: true,
    compared_products: new Set([...actual.keys(), ...expected.keys()]).size,
    mismatches,
    examples,
    totals: {
      documents: { sold: sum(actual, "sold"), returned: sum(actual, "returned") },
      report: { sold: sum(expected, "sold"), returned: sum(expected, "returned") },
    },
    rules: {
      posted_documents_only: true,
      compare_money: params.compare_money,
      money_tolerance_rubles: params.money_tolerance_rubles,
      return_price_basis: "return_document",
    },
    source: source.documents,
    catalog: source.catalog,
    ...(source.snapshot ? { snapshot: source.snapshot } : {}),
  });
}
export const tools: ToolDef[] = [
  {
    name: "reconcile_sales",
    description:
      "Compare posted line quantities with fresh product profitability. Totals, discrepancy count and at most 10 examples; never two full arrays. Optional decimal monetary comparison uses return-document prices.",
    schema: reconciliationSchema,
    handler: handleReconciliation,
  },
];
