import { readFile, writeFile } from "node:fs/promises";
process.env.MOYSKLAD_TOKEN = (await readFile(new URL("../token.txt", import.meta.url), "utf8")).trim();
process.env.MOYSKLAD_RATE_BUCKET = "8";
process.env.MOYSKLAD_MAX_CONCURRENT = "2";
const { loadSourceLines } = await import("../dist/analytics-data.js");
const { requestScheduler } = await import("../dist/client.js");
const { renderAnalytics, sizeReportSchema, priceReportSchema } = await import("../dist/tools/analytics.js");
const { handleArticleRanking, handleCategoryReport, articleRankingSchema, categoryReportSchema } =
  await import("../dist/tools/rankings.js");
const { handleReconciliation, reconciliationSchema } = await import("../dist/tools/reconciliation.js");
const config = JSON.parse(await readFile(new URL("../examples/leotards-september-2026.json", import.meta.url), "utf8"));
try {
  const started = performance.now();
  const source = await loadSourceLines({ ...config, limit: 100, offset: 0, refresh_source: true });
  const coldMs = performance.now() - started;
  const before = requestScheduler.diagnostics(0).requests;
  console.log(
    JSON.stringify({
      stage: "source_loaded",
      documents: source.documents,
      positions: source.lines.length,
      duration_ms: Math.round(coldMs),
    }),
  );
  const warmStart = performance.now();
  const size = JSON.parse(await renderAnalytics(sizeReportSchema.parse(config), "sizes", source));
  const price = JSON.parse(await renderAnalytics(priceReportSchema.parse(config), "prices", source));
  const category = JSON.parse(await handleCategoryReport(categoryReportSchema.parse(config)));
  const ranking = JSON.parse(
    await handleArticleRanking(
      articleRankingSchema.parse({ ...config, categories: ["female_sleeveless", "female_sleeved"] }),
    ),
  );
  const warmMs = performance.now() - warmStart;
  const added = requestScheduler.diagnostics(0).requests - before;
  const reconciliation = JSON.parse(await handleReconciliation(reconciliationSchema.parse(config)));
  const result = {
    checked_at: new Date().toISOString(),
    version: "3.3.0",
    read_only: true,
    configuration: { budget: 8, concurrency: 2 },
    cold_source_ms: Math.round(coldMs),
    warm_four_reports_ms: Math.round(warmMs),
    warm_additional_api_requests: added,
    source: { documents: source.documents, positions: source.lines.length },
    snapshot_ids: [size, price, category, ranking].map((r) => r.snapshot.id),
    sizes: size.totals,
    price_sold: price.rows.map((r) => r.sold),
    outside: price.outside,
    categories: category.rows,
    ranking: {
      leader: ranking.rows[0],
      top20_quantity: ranking.page_quantity,
      products_with_activity: ranking.products_with_activity,
      returns_only_products: ranking.returns_only_products,
    },
    reconciliation: { mismatches: reconciliation.mismatches, compared_products: reconciliation.compared_products },
    diagnostics: requestScheduler.diagnostics(20),
  };
  await writeFile(
    new URL("../verification/reliability-live-3.3.json", import.meta.url),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  if (reconciliation.mismatches || added || new Set(result.snapshot_ids).size !== 1) process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({
      error: /^([A-Z][A-Z0-9_]+):/.exec(error.message)?.[1] ?? "LIVE_VERIFICATION_FAILED",
      action: "Inspect safe request diagnostics; no credentials or payload printed.",
      diagnostics: requestScheduler.diagnostics(10),
    }),
  );
  process.exitCode = 1;
} finally {
  delete process.env.MOYSKLAD_TOKEN;
}
