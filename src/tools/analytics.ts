import { z } from "zod";
import { createHash } from "node:crypto";
import { loadSourceLines, type ApiEntity, type SourceLine } from "../analytics-data.js";
import {
  classificationSchema,
  classify,
  categoryIds,
  categorySchema,
  type ClassificationOptions,
} from "../classification.js";
import { assortmentFields, reportPeriodSchema } from "../report-lib.js";
import { outputResult, outputSchema } from "../output.js";
import { decimal, Exact, netUnitPrice, priceRules } from "../precision.js";
import type { ToolDef } from "../types.js";

const period = {
  moment_from: reportPeriodSchema.moment_from.unwrap(),
  moment_to: reportPeriodSchema.moment_to.unwrap(),
  organization_hrefs: z
    .array(z.string().min(1))
    .max(100)
    .optional()
    .describe("Organization meta hrefs; omit for all accessible organizations"),
  refresh_catalog: z
    .boolean()
    .optional()
    .describe("Reload cards and reclassify the shared snapshot without reloading documents or extending source TTL"),
  refresh_source: z
    .boolean()
    .optional()
    .describe("Reload documents/positions and replace the shared five-minute period snapshot"),
};
export const analyticsCommon = {
  ...period,
  ...classificationSchema,
  ...outputSchema,
  detail: outputSchema.detail.describe(
    "Default summary: aggregated rows only. rows/raw: compact position audit plus separate assortment dictionary; not original API documents.",
  ),
  fields: outputSchema.fields.describe(
    "Audit projection: quantity omits money; analysis/default includes size and exact line price; full adds compatibility identifiers. Applies to rows/raw and file audit, not aggregate totals.",
  ),
};
export const sizeReportSchema = z.object({
  ...analyticsCommon,
  size_min: z.number().int().min(1).max(300).default(24),
  size_max: z.number().int().min(1).max(300).default(46),
  size_step: z.number().int().min(1).max(20).default(2),
});

const boundary = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .max(50)
  .describe("Exact decimal rubles as a string; no display rounding");
export const priceBandSchema = z.object({
  id: z.string().min(1).max(80),
  category: categorySchema,
  min: boundary,
  max: boundary,
  include_min: z.boolean(),
  include_max: z.boolean(),
});
export const priceReportSchema = z.object({
  ...analyticsCommon,
  bands: z.array(priceBandSchema).min(1).max(100),
  return_price_basis: z
    .literal("return_document")
    .default("return_document")
    .describe("Returns use their own document's actual price and discount. Original-sale basis is not supported."),
});

export interface Counts {
  sold: number;
  returned: number;
  net: number;
  rows: number;
}
export const emptyCounts = (): Counts => ({ sold: 0, returned: 0, net: 0, rows: 0 });
export function addCount(bucket: Counts, line: SourceLine): void {
  const quantity = decimal(line.position.quantity);
  if (!quantity || quantity.isNegative())
    throw new Error("QUANTITY_UNRESOLVED: missing, negative or non-finite document quantity; report aborted.");
  bucket[line.kind] = new Exact(bucket[line.kind]).plus(quantity).toNumber();
  bucket.net = new Exact(bucket.sold).minus(bucket.returned).toNumber();
  bucket.rows++;
}
function sumCounts(buckets: Counts[]): Counts {
  return buckets.reduce(
    (sum, b) => ({
      sold: new Exact(sum.sold).plus(b.sold).toNumber(),
      returned: new Exact(sum.returned).plus(b.returned).toNumber(),
      net: new Exact(sum.net).plus(b.net).toNumber(),
      rows: sum.rows + b.rows,
    }),
    emptyCounts(),
  );
}
function bucketCount(map: Record<string, Counts>, key: string, line: SourceLine) {
  addCount((map[key] ??= emptyCounts()), line);
}

