#!/usr/bin/env node
import { jobTools, reportJobs, managedReportNames } from "./report-jobs.js";
import { reportError } from "./report-errors.js";
import { metricsAuthorized, observeOperation, renderMetrics } from "./metrics.js";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "./version.js";
import { AuthFailure, createOAuthGuard, loadOAuthConfig } from "./oauth.js";
import type { ToolDef } from "./types.js";

import { tools as productTools } from "./tools/products.js";
import { tools as stockTools } from "./tools/stock.js";
import { tools as counterpartyTools } from "./tools/counterparties.js";
import { tools as orderTools } from "./tools/orders.js";
import { tools as reportTools } from "./tools/reports.js";
import { tools as supplyTools } from "./tools/supply.js";
import { tools as shipmentTools } from "./tools/shipments.js";
import { tools as storeTools } from "./tools/stores.js";
import { tools as organizationTools } from "./tools/organizations.js";
import { tools as webhookTools } from "./tools/webhooks.js";
import { tools as documentTools } from "./tools/documents.js";
import { tools as financeTools } from "./tools/finance.js";
import { tools as catalogTools } from "./tools/catalog.js";
import { tools as reportsExtraTools } from "./tools/reports_extra.js";
import { tools as referenceTools } from "./tools/reference.js";
import { tools as auditTools } from "./tools/audit.js";
import { tools as analyticsTools } from "./tools/analytics.js";
import { tools as reconciliationTools } from "./tools/reconciliation.js";
import { tools as rankingTools } from "./tools/rankings.js";
import { tools as contactDeveloperTools } from "./tools/contact-developer.js";
import { tools as queryAnalyticsTools } from "./tools/query-analytics.js";
import { requestScheduler } from "./client.js";
import { sourceCacheDiagnostics } from "./analytics-data.js";
import { z } from "zod";
import { handleReadExport, readExport, readExportSchema } from "./output.js";

const allTools: ToolDef[] = [
  ...productTools,
  ...stockTools,
  ...counterpartyTools,
  ...orderTools,
  ...reportTools,
  ...supplyTools,
  ...shipmentTools,
  ...storeTools,
  ...organizationTools,
  ...webhookTools,
  ...documentTools,
  ...financeTools,
  ...catalogTools,
  ...reportsExtraTools,
  ...referenceTools,
  ...auditTools,
  ...analyticsTools,
  ...reconciliationTools,
  ...rankingTools,
  ...contactDeveloperTools,
  ...queryAnalyticsTools,
  ...jobTools,
  {
    name: "get_mcp_diagnostics",
    description:
      "Explicit compact diagnostics: request timings, safe rate-limit headers/codes, cooldown and source-cache counts. No credentials, paths, requests or business payloads.",
    schema: z.object({ last_events: z.number().int().min(0).max(20).default(5) }),
    handler: async (p) =>
      JSON.stringify({
        version: VERSION,
        reports: await reportJobs.diagnostics(),
        scheduler: requestScheduler.diagnostics(p.last_events),
        source_cache: sourceCacheDiagnostics(),
      }),
  },
  {
    name: "read_report_export",
    description:
      "Read only a needed page of a saved MCP export URI. Choose its section: detail/dictionary for analytics, ranking for articles, positions for a document, or its list key. Follow next_offset. Persistent job exports survive restart for 24 hours. limit must be 1..100 (default 25); max_bytes 1024..102400. Use next_cursor/next_offset for more rows. Legacy local exports expire after one hour or restart.",
    schema: readExportSchema,
    handler: handleReadExport,
  },
];

export const wrap = (handler: (params: any) => Promise<string>, name?: string) => async (params: any) => {
  const started = performance.now();
  const record = (outcome: string) => {
    if (name) observeOperation("tool", name, outcome, (performance.now() - started) / 1000);
  };
  let text;
  try {
    text = await handler(params);
  } catch (error) {
    record("error");
    const failure = reportError(error);
    const payload = { error: failure };
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
  const content: any[] = [{ type: "text", text }];
  try {
    const payload = JSON.parse(text);
    if (payload?.error) {
      record("error");
      return { isError: true, content, structuredContent: payload };
    }
  } catch {
    /* Plain text remains supported. */
  }
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    /* Plain-text tools remain supported. */
  }
  if (result?.export?.uri)
    content.push({
      type: "resource_link",
      uri: result.export.uri,
      name: "report.json",
      mimeType: "application/json",
      description: "Full export; resources/read or read_report_export",
    });
  record("success");
  return { content };
};

