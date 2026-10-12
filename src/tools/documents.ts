import { z } from "zod";
import { moyskladGet, moyskladPost } from "../client.js";
import {
  buildDocBody,
  documentFields,
  fetchDocumentList,
  formatDocument,
  kopToRub,
  listQuery,
  positionInputSchema,
} from "../lib.js";
import { assortmentFields, projectAssortment } from "../report-lib.js";
import { outputResult, outputSchema, pageInfo, type OutputOptions } from "../output.js";
import { displayPrice, netUnitPrice, priceRules } from "../precision.js";
import type { ToolDef } from "../types.js";

// Reusable schema fragments.
const orgHref = z.string().describe("Meta href of the organization. Get from list_organizations");
const agentHref = z.string().describe("Meta href of the counterparty. Get from get_counterparties");
const storeHref = z.string().describe("Meta href of the warehouse/store. Get from list_stores");
const positions = z.array(positionInputSchema).min(1).describe("Document line items");
const listParams = {
  search: z.string().optional().describe("Search by name/number"),
  limit: z.number().int().min(1).max(1000).default(25).describe("Number of results"),
  offset: z.number().int().default(0).describe("Offset for pagination"),
};

// --- move (перемещение между складами) ---
export const createMoveSchema = z.object({
  organization_href: orgHref,
  source_store_href: z.string().describe("Meta href of the source warehouse (ship from)"),
  target_store_href: z.string().describe("Meta href of the target warehouse (ship to)"),
  positions,
  description: z.string().optional().describe("Comment"),
});
export async function handleCreateMove(p: z.infer<typeof createMoveSchema>): Promise<string> {
  const body = buildDocBody({
    organization_href: p.organization_href,
    source_store_href: p.source_store_href,
    target_store_href: p.target_store_href,
    positions: p.positions,
    description: p.description,
  });
  return formatDocument(await moyskladPost("/entity/move", body));
}
export const getMovesSchema = z.object(listParams);
export async function handleGetMoves(p: z.infer<typeof getMovesSchema>): Promise<string> {
  return fetchDocumentList("move", p, "moves");
}

// --- enter (оприходование) ---
export const createEnterSchema = z.object({
  organization_href: orgHref,
  store_href: storeHref,
  positions,
  description: z.string().optional().describe("Comment"),
});
export async function handleCreateEnter(p: z.infer<typeof createEnterSchema>): Promise<string> {
  const body = buildDocBody({
    organization_href: p.organization_href,
    store_href: p.store_href,
    positions: p.positions,
    description: p.description,
  });
  return formatDocument(await moyskladPost("/entity/enter", body));
}
export const getEntersSchema = z.object(listParams);
export async function handleGetEnters(p: z.infer<typeof getEntersSchema>): Promise<string> {
  return fetchDocumentList("enter", p, "enters");
}

// --- loss (списание) ---
export const createLossSchema = z.object({
  organization_href: orgHref,
  store_href: storeHref,
  positions,
  description: z.string().optional().describe("Comment"),
});
export async function handleCreateLoss(p: z.infer<typeof createLossSchema>): Promise<string> {
  const body = buildDocBody({
    organization_href: p.organization_href,
    store_href: p.store_href,
    positions: p.positions,
    description: p.description,
  });
  return formatDocument(await moyskladPost("/entity/loss", body));
}
export const getLossesSchema = z.object(listParams);
export async function handleGetLosses(p: z.infer<typeof getLossesSchema>): Promise<string> {
  return fetchDocumentList("loss", p, "losses");
}

// --- inventory (инвентаризация) ---
export const createInventorySchema = z.object({
  organization_href: orgHref,
  store_href: storeHref,
  positions: z
    .array(positionInputSchema)
    .optional()
    .describe("Optional line items (inventory can be created empty and filled later)"),
  description: z.string().optional().describe("Comment"),
});
export async function handleCreateInventory(p: z.infer<typeof createInventorySchema>): Promise<string> {
  const body = buildDocBody({
    organization_href: p.organization_href,
    store_href: p.store_href,
    positions: p.positions,
    description: p.description,
  });
  return formatDocument(await moyskladPost("/entity/inventory", body));
}
export const getInventoriesSchema = z.object(listParams);
export async function handleGetInventories(p: z.infer<typeof getInventoriesSchema>): Promise<string> {
  return fetchDocumentList("inventory", p, "inventories");
}

