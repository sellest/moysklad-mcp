import { AsyncLocalStorage } from "node:async_hooks";
export interface RunContext {
  jobId: string;
  catalogId?: string;
  stage?: string;
  scope: string;
  signal: AbortSignal;
  progress: (stage: string, delta?: Record<string, number>, checkpoint?: unknown) => Promise<void>;
}
export const reportContext = new AsyncLocalStorage<RunContext>();
export function checkCancelled() {
  if (reportContext.getStore()?.signal.aborted) throw new Error("JOB_CANCELLED: Report cancelled.");
}
export async function reportProgress(stage: string, delta?: Record<string, number>, checkpoint?: unknown) {
  checkCancelled();
  const run = reportContext.getStore();
  if (run) {
    if (stage !== "upstream") run.stage = stage;
    await run.progress(run.stage ?? "fetch_documents", delta, checkpoint);
  }
}