function createMcpServer() {
  const instance = new McpServer(
    { name: "moysklad-mcp", version: VERSION },
    {
      instructions:
        "For analytical questions across customer orders, use query_analytics instead of downloading get_documents pages or running parallel page requests. For delivery city/region rankings use order.delivery.city/order.delivery.region with orders_count and orders_total_rub (each whole order sum once, including delivery). Do not substitute ordered_revenue or download raw orders. A missing region stays absent/null; never infer it from city/postal code/free text. Read missing/excluded counters and disclose default status policy. If aggregate next_offset is non-null, read the remaining aggregate page using the same query; this reuses the source snapshot. Use operation=describe to discover actual category values/status IDs; never invent category aliases or infer sleeves from names. Default order selection is posted except confirmed cancelled statuses; disclose it, and apply explicit user status selection when provided. A query may return job_id; poll get_report_job sequentially at intervals of at least 3 seconds. Partial/unresolved results cannot establish a definitive winner. Files are only for explicit export requests. When the user asks to contact the developer, or a task remains blocked after reasonable recovery, use contact_developer to prepare a concise problem report. Send the returned email through the user's connected Gmail only if a send tool is available, following that connector's approval rules. contact_developer itself never sends mail. If sending is unavailable or fails, provide the draft and explicitly state it was not sent. Never claim delivery without successful Gmail confirmation, invent reproduction steps, or include credentials, full conversation history or customer data dumps.",
    },
  );
  instance.resource(
    "report-export",
    new ResourceTemplate("moysklad-export://{id}", { list: undefined }),
    { mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: await readExport(uri.href) }] }),
  );
  const seen = new Set<string>();
  for (const t of selectedTools()) {
    if (seen.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    seen.add(t.name);
    if (process.env.MCP_AUTH_MODE === "oauth") {
      instance.registerTool(
        t.name,
        {
          description:
            t.description +
            (process.env.MOYSKLAD_REPORT_JOBS === "true" && managedReportNames.has(t.name)
              ? " May return job_id and queued/running state within the sync budget. Poll get_report_job for totals/export; do not repeat the full report while running."
              : ""),
          inputSchema: t.schema.shape,
          annotations: { readOnlyHint: t.name !== "cancel_report_job", destructiveHint: false },
          _meta: { securitySchemes: [{ type: "oauth2", scopes: [process.env.MCP_AUTH_SCOPE ?? "moysklad:read"] }] },
        },
        wrap(
          t.name === "query_analytics" ||
            (process.env.MOYSKLAD_REPORT_JOBS === "true" && managedReportNames.has(t.name))
            ? (params) =>
                t.name === "query_analytics" && params.operation === "describe"
                  ? t.handler(params)
                  : reportJobs.execute(t.name, params)
            : t.handler,
          t.name,
        ),
      );
    } else {
      instance.tool(
        t.name,
        t.description,
        t.schema.shape,
        wrap(
          t.name === "query_analytics" ||
            (process.env.MOYSKLAD_REPORT_JOBS === "true" && managedReportNames.has(t.name))
            ? (params) =>
                t.name === "query_analytics" && params.operation === "describe"
                  ? t.handler(params)
                  : reportJobs.execute(t.name, params)
            : t.handler,
          t.name,
        ),
      );
    }
  }
  return instance;
}

