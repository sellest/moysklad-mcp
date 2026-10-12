import { moyskladGet } from "./client.js";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { atomicWrite, readJson, storePath } from "./report-store.js";
import { reportContext, reportProgress } from "./report-context.js";
import type { ApiEntity } from "./analytics-data.js";
export function catalogCardPath(scope: string, catalogId: string, type: string, id: string) {
  return storePath(scope, "catalog", catalogId, createHash("sha256").update(`${type}:${id}`).digest("hex") + ".json");
}
export function isExpandedEntity(type: string, value?: ApiEntity) {
  return (
    !!value &&
    typeof value.name === "string" &&
    (type === "variant"
      ? Array.isArray(value.characteristics) && !!value.product
      : type === "service" || type === "bundle" || "pathName" in value)
  );
}
export async function saveExpandedCard(type: string, id: string, value: ApiEntity) {
  const run = reportContext.getStore();
  if (!run?.catalogId || !isExpandedEntity(type, value)) return;
  const path = catalogCardPath(run.scope, run.catalogId, type, id);
  if (await readJson(path).catch(() => null)) return;
  await atomicWrite(path, JSON.stringify(value));
  await reportProgress("fetch_positions", { catalog_embedded_cards: 1 });
}
export async function migrateLegacyCatalog(scope: string, snapshotId: string) {
  const target = storePath(scope, "catalog", snapshotId);
  if ((await readdir(target).catch(() => [])).some((name) => /^[a-f0-9]{64}\.json$/.test(name))) return;
  const candidates: { id: string; finished: number }[] = [];
  for (const name of await readdir(storePath(scope, "jobs")).catch(() => [])) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const job = await readJson(storePath(scope, "jobs", name)).catch(() => null);
    if (job?.state === "succeeded" && job.result?.snapshot?.id === snapshotId)
      candidates.push({ id: job.job_id, finished: Date.parse(job.finished_at) });
  }
  candidates.sort((a, b) => b.finished - a.finished);
  for (const candidate of candidates) {
    const names = await readdir(storePath(scope, "catalog", candidate.id)).catch(() => []);
    if (!names.length) continue;
    for (const name of names)
      if (/^[a-f0-9]{64}\.json$/.test(name)) {
        const card = await readJson(storePath(scope, "catalog", candidate.id, name));
        await atomicWrite(storePath(scope, "catalog", snapshotId, name), JSON.stringify(card));
        await reportProgress("enrich_catalog", { catalog_migrated_cards: 1 });
      }
    return;
  }
}
export async function completeCatalog(scope: string, catalogId: string, snapshotId: string, expiresAt: string) {
  const names = (await readdir(storePath(scope, "catalog", catalogId)).catch(() => []))
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .sort();
  const hash = createHash("sha256");
  for (const name of names)
    hash.update(name + JSON.stringify(await readJson(storePath(scope, "catalog", catalogId, name))));
  const manifest = {
    id: catalogId,
    snapshot_id: snapshotId,
    version: hash.digest("hex").slice(0, 20),
    card_count: names.length,
    checked_at: new Date().toISOString(),
    expires_at: expiresAt,
    complete: true,
  };
  await atomicWrite(storePath(scope, "catalog", catalogId, "manifest.json"), JSON.stringify(manifest));
  await atomicWrite(
    storePath(scope, "captures", snapshotId, "catalog-current.json"),
    JSON.stringify({ id: catalogId, complete: true }),
  );
  return manifest;
}

/** Fetch only missing UUID cards, at most twenty per API response. */
export async function prefetchCatalog(references: ApiEntity[], refresh = false) {
  const run = reportContext.getStore();
  if (!run?.catalogId) return;
  const groups = new Map<string, Map<string, ApiEntity>>();
  const unique = new Map<string, ApiEntity>();
  for (const card of references) unique.set(`${card.meta?.type}:${card.id ?? card.meta?.href}`, card);
  for (const card of unique.values()) {
    const type = card.meta?.type;
    const id = card.id ?? card.meta?.href?.split("?")[0].split("/").pop();
    if (!["product", "variant", "service", "bundle"].includes(type) || !/^[a-f0-9-]{36}$/i.test(id ?? "")) continue;
    const path = catalogCardPath(run.scope, run.catalogId, type, id);
    if (await readJson(path).catch(() => null)) continue;
    if (!refresh && isExpandedEntity(type, card)) {
      await saveExpandedCard(type, id, card);
      continue;
    }
    if (!groups.has(type)) groups.set(type, new Map());
    groups.get(type)!.set(id, card);
  }
  for (const [type, cards] of groups) {
    const ids = [...cards.keys()];
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = ids.slice(offset, offset + 20);
      if (batch.length < 2) continue; // A single reference uses the normal cached getter.
      const query = new URLSearchParams({ filter: batch.map((id) => "id=" + id).join(";"), limit: "20", offset: "0" });
      if (type === "variant") query.set("expand", "product");
      await reportProgress("enrich_catalog", { catalog_batch_requests: 1 });
      const response = (await moyskladGet("/entity/" + type + "?" + query)) as {
        rows?: ApiEntity[];
        meta?: { size?: number };
      };
      if (
        !Array.isArray(response.rows) ||
        response.meta?.size !== response.rows.length ||
        response.rows.length > batch.length
      )
        throw new Error("INCOMPLETE_PAGE: Catalog batch total invalid.");
      const seen = new Set<string>();
      for (const card of response.rows) {
        if (!batch.includes(card.id) || seen.has(card.id) || card.meta?.type !== type)
          throw new Error("INCOMPLETE_PAGE: Catalog batch identity mismatch.");
        seen.add(card.id);
        await atomicWrite(catalogCardPath(run.scope, run.catalogId, type, card.id), JSON.stringify(card));
        if (type === "variant" && card.product?.id) await saveExpandedCard("product", card.product.id, card.product);
      }
      await reportProgress("enrich_catalog", { catalog_batch_cards: seen.size });
      // Missing/archived IDs fall back to individual GETs; they are never silently dropped.
    }
  }
}