// --- purchaseorder (заказ поставщику) ---
export const createPurchaseOrderSchema = z.object({
  organization_href: orgHref,
  agent_href: agentHref,
  store_href: z.string().optional().describe("Meta href of the receiving warehouse (optional)"),
  positions,
  description: z.string().optional().describe("Comment"),
});
export async function handleCreatePurchaseOrder(p: z.infer<typeof createPurchaseOrderSchema>): Promise<string> {
  const body = buildDocBody({
    organization_href: p.organization_href,
    agent_href: p.agent_href,
    store_href: p.store_href,
    positions: p.positions,
    description: p.description,
  });
  return formatDocument(await moyskladPost("/entity/purchaseorder", body));
}
export const getPurchaseOrdersSchema = z.object(listParams);
export async function handleGetPurchaseOrders(p: z.infer<typeof getPurchaseOrdersSchema>): Promise<string> {
  return fetchDocumentList("purchaseorder", p, "purchase_orders");
}

// --- salesreturn (возврат покупателя) ---
export const createSalesReturnSchema = z.object({
  organization_href: orgHref,
  agent_href: agentHref,
  store_href: storeHref,
  positions,
  description: z.string().optional().describe("Comment"),
});
export async function handleCreateSalesReturn(p: z.infer<typeof createSalesReturnSchema>): Promise<string> {
  const body = buildDocBody({
    organization_href: p.organization_href,
    agent_href: p.agent_href,
    store_href: p.store_href,
    positions: p.positions,
    description: p.description,
  });
  return formatDocument(await moyskladPost("/entity/salesreturn", body));
}

// --- purchasereturn (возврат поставщику) ---
export const createPurchaseReturnSchema = z.object({
  organization_href: orgHref,
  agent_href: agentHref,
  store_href: storeHref,
  positions,
  description: z.string().optional().describe("Comment"),
});
export async function handleCreatePurchaseReturn(p: z.infer<typeof createPurchaseReturnSchema>): Promise<string> {
  const body = buildDocBody({
    organization_href: p.organization_href,
    agent_href: p.agent_href,
    store_href: p.store_href,
    positions: p.positions,
    description: p.description,
  });
  return formatDocument(await moyskladPost("/entity/purchasereturn", body));
}

// --- generic document access (fallback for any entity type) ---
export const getDocumentsSchema = z.object({
  ...outputSchema,
  entity_type: z.string().describe("MoySklad entity type, e.g. 'invoiceout', 'paymentin', 'retaildemand', 'move'"),
  search: z.string().optional().describe("Search by name/number"),
  filter: z.string().optional().describe("Raw MoySklad filter expression, e.g. 'name=00001'"),
  limit: z.number().int().min(1).max(1000).default(25).describe("Number of results"),
  offset: z.number().int().default(0).describe("Offset for pagination"),
  expand: z
    .enum(["positions", "positions.assortment"])
    .optional()
    .describe(
      "Include line items; positions.assortment also expands product details. Requires limit <= 100. Check positions_export.complete.",
    ),
});
export async function handleGetDocuments(p: z.infer<typeof getDocumentsSchema>): Promise<string> {
  if (p.expand && p.limit > 100) throw new Error("Expanded document lists require limit <= 100.");
  const qs = listQuery({ ...p, expand: p.detail === "summary" && p.output !== "file" ? undefined : p.expand });
  const result = (await moyskladGet(`/entity/${p.entity_type}?${qs}`)) as {
    meta?: { size?: number };
    rows?: Record<string, unknown>[];
  };
  const rows = result.rows ?? [];
  const summary = pageInfo(result.meta?.size, rows.length, p.offset, p.limit);
  const value =
    p.detail === "raw"
      ? result
      : {
          ...summary,
          ...(p.detail === "summary" && p.output !== "file"
            ? {}
            : {
                documents: rows.map((row) => ({
                  ...compactHeader(row, p.fields),
                  ...(p.expand ? { positions_export: exportPositions(row.positions, p) } : {}),
                })),
              }),
        };
  return outputResult(value, summary, p);
}

export const getDocumentSchema = z.object({
  ...outputSchema,
  entity_type: z.string().describe("MoySklad entity type, e.g. 'customerorder', 'demand', 'supply'"),
  id: z.string().describe("Document UUID"),
  positions_limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Fetch a separate positions page of this size, with expanded assortment"),
  positions_offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Fetch a separate positions page starting here; follow positions_export.next_offset"),
});
export async function handleGetDocument(p: z.infer<typeof getDocumentSchema>): Promise<string> {
  const base = `/entity/${p.entity_type}/${p.id}`;
  const paged = p.positions_limit !== undefined || p.positions_offset !== undefined;
  const result = (await moyskladGet(paged ? base : `${base}?expand=positions.assortment`)) as Record<string, unknown>;
  if (paged) {
    const qs = listQuery({ limit: p.positions_limit ?? 100, offset: p.positions_offset ?? 0, expand: "assortment" });
    result.positions = await moyskladGet(`${base}/positions?${qs}`);
  }
  const positions = exportPositions(result.positions, p);
  const { items, ...metadata } = positions;
  const header = compactHeader(result, p.fields);
  const summary = {
    ...header,
    ...metadata,
    quantity_on_page: items.reduce((sum, item) => sum + (typeof item.quantity === "number" ? item.quantity : 0), 0),
  };
  const value =
    p.detail === "raw"
      ? result
      : p.detail === "summary" && p.output !== "file"
        ? summary
        : {
            ...header,
            ...metadata,
            ...(p.fields === "quantity" ? {} : { price_rules: priceRules }),
            positions_export: positions,
          };
  return outputResult(value, summary, p);
}

