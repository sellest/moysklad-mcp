import { createHash, randomUUID } from "node:crypto";
import { atomicWrite, credentialScope, readJson, readLines, storePath } from "./report-store.js";
import { checkCancelled } from "./report-context.js";
export interface ExportManifest {
  id: string;
  schema_version: number;
  snapshot_id: string;
  job_id: string | null;
  expires_at: string;
  captured_from: string;
  captured_to: string;
  bytes: number;
  rows: number;
  checksum: string;
  metadata: Record<string, any>;
  sections: Record<string, { rows: number; bytes: number; files: string[]; page_rows: number[]; checksum: string }>;
}
export class PagedExport {
  readonly id = randomUUID();
  readonly sections: ExportManifest["sections"] = {};
  private hashes = new Map<string, ReturnType<typeof createHash>>();
  private totalHash = createHash("sha256");
  constructor(
    readonly scope = credentialScope(),
    readonly jobId: string | null = null,
  ) {}
  async append(section: string, items: unknown[]) {
    checkCancelled();
    const info = (this.sections[section] ??= { rows: 0, bytes: 0, files: [], page_rows: [], checksum: "" });
    const hash = this.hashes.get(section) ?? createHash("sha256");
    this.hashes.set(section, hash);
    if (!items.length) return;
    for (let offset = 0; offset < items.length; offset += 100) {
      const text = items
        .slice(offset, offset + 100)
        .map((x) => JSON.stringify(x) + "\n")
        .join("");
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("STORAGE_LIMIT: Export page too large.");
      const name = `${section}-${info.files.length}.ndjson`;
      await atomicWrite(storePath(this.scope, "exports", this.id, name), text);
      hash.update(text);
      this.totalHash.update(section + "\n" + text);
      info.files.push(name);
      info.page_rows.push(Math.min(100, items.length - offset));
      info.rows += Math.min(100, items.length - offset);
      info.bytes += Buffer.byteLength(text);
    }
  }
  async finish(metadata: Record<string, any>, snapshotId: string = this.id, capturedFrom = new Date().toISOString()) {
    for (const [section, hash] of this.hashes) this.sections[section].checksum = hash.digest("hex");
    const hours = Number(process.env.MOYSKLAD_EXPORT_TTL_HOURS ?? 24);
    const manifest: ExportManifest = {
      id: this.id,
      schema_version: 1,
      snapshot_id: snapshotId,
      job_id: this.jobId,
      captured_from: capturedFrom,
      captured_to: new Date().toISOString(),
      expires_at: new Date(Date.now() + hours * 3600000).toISOString(),
      bytes: Object.values(this.sections).reduce((n, s) => n + s.bytes, 0),
      rows: Object.values(this.sections).reduce((n, s) => n + s.rows, 0),
      checksum: this.totalHash.update(JSON.stringify(metadata)).digest("hex"),
      metadata,
      sections: this.sections,
    };
    await atomicWrite(storePath(this.scope, "exports", this.id, "manifest.json"), JSON.stringify(manifest));
    return {
      uri: `moysklad-export://${this.id}`,
      mimeType: "application/json",
      schema_version: 1,
      snapshot_id: snapshotId,
      job_id: this.jobId,
      bytes: manifest.bytes,
      rows: manifest.rows,
      checksum: manifest.checksum,
      expires_at: manifest.expires_at,
      retrieval_tool: "read_report_export",
      consistency: "non_transactional",
    };
  }
}
export async function exportManifest(uri: string) {
  const id = /^moysklad-export:\/\/([a-f0-9-]{36})$/.exec(uri)?.[1];
  if (!id) throw new Error("EXPIRED_EXPORT: Export unavailable.");
  const manifest = await readJson<ExportManifest>(storePath(credentialScope(), "exports", id, "manifest.json")).catch(
    () => null,
  );
  if (!manifest || Date.parse(manifest.expires_at) <= Date.now())
    throw new Error("EXPIRED_EXPORT: Export unavailable; regenerate report.");
  return manifest;
}
export async function readPagedExport(p: {
  uri: string;
  section: string;
  offset: number;
  limit: number;
  cursor?: string;
  max_bytes?: number;
}) {
  const manifest = await exportManifest(p.uri);
  const section = manifest.sections[p.section];
  if (!section) throw new Error("EXPORT_SECTION: Requested section is unavailable.");
  const offset = p.cursor === undefined ? p.offset : Number(p.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("INVALID_ARGUMENT: Invalid export cursor.");
  const items: unknown[] = [];
  let at = 0,
    bytes = 0;
  const max = Math.min(p.max_bytes ?? 102400, 102400);
  outer: for (const file of section.files) {
    // Page size is fixed at at most 100; skip whole pages without reading their data.
    const index = section.files.indexOf(file),
      count = section.page_rows[index];
    if (at + count <= offset) {
      at += count;
      continue;
    }
    for await (const row of readLines(storePath(credentialScope(), "exports", manifest.id, file))) {
      if (at++ < offset) continue;
      const size = Buffer.byteLength(JSON.stringify(row));
      if (items.length >= p.limit || bytes + size > max) {
        if (!items.length && size > max) throw new Error("STORAGE_LIMIT: Export row exceeds requested byte limit.");
        break outer;
      }
      items.push(row);
      bytes += size;
    }
  }
  const next = offset + items.length < section.rows ? offset + items.length : null;
  return JSON.stringify({
    uri: p.uri,
    schema_version: manifest.schema_version,
    snapshot_id: manifest.snapshot_id,
    job_id: manifest.job_id,
    section: p.section,
    total: section.rows,
    returned: items.length,
    offset,
    next_offset: next,
    next_cursor: next === null ? null : String(next),
    complete: offset === 0 && items.length === section.rows,
    items,
    bytes,
    checksum: section.checksum,
    export_checksum: manifest.checksum,
  });
}