const analyticsNames = new Set([
  "get_stock",
  "get_stock_at_date",
  "get_stock_by_store",
  "get_stock_current",
  "list_report_jobs",
  "search_products",
  "search_variants",
  "search_assortment",
  "get_document",
  "get_documents",
  "get_sales_report",
  "get_profit_report",
  "get_sales_by_size",
  "get_sales_by_price",
  "get_sales_by_category",
  "get_sales_ranking_by_article",
  "reconcile_sales",
  "read_report_export",
  "get_mcp_diagnostics",
  "list_organizations",
  "start_report",
  "get_report_job",
  "cancel_report_job",
  "contact_developer",
  "query_analytics",
]);
function selectedTools() {
  const profile = process.env.MOYSKLAD_TOOL_PROFILE ?? "full";
  if (profile !== "full" && profile !== "analytics") throw new Error("TOOL_PROFILE: use full or analytics.");
  return profile === "analytics" ? allTools.filter((tool) => analyticsNames.has(tool.name)) : allTools;
}
reportJobs.register(allTools);
const server = createMcpServer();
const TOOL_COUNT = selectedTools().length;

async function main() {
  const httpPort =
    process.env.HTTP_PORT ||
    (process.argv.includes("--http") ? process.argv[process.argv.indexOf("--http") + 1] : null);
  if (httpPort) {
    const port = parseInt(String(httpPort), 10) || 3000;
    await startHttpTransport(port);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[moysklad-mcp] Server started (stdio). ${TOOL_COUNT} tools available.`);
  }
}

async function startHttpTransport(port: number) {
  const { createServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  // CORS is opt-in: only emit Access-Control-Allow-Origin when explicitly
  // configured. The HTTP transport exposes tools that act on the configured
  // MoySklad token, so a wildcard default would let any web page drive it.
  const config = loadOAuthConfig();
  const auth = config ? createOAuthGuard(config) : undefined;
  const corsOrigin = process.env.MOYSKLAD_HTTP_CORS_ORIGIN;
  const httpServer = createServer(async (req, res) => {
    if (corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/metrics" && process.env.MCP_METRICS_TOKEN_FILE) {
      if (!metricsAuthorized(req.headers.authorization)) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405, { Allow: "GET" });
        res.end();
        return;
      }
      try {
        const jobs = await reportJobs.diagnostics(),
          api = requestScheduler.diagnostics(0);
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" });
        res.end(
          renderMetrics({
            mcp_report_queue_depth: jobs.queue_depth,
            mcp_report_active_jobs: jobs.active_jobs,
            mcp_api_requests_total: api.requests,
            mcp_api_throttled_total: api.throttled,
            mcp_api_queue_depth: api.queued,
            mcp_api_active_requests: api.active,
          }),
        );
      } catch {
        res.writeHead(503);
        res.end();
      }
      return;
    }
    if (
      auth &&
      [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
        "/mcp/.well-known/oauth-protected-resource",
      ].includes(pathname)
    ) {
      if (req.method !== "GET") {
        res.writeHead(405, { Allow: "GET" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(auth.metadata));
      return;
    }
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          tools: selectedTools().length,
          tool_profile: process.env.MOYSKLAD_TOOL_PROFILE ?? "full",
          transport: "streamable-http",
          version: VERSION,
        }),
      );
      return;
    }
    if (pathname === "/mcp") {
      if (auth) {
        try {
          await auth.verify(req);
        } catch (error) {
          auth.reject(res, error instanceof AuthFailure ? error : new AuthFailure(503, "auth_unavailable"));
          return;
        }
      }
      // A stateless transport may handle only one request. Keep both the
      // transport and server isolated so concurrent clients can reuse IDs.
      const requestServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void requestServer.close().catch(() => {
          console.error("[moysklad-mcp] HTTP_CLEANUP_FAILED");
        });
      });
      try {
        await requestServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch {
        console.error("[moysklad-mcp] HTTP_TRANSPORT_ERROR");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal server error" } }),
          );
        } else {
          res.end();
        }
      }
      return;
    }
    res.writeHead(404);
    res.end("Not found. Use /mcp or /health.");
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, resolve);
  });
  if (port !== 0) {
    console.error(`[moysklad-mcp] HTTP server on port ${port}. ${TOOL_COUNT} tools available.`);
  }
  return httpServer;
}

const isDirectRun = process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts");
if (isDirectRun) {
  main().catch((error) => {
    console.error("[moysklad-mcp] Error:", error);
    process.exit(1);
  });
}

export { server, allTools, startHttpTransport };
