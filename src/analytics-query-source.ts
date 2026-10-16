import { createHash, randomUUID } from "node:crypto";
import { moyskladGet } from "./client.js";
import { cachedEntity, entityId, type ApiEntity } from "./analytics-data.js";
import { sourcePages } from "./streaming-source.js";
import { prefetchCatalog, completeCatalog } from "./snapshot-catalog.js";
import { atomicWrite, credentialScope, readJson, readLines, storePath } from "./report-store.js";
import { checkCancelled, reportContext, reportProgress } from "./report-context.js";
import { type AnalyticsQuery, queryPeriod } from "./analytics-query-schema.js";

export type QueryLine = { order: ApiEntity; position: ApiEntity };
export interface OrderSnapshot {
  id: string;
  complete: boolean;
  files: string[];
  documents: number;
  positions: number;
  captured_from: string;
  captured_to: string;
  expires_at: string;
  catalog_version: string;
  states: ApiEntity[];
  folders: ApiEntity[];
  currencies: ApiEntity[];
  units: ApiEntity[];
}
function header(doc: ApiEntity) {
  return {
    id: doc.id,
    updated: doc.updated ?? null,
    moment: doc.moment ?? null,
    applicable: doc.applicable ?? null,
    state_id: entityId(doc.state),
    channel_id: entityId(doc.salesChannel),
    currency_id: entityId(doc.rate?.currency),
    deleted: doc.deleted ?? false,
  };
}
async function reference(type: string) {
  const rows: ApiEntity[] = [];
  for await (const page of sourcePages(`/entity/${type}`, { limit: 1000 })) {
    rows.push(...page.rows);
    if (rows.length > 10000) throw new Error("STORAGE_LIMIT: Reference dictionary too large.");
  }
  return rows;
}
export async function orderSnapshot(p: AnalyticsQuery) {
  const period = queryPeriod(p),
    scope = credentialScope(),
    run = reportContext.getStore()!;
  const key = createHash("sha256")
    .update(JSON.stringify(["orders-v1", scope, period.apiFrom, period.apiTo, period.apiTimezone]))
    .digest("hex");
  const index = storePath(scope, "captures", `orders-${key}.json`);
  let snapshot = await readJson<OrderSnapshot>(index).catch(() => null);
  if (snapshot?.complete && !p.refresh_source && Date.parse(snapshot.expires_at) > Date.now()) {
    const manifest = await readJson<OrderSnapshot>(storePath(scope, "captures", snapshot.id, "manifest.json")).catch(
      () => null,
    );
    if (manifest?.complete) {
      snapshot = manifest;
      run.catalogId = snapshot.id;
      await reportProgress(
        "aggregate_orders",
        { source_reused: 1, expected_documents: snapshot.documents, expected_positions: snapshot.positions },
        { capture_id: snapshot.id, catalog_id: snapshot.id },
      );
      return { snapshot, period, reused: true };
    }
  }
  const id = randomUUID();
  run.catalogId = id;
  snapshot = {
    id,
    complete: false,
    files: [],
    documents: 0,
    positions: 0,
    captured_from: new Date().toISOString(),
    captured_to: "",
    expires_at: new Date(Date.now() + 300000).toISOString(),
    catalog_version: "",
    states: [],
    folders: [],
    currencies: [],
    units: [],
  };
  await reportProgress("fetch_orders", {}, { capture_id: id, catalog_id: id });
  const metadata = (await moyskladGet("/entity/customerorder/metadata")) as ApiEntity;
  snapshot.states = (Array.isArray(metadata.states) ? metadata.states : (metadata.states?.rows ?? [])).map(
    (s: ApiEntity) => ({ id: s.id, name: s.name, stateType: s.stateType }),
  );
  if (!snapshot.states.length) throw new Error("INCOMPLETE_SOURCE: Order states missing.");
  // Sequential reference reads share the existing account-wide upstream rate limiter.
  snapshot.folders = (await reference("productfolder")).map((f) => ({
    id: f.id,
    name: f.name,
    pathName: f.pathName ?? "",
  }));
  snapshot.currencies = (await reference("currency")).map((c) => ({ id: c.id, isoCode: c.isoCode, code: c.code }));
  snapshot.units = (await reference("uom")).map((u) => ({ id: u.id, code: u.code, name: u.name }));
  const filter = `moment>=${period.apiFrom};moment<${period.apiTo}`;
  const signatures = new Map<string, string>();
  for await (const page of sourcePages("/entity/customerorder?order=moment,asc", {
    filter,
    expand: "positions.assortment",
    limit: 50,
  })) {
    if (page.expected > 50000) throw new Error("STORAGE_LIMIT: Order document budget exceeded.");
    await reportProgress("fetch_orders", { expected_documents: page.expected });
    const lines: QueryLine[] = [];
    const cards: ApiEntity[] = [];
    for (const doc of page.rows) {
      checkCancelled();
      if (typeof doc.id !== "string" || signatures.has(doc.id))
        throw new Error("INCOMPLETE_SOURCE: Missing or duplicate order ID.");
      signatures.set(doc.id, JSON.stringify(header(doc)));
      const expanded = doc.positions;
      if (!Number.isSafeInteger(expanded?.meta?.size) || expanded.meta.size < 0)
        throw new Error("INCOMPLETE_SOURCE: Missing position count.");
      const complete =
        Array.isArray(expanded.rows) &&
        (expanded.meta.offset ?? 0) === 0 &&
        expanded.rows.length === expanded.meta.size;
      const pages = complete
        ? (async function* () {
            yield { rows: expanded.rows, expected: expanded.meta.size };
          })()
        : sourcePages(`/entity/customerorder/${doc.id}/positions`, { expand: "assortment", limit: 100 });
      const seen = new Set<string>();
      for await (const positions of pages) {
        if (positions.expected !== expanded.meta.size || positions.expected > 10000)
          throw new Error("INCOMPLETE_SOURCE: Positions changed or exceed budget.");
        for (const position of positions.rows) {
          if (!position.id || seen.has(position.id))
            throw new Error("INCOMPLETE_SOURCE: Missing or duplicate position ID.");
          seen.add(position.id);
          const a = position.assortment ?? {};
          cards.push(a);
          if (a.product) cards.push(a.product);
          lines.push({
            order: header(doc),
            position: {
              id: position.id,
              quantity: position.quantity ?? null,
              price: position.price ?? null,
              discount: position.discount ?? null,
              assortment: {
                id: entityId(a),
                meta: { type: a.meta?.type ?? null },
                product: { id: entityId(a.product) },
              },
            },
          });
          if (++snapshot.positions > 1000000) throw new Error("STORAGE_LIMIT: Order position budget exceeded.");
          if (lines.length >= 1000) {
            await saveLines(snapshot, lines, cards, p);
            lines.length = 0;
            cards.length = 0;
          }
        }
      }
      if (seen.size !== expanded.meta.size) throw new Error("INCOMPLETE_SOURCE: Incomplete order positions.");
      snapshot.documents++;
    }
    await saveLines(snapshot, lines, cards, p);
    await reportProgress("fetch_orders", { processed_documents: page.rows.length });
  }
  let verified = 0;
  const seen = new Set<string>();
  for await (const page of sourcePages("/entity/customerorder?order=moment,asc", { filter, limit: 1000 })) {
    if (page.expected !== snapshot.documents) throw new Error("INCOMPLETE_SOURCE: Order count changed during capture.");
    for (const doc of page.rows) {
      if (seen.has(doc.id) || signatures.get(doc.id) !== JSON.stringify(header(doc)))
        throw new Error("INCOMPLETE_SOURCE: Order changed during capture.");
      seen.add(doc.id);
      verified++;
    }
    await reportProgress("verify_orders", { verified_documents: page.rows.length });
  }
  if (verified !== snapshot.documents) throw new Error("INCOMPLETE_SOURCE: Incomplete verification.");
  snapshot.captured_to = new Date().toISOString();
  snapshot.expires_at = new Date(Date.now() + 300000).toISOString();
  snapshot.catalog_version = (await completeCatalog(scope, id, id, snapshot.expires_at)).version;
  snapshot.complete = true;
  await atomicWrite(storePath(scope, "captures", id, "manifest.json"), JSON.stringify(snapshot));
  await atomicWrite(index, JSON.stringify(snapshot));
  return { snapshot, period, reused: false };
}
export async function* orderLines(snapshot: OrderSnapshot) {
  for (const file of snapshot.files)
    for await (const line of readLines(storePath(credentialScope(), "captures", snapshot.id, file))) {
      checkCancelled();
      yield line as QueryLine;
    }
}