export function validateBands(bands: z.infer<typeof priceBandSchema>[]): void {
  if (new Set(bands.map((b) => b.id)).size !== bands.length) throw new Error("BAND_ID: ids must be unique.");
  for (const band of bands)
    if (new Exact(band.min).gte(band.max)) throw new Error("BAND_RANGE: min must be less than max.");
  for (let i = 0; i < bands.length; i++)
    for (let j = i + 1; j < bands.length; j++) {
      const a = bands[i],
        b = bands[j];
      if (a.category !== b.category) continue;
      const lower = new Exact(a.min).gt(b.min) ? a.min : b.min;
      const upper = new Exact(a.max).lt(b.max) ? a.max : b.max;
      const equalOverlap = new Exact(lower).eq(upper) && inBand(lower, a) && inBand(lower, b);
      if (new Exact(lower).lt(upper) || equalOverlap)
        throw new Error(
          "BAND_OVERLAP: ranges in one category must not overlap, including shared inclusive boundaries.",
        );
    }
}
export function inBand(value: string, band: z.infer<typeof priceBandSchema>): boolean {
  const price = new Exact(value);
  return (
    (band.include_min ? price.gte(band.min) : price.gt(band.min)) &&
    (band.include_max ? price.lte(band.max) : price.lt(band.max))
  );
}

function lineDetails(line: SourceLine) {
  const enriched: ApiEntity = { ...line.assortment, product: line.product ?? line.assortment.product };
  // A product attribute is a fallback only when the variant has no size characteristic.
  if (!enriched.characteristics?.some((c: { name: string }) => c.name.toLocaleLowerCase() === "размер"))
    enriched.attributes = line.product?.attributes ?? enriched.attributes;
  const fields = assortmentFields(enriched);
  const { product_name: _name, product_type: _type, product_href: _href, ...identity } = fields;
  return {
    document_id: line.document_id,
    document_type: line.document_type,
    moment: line.moment,
    position_id: line.position.id ?? null,
    kind: line.kind,
    quantity: line.position.quantity,
    ...identity,
    parent_product_name: line.product?.name ?? null,
    net_unit_price: netUnitPrice(line.position.price, line.position.discount),
  };
}

const sourceRules = {
  documents: ["demand", "retaildemand", "salesreturn", "retailsalesreturn"],
  applicable: true,
  quantity_basis: "gross sold; returned separate; net = sold - returned (not stock balance)",
  category_basis:
    "explicit group/name/text, ordered path/name/short_description/description/SEO attributes, or supplied product override with evidence; never brand inference",
  completeness: "all document and position pages; inconsistent page totals abort instead of silently truncating",
};

export function aggregateSizes(lines: SourceLine[], params: z.infer<typeof sizeReportSchema>) {
  if (params.size_min > params.size_max) throw new Error("SIZE_RANGE: min must not exceed max.");
  const categories = params.categories ?? [...categoryIds];
  const sizes = Array.from(
    { length: Math.floor((params.size_max - params.size_min) / params.size_step) + 1 },
    (_, i) => params.size_min + i * params.size_step,
  );
  const buckets = new Map(
    sizes.map((size) => [
      size,
      Object.fromEntries(categories.map((c) => [c, emptyCounts()])) as Record<string, Counts>,
    ]),
  );
  const excluded: Record<string, Counts> = {},
    unresolved: Record<string, Counts> = {};
  const outOfScope = emptyCounts();
  const detail: Record<string, unknown>[] = [];
  const classifications = new Map<string, ReturnType<typeof classify>>();
  for (const line of lines) {
    const key = line.parent_product_id ?? `${line.assortment.meta?.type}:${line.assortment.id}`;
    const classification = classifications.get(key) ?? classify(line, params);
    classifications.set(key, classification);
    if (classification.status === "out_of_scope") {
      addCount(outOfScope, line);
      continue;
    }
    const fields = lineDetails(line);
    let status = classification.status,
      reason = classification.reason;
    if (status === "included" && fields.size === null) {
      status = "unresolved";
      reason = "size_unknown";
    } else if (status === "included" && !buckets.has(fields.size!)) {
      status = "excluded";
      reason = "size_outside_range";
    }
    if (status === "included") addCount(buckets.get(fields.size!)![classification.category!], line);
    else bucketCount(status === "unresolved" ? unresolved : excluded, reason!, line);
    detail.push({ ...fields, category: classification.category, evidence: classification.evidence, status, reason });
  }
  const totals = Object.fromEntries(categories.map((c) => [c, sumCounts([...buckets.values()].map((row) => row[c]))]));
  const rows = [...buckets].map(([size, row]) => ({
    size,
    sold: categories.map((c) => row[c].sold),
    returned: categories.map((c) => row[c].returned),
    net: categories.map((c) => row[c].net),
  }));
  return {
    categories,
    rows,
    totals,
    excluded,
    unresolved,
    out_of_scope: outOfScope,
    accounting: {
      included: sumCounts(Object.values(totals)),
      excluded: sumCounts(Object.values(excluded)),
      unresolved: sumCounts(Object.values(unresolved)),
      in_scope: sumCounts([
        sumCounts(Object.values(totals)),
        sumCounts(Object.values(excluded)),
        sumCounts(Object.values(unresolved)),
      ]),
    },
    detail,
  };
}

