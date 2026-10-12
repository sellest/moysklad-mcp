import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { managedReportNames, ReportJobs, type ReportJob } from "../src/report-jobs.js";
import { reportContext } from "../src/report-context.js";
import { atomicWrite, credentialScope, storePath } from "../src/report-store.js";
import { PagedExport, readPagedExport } from "../src/paged-export.js";
import { wrap } from "../src/index.js";
import { RequestScheduler } from "../src/scheduler.js";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moysklad-jobs-test-"));
  vi.stubEnv("MOYSKLAD_DATA_DIR", directory);
  vi.stubEnv("MOYSKLAD_TOKEN", "account-a-test-only");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function manager(handler: () => Promise<string>) {
  const jobs = new ReportJobs();
  jobs.register([
    {
      name: "get_sales_report",
      description: "fixture",
      schema: z.object({ period: z.string().default("month"), refresh_source: z.boolean().optional() }),
      handler,
    },
  ]);
  return jobs;
}
async function settled(jobs: ReportJobs, id: string) {
  for (let i = 0; i < 300; i++) {
    const job = await jobs.status(id);
    if (["succeeded", "failed", "cancelled"].includes(job.state)) {
      await jobs.idle();
      return job;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Fixture job did not settle");
}
describe("durable report lifecycle", () => {
  it("routes ordinary document reads outside the long report worker", () => {
    expect(managedReportNames.has("get_documents")).toBe(false);
    expect(managedReportNames.has("get_sales_by_size")).toBe(true);
  });
  it("reports known position progress and lists jobs without waiting for completion", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const jobs = manager(async () => {
      await reportContext
        .getStore()!
        .progress("enrich_catalog", { expected_positions: 21821, enriched_positions: 10911 });
      await hold;
      return "{}";
    });
    const first = await jobs.start("get_sales_report", {});
    for (let i = 0; i < 100; i++) {
      if ((await jobs.status(first.job_id)).percent === 50) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await jobs.status(first.job_id)).percent).toBe(50);
    const list = await jobs.list("running", 10);
    expect(list.total).toBe(1);
    expect(list.jobs[0].job_id).toBe(first.job_id);
    expect(list.jobs[0]).not.toHaveProperty("params");
    release();
    expect((await settled(jobs, first.job_id)).percent).toBe(100);
    vi.stubEnv("MOYSKLAD_TOKEN", "other-account");
    expect((await jobs.list()).total).toBe(0);
  });
  it("deduplicates concurrent requests and retains one immutable generation", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const jobs = manager(async () => {
      calls++;
      await hold;
      return JSON.stringify({ complete: true, units: 17 });
    });
    const [a, b, c] = await Promise.all([
      jobs.start("get_sales_report", {}),
      jobs.start("get_sales_report", {}),
      jobs.start("get_sales_report", {}),
    ]);
    expect(new Set([a.job_id, b.job_id, c.job_id]).size).toBe(1);
    expect(a).not.toHaveProperty("params");
    expect(a).not.toHaveProperty("scope");
    release();
    expect((await settled(jobs, a.job_id)).result).toEqual({ complete: true, units: 17 });
    expect(calls).toBe(1);
    const restarted = manager(async () => {
      throw new Error("Must reuse persisted result");
    });
    expect((await restarted.status(a.job_id)).result).toEqual({ complete: true, units: 17 });
    expect((await restarted.start("get_sales_report", {})).job_id).toBe(a.job_id);
  });
  it("returns job identity before long work and cancellation is idempotent", async () => {
    const jobs = manager(async () => {
      await new Promise<void>((resolve) => {
        const signal = reportContext.getStore()!.signal;
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "{}";
    });
    const started = await jobs.start("get_sales_report", {});
    expect(["queued", "running"]).toContain(started.state);
    await new Promise((r) => setTimeout(r, 20));
    await jobs.cancel(started.job_id);
    const cancelled = await settled(jobs, started.job_id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.error?.code).toBe("JOB_CANCELLED");
    expect((await jobs.cancel(started.job_id)).state).toBe("cancelled");
    expect(cancelled.result).toBeUndefined();
  });
  it("preserves an interrupted job as recoverable without pretending it completed", async () => {
    const scope = credentialScope(),
      id = randomUUID(),
      now = new Date().toISOString();
    const job: ReportJob = {
      job_id: id,
      fingerprint: "fixture",
      generation_id: randomUUID(),
      scope,
      tool: "get_sales_report",
      params: {},
      state: "running",
      stage: "fetch_positions",
      accepted_at: now,
      updated_at: now,
      disconnect_policy: "continue",
      progress: { documents: 40 },
      percent: null,
    };
    await atomicWrite(storePath(scope, "jobs", id + ".json"), JSON.stringify(job));
    const jobs = manager(async () => "{}");
    const restored = await jobs.status(id);
    expect(restored.state).toBe("failed");
    expect(restored.recoverable).toBe(true);
    expect(restored.progress.documents).toBe(40);
    expect(restored.resume_action).toContain("start_report");
  });
  it("isolates jobs and exports between credentials", async () => {
    const jobs = manager(async () => '{"complete":true}');
    const job = await jobs.start("get_sales_report", {});
    await settled(jobs, job.job_id);
    const writer = new PagedExport();
    await writer.append("detail", [{ quantity: 1 }]);
    const file = await writer.finish({});
    vi.stubEnv("MOYSKLAD_TOKEN", "account-b-test-only");
    await expect(jobs.status(job.job_id)).rejects.toThrow("JOB_NOT_FOUND");
    await expect(readPagedExport({ uri: file.uri, section: "detail", offset: 0, limit: 25 })).rejects.toThrow(
      "EXPIRED_EXPORT",
    );
  });
  it("creates a new generation for refresh while deduplicating concurrent refresh", async () => {
    const jobs = manager(async () => "{}");
    const first = await jobs.start("get_sales_report", {});
    await settled(jobs, first.job_id);
    const refreshed = await jobs.start("get_sales_report", { refresh_source: true });
    await settled(jobs, refreshed.job_id);
    expect(refreshed.generation_id).not.toBe(first.generation_id);
  });
  it("uses matching safe text and structured errors", async () => {
    const response = await wrap(async () => {
      throw new Error("API_TIMEOUT: sensitive upstream details");
    })({});
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
    expect(response.structuredContent?.error.code).toBe("UPSTREAM_TIMEOUT");
    expect(response.content[0].text).not.toContain("sensitive");
  });
});
describe("persistent paged exports", () => {
  it("reads correct cursors across partial physical pages and survives another reader", async () => {
    const writer = new PagedExport();
    await writer.append("detail", [{ n: 0 }, { n: 1 }]);
    await writer.append(
      "detail",
      Array.from({ length: 105 }, (_, n) => ({ n: n + 2 })),
    );
    const file = await writer.finish({ complete: true });
    const page = JSON.parse(
      await readPagedExport({ uri: file.uri, section: "detail", offset: 0, cursor: "3", limit: 4 }),
    );
    expect(page.items.map((r: { n: number }) => r.n)).toEqual([3, 4, 5, 6]);
    expect(page.next_cursor).toBe("7");
    expect(page.total).toBe(107);
    expect(page.checksum).toMatch(/^[a-f0-9]{64}$/);
    const last = JSON.parse(await readPagedExport({ uri: file.uri, section: "detail", offset: 105, limit: 100 }));
    expect(last.items).toEqual([{ n: 105 }, { n: 106 }]);
    expect(last.next_cursor).toBeNull();
  });
  it("publishes empty sections as complete rather than missing", async () => {
    const writer = new PagedExport();
    await writer.append("detail", []);
    const file = await writer.finish({});
    const page = JSON.parse(await readPagedExport({ uri: file.uri, section: "detail", offset: 0, limit: 100 }));
    expect(page.items).toEqual([]);
    expect(page.complete).toBe(true);
    expect(page.next_cursor).toBeNull();
  });
  it("limits returned bytes independently of row count", async () => {
    const writer = new PagedExport();
    await writer.append(
      "detail",
      Array.from({ length: 10 }, () => ({ text: "x".repeat(600) })),
    );
    const file = await writer.finish({});
    const page = JSON.parse(
      await readPagedExport({ uri: file.uri, section: "detail", offset: 0, limit: 100, max_bytes: 1024 }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.bytes).toBeLessThanOrEqual(1024);
    expect(page.next_cursor).toBe("1");
  });
  it("refuses writes beyond the global storage budget", async () => {
    vi.stubEnv("MOYSKLAD_STORAGE_MAX_BYTES", "1048576");
    await expect(atomicWrite(storePath(credentialScope(), "fixture.json"), "x".repeat(1048577))).rejects.toThrow(
      "STORAGE_LIMIT",
    );
  });
});
it("cancels scheduler wait without admitting another API call", async () => {
  const scheduler = new RequestScheduler(1, 1, 1000);
  const release = await scheduler.acquire();
  const controller = new AbortController();
  const queued = scheduler.acquire(1, controller.signal);
  controller.abort();
  await expect(queued).rejects.toThrow("JOB_CANCELLED");
  release();
  expect(scheduler.diagnostics().requests).toBe(1);
});
