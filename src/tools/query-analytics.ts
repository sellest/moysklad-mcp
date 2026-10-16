import { randomUUID } from "node:crypto";
import {
  analyticsQuerySchema,
  normalizeAnalyticsQuery,
  queryGrain,
  queryPeriod,
  dimensions,
  measures,
  type AnalyticsQuery,
} from "../analytics-query-schema.js";
import { queryOrderDocuments } from "../analytics-query-documents.js";
import { queryPolicy } from "../analytics-query-policy.js";
import { orderSnapshot, orderLines, type OrderSnapshot } from "../analytics-query-source.js";
import { cachedEntity, entityId, type ApiEntity } from "../analytics-data.js";
import { moyskladGet } from "../client.js";
import { sourcePages } from "../streaming-source.js";
import { credentialScope } from "../report-store.js";
import { reportContext, reportProgress } from "../report-context.js";
import { assortmentFields } from "../report-lib.js";
import { decimal, Exact, netUnitPrice } from "../precision.js";
import { createExport } from "../output.js";
import type { ToolDef } from "../types.js";

const short = (v: unknown) => (typeof v === "string" ? v.slice(0, 300) : null);
function categoryOf(product: ApiEntity, p: AnalyticsQuery, snapshot: OrderSnapshot) {
  if (p.category.source === "product_folder") {
    const id = entityId(product.productFolder),
      folder = snapshot.folders.find((f) => f.id === id);
    return { id, value: short(folder?.name), provenance: id ? `productFolder:${id}` : null };
  }
  const attributes = (Array.isArray(product.attributes) ? product.attributes : []).filter((a: ApiEntity) =>
    p.category.attribute_id ? a.id === p.category.attribute_id : a.name === (p.category.attribute_name ?? "Категория"),
  );
  if (attributes.length !== 1) return { id: null, value: null, provenance: null };
  const a = attributes[0],
    value = typeof a.value === "object" ? a.value?.name : a.value;
  return {
    id: typeof a.value === "object" ? entityId(a.value) : null,
    value: typeof value === "string" || typeof value === "number" ? String(value).slice(0, 300) : null,
    provenance: `attribute:${a.id ?? a.name}`,
  };
}
function compareFilter(actual: unknown, filter: AnalyticsQuery["filters"][number]): boolean | null {
  if (actual === null || actual === undefined) return null;
  if (filter.field === "position.net_unit_price_rub") {
    const a = decimal(actual),
      b = decimal(filter.value);
    if (!a || !b) return null;
    return filter.op === "lte" ? a.lte(b) : filter.op === "gte" ? a.gte(b) : a.eq(b);
  }
  if (filter.op === "in") return (filter.value as (string | number)[]).some((v) => String(v) === String(actual));
  return filter.op === "contains"
    ? String(actual).toLocaleLowerCase().includes(String(filter.value).toLocaleLowerCase())
    : String(actual) === String(filter.value);
}
async function describe() {
  const meta = (await moyskladGet("/entity/customerorder/metadata")) as ApiEntity;
  const states = (Array.isArray(meta.states) ? meta.states : (meta.states?.rows ?? [])).map((s: ApiEntity) => ({
    id: s.id,
    name: s.name,
    state_type: s.stateType,
  }));
  const folders: ApiEntity[] = [];
  for await (const page of sourcePages("/entity/productfolder", { limit: 1000 })) {
    folders.push(...page.rows.map((f) => ({ id: f.id, name: f.name, path: f.pathName ?? "" })));
    if (folders.length > 1000) throw new Error("STORAGE_LIMIT: Too many category values for discovery.");
  }
  const attributes: ApiEntity[] = [];
  for await (const page of sourcePages("/entity/product/metadata/attributes", { limit: 1000 })) {
    attributes.push(...page.rows.map((a) => ({ id: a.id, name: a.name, type: a.type })));
    if (attributes.length > 200) throw new Error("STORAGE_LIMIT: Too many attribute values for discovery.");
  }
  const policy = await queryPolicy().catch(() => null);
  return JSON.stringify({
    dataset: "orders",
    operation: "describe",
    source: "MoySklad metadata",
    states,
    category_source: "product_folder",
    categories: folders,
    attributes,
    contracts: {
      dimensions,
      measures,
      document_dimensions: ["order.delivery.city", "order.delivery.region", "order.channel"],
      document_measures: ["orders_count", "orders_total_rub"],
      document_rules:
        "Order-only queries read document headers without positions/catalog. orders_total_rub is the whole document sum once, including delivery; do not mix with position filters or ordered_revenue. Missing city excluded by default, missing region stays null and is never inferred. Use region is_set=true to request known regions only.",
    },
    default_policy: {
      posted_only: true,
      cancelled_state_ids: policy ? [...policy.cancelledIds] : [],
      configured: !!policy,
    },
    instructions:
      "Use actual category names/IDs, attribute IDs and order state IDs from this response. Do not invent category aliases or infer sleeves from a product name. Specify status selection if the user requests it; otherwise use posted orders excluding confirmed cancellations and disclose that default. Explicit order.state_id filters override cancellation exclusion. include_unposted is separate. Services are excluded; only confirmed piece units contribute to quantity/revenue. Orders are not shipped sales. Query date range is [from,to_exclusive) in an explicit IANA timezone.",
  });
}
async function calculate(p: AnalyticsQuery): Promise<string> {
  const calculationStarted = performance.now();
  if (p.operation === "describe") return describe();
  queryPeriod(p);
  if (queryGrain(p) === "documents") return queryOrderDocuments(p);
  if (
    new Set(p.dimensions).size !== p.dimensions.length ||
    new Set(p.measures).size !== p.measures.length ||
    (!p.measures.includes(p.order_by.field as any) && !p.dimensions.includes(p.order_by.field as any))
  )
    throw new Error("INVALID_ARGUMENT: Dimensions/measures must be unique and sort field selected.");
  if (p.category.source === "attribute" && !p.category.attribute_id && !p.category.attribute_name)
    throw new Error("INVALID_ARGUMENT: Select an explicit category attribute ID/name.");
  const explicitStates = p.filters.some((f) => f.field === "order.state_id");
  const excludeCancelled = !p.include_cancelled && !explicitStates;
  const policy = excludeCancelled ? await queryPolicy() : null;
  const { snapshot, period, reused } = await orderSnapshot(p);
  const sourceLoaded = performance.now();
  await reportProgress("aggregate_orders", { expected_positions: snapshot.positions });
  const stateIds = new Set(snapshot.states.map((s) => s.id));
  if (policy && [...policy.cancelledIds].some((id) => !stateIds.has(id)))
    throw new Error("ANALYTICS_POLICY_UNAVAILABLE: Cancellation IDs missing from current source metadata.");
  for (const f of p.filters.filter((f) => f.field === "order.state_id"))
    for (const id of Array.isArray(f.value) ? f.value : [f.value])
      if (!stateIds.has(id)) throw new Error("INVALID_ARGUMENT: Unknown order status ID; use operation=describe.");
  const unresolved: Record<string, number> = {
    category: 0,
    price: 0,
    product: 0,
    size: 0,
    article: 0,
    state: 0,
    channel: 0,
    quantity: 0,
    unit: 0,
    currency: 0,
  };
  const excluded: Record<string, number> = { unposted: 0, cancelled: 0, services: 0, non_piece_units: 0, filter: 0 };
  const groups = new Map<
    string,
    {
      values: Record<string, any>;
      quantity: InstanceType<typeof Exact>;
      revenue: InstanceType<typeof Exact>;
      orders: Set<string>;
    }
  >();
  const hydrated = new Map<string, ApiEntity>();
  const hydrate = async (type: string, id: string) => {
    const key = type + ":" + id;
    if (!hydrated.has(key)) {
      if (hydrated.size >= 20000) throw new Error("STORAGE_LIMIT: Catalog cardinality exceeded.");
      hydrated.set(key, await cachedEntity(type, id));
    }
    return hydrated.get(key)!;
  };
  let processed = 0,
    matched = 0,
    unresolvedPositions = 0;
  const matchedOrders = new Set<string>();
  const needCategory =
    p.dimensions.includes("product.category") || p.filters.some((f) => f.field.startsWith("product.category"));
  const needSize = p.dimensions.includes("variant.size") || p.filters.some((f) => f.field === "variant.size");
  const needArticle = p.dimensions.includes("product.article") || p.filters.some((f) => f.field === "product.article");
  const needPrice =
    p.measures.includes("ordered_revenue") || p.filters.some((f) => f.field === "position.net_unit_price_rub");
  for await (const line of orderLines(snapshot)) {
    processed++;
    if (processed % 100 === 0) await reportProgress("aggregate_orders", { processed_positions: 100 });
    const { order, position } = line;
    if (!p.include_unposted && order.applicable === false) {
      excluded.unposted++;
      continue;
    }
    if (excludeCancelled && policy!.cancelledIds.has(order.state_id)) {
      excluded.cancelled++;
      continue;
    }
    if (order.deleted) throw new Error("INCOMPLETE_SOURCE: Deleted order present in active source.");
    const orderFilters = p.filters.filter((f) => f.field.startsWith("order."));
    const orderValues: Record<string, any> = { "order.state_id": order.state_id, "order.channel": order.channel_id };
    if (orderFilters.some((f) => compareFilter(orderValues[f.field], f) === false)) {
      excluded.filter++;
      continue;
    }
    const reasons = new Set<string>();
    if (!p.include_unposted && order.applicable !== true) reasons.add("state");
    if (excludeCancelled && (!order.state_id || !policy!.knownIds.has(order.state_id))) reasons.add("state");
    for (const f of orderFilters)
      if (compareFilter(orderValues[f.field], f) === null)
        reasons.add(f.field === "order.channel" ? "channel" : "state");
    const a = position.assortment ?? {},
      type = a.meta?.type,
      id = entityId(a);
    if (type === "service") {
      excluded.services++;
      continue;
    }
    let assortment: ApiEntity = {},
      product: ApiEntity = {};
    if (!id || !["product", "variant", "bundle"].includes(type)) reasons.add("product");
    else {
      assortment = await hydrate(type, id);
      if (type === "variant") {
        const parent = entityId(assortment.product);
        if (parent) product = await hydrate("product", parent);
        else reasons.add("product");
      } else product = assortment;
      if (assortment.unavailable || product.unavailable || !product.id) reasons.add("product");
    }
    const quantity = decimal(position.quantity);
    if (!quantity || quantity.isNegative()) reasons.add("quantity");
    const unit = snapshot.units.find((u) => u.id === entityId(product.uom));
    if (!unit) reasons.add("unit");
    else if (String(unit.code) !== "796") {
      excluded.non_piece_units++;
      continue;
    }
    const currency = snapshot.currencies.find((c) => c.id === order.currency_id);
    const rub =
      currency &&
      (String(currency.isoCode) === "643" ||
        String(currency.code) === "643" ||
        String(currency.code).toUpperCase() === "RUB");
    const price = netUnitPrice(position.price, position.discount);
    const category = categoryOf(product, p, snapshot),
      size = assortmentFields(assortment);
    const values: Record<string, any> = {
      product: product.id ?? null,
      product_id: product.id ?? null,
      "product.id": product.id ?? null,
      "product.article": short(product.article),
      variant: id ?? null,
      "variant.id": id ?? null,
      "variant.size": size.size ?? size.size_raw,
      "product.category": category.value,
      "product.category_id": category.id,
      "order.channel": order.channel_id,
      "position.net_unit_price_rub": rub ? price : null,
    };
    const rowFilters = p.filters.filter((f) => !f.field.startsWith("order."));
    if (rowFilters.some((f) => compareFilter(values[f.field], f) === false)) {
      excluded.filter++;
      continue;
    }
    for (const f of rowFilters)
      if (compareFilter(values[f.field], f) === null)
        reasons.add(
          f.field === "position.net_unit_price_rub"
            ? "price"
            : f.field.startsWith("product.category")
              ? "category"
              : f.field === "product.article"
                ? "article"
                : f.field === "variant.size"
                  ? "size"
                  : "product",
        );
    if (needCategory && !category.value) reasons.add("category");
    if (needSize && !size.size_raw) reasons.add("size");
    if (needArticle && !values["product.article"]) reasons.add("article");
    if (p.dimensions.includes("order.channel") && !order.channel_id) reasons.add("channel");
    if (needPrice) {
      if (price === null) reasons.add("price");
      if (!rub) reasons.add("currency");
    }
    if (reasons.size) {
      unresolvedPositions++;
      for (const reason of reasons) unresolved[reason]++;
      continue;
    }
    // Product ID is always part of the key for identity-based dimensions, including article/size.
    const identity = p.dimensions.some((d) =>
      ["product", "product_id", "product.article", "variant", "variant.size"].includes(d),
    );
    const key = JSON.stringify([
      identity ? product.id : null,
      ...p.dimensions.map((d) => (d === "product.category" ? [category.id, category.value] : values[d])),
    ]);
    if (!groups.has(key)) {
      if (groups.size >= 10000) throw new Error("STORAGE_LIMIT: Aggregation group budget exceeded.");
      const fields: Record<string, any> = {};
      if (identity) {
        fields.product_id = product.id;
        fields.article = short(product.article);
        fields.product_name = short(product.name);
      }
      for (const d of p.dimensions) {
        if (d === "variant") fields.variant_id = id;
        else if (d === "variant.size") fields.size = size.size ?? size.size_raw;
        else if (d === "product.category") {
          fields.category = category.value;
          fields.category_id = category.id;
          fields.category_provenance = category.provenance;
        } else if (d === "order.channel") fields.channel_id = order.channel_id;
      }
      groups.set(key, { values: fields, quantity: new Exact(0), revenue: new Exact(0), orders: new Set() });
    }
    const group = groups.get(key)!;
    group.quantity = group.quantity.plus(quantity!);
    if (p.measures.includes("ordered_revenue")) group.revenue = group.revenue.plus(new Exact(price!).mul(quantity!));
    group.orders.add(order.id);
    matchedOrders.add(order.id);
    matched++;
  }
  if (processed !== snapshot.positions) throw new Error("INCOMPLETE_SOURCE: Snapshot line count mismatch.");
  await reportProgress("aggregate_orders", { processed_positions: processed % 100 });
  const field = p.order_by.field;
  const metric = (g: any) =>
    field === "ordered_quantity"
      ? g.quantity
      : field === "ordered_revenue"
        ? g.revenue
        : field === "orders_count"
          ? new Exact(g.orders.size)
          : null;
  const fieldKey: Record<string, string> = {
    product: "product_id",
    product_id: "product_id",
    "product.article": "article",
    variant: "variant_id",
    "variant.size": "size",
    "product.category": "category",
    "order.channel": "channel_id",
  };
  const sorted = [...groups.entries()].sort(([ka, a], [kb, b]) => {
    const ma = metric(a),
      mb = metric(b);
    const av = a.values[fieldKey[field]],
      bv = b.values[fieldKey[field]];
    const comparison = ma
      ? ma.comparedTo(mb!)
      : typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av ?? "") < String(bv ?? "")
          ? -1
          : String(av ?? "") > String(bv ?? "")
            ? 1
            : 0;
    return (p.order_by.direction === "desc" ? -comparison : comparison) || (ka < kb ? -1 : ka > kb ? 1 : 0);
  });
  const rows = sorted.map(([, g]) => ({
    ...g.values,
    ...(p.measures.includes("ordered_quantity") ? { ordered_quantity: g.quantity.toFixed() } : {}),
    ...(p.measures.includes("ordered_revenue") ? { ordered_revenue_rub: g.revenue.toFixed() } : {}),
    ...(p.measures.includes("orders_count") ? { orders_count: g.orders.size } : {}),
  }));
  const warnings: string[] = [];
  if (unresolvedPositions)
    warnings.push(
      "Some potentially matching positions are unresolved; ranking is provisional and may change when source data is completed.",
    );
  if (excluded.non_piece_units) warnings.push("Non-piece units are excluded explicitly; quantities are pieces only.");
  if (!process.env.MOYSKLAD_REPORT_TIMEZONE)
    warnings.push(
      "Source accounting timezone defaults to Europe/Moscow; operator should confirm MOYSKLAD_REPORT_TIMEZONE.",
    );
  const page = rows.slice(p.offset, p.offset + p.limit);
  while (Buffer.byteLength(JSON.stringify(page)) > 80000 && page.length) page.pop();
  if (!page.length && rows.length > p.offset) throw new Error("STORAGE_LIMIT: Aggregate row exceeds inline budget.");
  const result: any = {
    status: unresolvedPositions ? "partial" : "complete",
    data_complete: unresolvedPositions === 0,
    rows: page,
    total_groups: rows.length,
    returned: page.length,
    offset: p.offset,
    next_offset: p.offset + page.length < rows.length ? p.offset + page.length : null,
    metadata: {
      source: "customerorder",
      dataset: "orders",
      grain: "positions",
      period: p.date_range,
      timezone: p.date_range!.timezone,
      source_timezone: period.apiTimezone,
      generated_at: new Date().toISOString(),
      timings_ms: {
        source: Math.round(sourceLoaded - calculationStarted),
        aggregation: Math.round(performance.now() - sourceLoaded),
        total: Math.round(performance.now() - calculationStarted),
      },
      documents_processed: snapshot.documents,
      positions_processed: processed,
      positions_matched: matched,
      matched_orders: matchedOrders.size,
      unresolved: { ...unresolved, positions: unresolvedPositions },
      excluded,
      source_complete: true,
      classification_complete: unresolved.category === 0,
      answer_complete: unresolvedPositions === 0,
      warnings,
      filters: p.filters,
      dimensions: p.dimensions,
      measures: p.measures,
      order_by: p.order_by,
      category: p.category,
      unit_policy: "pieces_only: OKEI 796",
      currency_policy: "RUB only for price/revenue; no currency conversion",
      price_formula: "price_kopecks/100*(1-discount/100), decimal arithmetic; no pre-filter rounding",
      order_policy: {
        include_unposted: p.include_unposted,
        exclude_cancelled: excludeCancelled,
        explicit_status_selection: explicitStates,
        cancelled_state_ids: policy ? [...policy.cancelledIds] : [],
        deleted: "excluded by active entity source; encountering deleted rows aborts",
      },
      snapshot: {
        id: snapshot.id,
        captured_from: snapshot.captured_from,
        captured_to: snapshot.captured_to,
        expires_at: snapshot.expires_at,
        catalog_version: snapshot.catalog_version,
        reused,
        consistency: "non_transactional capture; headers verified twice; catalog frozen per snapshot",
      },
      interpretation:
        "Ordered units and selected order-line amounts, not shipments or net sales. Returns do not subtract from orders. Different product IDs never merge by article. Bundles count as their own item, not exploded components.",
    },
  };
  if (p.output === "file") result.export = await createExport({ metadata: result.metadata, rows });
  return JSON.stringify(result);
}
export async function handleQueryAnalytics(params: unknown) {
  const p = normalizeAnalyticsQuery(params);
  if (reportContext.getStore()) return calculate(p);
  return reportContext.run(
    { jobId: randomUUID(), scope: credentialScope(), signal: new AbortController().signal, progress: async () => {} },
    () => calculate(p),
  );
}
export const tools: ToolDef[] = [
  {
    name: "query_analytics",
    schema: analyticsQuerySchema,
    handler: handleQueryAnalytics,
    description:
      "Read-only server-side analytics across ALL customer orders in a period. Order-level rankings: dimensions order.delivery.city / order.delivery.region / order.channel, measures orders_count and orders_total_rub (full order amount once, including delivery); no positions/catalog needed. Missing cities excluded/counted by default; missing regions remain null and are never inferred. region is_set=true selects explicit regions only. Do not combine geography/document totals with product filters or position metrics. Product rankings: product/model/article/variant/size/category, ordered_quantity, orders_count and ordered_revenue (selected discounted lines). Use this instead of downloading get_documents pages/exports. operation=describe discovers supported fields and actual category/status values. Default posted orders except confirmed cancellations, disclose policy; explicit statuses override cancellation exclusion. Date range [from,to_exclusive) in explicit timezone. Inline aggregates; output=file only on explicit user export request. May return job_id: poll get_report_job sequentially every >=3 seconds; never fan out or restart running queries. Unresolved results are provisional. No SQL/endpoints/code accepted.",
  },
];
