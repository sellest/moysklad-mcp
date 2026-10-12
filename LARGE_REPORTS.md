# Durable large reports

Cloud release 3.4.1 adds start_report, get_report_job, list_report_jobs and cancel_report_job. The
analytics profile has 19 tools; MoySklad business access remains read-only.

Start long work explicitly:

```json
{"tool":"get_sales_by_size","parameters":{"moment_from":"2023-01-01","moment_to":"2025-12-31","detail":"summary","output":"file"}}
```

Pass that object to start_report, then call get_report_job with the returned
job_id. Poll conservatively, for example every 5–10 seconds. A queued/running
response is not a finished business report. On success, result contains the
summary and an export URI. Read only the needed section with read_report_export;
use next_cursor, limit <=100, and max_bytes <=102400. MCP resources/read refuses
large exports instead of loading them wholesale.

Cloud Compose enables MOYSKLAD_REPORT_JOBS=true. Existing analytical tool names
keep their parameters, but calls now return either a completed report or a job
status within an eight-second synchronous budget. Use start_report when you need
an immediate job identity. Standalone legacy handlers remain available when the
feature is disabled; explicit job tools still use the durable worker.

Identical simultaneous requests share one job. refresh_source or refresh_catalog
requests get a new generation after previous work finishes. Captured positions
are immutable and reusable across size, price and category reports for 24 hours;
catalog cards are persisted with the snapshot and reused across all dimensions.
Expanded position cards are saved once; missing cards are fetched in batches of
at most 20 IDs (variant batches expand parent products), with individual GET
fallback for missing/archived cards. refresh_catalog creates a separate catalog
generation; old exports retain their original version. No historical classification is
implied. Employees using the same configured MoySklad credential share this
company's jobs and exports. Separate credentials resolve to separate storage
namespaces; the service still supports one configured company per deployment.

get_documents and get_document run outside the heavy worker. Interactive API
reads receive priority over background calls, with fairness and one shared global
rate/cooldown limit. Status, list and cancellation do not wait for calculations.
Progress includes expected/enriched/processed positions, a known-total percent,
and separately measured fetch/enrichment/aggregation times.

Cancellation is idempotent. Queued work is marked cancelled; running work enters
cancelling, aborts scheduler waits/upstream fetches, and becomes cancelled after
execution stops. Client disconnect uses continue, so job state remains queryable.

The Docker named volume mcp_data stores private metadata, page captures, catalog
cards and exports. Files are 0600 and directories 0700, owned by the container's
node user. Do not delete this volume while reports matter. Back it up separately
from Pocket ID auth_data. A restart retains history and exports; unfinished jobs
become failed, recoverable=true. Start the same report again to recover. Page
checkpoints are recorded but automatic checkpoint resume is not implemented in
this first delivery.

Defaults: one heavy worker, at most 16 queued jobs, a 1 GiB total storage quota
with reserved error-metadata space, 24-hour exports/captures, seven-day metadata
retention, and a 256-record job-history capacity. Cleanup runs during account
initialization/access, at most once per minute. Old orphan directories are
reclaimed after 24 hours. Capacity/quota errors are explicit; the service does
not silently evict an active report. These controls are for the current single
MCP process; multiple workers sharing the volume are unsupported.

The loader holds a small document page and position batch rather than all raw
objects. Aggregators flush audit batches of 100 positions. Catalog memory is
bounded to 16 MiB and 2048 entries; large upstream pages are rejected above 8 MiB.
Document and position totals are checked and duplicate positions are rejected.
Captures are non-transactional: equal-total edits during offset pagination cannot
be ruled out. Metadata says this explicitly; deterministic control passes and
automatic recovery are later SRD work.

Errors use the same error object in text and structuredContent, including code,
retryable, correlation_id, job_id, stage and safe_context. Diagnostics include
boot_id, instance_id, uptime, queue/worker state, heap/RSS, storage usage and
per-job API/processing counters. Logged events contain no business payloads,
credentials or server paths. Source passports preserve upstream date semantics;
the account timezone has not been independently verified.

Remaining SRD work includes automatic checkpoint resume, combined monthly
aggregation, full reconciliation drilldowns, live June 2025 investigation,
stronger change-detection/control passes, offboarding tests and measured p95/p99
under upstream delays. This release does not claim all P0/P1 acceptance criteria.

Cold annual timing remains to be remeasured. Regression tests verify snapshot
reuse across all report dimensions without repeated upstream calls.
