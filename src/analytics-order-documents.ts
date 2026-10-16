import { createHash, randomUUID } from "node:crypto";
import { moyskladGet } from "./client.js";
import { entityId, type ApiEntity } from "./analytics-data.js";
import { sourcePages } from "./streaming-source.js";
import { atomicWrite, credentialScope, readJson, readLines, storePath } from "./report-store.js";
import { reportProgress, checkCancelled } from "./report-context.js";
import { queryPeriod, type AnalyticsQuery } from "./analytics-query-schema.js";

export interface DocumentOrder {
  id: string;
  updated: unknown;
  moment: unknown;
  applicable: unknown;
  state_id: string | null;
  channel_id: string | null;
  currency_id: string | null;
  deleted: unknown;
  sum: unknown;
  city: string | null;
  city_present: boolean;
  region: { id: string | null; name: string | null; present: boolean };
}
export interface DocumentSnapshot {
  id: string;
  schema_version: 2;
  grain: "documents";
  complete: boolean;
  files: string[];
  documents: number;
  states: ApiEntity[];
  currencies: ApiEntity[];
  captured_from: string;
  captured_to: string;
  expires_at: string;
}
const label = (v: unknown) =>
  typeof v === "string" && v.trim().length > 0 && v.trim().length <= 300 ? v.trim() : null;