export function aggregatePrices(lines: SourceLine[], params: z.infer<typeof priceReportSchema>) {
  validateBands(params.bands);
  const categories = params.categories ?? [...new Set(params.bands.map((b) => b.category))];
  const options: ClassificationOptions = { ...params, categories };
  const counts = new Map(params.bands.map((b) => [b.id, emptyCounts()]));
  const outside: Record<string, Counts> = {},
    excluded: Record<string, Counts> = {},
    unresolved: Record<string, Counts> = {};
  const totals = Object.fromEntries(categories.map((c) => [c, emptyCounts()]));
  const detail: Record<string, unknown>[] = [];
  const outOfScope = emptyCounts();
  const classifications = new Map<string, ReturnType<typeof classify>>();
  for (const line of lines) {
    const key = line.parent_product_id ?? `${line.assortment.meta?.type}:${line.assortment.id}`;
    const classification = classifications.get(key) ?? classify(line, options);
    classifications.set(key, classification);
    if (classification.status === "out_of_scope") {
      addCount(outOfScope, line);
      continue;
    }
    const fields = lineDetails(line);
    let status: string = classification.status;
    let reason = classification.reason;
    let bandId: string | null = null;
    if (classification.status !== "included")
      bucketCount(classification.status === "unresolved" ? unresolved : excluded, reason!, line);
    else {
      addCount(totals[classification.category!], line);
      if (fields.net_unit_price === null) {
        status = "unresolved";
        reason = "price_unknown";
        bucketCount(unresolved, `${classification.category}:price_unknown`, line);
      } else {
        const band = params.bands.find(
          (b) => b.category === classification.category && inBand(fields.net_unit_price!, b),
        );
        if (band) {
          bandId = band.id;
          addCount(counts.get(band.id)!, line);
        } else {
          status = "outside";
          reason = "outside_bands";
          bucketCount(outside, classification.category!, line);
        }
      }
    }
    detail.push({
      ...fields,
      category: classification.category,
      evidence: classification.evidence,
      status,
      reason,
      band_id: bandId,
    });
  }
  return {
    rows: params.bands.map((b) => ({ ...b, ...counts.get(b.id)! })),
    totals,
    outside,
    excluded,
    unresolved,
    out_of_scope: outOfScope,
    accounting: {
      banded: sumCounts([...counts.values()]),
      outside: sumCounts(Object.values(outside)),
      unresolved: sumCounts(Object.values(unresolved)),
      excluded: sumCounts(Object.values(excluded)),
      in_scope: sumCounts([
        sumCounts([...counts.values()]),
        sumCounts(Object.values(outside)),
        sumCounts(Object.values(unresolved)),
        sumCounts(Object.values(excluded)),
      ]),
    },
    detail,
  };
}

