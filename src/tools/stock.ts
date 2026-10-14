import { z } from "zod";
import { moyskladGet } from "../client.js";
import { json, kopToRub } from "../lib.js";
import { assortmentFields, normalizeReportMoment } from "../report-lib.js";
import { pageInfo, outputSchema, outputResult } from "../output.js";
import type { ToolDef } from "../types.js";
import { reportProgress } from "../report-context.js";

const STOCK_WEIGHT = 5;
const entityHref = (type: string) =>
  z.string().regex(new RegExp(`^https://api\\.moysklad\\.ru/api/remap/1\\.2/entity/${type}/[a-f0-9-]{36}$`, "i"));
const common = {
  search: z
    .string()
    .max(255)
    .refine((s) => !s.includes(";"), "Search must not contain a filter separator")
    .optional()
    .describe("Search by product/variant name"),
  limit: z.number().int().min(1).max(1000).default(25).describe("Page size; follow next_offset to read all items"),
  offset: z.number().int().min(0).default(0),
  group_by: z
    .enum(["product", "variant", "consignment"])
    .optional()
    .describe(
      "Default variant: separate products and modifications. product hides size detail; consignment also includes batches. Never sum parent and variant rows as a model total.",
    ),
  stock_mode: z
    .enum(["all", "positiveOnly", "negativeOnly", "empty", "nonEmpty", "underMinimum"])
    .optional()
    .describe("Default all, including zero stock. empty selects zero physical stock, not zero free stock."),
  store_href: entityHref("store").optional().describe("Limit report to this warehouse meta href"),
  product_href: entityHref("product")
    .optional()
    .describe("Filter by a parent product; cannot combine with search or variant_href"),
  variant_href: entityHref("variant")
    .optional()
    .describe("Filter by one modification; cannot combine with search or product_href"),
};
export const getStockSchema = z.object(common);
export const getStockByStoreSchema = z.object(common);
export const getStockAtDateSchema = z.object({
  ...common,
  output: outputSchema.output,
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe(
      "Completed calendar day YYYY-MM-DD. Physical stock at 23:59:59.999 in the configured API report timezone (default Europe/Moscow). For today use get_stock.",
    ),
  by_store: z
    .boolean()
    .optional()
    .describe(
      "Default false: combined warehouse balance. true: separate physical balances per warehouse. store_href restricts either mode to one warehouse.",
    ),
});
type Params = z.infer<typeof getStockSchema>;
type HistoricalParams = z.infer<typeof getStockAtDateSchema>;
type AsOf = { date: string; moment: string; timezone: string };

export function historicalStockMoment(date: string, now = new Date()): AsOf {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("INVALID_ARGUMENT: date must be YYYY-MM-DD.");
  let moment: string;
  try {
    moment = normalizeReportMoment(date, true);
  } catch {
    throw new Error("INVALID_ARGUMENT: invalid calendar date.");
  }
  const timezone = process.env.MOYSKLAD_REPORT_TIMEZONE ?? "Europe/Moscow";
  // Must match the timezone of the API's naive report timestamps.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  if (date >= today)
    throw new Error("INVALID_ARGUMENT: date must be a completed day; use get_stock for current stock.");
  return { date, moment, timezone };
}
type Row = Record<string, any>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function query(p: Params, byStore: boolean, asOf?: AsOf) {
  if ([p.search, p.product_href, p.variant_href].filter(Boolean).length > 1)
    throw new Error("STOCK_FILTER: choose only one of search, product_href, variant_href.");
  const filter = [`stockMode=${p.stock_mode ?? "all"}`];
  if (!byStore) filter.push("quantityMode=all");
  if (asOf) filter.push(`moment=${asOf.moment}`);
  if (asOf && !byStore) filter.push("archived=true", "archived=false");
  for (const [key, value] of [
    ["search", p.search],
    ["store", p.store_href],
    ["product", p.product_href],
    ["variant", p.variant_href],
  ])
    if (value) filter.push(`${key}=${value}`);
  return new URLSearchParams({
    limit: String(p.limit),
    offset: String(p.offset),
    groupBy: p.group_by ?? "variant",
    filter: filter.join(";"),
  });
}

