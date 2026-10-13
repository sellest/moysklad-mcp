import { expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metricsAuthorized, observeOperation, renderMetrics } from "../src/metrics.js";
it("exports bounded operation counters and cumulative latency buckets without payloads", () => {
  observeOperation("tool", "get_stock", "success", 0.3);
  observeOperation("tool", "get_stock", "error", 2);
  observeOperation("report", "get_sales_by_size", "succeeded", 10);
  const text = renderMetrics({ mcp_api_requests_total: 3 });
  expect(text).toContain('mcp_tool_calls_total{name="get_stock",outcome="success"} 1');
  expect(text).toContain('mcp_tool_duration_seconds_bucket{name="get_stock",outcome="success",le="0.1"} 0');
  expect(text).toContain('mcp_tool_duration_seconds_bucket{name="get_stock",outcome="success",le="0.5"} 1');
  expect(text).toContain('mcp_report_duration_seconds_sum{name="get_sales_by_size",outcome="succeeded"} 10');
  expect(text).toContain("# TYPE mcp_api_requests_total counter");
  expect(text).not.toMatch(/Bearer|job_id|params|scope/);
});
it("fails closed for absent/unreadable secrets and wrong bearer tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-metrics-test-"));
  try {
    vi.stubEnv("MCP_METRICS_TOKEN_FILE", join(dir, "token"));
    expect(metricsAuthorized()).toBe(false);
    writeFileSync(join(dir, "token"), "a".repeat(64));
    expect(metricsAuthorized("Bearer " + "a".repeat(64))).toBe(true);
    expect(metricsAuthorized("Bearer " + "b".repeat(64))).toBe(false);
    expect(metricsAuthorized("Bearer short")).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true });
  }
});
