import { z } from "zod";
import { moyskladGet, moyskladPost } from "../client.js";
import { formatList, getDefaultPriceTypeHref, json, kopToRub, listQuery, meta, rubToKop } from "../lib.js";
import type { ToolDef } from "../types.js";
import { compactAssortment, projectAssortment } from "../report-lib.js";
import { outputResult, outputSchema, pageInfo } from "../output.js";

const listParams = {
  ...outputSchema,
  characteristic_names: z.array(z.string()).max(20).optional().describe("Selected characteristics; default: Размер"),
  search: z.string().optional().describe("Search query"),
  limit: z.number().int().min(1).max(1000).default(25).describe("Number of results"),
  offset: z.number().int().default(0).describe("Offset for pagination"),
};

function firstSalePriceRubles(row: Record<string, unknown>): number | null {
  const sp = (row.salePrices as Array<{ value?: unknown }>) || [];
  return sp.length ? kopToRub(sp[0]?.value) : null;
}
function projectCatalog(
  row: Record<string, unknown>,
  p: { fields?: "quantity" | "analysis" | "full"; characteristic_names?: string[] },
) {
  if (p.fields === "full")
    return {
      id: row.id,
      name: row.name,
      article: row.article,
      code: row.code,
      sale_price_rubles: firstSalePriceRubles(row),
      meta_href: (row.meta as { href?: string } | undefined)?.href,
      ...compactAssortment(row, p.characteristic_names),
    };
  return {
    ...projectAssortment(row, p.fields, p.characteristic_names),
    ...(p.fields === "quantity" ? {} : { sale_price_rubles: firstSalePriceRubles(row) }),
  };
}

// --- search_assortment (unified product/variant/service/bundle search) ---
export const searchAssortmentSchema = z.object(listParams);
export async function handleSearchAssortment(p: z.infer<typeof searchAssortmentSchema>): Promise<string> {
  const qs = listQuery({ search: p.search, limit: p.limit, offset: p.offset });
  const result = await moyskladGet(`/entity/assortment?${qs}`);
  const compact = JSON.parse(formatList(result, "assortment", (row) => projectCatalog(row, p)));
  const data = result as { meta?: { size?: number }; rows?: unknown[] };
  const summary = pageInfo(data.meta?.size, data.rows?.length ?? 0, p.offset, p.limit);
  return outputResult(
    p.detail === "raw" ? result : p.detail === "summary" && p.output !== "file" ? summary : { ...compact, ...summary },
    summary,
    p,
  );
}

// --- list_price_types ---
export const listPriceTypesSchema = z.object({});
export async function handleListPriceTypes(): Promise<string> {
  const data = await moyskladGet("/context/companysettings/pricetype");
  const list: unknown[] = Array.isArray(data) ? data : ((data as { rows?: unknown[] })?.rows ?? []);
  return json({
    total: list.length,
    price_types: list.map((row, i) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        name: r.name,
        is_default: i === 0,
        meta_href: (r.meta as { href?: string } | undefined)?.href,
      };
    }),
  });
}

// --- search_variants ---
export const searchVariantsSchema = z.object(listParams);
export async function handleSearchVariants(p: z.infer<typeof searchVariantsSchema>): Promise<string> {
  const qs = listQuery({ search: p.search, limit: p.limit, offset: p.offset });
  const result = await moyskladGet(`/entity/variant?${qs}`);
  const compact = JSON.parse(formatList(result, "variants", (row) => projectCatalog(row, p)));
  const data = result as { meta?: { size?: number }; rows?: unknown[] };
  const summary = pageInfo(data.meta?.size, data.rows?.length ?? 0, p.offset, p.limit);
  return outputResult(
    p.detail === "raw" ? result : p.detail === "summary" && p.output !== "file" ? summary : { ...compact, ...summary },
    summary,
    p,
  );
}

