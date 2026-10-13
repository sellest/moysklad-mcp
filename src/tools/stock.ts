import { z } from "zod";
import { moyskladGet } from "../client.js";
import { json, kopToRub } from "../lib.js";
import { assortmentFields } from "../report-lib.js";
import { pageInfo } from "../output.js";
import type { ToolDef } from "../types.js";

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
type Params = z.infer<typeof getStockSchema>;
type Row = Record<string, any>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function query(p: Params, byStore: boolean) {
  if ([p.search, p.product_href, p.variant_href].filter(Boolean).length > 1)
    throw new Error("STOCK_FILTER: choose only one of search, product_href, variant_href.");
  const filter = [`stockMode=${p.stock_mode ?? "all"}`];
  if (!byStore) filter.push("quantityMode=all");
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
async function catalog(rows: Row[]) {
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

async function report(p: Params, byStore: boolean) {
  const raw = (await moyskladGet(
    `/report/stock/${byStore ? "bystore" : "all"}?${query(p, byStore)}`,
    STOCK_WEIGHT,
  )) as { meta?: { size?: number }; rows?: Row[] };
  if (!Array.isArray(raw.rows)) throw new Error("INCOMPLETE_PAGE: Stock rows missing.");
  const cards = await catalog(raw.rows);
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
              ...amounts(b),
              in_transit: num(b.inTransit),
            })),
          }
        : { ...amounts(s), sale_price_rubles: kopToRub(s.salePrice) }),
    };
  });
  return json({
    ...pageInfo(raw.meta?.size, items.length, p.offset, p.limit),
    group_by: p.group_by ?? "variant",
    stock_mode: p.stock_mode ?? "all",
    store_href: p.store_href ?? null,
    rules: {
      stock: "physical on hand",
      free_stock: "stock minus reserve",
      quantity: "stock minus reserve plus inTransit",
      missing:
        "Unknown fields are null. An absent row is not proof of zero. Follow next_offset; do not double-count parent products and variants.",
    },
    items,
  });
}
export const handleGetStock = (p: Params) => report(p, false);
export const handleGetStockByStore = (p: Params) => report(p, true);
export const tools: ToolDef[] = [
  {
    name: "get_stock",
    description:
      "Current stock by article and explicit size, with assortment/parent IDs for joining sales. Default variant grouping and all stock/quantity levels includes zeros. Physical stock, reserve, free_stock and quantity differ. Unknown size is null, never inferred. Follow next_offset; this is a page, not the entire catalog.",
    schema: getStockSchema,
    handler: handleGetStock,
  },
  {
    name: "get_stock_by_store",
    description:
      "Current stock by warehouse, article and explicit modification size, with IDs and reserves. Default variant grouping and stock_mode=all includes zero rows. free_stock excludes reserve; quantity includes in-transit. Follow next_offset. Missing rows/fields must not be treated as zero.",
    schema: getStockByStoreSchema,
    handler: handleGetStockByStore,
  },
];
