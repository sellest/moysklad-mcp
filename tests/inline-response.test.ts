import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputResult } from "../src/output.js";
import { credentialScope, storePath } from "../src/report-store.js";
import { inlineTool, readInlineResponse } from "../src/inline-response.js";
import { wrap } from "../src/index.js";
import { handleGetDocuments } from "../src/tools/documents.js";
import { moyskladGet } from "../src/client.js";
import { ReportJobs } from "../src/report-jobs.js";
import { z } from "zod";
vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn(), moyskladPost: vi.fn(), moyskladPut: vi.fn() }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "inline-response-"));
  vi.stubEnv("MOYSKLAD_DATA_DIR", directory);
  vi.stubEnv("MOYSKLAD_TOKEN", "synthetic-account");
  vi.mocked(moyskladGet).mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe("explicit exports and resumable inline data", () => {
  it("returns all oversized raw document rows across bounded pages without refetch or files", async () => {
    const rows = Array.from({ length: 100 }, (_, id) => ({ id, description: "x".repeat(6500) }));
    vi.mocked(moyskladGet).mockResolvedValue({ meta: { size: 912 }, rows });
    const call = wrap(handleGetDocuments, "get_documents");
    const args = { entity_type: "customerorder", detail: "raw", limit: 100, offset: 0 };
    let response = await call(args);
    const ids: number[] = [];
    let pages = 0;
    while (true) {
      expect(response.isError).not.toBe(true);
      expect(response.content).toHaveLength(1);
      expect(Buffer.byteLength(response.content[0].text)).toBeLessThanOrEqual(102400);
      const value = JSON.parse(response.content[0].text);
      expect(value.export).toBeUndefined();
      expect(value.pagination.source_next_offset).toBe(100);
      ids.push(...value.rows.map((row: { id: number }) => row.id));
      pages++;
      if (!value.next_cursor) {
        expect(value.next_offset).toBe(100);
        expect(value.complete).toBe(false);
        break;
      }
      response = await call({ ...args, response_cursor: value.next_cursor });
    }
    expect(ids).toEqual(rows.map((row) => row.id));
    expect(pages).toBeGreaterThan(1);
    expect(moyskladGet).toHaveBeenCalledTimes(1);
    expect(await readdir(storePath(credentialScope(), "exports")).catch(() => [])).toEqual([]);
  });
  it("isolates cursors by tool and company, and retains the same immutable page", async () => {
    const text = await inlineTool.run("fixture", () =>
      outputResult(
        {
          rows: [
            { id: 1, data: "x".repeat(60000) },
            { id: 2, data: "y".repeat(60000) },
          ],
        },
        { total: 2 },
        {},
      ),
    );
    const first = JSON.parse(text);
    const second = await readInlineResponse(first.next_cursor, "fixture");
    expect(await readInlineResponse(first.next_cursor, "fixture")).toBe(second);
    expect(JSON.parse(second).rows[0].id).toBe(2);
    await expect(readInlineResponse(first.next_cursor, "other")).rejects.toThrow("another tool");
    vi.stubEnv("MOYSKLAD_TOKEN", "other-synthetic-account");
    await expect(readInlineResponse(first.next_cursor, "fixture")).rejects.toThrow("unavailable");
  });
  it("returns an actionable error for a single oversized row without creating an export", async () => {
    const result = await wrap(() => outputResult({ rows: [{ data: "x".repeat(110000) }] }, {}, {}), "fixture")({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe("INLINE_RESPONSE_TOO_LARGE");
    expect(await readdir(storePath(credentialScope(), "exports")).catch(() => [])).toEqual([]);
  });
  it("only creates exports on explicit file requests", async () => {
    expect(JSON.parse(await outputResult({ rows: [{ id: 1 }] }, {}, {}))).toEqual({ rows: [{ id: 1 }] });
    expect(JSON.parse(await outputResult({ rows: [{ id: 1 }] }, {}, { output: "file" })).export.uri).toMatch(
      /^moysklad-export:/,
    );
  });
  it("does not force file output in background workers", async () => {
    const received: any[] = [];
    const jobs = new ReportJobs();
    jobs.register([
      {
        name: "get_sales_report",
        description: "fixture",
        schema: z.object({ output: z.enum(["inline", "file"]).optional() }),
        handler: async (params) => {
          received.push(params.output);
          return JSON.stringify({ rows: [{ id: 1 }] });
        },
      },
    ]);
    const first = await jobs.start("get_sales_report", {});
    await jobs.idle();
    expect((await jobs.status(first.job_id)).result).toEqual({ rows: [{ id: 1 }] });
    await jobs.start("get_sales_report", { output: "file" });
    await jobs.idle();
    expect(received).toEqual([undefined, "file"]);
  });
});
