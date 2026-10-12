import { saveExpandedCard, migrateLegacyCatalog, completeCatalog, prefetchCatalog } from "./snapshot-catalog.js";
import { createHash, randomUUID } from "node:crypto";
import { moyskladGet } from "./client.js";
import { buildFilter, listQuery } from "./lib.js";
import { normalizeReportMoment } from "./report-lib.js";
import { atomicWrite, credentialScope, readJson, readLines, storePath } from "./report-store.js";
import { checkCancelled, reportContext, reportProgress } from "./report-context.js";
import {
  cachedEntity,
  entityId,
  catalogVersion,
  type AnalyticsPeriod,
  type ApiEntity,
  type LoadedSource,
  type SourceLine,
} from "./analytics-data.js";
export async function* sourcePages(path: string, options: { filter?: string; expand?: string; limit?: number } = {}) {
  const limit = options.limit ?? 100;
  let offset = 0;
  let expected: number | undefined;
  while (true) {
    checkCancelled();
    const result = (await moyskladGet(
      `${path}${path.includes("?") ? "&" : "?"}${listQuery({ ...options, limit, offset })}`,
    )) as { rows?: ApiEntity[]; meta?: { size?: number; offset?: number } };
    if (
      !Array.isArray(result.rows) ||
      typeof result.meta?.size !== "number" ||
      !Number.isSafeInteger(result.meta.size) ||
      result.meta.size < 0
    )
      throw new Error("INCOMPLETE_PAGE: Missing page count.");
    if (expected !== undefined && expected !== result.meta.size) throw new Error("SOURCE_CHANGED: Page total changed.");
    expected = result.meta.size;
    if (result.meta.offset !== undefined && result.meta.offset !== offset)
      throw new Error("INCOMPLETE_PAGE: Offset mismatch.");
    if (offset + result.rows.length > expected || (!result.rows.length && offset < expected))
      throw new Error("INCOMPLETE_PAGE: Missing page.");
    yield { rows: result.rows, offset, expected };
    offset += result.rows.length;
    if (offset === expected) return;
  }
}
interface Capture {
  id: string;
  pages: string[];
  documents: Record<string, number>;
  positions: number;
  captured_from: string;
  captured_to: string;
  expires_at: string;
  complete: boolean;
  duplicates: number;
}
export async function loadStreamingSource(params: AnalyticsPeriod): Promise<LoadedSource> {
  const scope = credentialScope();
  const run = reportContext.getStore()!;
  if (!params.moment_from || !params.moment_to) throw new Error("PERIOD_REQUIRED: Both dates required.");
  const from = normalizeReportMoment(params.moment_from),
    to = normalizeReportMoment(params.moment_to, true);
  if (from > to) throw new Error("PERIOD_ORDER: Start exceeds end.");
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
    .update(JSON.stringify([scope, from, to, organizations, 1]))
    .digest("hex");
  const index = storePath(scope, "captures", "index-" + key + ".json");
  let capture = await readJson<Capture>(index).catch(() => null);
  const reused = !!capture && !params.refresh_source && capture.complete && Date.parse(capture.expires_at) > Date.now();
  if (!reused) {
    capture = {
      id: randomUUID(),
      pages: [],
      documents: {},
      positions: 0,
      captured_from: new Date().toISOString(),
      captured_to: "",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      complete: false,
      duplicates: 0,
    };
    run.catalogId = capture.id;
    const seeded = new Set<string>();
    const seen = new Set<string>();
    for (const type of ["demand", "salesreturn", "retaildemand", "retailsalesreturn"]) {
      capture.documents[type] = 0;
      for (const organization of organizations.length ? organizations : [undefined]) {
        const filter = buildFilter([
          ["moment", from, ">="],
          ["moment", to, "<="],
          ["applicable", "true"],
          ["organization", organization ?? ""],
        ]);
        // Small document pages bound expansion memory; positions are captured individually.
        for await (const page of sourcePages(`/entity/${type}`, {
          filter,
          expand: "positions.assortment",
          limit: 20,
        })) {
          for (const doc of page.rows) {
            if (!doc.id) throw new Error("DOCUMENT_ID: Document id missing.");
            const key = type + ":" + doc.id;
            if (seen.has(key)) {
              capture.duplicates++;
              throw new Error(
                "INCOMPLETE_PAGE: Duplicate document across capture pages; unique completeness is not established.",
              );
            }
            seen.add(key);
            if (seen.size > 200000)
              throw new Error("STORAGE_LIMIT: Capture document budget exceeded; split the period.");
            capture.documents[type]++;
            const expanded = doc.positions;
            const expected = expanded?.meta?.size;
            if (typeof expected !== "number") throw new Error("INCOMPLETE_PAGE: Position total missing.");
            const complete =
              Array.isArray(expanded.rows) && (expanded.meta.offset ?? 0) === 0 && expanded.rows.length === expected;
            const pages = complete
              ? (async function* () {
                  yield { rows: expanded.rows, offset: 0, expected };
                })()
              : sourcePages(`/entity/${type}/${doc.id}/positions`, { expand: "assortment", limit: 100 });
            const positionIds = new Set<string>();
            let received = 0;
            for await (const positions of pages) {
              const lines: SourceLine[] = [];
              for (const position of positions.rows) {
                if (!position.id) throw new Error("POSITION_ID: Position id missing.");
                if (positionIds.has(position.id)) throw new Error("INCOMPLETE_PAGE: Duplicate position.");
                positionIds.add(position.id);
                const assortment = position.assortment ?? {};
                const cardType = assortment.meta?.type,
                  cardId = entityId(assortment);
                if (!params.refresh_catalog && cardType && cardId && !seeded.has(cardType + cardId)) {
                  if (seeded.size >= 50000) throw new Error("STORAGE_LIMIT: Catalog cardinality exceeded.");
                  seeded.add(cardType + cardId);
                  await saveExpandedCard(cardType, cardId, assortment);
                  const parentId = entityId(assortment.product);
                  if (parentId && assortment.product) await saveExpandedCard("product", parentId, assortment.product);
                }
                // Keep references and numeric line fields, not repeated raw entity payloads.
                lines.push({
                  document_id: doc.id,
                  document_type: type,
                  moment: doc.moment,
                  position: {
                    id: position.id,
                    quantity: position.quantity,
                    price: position.price,
                    discount: position.discount,
                    assortment: {
                      id: assortment.id,
                      meta: assortment.meta,
                      name: assortment.name,
                      article: assortment.article,
                      code: assortment.code,
                    },
                  },
                  assortment: {
                    id: assortment.id,
                    meta: assortment.meta,
                    name: assortment.name,
                    article: assortment.article,
                    code: assortment.code,
                  },
                  product: null,
                  parent_product_id: null,
                  kind: type === "demand" || type === "retaildemand" ? "sold" : "returned",
                });
              }
              const name = `page-${capture.pages.length}.ndjson`;
              if (lines.length) {
                await atomicWrite(
                  storePath(scope, "captures", capture.id, name),
                  lines.map((line) => JSON.stringify(line) + "\n").join(""),
                );
                capture.pages.push(name);
              }
              received += lines.length;
              capture.positions += lines.length;
              await reportProgress(
                "fetch_positions",
                { positions: lines.length },
                {
                  capture_id: capture.id,
                  document_type: type,
                  next_document_offset: page.offset,
                  document_id: doc.id,
                  next_position_offset: received,
                },
              );
            }
            if (received !== expected)
              throw new Error("INCOMPLETE_PAGE: Expanded and actual position totals disagree.");
          }
          await reportProgress(
            "fetch_documents",
            { documents: page.rows.length, pages: 1 },
            {
              capture_id: capture.id,
              document_type: type,
              next_offset: page.offset + page.rows.length,
              expected: page.expected,
            },
          );
        }
      }
    }
    capture.complete = true;
    capture.captured_to = new Date().toISOString();
    await atomicWrite(storePath(scope, "captures", capture.id, "manifest.json"), JSON.stringify(capture));
    await atomicWrite(index, JSON.stringify(capture));
  }
  const saved = capture!;
  if (reused) {
    await reportProgress("enrich_catalog", { expected_positions: saved.positions }, { capture_id: saved.id });
    const pointer = await readJson<{ id: string }>(
      storePath(scope, "captures", saved.id, "catalog-current.json"),
    ).catch(() => null);
    run.catalogId = params.refresh_catalog ? randomUUID() : (pointer?.id ?? saved.id);
    if (!params.refresh_catalog && !pointer) await migrateLegacyCatalog(scope, saved.id);
  }
  const catalogId = run.catalogId!;
  const source: LoadedSource = {
    passport: {
      report_basis: "posted_document_positions",
      source_kind: "documents",
      applicable: true,
      document_types: ["demand", "salesreturn", "retaildemand", "retailsalesreturn"],
      organizations: organizations.length ? organizations : "all_accessible",
      period_from: from,
      period_to: to,
      timezone: "upstream_account_timezone_no_conversion",
      timezone_verified: false,
      currency: "RUB",
      quantity_unit: "upstream_quantity",
      return_date_basis: "return_document",
      catalog_basis: "frozen_cards_shared_by_snapshot",
      rules_version: 1,
    },
    lines: [],
    position_count: saved.positions,
    documents: saved.documents,
    catalog: catalogVersion(),
    snapshot: {
      id: saved.id,
      captured_at: saved.captured_from,
      loaded_at: saved.captured_to,
      expires_at: saved.expires_at,
      reused,
      freshness: "frozen document positions and catalog enrichment; not a transactional API snapshot",
    },
    completeness: {
      complete: saved.complete,
      documents_observed: Object.values(saved.documents).reduce((n, x) => n + x, 0),
      positions_observed: saved.positions,
      duplicate_documents: saved.duplicates,
      missing_pages: 0,
      consistency: "non_transactional",
      captured_from: saved.captured_from,
      captured_to: saved.captured_to,
      upper_moment: to,
      ordering: "upstream offset order; page totals verified; equal-total edits cannot be excluded",
    },
  };
  source.lineStream = (async function* () {
    const hydrate = async (line: SourceLine) => {
      checkCancelled();
      const id = entityId(line.assortment),
        type = line.assortment.meta?.type;
      if (id && ["variant", "product", "service", "bundle"].includes(type ?? "")) {
        line.assortment = await cachedEntity(type!, id, line.assortment, params.refresh_catalog);
        line.parent_product_id = type === "product" ? id : entityId(line.assortment.product);
        if (line.parent_product_id)
          line.product = await cachedEntity(
            "product",
            line.parent_product_id,
            type === "product" ? line.assortment : line.assortment.product,
            params.refresh_catalog,
          );
      }
      return line;
    };
    for (const page of saved.pages) {
      let batch: SourceLine[] = [];
      const enrich = async (lines: SourceLine[]) => {
        await prefetchCatalog(
          lines.map((line) => line.assortment),
          params.refresh_catalog,
        );
        let next = 0;
        const outcomes = await Promise.allSettled(
          Array.from({ length: Math.min(2, lines.length) }, async () => {
            while (next < lines.length) {
              const index = next++;
              lines[index] = await hydrate(lines[index]);
            }
          }),
        );
        const failed = outcomes.find((outcome) => outcome.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        await reportProgress("enrich_catalog", {
          enriched_positions: lines.length,
          expected_positions: saved.positions,
        });
        return lines;
      };
      for await (const row of readLines(storePath(scope, "captures", saved.id, page))) {
        batch.push(row as SourceLine);
        if (batch.length === 100) {
          for (const line of await enrich(batch)) yield line;
          await reportProgress("aggregate", { processed_positions: batch.length });
          batch = [];
        }
      }
      if (batch.length) {
        for (const line of await enrich(batch)) yield line;
        await reportProgress("aggregate", { processed_positions: batch.length });
      }
    }
    const manifest = await completeCatalog(scope, catalogId, saved.id, saved.expires_at);
    source.catalog = { version: manifest.version, checked_at: manifest.checked_at, cache: catalogVersion().cache };
  })();
  await reportProgress(
    "enrich_catalog",
    { source_reused: reused ? 1 : 0, expected_positions: saved.positions },
    { capture_id: saved.id, catalog_id: catalogId },
  );
  // Captures are account-scoped, immutable and reusable across report dimensions.
  return source;
}