export function projectOrderDocument(doc: ApiEntity): DocumentOrder {
  const address = doc.shipmentAddressFull ?? {},
    raw = address.region;
  const cityPresent =
    address.city !== null &&
    address.city !== undefined &&
    address.city !== "" &&
    !(typeof address.city === "string" && !address.city.trim());
  const regionPresent = raw !== null && raw !== undefined && raw !== "" && !(typeof raw === "string" && !raw.trim());
  return {
    id: doc.id,
    updated: doc.updated ?? null,
    moment: doc.moment ?? null,
    applicable: doc.applicable ?? null,
    state_id: entityId(doc.state),
    channel_id: entityId(doc.salesChannel),
    currency_id: entityId(doc.rate?.currency),
    deleted: doc.deleted ?? false,
    sum: doc.sum ?? null,
    city: label(address.city),
    city_present: cityPresent,
    region: {
      id: typeof raw === "object" && raw ? entityId(raw) : null,
      name: label(typeof raw === "string" ? raw : raw?.name),
      present: regionPresent,
    },
  };
}
export async function captureOrderDocuments(p: AnalyticsQuery) {
  const period = queryPeriod(p),
    scope = credentialScope();
  const key = createHash("sha256")
    .update(JSON.stringify(["order-documents-v2", scope, period.apiFrom, period.apiTo, period.apiTimezone]))
    .digest("hex");
  const index = storePath(scope, "captures", `order-documents-${key}.json`);
  const existing = await readJson<DocumentSnapshot>(index).catch(() => null);
  if (
    existing?.schema_version === 2 &&
    existing.grain === "documents" &&
    existing.complete &&
    !p.refresh_source &&
    Date.parse(existing.expires_at) > Date.now()
  ) {
    const snapshot = await readJson<DocumentSnapshot>(storePath(scope, "captures", existing.id, "manifest.json")).catch(
      () => null,
    );
    if (snapshot?.schema_version === 2 && snapshot.grain === "documents" && snapshot.complete) {
      await reportProgress(
        "aggregate_documents",
        { source_reused: 1, expected_documents: snapshot.documents },
        { capture_id: snapshot.id },
      );
      return { snapshot, period, reused: true };
    }
  }
  const snapshot: DocumentSnapshot = {
    id: randomUUID(),
    schema_version: 2,
    grain: "documents",
    complete: false,
    files: [],
    documents: 0,
    states: [],
    currencies: [],
    captured_from: new Date().toISOString(),
    captured_to: "",
    expires_at: new Date(Date.now() + 300000).toISOString(),
  };
  await reportProgress("fetch_orders", {}, { capture_id: snapshot.id });
  const metadata = (await moyskladGet("/entity/customerorder/metadata")) as ApiEntity;
  snapshot.states = (Array.isArray(metadata.states) ? metadata.states : (metadata.states?.rows ?? [])).map(
    (s: ApiEntity) => ({ id: s.id, name: s.name, stateType: s.stateType }),
  );
  if (!snapshot.states.length) throw new Error("INCOMPLETE_SOURCE: Missing order status reference.");
  {
    for await (const page of sourcePages("/entity/currency", { limit: 1000 })) {
      snapshot.currencies.push(...page.rows.map((c) => ({ id: c.id, isoCode: c.isoCode, code: c.code })));
      if (snapshot.currencies.length > 10000) throw new Error("STORAGE_LIMIT: Currency reference budget exceeded.");
    }
  }
  const filter = `moment>=${period.apiFrom};moment<${period.apiTo}`;
  const signatures = new Map<string, string>();
  for await (const page of sourcePages("/entity/customerorder?order=moment,asc", { filter, limit: 200 })) {
    if (page.expected > 50000) throw new Error("STORAGE_LIMIT: Order document budget exceeded.");
    const docs = page.rows.map(projectOrderDocument);
    for (const doc of docs) {
      if (typeof doc.id !== "string" || !doc.id || signatures.has(doc.id))
        throw new Error("INCOMPLETE_SOURCE: Missing or duplicate order ID.");
      signatures.set(doc.id, createHash("sha256").update(JSON.stringify(doc)).digest("hex"));
    }
    const file = `orders-${snapshot.files.length}.ndjson`,
      text = docs.map((d) => JSON.stringify(d) + "\n").join("");
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new Error("STORAGE_LIMIT: Document capture page budget exceeded.");
    await atomicWrite(storePath(scope, "captures", snapshot.id, file), text);
    snapshot.files.push(file);
    snapshot.documents += docs.length;
    await reportProgress("fetch_orders", {
      expected_documents: page.expected,
      processed_documents: docs.length,
      captured_documents_bytes: Buffer.byteLength(text),
    });
  }
  let verified = 0;
  const seen = new Set<string>();
  for await (const page of sourcePages("/entity/customerorder?order=moment,asc", { filter, limit: 200 })) {
    if (page.expected !== snapshot.documents) throw new Error("INCOMPLETE_SOURCE: Order count changed during capture.");
    for (const raw of page.rows) {
      const doc = projectOrderDocument(raw),
        hash = createHash("sha256").update(JSON.stringify(doc)).digest("hex");
      if (seen.has(doc.id) || signatures.get(doc.id) !== hash)
        throw new Error("INCOMPLETE_SOURCE: Order geography, total or header changed during capture.");
      seen.add(doc.id);
      verified++;
    }
    await reportProgress("verify_orders", { verified_documents: page.rows.length });
  }
  if (verified !== snapshot.documents) throw new Error("INCOMPLETE_SOURCE: Incomplete document verification.");
  snapshot.complete = true;
  snapshot.captured_to = new Date().toISOString();
  snapshot.expires_at = new Date(Date.now() + 300000).toISOString();
  await atomicWrite(storePath(scope, "captures", snapshot.id, "manifest.json"), JSON.stringify(snapshot));
  await atomicWrite(index, JSON.stringify(snapshot));
  return { snapshot, period, reused: false };
}
export async function* documentOrders(snapshot: DocumentSnapshot) {
  for (const file of snapshot.files)
    for await (const doc of readLines(storePath(credentialScope(), "captures", snapshot.id, file))) {
      checkCancelled();
      yield doc as DocumentOrder;
    }
}
export async function sourceRegion(region: DocumentOrder["region"], snapshot: DocumentSnapshot) {
  if (!region.present) return { id: null, name: null, status: "absent" as const };
  if (region.name) return { id: region.id, name: region.name, status: "provided" as const };
  if (!region.id || !/^[a-zA-Z0-9-]{1,100}$/.test(region.id))
    return { id: region.id, name: null, status: "unresolved" as const };
  const hash = createHash("sha256").update(region.id).digest("hex");
  const path = storePath(credentialScope(), "captures", snapshot.id, `region-${hash}.json`);
  let saved = await readJson<{ id: string; name: string | null; status: "provided" | "unresolved" }>(path).catch(
    () => null,
  );
  if (!saved) {
    try {
      const value = (await moyskladGet(`/entity/region/${encodeURIComponent(region.id)}`)) as ApiEntity;
      const name = label(value.name);
      if (entityId(value) !== region.id) throw new Error("INCOMPLETE_SOURCE: Region reference identity mismatch.");
      saved = { id: region.id, name, status: name ? "provided" : "unresolved" };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("API_HTTP_404:")) throw error;
      saved = { id: region.id, name: null, status: "unresolved" };
    }
    await atomicWrite(path, JSON.stringify(saved));
  }
  return saved;
}