/** Enrich only this page, in bounded batches; no requests to arbitrary response hrefs. */
async function catalog(rows: Row[], includeArchived = false) {
  const cards = new Map<string, Row>();
  for (const type of ["product", "variant", "consignment"]) {
    const ids = [
      ...new Set(
        rows
          .filter((r) => r.meta?.type === type)
          .map(
            (r) =>
              String(r.meta?.href ?? "")
                .split("?")[0]
                .split("/")
                .pop()!,
          )
          .filter((id) => /^[a-f0-9-]{36}$/i.test(id)),
      ),
    ];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const q = new URLSearchParams({ filter: batch.map((id) => `id=${id}`).join(";"), limit: "20" });
      if (includeArchived && type !== "consignment") q.set("filter", q.get("filter") + ";archived=true;archived=false");
      if (type === "variant") q.set("expand", "product");
      if (type === "consignment") q.set("expand", "assortment,assortment.product");
      const data = (await moyskladGet(`/entity/${type}?${q}`)) as { rows?: Row[]; meta?: { size?: number } };
      if (!Array.isArray(data.rows) || data.meta?.size !== data.rows.length || data.rows.length > batch.length)
        throw new Error("INCOMPLETE_PAGE: Stock catalog batch is incomplete.");
      for (const card of data.rows) {
        const key = `${type}:${card.id}`;
        if (!batch.includes(card.id) || card.meta?.type !== type || cards.has(key))
          throw new Error("INCOMPLETE_PAGE: Stock catalog identity mismatch.");
        cards.set(key, card);
      }
    }
  }
  return cards;
}

function amounts(s: Row) {
  const stock = num(s.stock),
    reserve = num(s.reserve),
    inTransit = num(s.inTransit);
  const free = stock !== null && reserve !== null ? stock - reserve : null;
  return {
    stock,
    reserve,
    inTransit,
    free_stock: free,
    quantity: num(s.quantity) ?? (free !== null && inTransit !== null ? free + inTransit : null),
  };
}

/** Native bystore omits archived assortment. Build historical warehouse balances
 * from archive-inclusive stock/all, batching the selected page's identities. */
