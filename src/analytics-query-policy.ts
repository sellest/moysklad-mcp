import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export async function queryPolicy() {
  const text = await readFile(process.env.MCP_ANALYTICS_ORDER_POLICY_FILE ?? "", "utf8").catch(() => "");
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("ANALYTICS_POLICY_UNAVAILABLE: Configure a confirmed order status reference.");
  }
  const ids = value.default_policy?.cancelled_state_ids;
  if (
    value.default_policy?.cancellation_mapping_confirmed !== true ||
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id: any) => typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) ||
    !Array.isArray(value.states)
  )
    throw new Error("ANALYTICS_POLICY_UNAVAILABLE: Cancellation mapping must be confirmed.");
  return {
    cancelledIds: new Set<string>(ids),
    knownIds: new Set<string>(value.states.map((s: any) => s.id)),
    revision: createHash("sha256").update(text).digest("hex"),
  };
}
export async function analyticsConfigurationRevision() {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "query-analytics-v2-document-grain",
        await readFile(process.env.MCP_ANALYTICS_ORDER_POLICY_FILE ?? "", "utf8").catch(() => ""),
        process.env.MOYSKLAD_REPORT_TIMEZONE ?? "Europe/Moscow",
      ]),
    )
    .digest("hex");
}