// --- search_bundles ---
export const searchBundlesSchema = z.object(listParams);
export async function handleSearchBundles(p: z.infer<typeof searchBundlesSchema>): Promise<string> {
  const qs = listQuery({ search: p.search, limit: p.limit, offset: p.offset });
  const result = await moyskladGet(`/entity/bundle?${qs}`);
  const compact = JSON.parse(formatList(result, "bundles", (row) => projectCatalog(row, p)));
  const data = result as { meta?: { size?: number }; rows?: unknown[] };
  const summary = pageInfo(data.meta?.size, data.rows?.length ?? 0, p.offset, p.limit);
  return outputResult(
    p.detail === "raw" ? result : p.detail === "summary" && p.output !== "file" ? summary : { ...compact, ...summary },
    summary,
    p,
  );
}

// --- search_services ---
export const searchServicesSchema = z.object(listParams);
export async function handleSearchServices(p: z.infer<typeof searchServicesSchema>): Promise<string> {
  const qs = listQuery({ search: p.search, limit: p.limit, offset: p.offset });
  const result = await moyskladGet(`/entity/service?${qs}`);
  const compact = JSON.parse(formatList(result, "services", (row) => projectCatalog(row, p)));
  const data = result as { meta?: { size?: number }; rows?: unknown[] };
  const summary = pageInfo(data.meta?.size, data.rows?.length ?? 0, p.offset, p.limit);
  return outputResult(
    p.detail === "raw" ? result : p.detail === "summary" && p.output !== "file" ? summary : { ...compact, ...summary },
    summary,
    p,
  );
}

// --- create_service ---
export const createServiceSchema = z.object({
  name: z.string().describe("Service name"),
  description: z.string().optional().describe("Description"),
  code: z.string().optional().describe("Code"),
  sale_price_rubles: z.number().optional().describe("Sale price in RUBLES"),
  price_type_href: z
    .string()
    .optional()
    .describe("Price type meta href (defaults to the account default). Get from list_price_types."),
  vat: z.number().optional().describe("VAT rate: 0, 10, 20"),
});
export async function handleCreateService(p: z.infer<typeof createServiceSchema>): Promise<string> {
  const body: Record<string, unknown> = { name: p.name };
  if (p.description) body.description = p.description;
  if (p.code) body.code = p.code;
  if (p.vat !== undefined) body.effectiveVat = p.vat;
  if (p.sale_price_rubles !== undefined) {
    const priceTypeHref = p.price_type_href ?? (await getDefaultPriceTypeHref());
    body.salePrices = [{ value: rubToKop(p.sale_price_rubles), priceType: meta(priceTypeHref, "pricetype") }];
  }
  const result = await moyskladPost("/entity/service", body);
  const s = (result ?? {}) as Record<string, unknown>;
  return json({ id: s.id, name: s.name, code: s.code, sale_price_rubles: firstSalePriceRubles(s) });
}

export const tools: ToolDef[] = [
  {
    name: "search_assortment",
    description: "Unified search across products, variants, services and bundles. Returns name, type, price.",
    schema: searchAssortmentSchema,
    handler: handleSearchAssortment,
  },
  {
    name: "list_price_types",
    description:
      "List the account's price types (the first is the default). Use a price type href when setting product prices.",
    schema: listPriceTypesSchema,
    handler: handleListPriceTypes,
  },
  {
    name: "search_variants",
    description: "Search product variants (modifications).",
    schema: searchVariantsSchema,
    handler: handleSearchVariants,
  },
  {
    name: "search_bundles",
    description: "Search bundles (kits/sets).",
    schema: searchBundlesSchema,
    handler: handleSearchBundles,
  },
  {
    name: "search_services",
    description: "Search services.",
    schema: searchServicesSchema,
    handler: handleSearchServices,
  },
  {
    name: "create_service",
    description: "Create a service. Prices in RUBLES.",
    schema: createServiceSchema,
    handler: handleCreateService,
  },
];