async function historicalWarehouses(rows: Row[], p: Params, asOf: AsOf) {
  if (!rows.length) return;
  const root = "https://api.moysklad.ru/api/remap/1.2/entity/";
  const stores: Row[] = [];
  if (p.store_href) {
    stores.push((await moyskladGet("/entity/store/" + p.store_href.split("/").pop())) as Row);
  } else {
    for (let offset = 0; ; ) {
      const q = new URLSearchParams({ limit: "1000", offset: String(offset), filter: "archived=true;archived=false" });
      const data = (await moyskladGet("/entity/store?" + q)) as { rows: Row[]; meta: { size: number } };
      if (
        !Array.isArray(data.rows) ||
        !Number.isInteger(data.meta?.size) ||
        data.meta.size > 1000 ||
        (!data.rows.length && offset < data.meta.size)
      )
        throw new Error("INCOMPLETE_PAGE: Warehouse list incomplete or exceeds budget.");
      stores.push(...data.rows);
      offset += data.rows.length;
      if (offset >= data.meta.size) break;
    }
  }
  const storeIds = new Set<string>();
  for (const store of stores) {
    if (!/^[a-f0-9-]{36}$/i.test(store.id) || storeIds.has(store.id))
      throw new Error("INCOMPLETE_PAGE: Warehouse identity invalid.");
    storeIds.add(store.id);
  }
  const refs = rows.map((row) => {
    const identity = assortmentFields(row);
    if (
      !["product", "variant", "consignment"].includes(identity.assortment_type ?? "") ||
      !/^[a-f0-9-]{36}$/i.test(identity.assortment_id ?? "")
    )
      throw new Error("INCOMPLETE_PAGE: Historical stock identity unavailable.");
    return { type: identity.assortment_type!, id: identity.assortment_id! };
  });
  rows.forEach((row) => {
    row.stockByStore = [];
  });
  await reportProgress("historical_warehouses", { expected_warehouse_balances: stores.length * rows.length });
  for (const store of stores) {
    const values = new Map<string, number | null>();
    for (let batchOffset = 0; batchOffset < refs.length; batchOffset += 20) {
      const batch = refs.slice(batchOffset, batchOffset + 20);
      const q = query(
        {
          ...p,
          search: undefined,
          product_href: undefined,
          variant_href: undefined,
          store_href: root + "store/" + store.id,
          stock_mode: "all",
          limit: 1000,
          offset: 0,
        },
        false,
        asOf,
      );
      q.set("filter", q.get("filter") + ";" + batch.map((ref) => `${ref.type}=${root}${ref.type}/${ref.id}`).join(";"));
      const seen = new Set<string>();
      for (let offset = 0; ; ) {
        q.set("offset", String(offset));
        const data = (await moyskladGet("/report/stock/all?" + q, STOCK_WEIGHT)) as {
          rows: Row[];
          meta: { size: number };
        };
        if (
          !Array.isArray(data.rows) ||
          !Number.isInteger(data.meta?.size) ||
          data.meta.size > 5000 ||
          (!data.rows.length && offset < data.meta.size)
        )
          throw new Error("INCOMPLETE_PAGE: Warehouse stock page incomplete or exceeds budget.");
        for (const row of data.rows) {
          const identity = assortmentFields(row),
            key = `${identity.assortment_type}:${identity.assortment_id}`;
          if (seen.has(key)) throw new Error("INCOMPLETE_PAGE: Duplicate warehouse stock identity.");
          seen.add(key);
          if (batch.some((ref) => ref.type === identity.assortment_type && ref.id === identity.assortment_id))
            values.set(key, num(row.stock));
        }
        offset += data.rows.length;
        if (offset >= data.meta.size) break;
      }
    }
    rows.forEach((row, i) => {
      const key = `${refs[i].type}:${refs[i].id}`;
      row.stockByStore.push({
        meta: { href: root + "store/" + store.id },
        name: store.name ?? null,
        stock: values.get(key) ?? null,
        stock_status: values.has(key) ? "reported" : "not_returned",
      });
    });
    await reportProgress("historical_warehouses", { processed_warehouse_balances: rows.length });
  }
}