async function saveLines(snapshot: OrderSnapshot, lines: QueryLine[], cards: ApiEntity[], p: AnalyticsQuery) {
  if (!lines.length) return;
  await prefetchCatalog(cards, p.refresh_source);
  const unique = new Map<string, ApiEntity>();
  for (const card of cards) {
    const cardId = entityId(card),
      type = card.meta?.type;
    if (cardId && ["product", "variant", "bundle"].includes(type)) unique.set(`${type}:${cardId}`, card);
  }
  const parents: ApiEntity[] = [];
  for (const card of unique.values()) {
    const loaded = await cachedEntity(card.meta.type, entityId(card)!, card, p.refresh_source);
    if (loaded.product) parents.push(loaded.product);
  }
  await prefetchCatalog(parents, p.refresh_source);
  for (const parent of parents) {
    const parentId = entityId(parent);
    if (parentId) await cachedEntity("product", parentId, parent, p.refresh_source);
  }
  const file = `lines-${snapshot.files.length}.ndjson`;
  const text = lines.map((l) => JSON.stringify(l) + "\n").join("");
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("STORAGE_LIMIT: Order capture page budget exceeded.");
  await atomicWrite(storePath(credentialScope(), "captures", snapshot.id, file), text);
  snapshot.files.push(file);
  await reportProgress("fetch_orders", { captured_positions: lines.length });
}
