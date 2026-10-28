import { createHash, randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { inlineTool } from "./inline-response.js";
import { z } from "zod";
import {
  atomicWrite,
  credentialScope,
  dataRoot,
  readJson,
  removeStored,
  storePath,
  storageDiagnostics,
} from "./report-store.js";
import { reportContext } from "./report-context.js";
import { reportError } from "./report-errors.js";
import { observeOperation } from "./metrics.js";
import type { ToolDef } from "./types.js";
import { analyticsConfigurationRevision } from "./analytics-query-policy.js";
import { normalizeAnalyticsQuery } from "./analytics-query-schema.js";
export type JobState = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export interface ReportJob {
  job_id: string;
  fingerprint: string;
  generation_id: string;
  scope: string;
  tool: string;
  params: Record<string, any>;
  state: JobState;
  stage: string;
  accepted_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  disconnect_policy: "continue";
  progress: Record<string, number>;
  percent: number | null;
  checkpoint?: unknown;
  result?: unknown;
  error?: ReturnType<typeof reportError>;
  recoverable?: boolean;
  cancel_requested_at?: string;
}
const supported = new Set([
  "query_analytics",
  "get_stock_at_date",
  "get_sales_by_size",
  "get_sales_by_price",
  "get_sales_by_category",
  "get_sales_ranking_by_article",
  "get_sales_report",
  "get_profit_report",
  "get_documents",
  "reconcile_sales",
]);
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}
export class ReportJobs {
  private tools = new Map<string, ToolDef>();
  private initialized = new Set<string>();
  private cleanupAt = new Map<string, number>();
  private queue: { scope: string; id: string }[] = [];
  private active?: { job: ReportJob; controller: AbortController };
  private gate: Promise<unknown> = Promise.resolve();
  private working = false;
  readonly bootId = randomUUID();
  readonly startedAt = new Date().toISOString();
  register(tools: ToolDef[]) {
    for (const tool of tools) if (supported.has(tool.name)) this.tools.set(tool.name, tool);
  }
  private path(scope: string, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("JOB_NOT_FOUND: Job unavailable.");
    return storePath(scope, "jobs", id + ".json");
  }
  private async save(job: ReportJob) {
    job.updated_at = new Date().toISOString();
    await atomicWrite(this.path(job.scope, job.job_id), JSON.stringify(job));
  }
  private async records(scope: string) {
    const names = await readdir(storePath(scope, "jobs")).catch(() => []);
    if (names.length > 512) throw new Error("STORAGE_LIMIT: Too many job records.");
    const jobs: ReportJob[] = [];
    for (const name of names)
      if (/^[a-f0-9-]{36}\.json$/.test(name))
        jobs.push({ ...(await readJson<ReportJob>(storePath(scope, "jobs", name))), result: undefined });
    return jobs;
  }
  private async init(scope: string) {
    const key = dataRoot() + scope;
    const alreadyInitialized = this.initialized.has(key);
    if (alreadyInitialized && Date.now() - (this.cleanupAt.get(key) ?? 0) < 60000) return;
    for (const job of await this.records(scope)) {
      if (!alreadyInitialized && ["running", "queued", "cancelling"].includes(job.state)) {
        job.state = "failed";
        job.stage = "interrupted";
        job.recoverable = true;
        job.finished_at = new Date().toISOString();
        job.error = { ...reportError(new Error("INTERNAL_ERROR: Restart interrupted report.")), job_id: job.job_id };
        await this.save(job);
      }
      if (Date.now() - Date.parse(job.accepted_at) > 7 * 86400000) await removeStored(this.path(scope, job.job_id));
    }
    // Expired exports and incomplete orphan captures are reclaimed after retention.
    for (const kind of ["exports", "responses", "captures", "catalog"]) {
      for (const id of await readdir(storePath(scope, kind)).catch(() => [])) {
        if (!/^[a-f0-9-]{36}$/.test(id)) continue;
        if (
          kind === "catalog" &&
          (this.active?.job.checkpoint as { catalog_id?: string } | undefined)?.catalog_id === id
        )
          continue;
        if (
          kind === "captures" &&
          (this.active?.job.checkpoint as { capture_id?: string } | undefined)?.capture_id === id
        )
          continue;
        const meta = await readJson(storePath(scope, kind, id, "manifest.json")).catch(() => null);
        const job =
          kind === "captures" || kind === "catalog"
            ? await readJson<ReportJob>(this.path(scope, id)).catch(() => null)
            : null;
        if (
          (meta && Date.parse(meta.expires_at) <= Date.now()) ||
          (job?.finished_at && Date.now() - Date.parse(job.finished_at) > 86400000) ||
          (!meta && !job && Date.now() - (await stat(storePath(scope, kind, id))).mtimeMs > 86400000)
        )
          await removeStored(storePath(scope, kind, id));
      }
    }
    this.initialized.add(key);
    this.cleanupAt.set(key, Date.now());
  }
  async start(toolName: string, parameters: Record<string, any>, _requestKey?: string) {
    const operation = this.gate.then(async () => {
      const tool = this.tools.get(toolName);
      if (!tool) throw new Error("INVALID_ARGUMENT: Unsupported report tool.");
      const parsed = tool.schema.safeParse(parameters);
      if (!parsed.success) throw new Error("INVALID_ARGUMENT: Report parameters do not match tool schema.");
      const params: Record<string, any> =
        toolName === "query_analytics" ? normalizeAnalyticsQuery(parsed.data) : parsed.data;
      if (Buffer.byteLength(JSON.stringify(params)) > 131072)
        throw new Error("INVALID_ARGUMENT: Parameters too large.");
      if (params.organization_hrefs) params.organization_hrefs = [...new Set(params.organization_hrefs)].sort();
      const scope = credentialScope();
      await this.init(scope);
      const normalized = { ...params };
      normalized.refresh_source = params.refresh_source === true;
      normalized.refresh_catalog = params.refresh_catalog === true;
      if (toolName === "query_analytics") normalized.configuration_revision = await analyticsConfigurationRevision();
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(stable({ schema: 3, scope, tool: toolName, params: normalized })))
        .digest("hex");
      const records = await this.records(scope);
      const previous = records
        .sort((a, b) => Date.parse(b.accepted_at) - Date.parse(a.accepted_at))
        .find(
          (j) =>
            j.fingerprint === fingerprint &&
            (["queued", "running", "cancelling"].includes(j.state) ||
              (!params.refresh_source &&
                !params.refresh_catalog &&
                j.state === "succeeded" &&
                Date.now() - Date.parse(j.finished_at!) < (toolName === "query_analytics" ? 300000 : 86400000))),
        );
      if (previous) return this.public(previous);
      if (records.length >= 256) throw new Error("STORAGE_LIMIT: Job history capacity reached.");
      if (this.queue.length >= 16) throw new Error("RATE_LIMITED: Report queue is full.");
      const now = new Date().toISOString();
      const job: ReportJob = {
        job_id: randomUUID(),
        fingerprint,
        generation_id: randomUUID(),
        scope,
        tool: toolName,
        params,
        state: "queued",
        stage: "queued",
        accepted_at: now,
        updated_at: now,
        disconnect_policy: "continue",
        progress: {},
        percent: null,
      };
      await this.save(job);
      this.queue.push({ scope, id: job.job_id });
      void this.work().catch((error) =>
        console.error(
          JSON.stringify({
            event: "report_worker_error",
            error_code: "INTERNAL_ERROR",
            error_type: error instanceof Error ? error.name : "unknown",
          }),
        ),
      );
      return this.public(job);
    });
    this.gate = operation.catch(() => {});
    return operation;
  }
  private public(job: ReportJob) {
    const { scope: _scope, params: _params, checkpoint: _checkpoint, ...value } = job;
    return {
      ...value,
      elapsed_ms:
        Date.parse(job.finished_at ?? new Date().toISOString()) - Date.parse(job.started_at ?? job.accepted_at),
      status_uri: `moysklad-job://${job.job_id}`,
      resume_action: job.recoverable
        ? "Call start_report with the same parameters; interrupted history is retained. Checkpoints are diagnostic in this release, not automatic resume."
        : null,
    };
  }
  async status(id: string) {
    const scope = credentialScope();
    await this.init(scope);
    const job = await readJson<ReportJob>(this.path(scope, id)).catch(() => null);
    if (!job || job.scope !== scope) throw new Error("JOB_NOT_FOUND: Job unavailable.");
    return this.public(job);
  }
  async list(state?: JobState, limit = 10) {
    const scope = credentialScope();
    await this.init(scope);
    const jobs = (await this.records(scope))
      .filter((j) => !state || j.state === state)
      .sort((a, b) => Date.parse(b.accepted_at) - Date.parse(a.accepted_at));
    return { jobs: jobs.slice(0, limit).map((j) => this.public(j)), total: jobs.length, limit };
  }
  async cancel(id: string) {
    const operation = this.gate.then(() => this.cancelInternal(id));
    this.gate = operation.catch(() => {});
    return operation;
  }
  private async cancelInternal(id: string) {
    const scope = credentialScope();
    await this.init(scope);
    let job = await readJson<ReportJob>(this.path(scope, id)).catch(() => null);
    if (!job || job.scope !== scope) throw new Error("JOB_NOT_FOUND: Job unavailable.");
    if (this.active?.job.job_id === id && this.active.job.scope === scope) job = this.active.job;
    if (["succeeded", "failed", "cancelled"].includes(job.state)) return this.public(job);
    if (this.active?.job.job_id === id && this.active.job.scope === scope) {
      job = this.active.job;
      job.state = "cancelling";
      job.cancel_requested_at ??= new Date().toISOString();
      this.active.controller.abort();
    } else {
      job.state = "cancelled";
      job.stage = "cancelled";
      job.finished_at = new Date().toISOString();
      job.cancel_requested_at ??= job.finished_at;
    }
    await this.save(job);
    return this.public(job);
  }
  private async work() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        const claim = this.gate.then(async () => {
          const job = await readJson<ReportJob>(this.path(next.scope, next.id));
          if (job.state !== "queued") return null;
          const controller = new AbortController();
          this.active = { job, controller };
          job.state = "running";
          job.started_at = new Date().toISOString();
          job.stage = "fetch_documents";
          await this.save(job);
          return { job, controller };
        });
        this.gate = claim.catch(() => {});
        const claimed = await claim;
        if (!claimed) continue;
        const { job, controller } = claimed;
        let lastSave = 0;
        let stageSince = Date.now();
        await reportContext.run(
          {
            jobId: job.job_id,
            scope: job.scope,
            signal: controller.signal,
            progress: async (stage, delta, checkpoint) => {
              if (stage !== job.stage) {
                const timing = "stage_" + job.stage + "_ms";
                job.progress[timing] = (job.progress[timing] ?? 0) + Date.now() - stageSince;
                stageSince = Date.now();
              }
              job.stage = stage;
              job.progress.peak_sampled_rss_bytes = Math.max(
                job.progress.peak_sampled_rss_bytes ?? 0,
                process.memoryUsage().rss,
              );
              job.progress.peak_sampled_heap_bytes = Math.max(
                job.progress.peak_sampled_heap_bytes ?? 0,
                process.memoryUsage().heapUsed,
              );
              for (const [key, n] of Object.entries(delta ?? {}))
                job.progress[key] = key.startsWith("expected_") ? n : (job.progress[key] ?? 0) + n;
              if (job.progress.expected_positions > 0)
                job.percent = Math.max(
                  job.percent ?? 0,
                  Math.min(
                    99,
                    Math.floor(
                      (100 * (job.progress.processed_positions ?? job.progress.enriched_positions ?? 0)) /
                        job.progress.expected_positions,
                    ),
                  ),
                );
              if (job.progress.expected_warehouse_balances > 0)
                job.percent = Math.min(
                  99,
                  Math.floor(
                    (100 * (job.progress.processed_warehouse_balances ?? 0)) / job.progress.expected_warehouse_balances,
                  ),
                );
              if (job.tool === "query_analytics") {
                const phase =
                  stage === "aggregate_documents" && job.progress.expected_documents > 0
                    ? 70 + (29 * (job.progress.aggregated_documents ?? 0)) / job.progress.expected_documents
                    : stage === "aggregate_orders" && job.progress.expected_positions > 0
                      ? 70 + (29 * (job.progress.processed_positions ?? 0)) / job.progress.expected_positions
                      : stage === "verify_orders" && job.progress.expected_documents > 0
                        ? 60 + (10 * (job.progress.verified_documents ?? 0)) / job.progress.expected_documents
                        : job.progress.expected_documents > 0
                          ? (60 * (job.progress.processed_documents ?? 0)) / job.progress.expected_documents
                          : null;
                if (phase !== null) job.percent = Math.max(job.percent ?? 0, Math.min(99, Math.floor(phase)));
              }
              if (checkpoint !== undefined) job.checkpoint = checkpoint;
              if (checkpoint !== undefined || Date.now() - lastSave >= 1000) {
                lastSave = Date.now();
                await this.save(job);
              }
            },
          },
          async () => {
            try {
              const tool = this.tools.get(job.tool)!;
              const text = await inlineTool.run(job.tool, () => tool.handler(job.params));
              if (controller.signal.aborted) throw new Error("JOB_CANCELLED: Cancelled.");
              if (Buffer.byteLength(text) > 102400)
                throw new Error("STORAGE_LIMIT: Job summary exceeds inline budget.");
              job.result = JSON.parse(text);
              job.state = "succeeded";
              job.stage = "complete";
              job.percent = 100;
            } catch (error) {
              job.error = reportError(error, job.job_id);
              job.state = controller.signal.aborted ? "cancelled" : "failed";
              job.stage = job.state;
              job.recoverable = job.error.retryable;
            }
            const timing = "stage_" + (reportContext.getStore()?.stage ?? "processing") + "_ms";
            job.progress[timing] = (job.progress[timing] ?? 0) + Date.now() - stageSince;
            job.finished_at = new Date().toISOString();
            observeOperation(
              "report",
              job.tool,
              job.state,
              (Date.parse(job.finished_at) - Date.parse(job.started_at!)) / 1000,
            );
            await this.save(job);
            console.error(
              JSON.stringify({
                event: "report_job",
                job_id: job.job_id,
                state: job.state,
                error_code: job.error?.code ?? null,
                elapsed_ms: Date.parse(job.finished_at) - Date.parse(job.started_at!),
                progress: job.progress,
                rss_bytes: process.memoryUsage().rss,
              }),
            );
          },
        );
        this.active = undefined;
      }
    } finally {
      this.working = false;
      this.active = undefined;
    }
  }
  async execute(tool: string, params: Record<string, any>) {
    const job = await this.start(tool, params);
    if (tool === "query_analytics") {
      const current = await this.status(job.job_id);
      return JSON.stringify(
        current.state === "succeeded"
          ? current.result
          : {
              ...current,
              poll_after_ms: 3000,
              next_action:
                "Poll get_report_job with this job_id, sequentially after at least 3 seconds; do not repeat query_analytics or fetch order pages.",
            },
      );
    }
    const budget = Math.min(15000, Number(process.env.MOYSKLAD_REPORT_SYNC_MS ?? 15000));
    const until = Date.now() + budget;
    while (Date.now() < until) {
      const current = await this.status(job.job_id);
      if (current.state === "succeeded") return JSON.stringify(current.result);
      if (current.state === "failed" || current.state === "cancelled")
        return JSON.stringify({ job_id: current.job_id, state: current.state, error: current.error });
      await new Promise((r) => setTimeout(r, 50));
    }
    return JSON.stringify(await this.status(job.job_id));
  }
  async idle() {
    while (this.working) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  async diagnostics() {
    return {
      instance_id: process.env.HOSTNAME ?? "local",
      boot_id: this.bootId,
      started_at: this.startedAt,
      uptime_seconds: Math.floor(process.uptime()),
      rss_bytes: process.memoryUsage().rss,
      heap_used_bytes: process.memoryUsage().heapUsed,
      queue_depth: this.queue.length,
      active_jobs: this.active ? 1 : 0,
      active_job_id: this.active?.job.scope === credentialScope() ? this.active.job.job_id : null,
      counters_since: this.startedAt,
      storage: await storageDiagnostics(),
      disconnect_policy: "continue",
      worker_concurrency: 1,
    };
  }
}
export const reportJobs = new ReportJobs();
export const jobTools: ToolDef[] = [
  {
    name: "list_report_jobs",
    description:
      "Quick account-scoped job listing independent of the report queue. Returns latest states, stages and counters. Use get_report_job for results. Maximum limit 50, default 10.",
    schema: z.object({
      state: z.enum(["queued", "running", "cancelling", "succeeded", "failed", "cancelled"]).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    handler: async (p) => JSON.stringify(await reportJobs.list(p.state, p.limit)),
  },
  {
    name: "start_report",
    description:
      "Start a durable background report before long API work. Returns job_id immediately; poll get_report_job, never repeat the full request while running. Same account and parameters deduplicate. Continue after client disconnect. Reports remain read-only in MoySklad.",
    schema: z.object({
      tool: z.enum([...supported] as [string, ...string[]]),
      parameters: z.record(z.unknown()),
      request_key: z.string().max(100).optional(),
    }),
    handler: async (p) => JSON.stringify(await reportJobs.start(p.tool, p.parameters, p.request_key)),
  },
  {
    name: "get_report_job",
    description:
      "Quick status lookup independent of report calculations. Read durable report state, stage, progress, safe error and final result/export by job_id. Unknown total has percent=null. Restart preserves failed recoverable history.",
    schema: z.object({ job_id: z.string().uuid() }),
    handler: async (p) => JSON.stringify(await reportJobs.status(p.job_id)),
  },
  {
    name: "cancel_report_job",
    description:
      "Idempotently cancel a queued or running report for this MoySklad account. Stops further upstream requests; poll until cancelled. Does not modify MoySklad business data.",
    schema: z.object({ job_id: z.string().uuid() }),
    handler: async (p) => JSON.stringify(await reportJobs.cancel(p.job_id)),
  },
];
export const managedReportNames = new Set([...supported].filter((name) => name !== "get_documents"));
