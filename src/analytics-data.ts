import { createHash, randomUUID } from "node:crypto";
import { moyskladGet } from "./client.js";
import { buildFilter, listQuery } from "./lib.js";
import { getExportScope } from "./output.js";
import { normalizeReportMoment, type ReportPeriod } from "./report-lib.js";

export type ApiEntity = Record<string, any>;
type CachedEntity = { value: ApiEntity; checked: number };
const cache = new Map<string, CachedEntity>();
const pending = new Map<string, Promise<ApiEntity>>();
const cacheTtl = 5 * 60 * 1000;
export const cacheRules = {
  ttl_seconds: 300,
  refresh: "refresh_catalog=true bypasses cached cards; embedded changed updated also refreshes",
  scope: "credential-specific, in-process; no disk cache of business cards",
};

export async function cachedEntity(
  type: string,
  id: string,
  embedded?: ApiEntity,
  refresh = false,
): Promise<ApiEntity> {
  if (!/^[a-z]+$/.test(type) || !/^[\w-]+$/.test(id)) throw new Error("ENTITY_ID: invalid type or id.");
  const key = `${getExportScope()}:${type}:${id}`;
  const existing = cache.get(key);
  if (
    !refresh &&
    existing &&
    Date.now() - existing.checked < cacheTtl &&
    (!embedded?.updated || embedded.updated === existing.value.updated)
  )
    return existing.value;
  const active = pending.get(key);
  if (active) return active;
  const promise = (async () => {
    // API expansions are fresh, full entity snapshots; references are not.
    const isFull =
      embedded &&
      typeof embedded.name === "string" &&
      (type === "variant" ? Array.isArray(embedded.characteristics) && embedded.product : "pathName" in embedded);
    const value = !refresh && isFull ? embedded : ((await moyskladGet(`/entity/${type}/${id}`)) as ApiEntity);
    cache.set(key, { value, checked: Date.now() });
    return value;
  })();
  pending.set(key, promise);
  try {
    return await promise;
  } finally {
    pending.delete(key);
  }
}

export function entityId(entity: ApiEntity | undefined): string | null {
  return entity?.id ?? entity?.meta?.href?.split("?")[0].split("/").pop() ?? null;
}

export function catalogVersion(): { version: string; checked_at: string | null; cache: typeof cacheRules } {
  const scoped = [...cache.entries()]
    .filter(([key]) => key.startsWith(`${getExportScope()}:`))
    .sort(([a], [b]) => a.localeCompare(b));
  return {
    version: createHash("sha256")
      .update(JSON.stringify(scoped.map(([key, entry]) => [key.split(":").slice(1).join(":"), entry.value])))
      .digest("hex")
      .slice(0, 20),
    checked_at: scoped.length ? new Date(Math.min(...scoped.map(([, entry]) => entry.checked))).toISOString() : null,
    cache: cacheRules,
  };
}

export function clearCatalogCache(): void {
  cache.clear();
  pending.clear();
}

export async function fetchAllPages(
  path: string,
  options: { filter?: string; expand?: string; limit?: number } = {},
): Promise<ApiEntity[]> {
  const rows: ApiEntity[] = [];
  const limit = options.limit ?? (options.expand ? 100 : 1000);
  let offset = 0;
  let expectedTotal: number | undefined;
  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const result = (await moyskladGet(`${path}${separator}${listQuery({ ...options, limit, offset })}`)) as {
      meta?: { size?: number; offset?: number };
      rows?: ApiEntity[];
    };
    if (!Array.isArray(result.rows) || typeof result.meta?.size !== "number")
      throw new Error("INCOMPLETE_PAGE: API did not return rows and total; report aborted.");
    if (expectedTotal !== undefined && result.meta.size !== expectedTotal)
      throw new Error("SOURCE_CHANGED: total changed during pagination; retry report.");
    expectedTotal = result.meta.size;
    if (result.meta.offset !== undefined && result.meta.offset !== offset)
      throw new Error("INCOMPLETE_PAGE: unexpected offset.");
    rows.push(...result.rows);
    if (rows.length === expectedTotal) return rows;
    if (rows.length > expectedTotal || result.rows.length === 0)
      throw new Error("INCOMPLETE_PAGE: missing or inconsistent rows.");
    offset += result.rows.length;
  }
}

