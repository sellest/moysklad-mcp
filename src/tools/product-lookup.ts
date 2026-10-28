import { z } from "zod";
import { moyskladGet } from "../client.js";
import { json, kopToRub } from "../lib.js";
import { pageInfo } from "../output.js";
import type { ToolDef } from "../types.js";

export const getProductsByIdsSchema = z.object({
  ids: z
    .array(z.string().uuid())
    .min(1)
    .max(1000)
    .describe(
      "MoySklad product UUIDs (1..1000). Case-insensitive duplicates are removed, keeping first occurrence order. Not variant UUIDs.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(0)
    .describe("Offset in the ordered unique UUID list. Repeat the same ids with next_offset to read the next page."),
  limit: z.number().int().min(1).max(100).default(100).describe("Page size, at most 100 product results."),
});

export async function handleGetProductsByIds(params: z.infer<typeof getProductsByIdsSchema>): Promise<string> {
  const ids = [...new Set(params.ids.map((id) => id.toLowerCase()))];
  const selected = ids.slice(params.offset, params.offset + params.limit);
  const found = new Map<string, Record<string, unknown>>();
  if (selected.length) {
    const query = new URLSearchParams({
      filter: [...selected.map((id) => `id=${id}`), "archived=true", "archived=false"].join(";"),
      limit: "100",
    });
    // One scheduled, read-only API request per page. Do not turn API failures into not_found.
    const response = (await moyskladGet(`/entity/product?${query}`)) as {
      rows?: Record<string, unknown>[];
      meta?: { size?: number };
    };
    if (!Array.isArray(response?.rows)) throw new Error("UPSTREAM_RESPONSE: Product rows are missing.");
    const expected = new Set(selected);
    for (const row of response.rows) {
      if (typeof row?.id !== "string" || !expected.has(row.id.toLowerCase()) || found.has(row.id.toLowerCase())) {
        throw new Error("UPSTREAM_RESPONSE: Unexpected or duplicate product UUID.");
      }
      found.set(row.id.toLowerCase(), row);
    }
    if (response.meta?.size !== undefined && response.meta.size !== found.size) {
      throw new Error("UPSTREAM_RESPONSE: Incomplete product selection; retry the same page.");
    }
  }
  const products = selected.map((id) => {
    const row = found.get(id);
    if (!row) return { id, status: "not_found", article: null, name: null, archived: null };
    const sale = (row.salePrices as { value?: number }[] | undefined)?.[0]?.value;
    const buy = (row.buyPrice as { value?: number } | undefined)?.value;
    return {
      id,
      status: "found",
      article: row.article ?? null,
      name: row.name ?? null,
      code: row.code ?? null,
      archived: row.archived === true,
      external_code: row.externalCode ?? null,
      path_name: row.pathName ?? null,
      updated: row.updated ?? null,
      sale_price_rubles: typeof sale === "number" ? kopToRub(sale) : null,
      buy_price_rubles: typeof buy === "number" ? kopToRub(buy) : null,
    };
  });
  return json({
    products,
    ...pageInfo(ids.length, products.length, params.offset, params.limit),
    complete: params.offset + products.length >= ids.length,
    requested_count: params.ids.length,
    duplicates_removed: params.ids.length - ids.length,
    found: products.filter((p) => p.status === "found").length,
    not_found: products.filter((p) => p.status === "not_found").length,
  });
}

export const tools: ToolDef[] = [
  {
    name: "get_products_by_ids",
    description:
      "Batch lookup by exact MoySklad PRODUCT UUIDs, including archived products. Accepts 1..1000 ids; returns at most 100 products per page in first-occurrence input order after case-insensitive deduplication. Each row has id, status=found|not_found, exact article and name; found rows also include code, archived, external_code, path_name, updated and prices in RUB. Preserve leading zeros in articles. A missing/inaccessible product is not_found, not proof of deletion; API failures fail the page instead. total counts unique requested UUIDs, not found products; complete means no more input pages, not that every product exists. Repeat the SAME ids and next_offset; do not send parallel pages. One API request per page, no full catalog scan. Use get_product for a single full card. Variant UUIDs are not resolved to parents. Website IDs must first be verified as MoySklad product IDs.",
    schema: getProductsByIdsSchema,
    handler: handleGetProductsByIds,
  },
];