function compactHeader(raw: Record<string, unknown>, fields: OutputOptions["fields"]) {
  if (fields === "full") return documentFields(raw);
  return {
    id: raw.id ?? null,
    name: raw.name ?? null,
    moment: raw.moment ?? null,
    applicable: raw.applicable ?? null,
    ...(fields === "quantity" ? {} : { sum_rubles: kopToRub(raw.sum) }),
  };
}

export function exportPositions(raw: unknown, options: OutputOptions = {}) {
  const data = (raw ?? {}) as { meta?: { size?: number; offset?: number }; rows?: Record<string, unknown>[] };
  const rows = data.rows ?? [];
  const offset = data.meta?.offset ?? 0;
  const total = data.meta?.size;
  return {
    ...pageInfo(total, rows.length, offset, rows.length || 25),
    items: rows.map((row) => {
      const fields =
        options.fields === "full"
          ? assortmentFields(row.assortment)
          : projectAssortment(row.assortment, options.fields);
      const price = netUnitPrice(row.price, row.discount);
      const money =
        options.fields === "quantity"
          ? {}
          : {
              price_rubles: kopToRub(row.price),
              discount: row.discount ?? null,
              net_unit_price: price,
              net_unit_price_display: displayPrice(price),
            };
      return {
        ...(options.fields === "full" ? { id: row.id ?? null } : { position_id: row.id ?? null }),
        quantity: row.quantity ?? null,
        ...fields,
        ...money,
      };
    }),
  };
}

export const tools: ToolDef[] = [
  {
    name: "create_move",
    description: "Create a stock transfer (move) between two warehouses.",
    schema: createMoveSchema,
    handler: handleCreateMove,
  },
  {
    name: "get_moves",
    description: "List stock transfer (move) documents.",
    schema: getMovesSchema,
    handler: handleGetMoves,
  },
  {
    name: "create_enter",
    description: "Create a stock enter (оприходование) — add stock into a warehouse.",
    schema: createEnterSchema,
    handler: handleCreateEnter,
  },
  {
    name: "get_enters",
    description: "List stock enter (оприходование) documents.",
    schema: getEntersSchema,
    handler: handleGetEnters,
  },
  {
    name: "create_loss",
    description: "Create a stock write-off (списание) from a warehouse.",
    schema: createLossSchema,
    handler: handleCreateLoss,
  },
  {
    name: "get_losses",
    description: "List stock write-off (списание) documents.",
    schema: getLossesSchema,
    handler: handleGetLosses,
  },
  {
    name: "create_inventory",
    description: "Create an inventory count (инвентаризация) for a warehouse.",
    schema: createInventorySchema,
    handler: handleCreateInventory,
  },
  {
    name: "get_inventories",
    description: "List inventory count (инвентаризация) documents.",
    schema: getInventoriesSchema,
    handler: handleGetInventories,
  },
  {
    name: "create_purchase_order",
    description: "Create a purchase order (заказ поставщику). Prices in RUBLES.",
    schema: createPurchaseOrderSchema,
    handler: handleCreatePurchaseOrder,
  },
  {
    name: "get_purchase_orders",
    description: "List purchase orders (заказы поставщикам).",
    schema: getPurchaseOrdersSchema,
    handler: handleGetPurchaseOrders,
  },
  {
    name: "create_sales_return",
    description: "Create a sales return (возврат покупателя). Prices in RUBLES.",
    schema: createSalesReturnSchema,
    handler: handleCreateSalesReturn,
  },
  {
    name: "create_purchase_return",
    description: "Create a purchase return (возврат поставщику). Prices in RUBLES.",
    schema: createPurchaseReturnSchema,
    handler: handleCreatePurchaseReturn,
  },
  {
    name: "get_documents",
    description:
      "Immediate short read independent of the heavy report worker. List documents by entity type with pagination. Positions require expand=positions or positions.assortment and limit<=100; each positions_export may be incomplete. Use get_document to page remaining positions. Summary covers this page only; follow next_offset.",
    schema: getDocumentsSchema,
    handler: handleGetDocuments,
  },
  {
    name: "get_document",
    description:
      "Get a document by entity type and UUID with compact positions. position_id identifies the line; id identifies assortment. Expanded positions may be incomplete: follow positions_export.next_offset using positions_limit/positions_offset. detail=raw returns the original API object.",
    schema: getDocumentSchema,
    handler: handleGetDocument,
  },
];
