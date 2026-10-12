import { PagedExport, exportManifest, readPagedExport } from "./paged-export.js";
import { credentialScope, readLines, storePath } from "./report-store.js";
import { reportContext } from "./report-context.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const outputSchema = {
  detail: z
    .enum(["summary", "rows", "raw"])
    .optional()
    .describe("summary: totals for this page; rows/default: compact rows; raw: original API data, ignoring fields"),
  output: z
    .enum(["inline", "file"])
    .optional()
    .describe("file returns summary and a readable MCP export URI, never a server path"),
  fields: z
    .enum(["quantity", "analysis", "full"])
    .optional()
    .describe(
      "quantity omits money; analysis/default adds available analysis fields; full retains compatibility aliases. Ignored in raw mode.",
    ),
};
export interface OutputOptions {
  detail?: "summary" | "rows" | "raw";
  output?: "inline" | "file";
  fields?: "quantity" | "analysis" | "full";
}

type ExportEntry = { path: string; expires: number; bytes: number; scope: string };
const entries = new Map<string, ExportEntry>();
const exportDirectory = join(tmpdir(), "moysklad-mcp-exports", String(process.pid));
const ttl = 60 * 60 * 1000;
export const getExportScope = credentialScope;

export async function createExport(value: unknown) {
  if (reportContext.getStore() || process.env.MOYSKLAD_REPORT_JOBS === "true") {
    const writer = new PagedExport(undefined, reportContext.getStore()?.jobId ?? null);
    const metadata: Record<string, any> = {};
    for (const [key, item] of Object.entries(value as Record<string, any>)) {
      if (Array.isArray(item)) await writer.append(key, item);
      else if (key === "dictionary" && item)
        await writer.append(
          key,
          Object.entries(item).map(([key, value]) => ({ key, value })),
        );
      else if (key === "positions_export" && Array.isArray(item?.items)) {
        await writer.append("positions", item.items);
        metadata.positions_export = { ...item, items: undefined };
      } else metadata[key] = item;
    }
    return writer.finish(metadata);
  }
  for (const [id, entry] of entries)
    if (entry.expires <= Date.now()) {
      entries.delete(id);
      await unlink(entry.path).catch(() => {});
    }
  if (entries.size >= 100) throw new Error("EXPORT_CAPACITY: 100 active exports; wait for expiry.");
  const id = randomUUID();
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  if (bytes > 100 * 1024 * 1024) throw new Error("EXPORT_TOO_LARGE: maximum 100 MB.");
  await mkdir(exportDirectory, { recursive: true });
  const path = join(exportDirectory, `${id}.json`);
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  const expires = Date.now() + ttl;
  entries.set(id, { path, expires, bytes, scope: getExportScope() });
  return {
    uri: `moysklad-export://${id}`,
    mimeType: "application/json",
    bytes,
    expires_at: new Date(expires).toISOString(),
    retrieval_tool: "read_report_export",
  };
}

export async function readExport(uri: string): Promise<string> {
  const id = /^moysklad-export:\/\/([a-f0-9-]+)$/.exec(uri)?.[1];
  const entry = id ? entries.get(id) : undefined;
  if (!entry) {
    const manifest = await exportManifest(uri);
    if (manifest.bytes > 102400)
      throw new Error("INVALID_ARGUMENT: Large exports must be read with read_report_export.");
    const result = { ...manifest.metadata };
    for (const [section, info] of Object.entries(manifest.sections)) {
      const rows = [];
      for (const file of info.files)
        for await (const row of readLines(storePath(credentialScope(), "exports", manifest.id, file))) rows.push(row);
      if (section === "dictionary") result[section] = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      else if (section === "positions") result.positions_export = { ...result.positions_export, items: rows };
      else result[section] = rows;
    }
    return JSON.stringify(result);
  }
  if (entry.expires <= Date.now() || entry.scope !== getExportScope())
    throw new Error("EXPORT_NOT_FOUND: expired, unknown or unavailable export; regenerate it.");
  return readFile(entry.path, "utf8");
}

export async function outputResult(value: unknown, summary: unknown, options: OutputOptions): Promise<string> {
  if (options.output === "file") return JSON.stringify({ ...(summary as object), export: await createExport(value) });
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 102400)
    return JSON.stringify({ ...(summary as object), output_mode: "automatic_file", export: await createExport(value) });
  return text;
}

export function pageInfo(total: number | undefined, returned: number, offset: number, limit: number) {
  const next = total === undefined ? returned === limit : offset + returned < total;
  return {
    total: total ?? null,
    returned,
    offset,
    next_offset: next && returned > 0 ? offset + returned : null,
    complete: total !== undefined && offset === 0 && returned === total,
  };
}

export const readExportSchema = z.object({
  uri: z.string().describe("moysklad-export:// URI from a file response"),
  offset: z.number().int().min(0).default(0),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Rows per page: 1 through 100 inclusive; default 25. Use next_cursor/next_offset for more rows."),
  cursor: z.string().regex(/^\d+$/).optional(),
  max_bytes: z
    .number()
    .int()
    .min(1024)
    .max(102400)
    .default(102400)
    .describe("Response byte budget: 1024 through 102400 inclusive."),
  section: z
    .enum([
      "items",
      "rows",
      "documents",
      "variants",
      "products",
      "bundles",
      "services",
      "assortment",
      "detail",
      "positions",
      "dictionary",
      "ranking",
    ])
    .default("detail"),
});
export async function handleReadExport(p: z.infer<typeof readExportSchema>): Promise<string> {
  const id = /^moysklad-export:\/\/([a-f0-9-]+)$/.exec(p.uri)?.[1];
  if (!id || !entries.has(id)) return readPagedExport(p);
  const parsed = JSON.parse(await readExport(p.uri)) as Record<string, unknown>;
  const rows =
    p.section === "dictionary" && parsed.dictionary
      ? Object.entries(parsed.dictionary as object).map(([key, value]) => ({ key, value }))
      : p.section === "positions"
        ? (parsed.positions_export as { items?: unknown[] } | undefined)?.items
        : parsed[p.section];
  if (!Array.isArray(rows)) throw new Error(`EXPORT_SECTION: '${p.section}' is not an array in this export.`);
  const items = rows.slice(p.offset, p.offset + p.limit);
  return JSON.stringify({
    uri: p.uri,
    section: p.section,
    ...pageInfo(rows.length, items.length, p.offset, p.limit),
    items,
  });
}
