import { AsyncLocalStorage } from "node:async_hooks";
import { PagedExport, exportManifest, readPagedExport } from "./paged-export.js";
import { reportContext } from "./report-context.js";
import { credentialScope, dataRoot, readJson, removeStored, storePath } from "./report-store.js";
import { readdir, stat } from "node:fs/promises";

export const inlineTool = new AsyncLocalStorage<string>();
export const responseCursorDescription =
  "Resume a bounded inline response with its next_cursor or a sections cursor. Repeat the same tool with this response_cursor; no download or recalculation. Read sequentially. Expires after snapshot retention.";
const cleanupTimes = new Map<string, number>();
async function cleanupResponses() {
  const scope = credentialScope(),
    key = `${dataRoot()}:${scope}`;
  if (Date.now() - (cleanupTimes.get(key) ?? 0) < 60000) return;
  cleanupTimes.set(key, Date.now());
  for (const id of await readdir(storePath(scope, "responses")).catch(() => [])) {
    if (!/^[a-f0-9-]{36}$/.test(id)) continue;
    const path = storePath(scope, "responses", id);
    const manifest = await readJson(`${path}/manifest.json`).catch(() => null);
    const expired = manifest
      ? Date.parse(manifest.expires_at) <= Date.now()
      : Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 86400000;
    if (expired) await removeStored(path);
  }
}
export async function responseWriter(file: boolean) {
  if (!file) await cleanupResponses();
  return new PagedExport(undefined, reportContext.getStore()?.jobId ?? null, file ? "exports" : "responses");
}
const cursor = (id: string, section: string, offset: number) => `${id}:${section}:${offset}`;

export async function finishInline(writer: PagedExport, metadata: Record<string, any>) {
  await writer.finish({ tool: inlineTool.getStore() ?? "", value: metadata });
  const section =
    ["rows", "documents", "items", "detail", "ranking", "positions"].find((key) => writer.sections[key]) ??
    Object.keys(writer.sections)[0];
  if (!section)
    throw new Error("INLINE_RESPONSE_TOO_LARGE: No pageable rows; use narrower fields or explicit output=file.");
  return readInlineResponse(cursor(writer.id, section, 0), inlineTool.getStore() ?? "");
}

export async function readInlineResponse(token: string, tool: string): Promise<string> {
  const match = /^([a-f0-9-]{36}):([a-zA-Z0-9_-]+):(\d+)$/.exec(token);
  if (!match || !Number.isSafeInteger(Number(match[3]))) throw new Error("INVALID_ARGUMENT: Invalid response cursor.");
  const [, id, section, offset] = match;
  const uri = `moysklad-export://${id}`;
  const manifest = await exportManifest(uri, "responses").catch(() => {
    throw new Error("EXPIRED_RESPONSE: Response unavailable; repeat the original request without the cursor.");
  });
  if (manifest.metadata.tool !== tool) throw new Error("INVALID_ARGUMENT: Cursor belongs to another tool.");
  const { _inline_paths: paths = {}, ...metadata } = manifest.metadata.value;
  // Reserve space for metadata, section cursors and the MCP job envelope.
  const sections = Object.fromEntries(
    Object.entries(manifest.sections).map(([key, info]) => [
      key,
      {
        total: info.rows,
        cursor: cursor(id, key, 0),
      },
    ]),
  );
  const overhead = Buffer.byteLength(JSON.stringify({ ...metadata, sections })) + 4096;
  const budget = Math.min(80000, 90000 - overhead);
  if (budget < 1024) throw new Error("INLINE_RESPONSE_TOO_LARGE: Metadata exceeds inline budget; narrow the request.");
  let page;
  try {
    page = JSON.parse(
      await readPagedExport({ uri, section, offset: Number(offset), limit: 100, max_bytes: budget }, "responses"),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("row exceeds"))
      throw new Error("INLINE_RESPONSE_TOO_LARGE: A single row exceeds the inline budget.");
    throw error;
  }
  const next = page.next_offset === null ? null : cursor(id, section, page.next_offset);
  const value = { ...metadata };
  const nested = paths[section];
  if (nested) value[nested[0]] = { ...value[nested[0]], [nested[1]]: page.items };
  else value[section] = page.items;
  return JSON.stringify({
    ...value,
    output_mode: "inline_page",
    returned: page.returned,
    complete: page.complete && metadata.complete !== false,
    next_cursor: next,
    next_offset: next === null ? (metadata.next_offset ?? null) : null,
    pagination: {
      section,
      total: page.total,
      offset: page.offset,
      returned: page.returned,
      next_cursor: next,
      reason: "inline_byte_budget",
      source_next_offset: metadata.next_offset ?? null,
      source_total: metadata.total ?? metadata.meta?.size ?? null,
      expires_at: manifest.expires_at,
    },
    sections,
    continuation:
      next === null
        ? null
        : {
            tool,
            arguments: { response_cursor: next },
            instruction:
              "Repeat the original tool arguments and add response_cursor; source filters and required arguments remain unchanged.",
          },
  });
}

export async function paginateInline(value: Record<string, any>, summary: Record<string, any>) {
  const writer = await responseWriter(false);
  const metadata = { ...summary, ...value };
  const paths: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      await writer.append(key, item);
      delete metadata[key];
    } else if (key === "dictionary" && item) {
      await writer.append(
        key,
        Object.entries(item).map(([key, value]) => ({ key, value })),
      );
      delete metadata[key];
    } else if (key === "positions_export" && Array.isArray(item?.items)) {
      await writer.append("positions", item.items);
      metadata.positions_export = { ...item, items: undefined };
      paths.positions = ["positions_export", "items"];
    } else if (key === "positions" && Array.isArray(item?.rows)) {
      await writer.append("positions", item.rows);
      metadata.positions = { ...item, rows: undefined };
      paths.positions = ["positions", "rows"];
    }
  }
  return finishInline(writer, { ...metadata, _inline_paths: paths });
}
