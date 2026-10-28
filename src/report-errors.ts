import { randomUUID } from "node:crypto";
import { reportContext } from "./report-context.js";
const messages: Record<string, string> = {
  EXPIRED_RESPONSE:
    "Inline response snapshot expired or is unavailable. Repeat the original request without response_cursor.",
  INLINE_RESPONSE_TOO_LARGE:
    "A single row or metadata exceeds the inline budget. Request narrower fields, smaller position pages, or explicitly output=file if a file is needed.",
  ANALYTICS_POLICY_UNAVAILABLE:
    "Confirmed cancellation status reference is missing or outdated; ask the operator to configure MCP_ANALYTICS_ORDER_POLICY_FILE. Use query_analytics operation=describe for source statuses.",
  CONTACT_NOT_CONFIGURED:
    "Developer contact is not configured on the MCP server. Ask the server operator to set MCP_DEVELOPER_EMAIL.",
  INVALID_ARGUMENT: "Invalid report parameters.",
  UPSTREAM_TIMEOUT: "MoySklad did not respond within the request budget.",
  RATE_LIMITED: "Upstream request budget exhausted; retry later.",
  JOB_CANCELLED: "Report cancelled.",
  INCOMPLETE_SOURCE: "Source capture is incomplete or changed; start a new capture.",
  INTERNAL_ERROR: "Report failed; use correlation_id for diagnosis.",
  EXPIRED_EXPORT: "Export expired; start the report again.",
  AUTH_FAILED: "Required access is unavailable.",
  JOB_NOT_FOUND: "Job is unavailable for this account.",
  STORAGE_LIMIT: "Report storage budget exhausted; wait for cleanup or reduce the report period.",
};
export function reportError(error: unknown, correlationId: string = randomUUID()) {
  const source = error instanceof Error ? /^([A-Z][A-Z0-9_]+):/.exec(error.message)?.[1] : undefined;
  let code = "INTERNAL_ERROR";
  if (source && source in messages) code = source;
  else if (source === "API_TIMEOUT" || source === "API_NETWORK_ERROR") code = "UPSTREAM_TIMEOUT";
  else if (source === "API_HTTP_429" || source === "RATE_WAIT_EXHAUSTED") code = "RATE_LIMITED";
  else if (
    source &&
    /^(INCOMPLETE_PAGE|SOURCE_CHANGED|DOCUMENT_ID|POSITION_ID|QUANTITY_UNRESOLVED|REPORT_ID|ASSORTMENT_ID)$/.test(
      source,
    )
  )
    code = "INCOMPLETE_SOURCE";
  else if (source && /^(API_HTTP_401|API_HTTP_403|AUTH_NOT_CONFIGURED)$/.test(source)) code = "AUTH_FAILED";
  else if (source && /^(PERIOD_|BAND_|SIZE_|ENTITY_ID|EXPORT_SECTION|INVALID_ARGUMENT)/.test(source))
    code = "INVALID_ARGUMENT";
  const run = reportContext.getStore();
  return {
    code,
    message: messages[code],
    retryable: ["UPSTREAM_TIMEOUT", "RATE_LIMITED", "INTERNAL_ERROR", "INCOMPLETE_SOURCE"].includes(code),
    retry_after_ms: code === "RATE_LIMITED" ? 3000 : null,
    correlation_id: correlationId,
    job_id: run?.jobId ?? null,
    stage: run?.stage ?? null,
    safe_context: { source_code: source ?? "UNCLASSIFIED" },
  };
}
