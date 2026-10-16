import { captureOrderDocuments, documentOrders, sourceRegion } from "./analytics-order-documents.js";
import { queryPolicy } from "./analytics-query-policy.js";
import { decimal, Exact } from "./precision.js";
import { reportProgress } from "./report-context.js";
import { createExport } from "./output.js";
import type { AnalyticsQuery } from "./analytics-query-schema.js";

function compare(actual: unknown, f: AnalyticsQuery["filters"][number]): boolean | null {
  if (f.op === "is_set") return (actual !== null && actual !== undefined) === f.value;
  if (actual === undefined) return null;
  if (actual === null) return f.field.startsWith("order.delivery.") ? false : null;
  if (f.op === "in") return (f.value as (string | number)[]).some((v) => String(v) === String(actual));
  return f.op === "contains"
    ? String(actual).toLowerCase().includes(String(f.value).toLowerCase())
    : String(actual) === String(f.value);
}
export async function queryOrderDocuments(p: AnalyticsQuery): Promise<string> {
  const started = performance.now();
  const explicitStates = p.filters.some((f) => f.field === "order.state_id"),
    excludeCancelled = !p.include_cancelled && !explicitStates;
  const policy = excludeCancelled ? await queryPolicy() : null;
  const { snapshot, period, reused } = await captureOrderDocuments(p),
    loaded = performance.now();
  const stateIds = new Set(snapshot.states.map((s) => s.id));
  if (policy && [...policy.cancelledIds].some((id) => !stateIds.has(id)))
    throw new Error("ANALYTICS_POLICY_UNAVAILABLE: Confirmed cancellation IDs no longer exist.");
  for (const f of p.filters.filter((f) => f.field === "order.state_id"))
    for (const id of Array.isArray(f.value) ? f.value : [f.value])
      if (!stateIds.has(id)) throw new Error("INVALID_ARGUMENT: Unknown order state; use operation=describe.");
  const excluded = { unposted: 0, cancelled: 0, filter: 0, missing_city: 0, currency: 0, amount: 0, unresolved: 0 };
  const unresolved = { state: 0, city: 0, region: 0, channel: 0, currency: 0, amount: 0, documents: 0 };
  const missing = { city: 0, region: 0 },
    sourceMissing = { city: 0, region: 0 };
  const needRegion =
    p.dimensions.includes("order.delivery.region") ||
    p.filters.some((f) => f.field === "order.delivery.region" && f.op !== "is_set");
  const needTotal = p.measures.includes("orders_total_rub");
  const needCity = p.dimensions.includes("order.delivery.city");
  const regions = new Map<string, Awaited<ReturnType<typeof sourceRegion>>>();
  const groups = new Map<
    string,
    { values: Record<string, unknown>; count: number; total: InstanceType<typeof Exact> }
  >();
  let processed = 0,
    matched = 0,
    eligible = 0;
  await reportProgress("aggregate_documents", { expected_documents: snapshot.documents });
  for await (const order of documentOrders(snapshot)) {
    processed++;
    if (processed % 100 === 0) await reportProgress("aggregate_documents", { aggregated_documents: 100 });
    if (!order.city_present) sourceMissing.city++;
    if (!order.region.present) sourceMissing.region++;
    if (!p.include_unposted && order.applicable === false) {
      excluded.unposted++;
      continue;
    }
    if (excludeCancelled && policy!.cancelledIds.has(order.state_id ?? "")) {
      excluded.cancelled++;
      continue;
    }
    if (order.deleted) throw new Error("INCOMPLETE_SOURCE: Deleted document encountered.");
    eligible++;
    if (!order.city_present) missing.city++;
    if (!order.region.present) missing.region++;
    let region: Awaited<ReturnType<typeof sourceRegion>> = !order.region.present
      ? { id: null, name: null, status: "absent" }
      : order.region.name
        ? { id: order.region.id, name: order.region.name, status: "provided" }
        : { id: order.region.id, name: null, status: "unresolved" };
    if (needRegion) {
      const regionKey = JSON.stringify(order.region);
      if (!regions.has(regionKey)) regions.set(regionKey, await sourceRegion(order.region, snapshot));
      region = regions.get(regionKey)!;
    }
    const values: Record<string, unknown> = {
      "order.state_id": order.state_id,
      "order.channel": order.channel_id,
      "order.delivery.city": order.city_present ? (order.city ?? undefined) : null,
      "order.delivery.region": region.status === "absent" ? null : (region.name ?? undefined),
    };
    const compared = p.filters.map((f) => {
      if (f.op === "is_set")
        return (f.field === "order.delivery.city" ? order.city_present : order.region.present) === f.value;
      return compare(values[f.field], f);
    });
    if (compared.some((v) => v === false)) {
      excluded.filter++;
      continue;
    }
    if (needCity && !p.include_missing_city && !order.city_present) {
      excluded.missing_city++;
      continue;
    }
    const reasons = new Set<keyof typeof unresolved>();
    if (!p.include_unposted && order.applicable !== true) reasons.add("state");
    if (excludeCancelled && (!order.state_id || !policy!.knownIds.has(order.state_id))) reasons.add("state");
    for (let n = 0; n < compared.length; n++)
      if (compared[n] === null) {
        const field = p.filters[n].field;
        reasons.add(
          field === "order.delivery.city"
            ? "city"
            : field === "order.delivery.region"
              ? "region"
              : field === "order.channel"
                ? "channel"
                : "state",
        );
      }
    if (needCity && order.city_present && !order.city) reasons.add("city");
    if (needRegion && region.status === "unresolved") reasons.add("region");
    if (p.dimensions.includes("order.channel") && !order.channel_id) reasons.add("channel");
    const amount = decimal(order.sum);
    if (needTotal) {
      const c = snapshot.currencies.find((c) => c.id === order.currency_id);
      const rub =
        c && (String(c.isoCode) === "643" || String(c.code) === "643" || String(c.code).toUpperCase() === "RUB");
      if (!rub) reasons.add("currency");
      if (!amount || amount.isNegative()) reasons.add("amount");
    }
    if (reasons.size) {
      unresolved.documents++;
      for (const reason of reasons) unresolved[reason]++;
      if (reasons.has("currency")) excluded.currency++;
      else if (reasons.has("amount")) excluded.amount++;
      else excluded.unresolved++;
      continue;
    }
    const key = JSON.stringify(
      p.dimensions.map((d) => (d === "order.delivery.region" ? [region.id, region.name, region.status] : values[d])),
    );
    if (!groups.has(key)) {
      if (groups.size >= 10000) throw new Error("STORAGE_LIMIT: Document aggregation group budget exceeded.");
      const fields: Record<string, unknown> = {};
      for (const dimension of p.dimensions) {
        if (dimension === "order.delivery.city") fields.city = order.city;
        else if (dimension === "order.delivery.region") {
          fields.region = region.name;
          fields.region_id = region.id;
          fields.region_status = region.status;
        } else if (dimension === "order.channel") fields.channel_id = order.channel_id;
      }
      groups.set(key, { values: fields, count: 0, total: new Exact(0) });
    }
    const group = groups.get(key)!;
    group.count++;
    if (needTotal) group.total = group.total.plus(amount!.div(100));
    matched++;
  }
  if (processed !== snapshot.documents) throw new Error("INCOMPLETE_SOURCE: Document count mismatch.");
  await reportProgress("aggregate_documents", { aggregated_documents: processed % 100 });
  const fieldKey: Record<string, string> = {
    "order.delivery.city": "city",
    "order.delivery.region": "region",
    "order.channel": "channel_id",
  };
  const sorted = [...groups.entries()].sort(([ka, a], [kb, b]) => {
    let comparison: number;
    if (p.order_by.field === "orders_count") comparison = a.count - b.count;
    else if (p.order_by.field === "orders_total_rub") comparison = a.total.comparedTo(b.total);
    else {
      const av = String(a.values[fieldKey[p.order_by.field]] ?? ""),
        bv = String(b.values[fieldKey[p.order_by.field]] ?? "");
      comparison = av < bv ? -1 : av > bv ? 1 : 0;
    }
    return (p.order_by.direction === "desc" ? -comparison : comparison) || (ka < kb ? -1 : ka > kb ? 1 : 0);
  });
  const rows = sorted.map(([, g]) => ({
    ...g.values,
    ...(p.measures.includes("orders_count") ? { orders_count: g.count } : {}),
    ...(needTotal ? { orders_total_rub: g.total.toFixed() } : {}),
  }));
  const page = rows.slice(p.offset, p.offset + p.limit);
  while (Buffer.byteLength(JSON.stringify(page)) > 80000 && page.length) page.pop();
  if (!page.length && rows.length > p.offset)
    throw new Error("STORAGE_LIMIT: Document aggregate row exceeds inline budget.");
  const warnings: string[] = [];
  if (excluded.missing_city) warnings.push("Orders without an explicitly provided city were excluded and counted.");
  if (missing.region)
    warnings.push(
      "Missing regions remain null/absent. No region is inferred from city, postal code, address text or another order.",
    );
  if (unresolved.documents)
    warnings.push(
      "Some potentially matching orders are excluded because required data is unresolved; counts and totals cover only resolved orders and the ranking is provisional.",
    );
  if (!process.env.MOYSKLAD_REPORT_TIMEZONE)
    warnings.push("Source accounting timezone defaults to Europe/Moscow; operator should confirm it.");
  const result: any = {
    status: unresolved.documents ? "partial" : "complete",
    data_complete: unresolved.documents === 0,
    rows: page,
    total_groups: rows.length,
    returned: page.length,
    offset: p.offset,
    next_offset: p.offset + page.length < rows.length ? p.offset + page.length : null,
    metadata: {
      source: "customerorder",
      dataset: "orders",
      grain: "documents",
      period: p.date_range,
      timezone: p.date_range!.timezone,
      source_timezone: period.apiTimezone,
      generated_at: new Date().toISOString(),
      documents_processed: processed,
      documents_eligible_by_posting_and_cancellation: eligible,
      documents_matched: matched,
      positions_processed: 0,
      source_missing: sourceMissing,
      missing,
      excluded,
      unresolved,
      counter_units: "documents; excluded categories are mutually exclusive; unresolved reasons may overlap",
      source_complete: true,
      answer_complete: unresolved.documents === 0,
      warnings,
      filters: p.filters,
      dimensions: p.dimensions,
      measures: p.measures,
      order_by: p.order_by,
      order_policy: {
        include_unposted: p.include_unposted,
        exclude_cancelled: excludeCancelled,
        explicit_status_selection: explicitStates,
        cancelled_state_ids: policy ? [...policy.cancelledIds] : [],
        deleted: "excluded by active entity source; encountering deleted rows aborts",
      },
      geography_policy: {
        city_source: "shipmentAddressFull.city",
        region_source: "shipmentAddressFull.region",
        include_missing_city: p.include_missing_city,
        missing_region: "null/absent, never inferred",
        normalization: "trim only; no spelling fixes, aliases or geocoding",
      },
      currency_policy: needTotal
        ? "Confirmed RUB documents only; unresolved/unsupported currencies excluded with counters; no conversion"
        : "Currency does not restrict order counts",
      amount_formula:
        "sum_kopecks/100 once per selected document, including delivery/services present in document total; no average check",
      timings_ms: {
        source: Math.round(loaded - started),
        aggregation: Math.round(performance.now() - loaded),
        total: Math.round(performance.now() - started),
      },
      snapshot: {
        id: snapshot.id,
        schema_version: 2,
        grain: "documents",
        captured_from: snapshot.captured_from,
        captured_to: snapshot.captured_to,
        expires_at: snapshot.expires_at,
        reused,
        consistency: "non_transactional capture; IDs, counts, selected headers, totals and geography verified twice",
      },
      interpretation:
        "Order-level counts and full document totals, independent of positions, units, services or product catalog. Missing region is not a geographic region; use order.delivery.region is_set=true to restrict to explicitly provided regions.",
    },
  };
  if (p.output === "file") result.export = await createExport({ metadata: result.metadata, rows });
  return JSON.stringify(result);
}
