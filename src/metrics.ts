import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
const buckets = [0.1, 0.5, 1, 5, 15, 60, 300];
const series = new Map<string, { count: number; sum: number; buckets: number[] }>();
let lastCall = 0;
export function observeOperation(kind: "tool" | "report", name: string, outcome: string, seconds: number) {
  // Only registry names and fixed outcomes are supplied, never user data or errors.
  const key = `${kind}:${name}:${outcome}`;
  const value = series.get(key) ?? { count: 0, sum: 0, buckets: buckets.map(() => 0) };
  value.count++;
  value.sum += seconds;
  buckets.forEach((b, i) => {
    if (seconds <= b) value.buckets[i]++;
  });
  series.set(key, value);
  if (kind === "tool") lastCall = Date.now() / 1000;
}
export function metricsAuthorized(header?: string) {
  const path = process.env.MCP_METRICS_TOKEN_FILE;
  if (!path) return false;
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    return false;
  }
  const expected = Buffer.from(`Bearer ${token}`),
    supplied = Buffer.from(header ?? "");
  return token.length >= 32 && expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
export function renderMetrics(gauges: Record<string, number>) {
  const lines: string[] = [];
  for (const kind of ["tool", "report"]) {
    const prefix = `mcp_${kind}`;
    lines.push(`# TYPE ${prefix}_calls_total counter`, `# TYPE ${prefix}_duration_seconds histogram`);
    for (const [key, value] of series) {
      const [k, name, outcome] = key.split(":");
      if (k !== kind) continue;
      const labels = `name="${name}",outcome="${outcome}"`;
      lines.push(`${prefix}_calls_total{${labels}} ${value.count}`);
      buckets.forEach((b, i) =>
        lines.push(`${prefix}_duration_seconds_bucket{${labels},le="${b}"} ${value.buckets[i]}`),
      );
      lines.push(
        `${prefix}_duration_seconds_bucket{${labels},le="+Inf"} ${value.count}`,
        `${prefix}_duration_seconds_count{${labels}} ${value.count}`,
        `${prefix}_duration_seconds_sum{${labels}} ${value.sum}`,
      );
    }
  }
  const mem = process.memoryUsage(),
    cpu = process.cpuUsage();
  for (const [name, value] of Object.entries({
    ...gauges,
    process_resident_memory_bytes: mem.rss,
    process_heap_used_bytes: mem.heapUsed,
    process_uptime_seconds: process.uptime(),
    mcp_last_tool_call_timestamp_seconds: lastCall,
  }))
    lines.push(`# TYPE ${name} ${name.endsWith("_total") ? "counter" : "gauge"}`, `${name} ${value}`);
  lines.push("# TYPE process_cpu_seconds_total counter", `process_cpu_seconds_total ${(cpu.user + cpu.system) / 1e6}`);
  return lines.join("\n") + "\n";
}