export interface AnalyticsPeriod extends ReportPeriod {
  organization_hrefs?: string[];
  refresh_catalog?: boolean;
  refresh_source?: boolean;
}
export interface SourceLine {
  document_id: string;
  document_type: string;
  moment: string;
  position: ApiEntity;
  assortment: ApiEntity;
  product: ApiEntity | null;
  parent_product_id: string | null;
  kind: "sold" | "returned";
}

async function loadSourceLinesUncached(
  params: AnalyticsPeriod,
  previous?: LoadedSource,
): Promise<{ lines: SourceLine[]; documents: Record<string, number>; catalog: ReturnType<typeof catalogVersion> }> {
  if (!params.moment_from || !params.moment_to) throw new Error("PERIOD_REQUIRED: specify both report dates.");
  const from = normalizeReportMoment(params.moment_from);
  const to = normalizeReportMoment(params.moment_to, true);
  if (Date.parse(from.replace(" ", "T") + "Z") > Date.parse(to.replace(" ", "T") + "Z"))
    throw new Error("PERIOD_ORDER: start exceeds end.");
  const organizations = params.organization_hrefs?.length ? params.organization_hrefs : [params.organization_href];
  const lines: SourceLine[] = previous
    ? previous.lines.map((line) => ({
        ...line,
        assortment: line.position.assortment ?? {},
        product: null,
        parent_product_id: null,
      }))
    : [];
  const documents: Record<string, number> = previous ? { ...previous.documents } : {};
  const hydrated = new Map<string, Promise<ApiEntity>>();
  async function hydrate(type: string, id: string, embedded?: ApiEntity) {
    const key = `${type}:${id}`;
    if (!hydrated.has(key)) hydrated.set(key, cachedEntity(type, id, embedded, params.refresh_catalog));
    return await hydrated.get(key)!;
  }
  if (!previous)
    for (const type of ["demand", "salesreturn", "retaildemand", "retailsalesreturn"]) {
      const seen = new Set<string>();
      documents[type] = 0;
      for (const organization of organizations) {
        const filter = buildFilter([
          ["moment", from, ">="],
          ["moment", to, "<="],
          ["applicable", "true"],
          ["organization", organization ?? ""],
        ]);
        const docs = await fetchAllPages(`/entity/${type}`, { filter, expand: "positions.assortment", limit: 100 });
        for (const doc of docs) {
          if (!doc.id) throw new Error("DOCUMENT_ID: missing id.");
          if (seen.has(doc.id)) continue;
          seen.add(doc.id);
          documents[type]++;
          const expanded = doc.positions as
            | { meta?: { size?: number; offset?: number }; rows?: ApiEntity[] }
            | undefined;
          const complete =
            typeof expanded?.meta?.size === "number" &&
            (expanded.meta.offset ?? 0) === 0 &&
            expanded.rows?.length === expanded.meta.size;
          const positions = complete
            ? expanded!.rows!
            : await fetchAllPages(`/entity/${type}/${doc.id}/positions`, { expand: "assortment", limit: 100 });
          for (const position of positions) {
            lines.push({
              document_id: doc.id,
              document_type: type,
              moment: doc.moment ?? null,
              position,
              assortment: position.assortment ?? {},
              product: null,
              parent_product_id: null,
              kind: type === "demand" || type === "retaildemand" ? "sold" : "returned",
            });
          }
        }
      }
    }
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(5, lines.length) }, async () => {
      while (cursor < lines.length) {
        const line = lines[cursor++];
        const id = entityId(line.assortment);
        const type = line.assortment.meta?.type;
        if (id && type === "variant") {
          line.assortment = await hydrate("variant", id, line.assortment);
          line.parent_product_id = entityId(line.assortment.product);
          if (line.parent_product_id)
            line.product = await hydrate("product", line.parent_product_id, line.assortment.product);
        } else if (id && type === "product") {
          line.parent_product_id = id;
          line.product = await hydrate("product", id, line.assortment);
        }
      }
    }),
  );
  return { lines, documents, catalog: catalogVersion() };
}