async function report(p: Params, byStore: boolean, asOf?: AsOf) {
  const raw = (await moyskladGet(
    `/report/stock/${byStore && !asOf ? "bystore" : "all"}?${query(p, byStore && !asOf, asOf)}`,
    STOCK_WEIGHT,
  )) as { meta?: { size?: number }; rows?: Row[] };
  if (!Array.isArray(raw.rows)) throw new Error("INCOMPLETE_PAGE: Stock rows missing.");
  if (byStore && asOf) await historicalWarehouses(raw.rows, p, asOf);
  const cards = await catalog(raw.rows, !!asOf);
  const items = raw.rows.map((s) => {
    const ref = assortmentFields(s);
    const card = cards.get(`${ref.assortment_type}:${ref.assortment_id}`);
    const entity = card ?? s;
    const base = entity.meta?.type === "consignment" ? (entity.assortment ?? entity) : entity;
    const identity = assortmentFields(base);
    return {
      ...ref,
      parent_product_id: identity.parent_product_id,
      parent_product_href: identity.parent_product_href,
      size: identity.size,
      size_raw: identity.size_raw,
      characteristics: identity.characteristics,
      name: s.name ?? card?.name ?? null,
      article: base.product?.article ?? base.article ?? s.article ?? null,
      code: s.code ?? card?.code ?? null,
      catalog_status: card ? "resolved" : "unavailable",
      ...(byStore
        ? {
            by_store: (s.stockByStore ?? []).map((b: Row) => ({
              store: b.name ?? null,
              store_id: b.meta?.href?.split("?")[0].split("/").pop() ?? null,
              store_href: b.meta?.href ?? null,
              ...(asOf
                ? { stock: num(b.stock), stock_status: b.stock_status }
                : { ...amounts(b), in_transit: num(b.inTransit) }),
            })),
          }
        : asOf
          ? { stock: num(s.stock) }
          : { ...amounts(s), sale_price_rubles: kopToRub(s.salePrice) }),
    };
  });
  const result = {
    ...pageInfo(raw.meta?.size, items.length, p.offset, p.limit),
    group_by: p.group_by ?? "variant",
    stock_mode: p.stock_mode ?? "all",
    store_href: p.store_href ?? null,
    ...(asOf
      ? {
          date: asOf.date,
          as_of: asOf.moment,
          timezone: asOf.timezone,
          by_store: byStore,
          retrieved_at: new Date().toISOString(),
          catalog_as_of: "current",
          source: "moysklad_stock_report",
        }
      : {}),
    rules: {
      stock: "physical on hand",
      ...(asOf
        ? {
            history:
              "End-of-day physical stock recalculated by MoySklad from currently accessible documents; backdated edits can change it. Catalog names, articles, sizes and warehouse labels are current, not historical. Reserves, transit, availability and prices are deliberately omitted. Paginated API reads are not a transactional frozen snapshot.",
          }
        : { free_stock: "stock minus reserve", quantity: "stock minus reserve plus inTransit" }),
      missing:
        "Unknown fields are null. An absent row is not proof of zero. Follow next_offset; do not double-count parent products and variants.",
    },
    items,
  };
  const { items: _items, ...summary } = result;
  return asOf ? outputResult(result, summary, p as HistoricalParams) : json(result);
}
export const handleGetStock = (p: Params) => report(p, false);
export const handleGetStockByStore = (p: Params) => report(p, true);
export const handleGetStockAtDate = (p: HistoricalParams) =>
  report(p, p.by_store ?? false, historicalStockMoment(p.date));
export const tools: ToolDef[] = [
  {
    name: "get_stock",
    description:
      "Current stock only; for a past date use get_stock_at_date. Stock by article and explicit size, with assortment/parent IDs for joining sales. Default variant grouping and all stock/quantity levels includes zeros. Physical stock, reserve, free_stock and quantity differ. Unknown size is null, never inferred. Follow next_offset; this is a page, not the entire catalog.",
    schema: getStockSchema,
    handler: handleGetStock,
  },
  {
    name: "get_stock_at_date",
    description:
      "Исторические физические остатки на конец завершённого дня: например, склад на 14 сентября для сравнения дат. date=YYYY-MM-DD; uses API moment filter at 23:59:59.999, never reconstructs from sales. Default group_by=variant preserves article/size IDs; by_store=true separates warehouses, store_href selects one. Includes zero levels; follow next_offset until null. stock is historical; catalog labels/sizes are current and may be unavailable. Reserves/prices are omitted. Backdated document edits and API visibility/recalculation affect results. Today/future days are rejected: use get_stock for current stock. Do not sum parent and variant rows together.",
    schema: getStockAtDateSchema,
    handler: handleGetStockAtDate,
  },
  {
    name: "get_stock_by_store",
    description:
      "Current stock by warehouse, article and explicit modification size, with IDs and reserves. Default variant grouping and stock_mode=all includes zero rows. free_stock excludes reserve; quantity includes in-transit. Follow next_offset. Missing rows/fields must not be treated as zero.",
    schema: getStockByStoreSchema,
    handler: handleGetStockByStore,
  },
];
