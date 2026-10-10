import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const outputSchema = {
  detail: z
    .enum(["summary", "rows", "raw"])
    .optional()
    .describe("summary: totals; rows: compact data; raw: full API data"),
  output: z
    .enum(["inline", "file"])
    .optional()
    .describe("file returns summary and a readable MCP export URI, never a server path"),
  fields: z
    .enum(["quantity", "analysis", "full"])
    .optional()
    .describe(
      "quantity omits prices/descriptions; analysis includes size and exact price; full includes legacy aliases",
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
export function getExportScope(): string {
  return createHash("sha256")
    .update(JSON.stringify([process.env.MOYSKLAD_TOKEN, process.env.MOYSKLAD_LOGIN, process.env.MOYSKLAD_PASSWORD]))
    .digest("hex");
}

export async function createExport(value: unknown) {
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
  if (!entry || entry.expires <= Date.now() || entry.scope !== getExportScope())
    throw new Error("EXPORT_NOT_FOUND: expired, unknown or unavailable export; regenerate it.");
  return readFile(entry.path, "utf8");
}

export async function outputResult(value: unknown, summary: unknown, options: OutputOptions): Promise<string> {
  if (options.output === "file") return JSON.stringify({ ...(summary as object), export: await createExport(value) });
  return JSON.stringify(value);
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
  limit: z.number().int().min(1).max(100).default(25),
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
