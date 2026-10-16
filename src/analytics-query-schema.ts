import { z } from "zod";
import { normalizeReportMoment } from "./report-lib.js";

const scalar = z.union([z.string().min(1).max(300), z.number().finite()]);
const stringFilter = (field: string, uuid = false) =>
  z
    .object({
      field: z.literal(field),
      op: z.enum(uuid ? ["eq", "in"] : ["eq", "in", "contains"]),
      value: uuid
        ? z.union([z.string().uuid(), z.array(z.string().uuid()).min(1).max(100)])
        : z.union([scalar, z.array(scalar).min(1).max(100)]),
    })
    .strict();
const filters = z
  .union([
    stringFilter("product.id", true),
    stringFilter("product.article"),
    stringFilter("product.category"),
    stringFilter("product.category_id", true),
    stringFilter("variant.id", true),
    stringFilter("variant.size"),
    stringFilter("order.state_id", true),
    stringFilter("order.channel", true),
    stringFilter("order.delivery.city"),
    stringFilter("order.delivery.region"),
    z
      .object({
        field: z.enum(["order.delivery.city", "order.delivery.region"]),
        op: z.literal("is_set"),
        value: z.boolean(),
      })
      .strict(),
    z
      .object({
        field: z.literal("position.net_unit_price_rub"),
        op: z.enum(["eq", "gte", "lte"]),
        value: z.number().finite().nonnegative().max(1e12),
      })
      .strict(),
  ])
  .superRefine((f, ctx) => {
    if ((f.op === "in") !== Array.isArray(f.value))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "in requires an array; other operators require a scalar." });
  });
export const dimensions = [
  "product",
  "product_id",
  "product.article",
  "variant",
  "variant.size",
  "product.category",
  "order.channel",
  "order.delivery.city",
  "order.delivery.region",
] as const;
export const measures = ["ordered_quantity", "ordered_revenue", "orders_count", "orders_total_rub"] as const;
const localMoment = z.string().refine((v) => {
  try {
    normalizeReportMoment(v);
    return v.includes("T") || v.includes(" ");
  } catch {
    return false;
  }
}, "Use local YYYY-MM-DDTHH:mm:ss[.SSS] with date_range.timezone.");
export const analyticsQuerySchema = z
  .object({
    dataset: z
      .literal("orders")
      .describe("MVP supports customer orders only. Orders are not shipped sales or returns."),
    operation: z
      .enum(["query", "describe"])
      .default("query")
      .describe(
        "describe lists real status IDs and product groups from MoySklad; query calculates the complete period.",
      ),
    date_range: z
      .object({ from: localMoment, to_exclusive: localMoment, timezone: z.string().min(1).max(100) })
      .strict()
      .optional(),
    filters: z
      .array(filters)
      .max(20)
      .default([])
      .describe(
        "AND filters. Category values are actual group/attribute values, not invented canonical category labels. Price is each selected order line after discount in RUB.",
      ),
    dimensions: z.array(z.enum(dimensions)).min(1).max(5).default(["product"]),
    measures: z
      .array(z.enum(measures))
      .min(1)
      .max(3)
      .optional()
      .describe(
        "Defaults to orders_count for delivery geography; legacy product/channel defaults remain ordered_quantity. orders_total_rub sums each whole order exactly once, including delivery; incompatible with product/position filters or dimensions.",
      ),
    order_by: z
      .object({ field: z.enum([...measures, ...dimensions]), direction: z.enum(["asc", "desc"]) })
      .strict()
      .optional()
      .describe("Defaults to the first requested measure, descending."),
    include_missing_city: z
      .boolean()
      .default(false)
      .describe(
        "City rankings exclude blank cities by default and count omissions. Missing regions remain null; never inferred. Use region is_set=true for explicitly provided regions only.",
      ),
    limit: z.number().int().min(1).max(100).default(10),
    offset: z.number().int().min(0).max(10000).default(0),
    include_unposted: z.boolean().default(false),
    include_cancelled: z
      .boolean()
      .default(false)
      .describe(
        "Default excludes the operator-confirmed cancellation status IDs. Explicit order.state_id selection overrides cancellation exclusion, but not include_unposted.",
      ),
    category: z
      .object({
        source: z.enum(["product_folder", "attribute"]).default("product_folder"),
        attribute_id: z.string().uuid().optional(),
        attribute_name: z.string().min(1).max(100).optional(),
      })
      .strict()
      .default({ source: "product_folder" }),
    output: z
      .enum(["inline", "file"])
      .default("inline")
      .describe(
        "Inline aggregates by default. file only if the user explicitly asks for an export of the complete ranking.",
      ),
    refresh_source: z.boolean().default(false),
  })
  .strict();
type ParsedAnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type AnalyticsQuery = Omit<ParsedAnalyticsQuery, "measures" | "order_by"> & {
  measures: NonNullable<ParsedAnalyticsQuery["measures"]>;
  order_by: NonNullable<ParsedAnalyticsQuery["order_by"]>;
};
export function queryGrain(p: AnalyticsQuery): "documents" | "positions" {
  const documents =
    p.dimensions.every((d) => d.startsWith("order.")) &&
    p.measures.every((m) => m === "orders_count" || m === "orders_total_rub") &&
    p.filters.every((f) => f.field.startsWith("order."));
  if (
    !documents &&
    (p.measures.includes("orders_total_rub") ||
      p.dimensions.some((d) => d.startsWith("order.delivery.")) ||
      p.filters.some((f) => f.field.startsWith("order.delivery.")))
  )
    throw new Error("INVALID_ARGUMENT: Document totals/geography cannot be combined with product/position queries.");
  return documents ? "documents" : "positions";
}
export function normalizeAnalyticsQuery(input: unknown): AnalyticsQuery {
  const p = analyticsQuerySchema.parse(input);
  const selected =
    p.measures ??
    (p.dimensions.some((d) => d.startsWith("order.delivery."))
      ? ["orders_count" as const]
      : ["ordered_quantity" as const]);
  const resolved = {
    ...p,
    measures: selected,
    order_by: p.order_by ?? { field: selected[0], direction: "desc" as const },
  };
  if (p.operation === "query") {
    queryGrain(resolved);
    if (
      new Set(p.dimensions).size !== p.dimensions.length ||
      new Set(selected).size !== selected.length ||
      (!selected.includes(resolved.order_by.field as any) && !p.dimensions.includes(resolved.order_by.field as any))
    )
      throw new Error("INVALID_ARGUMENT: Dimensions/measures must be unique and sort field selected.");
  }
  return resolved;
}

function parts(epoch: number, timezone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(epoch))
      .map((p) => [p.type, p.value]),
  );
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}
export function localEpoch(value: string, timezone: string): number {
  const normalized = normalizeReportMoment(value);
  const naive = Date.parse(normalized.replace(" ", "T") + "Z");
  const candidates = new Set<number>();
  for (const shift of [-86400000, 0, 86400000]) {
    const probe = naive + shift;
    const offset = Date.parse(parts(probe, timezone).replace(" ", "T") + "Z") - Math.floor(probe / 1000) * 1000;
    const candidate = naive - offset;
    if (parts(candidate, timezone) === normalized.slice(0, 19)) candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new Error("INVALID_ARGUMENT: Ambiguous or nonexistent local time.");
  return [...candidates][0];
}
export function queryPeriod(p: Pick<AnalyticsQuery, "date_range">) {
  try {
    if (!p.date_range) throw new Error();
    const from = localEpoch(p.date_range.from, p.date_range.timezone),
      to = localEpoch(p.date_range.to_exclusive, p.date_range.timezone);
    if (to <= from || to - from > 366 * 86400000) throw new Error();
    const apiTimezone = process.env.MOYSKLAD_REPORT_TIMEZONE ?? "Europe/Moscow";
    // The source API has no offset in moment. Reject ambiguous boundaries in its accounting timezone.
    const apiFrom = parts(from, apiTimezone) + "." + String(from % 1000).padStart(3, "0");
    const apiTo = parts(to, apiTimezone) + "." + String(to % 1000).padStart(3, "0");
    if (localEpoch(apiFrom, apiTimezone) !== from || localEpoch(apiTo, apiTimezone) !== to) throw new Error();
    return { from, to, apiFrom, apiTo, apiTimezone };
  } catch {
    throw new Error(
      "INVALID_ARGUMENT: Explicit valid timezone and an unambiguous interval of at most 366 days are required.",
    );
  }
}