export interface SourceSnapshot {
  id: string;
  captured_at: string;
  loaded_at: string;
  expires_at: string;
  reused: boolean;
  freshness: "frozen document positions and catalog enrichment; not a transactional API snapshot";
}
export interface LoadedSource {
  lines: SourceLine[];
  documents: Record<string, number>;
  catalog: ReturnType<typeof catalogVersion>;
  snapshot?: SourceSnapshot;
}
const sources = new Map<string, { value: LoadedSource; expires: number }>();
const sourcePending = new Map<
  string,
  { promise: Promise<LoadedSource>; refreshCatalog: boolean; freshDocuments: boolean }
>();
const sourceTtl = 300000;
export function clearSourceCache() {
  sources.clear();
  sourcePending.clear();
}
export function sourceCacheDiagnostics() {
  return { entries: sources.size, pending: sourcePending.size, ttl_seconds: sourceTtl / 1000, capacity: 8 };
}
export async function loadSourceLines(params: AnalyticsPeriod): Promise<LoadedSource> {
  if (!params.moment_from || !params.moment_to) throw new Error("PERIOD_REQUIRED: specify both report dates.");
  const from = normalizeReportMoment(params.moment_from),
    to = normalizeReportMoment(params.moment_to, true);
  if (Date.parse(from.replace(" ", "T") + "Z") > Date.parse(to.replace(" ", "T") + "Z"))
    throw new Error("PERIOD_ORDER: start exceeds end.");
  const organizations = [
    ...new Set(
      params.organization_hrefs?.length
        ? params.organization_hrefs
        : params.organization_href
          ? [params.organization_href]
          : [],
    ),
  ].sort();
  const key = createHash("sha256")
    .update(JSON.stringify([getExportScope(), from, to, organizations]))
    .digest("hex");
  for (const [id, entry] of sources) if (entry.expires <= Date.now()) sources.delete(id);
  const cached = sources.get(key);
  if (cached && !params.refresh_source && !params.refresh_catalog)
    return { ...cached.value, snapshot: { ...cached.value.snapshot!, reused: true } };
  // Requests with the same scope share the in-flight refresh, including concurrent explicit refreshes.
  const active = sourcePending.get(key);
  if (active) {
    const needsCards = params.refresh_catalog && !active.refreshCatalog;
    const needsDocuments = params.refresh_source && !active.freshDocuments;
    if (needsCards || needsDocuments) {
      await active.promise;
      return loadSourceLines({ ...params, refresh_source: !!needsDocuments });
    }
    return active.promise;
  }
  const captured = Date.now();
  const promise = (async () => {
    const reuseDocuments = cached && !params.refresh_source ? cached : undefined;
    const source = await loadSourceLinesUncached(
      { ...params, organization_hrefs: organizations },
      reuseDocuments?.value,
    );
    const loaded = Date.now(),
      expires = reuseDocuments?.expires ?? loaded + sourceTtl;
    const value: LoadedSource = {
      ...source,
      snapshot: {
        id: createHash("sha256")
          .update(`${key}:${captured}:${loaded}:${source.catalog.version}:${randomUUID()}`)
          .digest("hex")
          .slice(0, 20),
        captured_at: reuseDocuments?.value.snapshot!.captured_at ?? new Date(captured).toISOString(),
        loaded_at: new Date(loaded).toISOString(),
        expires_at: new Date(expires).toISOString(),
        reused: !!reuseDocuments,
        freshness: "frozen document positions and catalog enrichment; not a transactional API snapshot",
      },
    };
    if (sources.size >= 8) sources.delete(sources.keys().next().value!);
    sources.set(key, { value, expires });
    return value;
  })();
  sourcePending.set(key, {
    promise,
    refreshCatalog: !!params.refresh_catalog,
    freshDocuments: !cached || !!params.refresh_source,
  });
  try {
    return await promise;
  } finally {
    sourcePending.delete(key);
  }
}