export async function renderAnalytics(
  params: z.infer<typeof sizeReportSchema> | z.infer<typeof priceReportSchema>,
  kind: "sizes" | "prices",
  source: Awaited<ReturnType<typeof loadSourceLines>>,
) {
  if (source.lineStream) {
    const { renderStreamingAnalytics } = await import("../streaming-analytics.js");
    return renderStreamingAnalytics(params, kind, source);
  }
  const aggregated =
    kind === "sizes"
      ? aggregateSizes(source.lines, params as z.infer<typeof sizeReportSchema>)
      : aggregatePrices(source.lines, params as z.infer<typeof priceReportSchema>);
  const { detail, ...compact } = aggregated;
  const result = {
    period: { from: params.moment_from, to: params.moment_to },
    organizations: params.organization_hrefs?.length ? [...new Set(params.organization_hrefs)] : "all_accessible",
    ...compact,
    total: compact.rows.length,
    returned: compact.rows.length,
    next_offset: null,
    complete: true,
    source: { documents: source.documents, positions: source.lines.length },
    catalog: source.catalog,
    ...(source.snapshot ? { snapshot: source.snapshot } : {}),
    rules: {
      ...sourceRules,
      return_price_basis: "return_document",
      ...(kind === "prices"
        ? priceRules
        : {
            size_basis:
              "explicit Размер characteristic or parent attribute, integer prefix with optional height parentheses; no article/name guessing",
          }),
      policy_hash: createHash("sha256")
        .update(JSON.stringify({ ...params, detail: undefined, output: undefined }))
        .digest("hex")
        .slice(0, 16),
    },
  };
  const dictionary: Record<string, unknown> = {};
  const projected = detail.map((row, index) => {
    const {
      document_id,
      document_type,
      moment,
      position_id,
      kind,
      quantity,
      net_unit_price,
      status,
      reason,
      band_id,
      ...identity
    } = row;
    const key =
      identity.assortment_id === null
        ? `unidentified:${index}`
        : `${identity.assortment_type}:${identity.assortment_id}`;
    dictionary[key] ??=
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
    return {
      document_id,
      document_type,
      moment,
      position_id,
      kind,
      quantity,
      assortment_ref: key,
      status,
      reason,
      ...(band_id === undefined ? {} : { band_id }),
      ...(params.fields === "quantity" ? {} : { net_unit_price }),
    };
  });
  const audit = { ...result, dictionary, detail: projected };
  const value = params.detail === "raw" || params.detail === "rows" ? audit : result;
  // File mode always makes the full audit available without inlining it.
  return outputResult(params.output === "file" ? audit : value, result, params);
}

export async function handleSizeReport(params: z.infer<typeof sizeReportSchema>) {
  return renderAnalytics(params, "sizes", await loadSourceLines({ ...params, limit: 100, offset: 0 }));
}
export async function handlePriceReport(params: z.infer<typeof priceReportSchema>) {
  return renderAnalytics(params, "prices", await loadSourceLines({ ...params, limit: 100, offset: 0 }));
}
export const tools: ToolDef[] = [
  {
    name: "get_sales_by_size",
    description:
      "Aggregate all posted sales/returns by explicit size and sleeve/gender category. Default 24–46 step 2: 12 rows, no documents. Missing categories/sizes are reported, never guessed. net is sales minus returns, not inventory. detail rows/raw provides audit; file provides a readable MCP export.",
    schema: sizeReportSchema,
    handler: handleSizeReport,
  },
  {
    name: "get_sales_by_price",
    description:
      "Aggregate actual line prices after discount into exact non-overlapping RUB bands. Returns use return-document price. No average product prices or rounding before comparison. Summary includes outside/unresolved; file provides full audit.",
    schema: priceReportSchema,
    handler: handlePriceReport,
  },
];
