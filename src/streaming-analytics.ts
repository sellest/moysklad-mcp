import { createHash } from "node:crypto";
import { aggregateSizes, aggregatePrices, type sizeReportSchema, type priceReportSchema } from "./tools/analytics.js";
import type { LoadedSource } from "./analytics-data.js";
import type { z } from "zod";
import { Exact } from "./precision.js";
import { reportProgress } from "./report-context.js";
import { finishInline, responseWriter } from "./inline-response.js";
type Params = z.infer<typeof sizeReportSchema> | z.infer<typeof priceReportSchema>;
function mergeCounts(target: any, value: any) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("sold" in value && "returned" in value && "net" in value && "rows" in value) {
      for (const key of ["sold", "returned", "net", "rows"])
        target[key] = new Exact(target[key] ?? 0).plus(value[key]).toNumber();
    } else
      for (const [key, item] of Object.entries(value)) {
        target[key] ??= {};
        mergeCounts(target[key], item);
      }
  }
}
export async function renderStreamingAnalytics(params: Params, kind: "sizes" | "prices", source: LoadedSource) {
  const aggregate = (lines: any[]) =>
    kind === "sizes"
      ? aggregateSizes(lines, params as z.infer<typeof sizeReportSchema>)
      : aggregatePrices(lines, params as z.infer<typeof priceReportSchema>);
  const result: any = aggregate([]);
  delete result.detail;
  const writer = await responseWriter(params.output === "file");
  const dictionaryKeys = new Set<string>();
  let batch: any[] = [];
  let anonymous = 0;
  async function flush() {
    if (!batch.length) return;
    const part = aggregate(batch);
    batch = [];
    for (const field of ["totals", "excluded", "unresolved", "outside", "out_of_scope", "accounting"])
      if ((part as any)[field]) {
        result[field] ??= {};
        mergeCounts(result[field], (part as any)[field]);
      }
    part.rows.forEach((row: any, index: number) => {
      if (kind === "sizes")
        for (const field of ["sold", "returned", "net"])
          row[field].forEach((n: number, i: number) => {
            result.rows[index][field][i] = new Exact(result.rows[index][field][i]).plus(n).toNumber();
          });
      else
        for (const key of ["sold", "returned", "net", "rows"])
          result.rows[index][key] = new Exact(result.rows[index][key]).plus(row[key]).toNumber();
    });
    const details: unknown[] = [],
      dictionary: unknown[] = [];
    for (const row of part.detail) {
      const {
        document_id,
        document_type,
        moment,
        position_id,
        kind: rowKind,
        quantity,
        net_unit_price,
        status,
        reason,
        band_id,
        ...identity
      } = row;
      const key =
        identity.assortment_id === null
          ? `unidentified:${anonymous++}`
          : `${identity.assortment_type}:${identity.assortment_id}`;
      if (!dictionaryKeys.has(key)) {
        dictionaryKeys.add(key);
        if (dictionaryKeys.size > 50000) throw new Error("STORAGE_LIMIT: Catalog cardinality budget exceeded.");
        const value =
          params.fields === "full"
            ? identity
            : {
                id: identity.assortment_id,
                type: identity.assortment_type,
                name: identity.assortment_name,
                parent_product_id: identity.parent_product_id,
                size: identity.size,
                size_raw: identity.size_raw,
                category: identity.category,
                evidence: identity.evidence,
                ...(params.fields === "quantity" ? {} : { characteristics: identity.characteristics }),
              };
        dictionary.push({ key, value });
      }
      details.push({
        document_id,
        document_type,
        moment,
        position_id,
        kind: rowKind,
        quantity,
        assortment_ref: key,
        status,
        reason,
        ...(band_id === undefined ? {} : { band_id }),
        ...(params.fields === "quantity" ? {} : { net_unit_price }),
      });
    }
    await writer.append("detail", details);
    await writer.append("dictionary", dictionary);
  }
  for await (const line of source.lineStream!) {
    batch.push(line);
    if (batch.length >= 100) await flush();
  }
  await flush();
  const summary = {
    period: { from: params.moment_from, to: params.moment_to },
    organizations: params.organization_hrefs?.length ? params.organization_hrefs : "all_accessible",
    ...result,
    total: result.rows.length,
    returned: result.rows.length,
    next_offset: null,
    complete: true,
    source: { documents: source.documents, positions: source.position_count, completeness: source.completeness },
    catalog: source.catalog,
    snapshot: source.snapshot,
    source_passport: {
      ...source.passport,
      report_basis: "posted_document_positions",
      source_kind: "documents",
      document_types: ["demand", "retaildemand", "salesreturn", "retailsalesreturn"],
      applicable: true,
      timezone: "upstream_account_timezone_no_conversion",
      currency: "RUB",
      quantity_unit: "upstream_quantity",
      return_date_basis: "return_document",
      catalog_basis: "frozen_cards_shared_by_snapshot",
      rules_version: 1,
      snapshot_id: source.snapshot?.id,
    },
    rules: {
      return_price_basis: "return_document",
      policy_hash: createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16),
    },
  };
  await reportProgress("export");
  await writer.append("detail", []);
  await writer.append("dictionary", []);
  await writer.append("rows", summary.rows);
  const { rows: _rows, ...metadata } = summary;
  if (params.output !== "file") return finishInline(writer, metadata);
  return JSON.stringify({
    ...summary,
    export: await writer.finish(metadata, source.snapshot?.id, source.snapshot?.captured_at),
  });
}
