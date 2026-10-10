// Read-only API verification. Never prints credentials, names, or source documents.
import { readFile, writeFile } from "node:fs/promises";
process.env.MOYSKLAD_TOKEN = (await readFile(new URL("../token.txt", import.meta.url), "utf8")).trim();
process.env.MOYSKLAD_RATE_BUCKET = "5";
process.env.MOYSKLAD_MAX_CONCURRENT = "2";
const { loadSourceLines } = await import("../dist/analytics-data.js");
const { sizeReportSchema, priceReportSchema, renderAnalytics } = await import("../dist/tools/analytics.js");
const { handleReconciliation, reconciliationSchema } = await import("../dist/tools/reconciliation.js");
const { readExport, handleReadExport } = await import("../dist/output.js");
const config = JSON.parse(await readFile(new URL("../examples/leotards-september-2026.json", import.meta.url), "utf8"));
try {
  const source = await loadSourceLines({ ...config, limit: 100, offset: 0 });
  console.log(JSON.stringify({ stage: "source_loaded", documents: source.documents, positions: source.lines.length }));
  const sizes = JSON.parse(await renderAnalytics(sizeReportSchema.parse(config), "sizes", source));
  const prices = JSON.parse(
    await renderAnalytics(priceReportSchema.parse({ ...config, output: "file" }), "prices", source),
  );
  const exportData = JSON.parse(await readExport(prices.export.uri));
  const exportPage = JSON.parse(
    await handleReadExport({ uri: prices.export.uri, section: "detail", limit: 1, offset: 0 }),
  );
  const reconcile = JSON.parse(await handleReconciliation(reconciliationSchema.parse(config)));
  const expectedSizes = [
    [1117, 25],
    [166, 20],
    [353, 6],
  ];
  const sizeMatches = ["female_sleeveless", "female_sleeved", "male"].every(
    (c, i) => sizes.totals[c].sold === expectedSizes[i][0] && sizes.totals[c].returned === expectedSizes[i][1],
  );
  const expectedPrices = [
    [239, 9],
    [444, 11],
    [244, 2],
    [14, 1],
    [3, 0],
    [94, 13],
  ];
  const priceMatches = prices.rows.every(
    (r, i) => r.sold === expectedPrices[i][0] && r.returned === expectedPrices[i][1],
  );
  const result = {
    checked_at: new Date().toISOString(),
    read_only: true,
    documents: source.documents,
    positions: source.lines.length,
    sizes: sizes.totals,
    prices: prices.rows.map(({ id, sold, returned, net }) => ({ id, sold, returned, net })),
    outside: prices.outside,
    unresolved: { sizes: sizes.unresolved, prices: prices.unresolved },
    snapshot_controls_match:
      sizeMatches &&
      priceMatches &&
      prices.outside.female_sleeveless?.sold === 190 &&
      prices.outside.female_sleeved?.sold === 55,
    reconciliation: {
      mismatches: reconcile.mismatches,
      compared_products: reconcile.compared_products,
      totals: reconcile.totals,
    },
    export: {
      readable: exportData.detail.length === exportPage.total,
      detail_rows: exportPage.total,
      dictionary_entries: Object.keys(exportData.dictionary).length,
    },
  };
  await writeFile(new URL("../verification/analytics-live.json", import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.snapshot_controls_match || reconcile.mismatches) process.exitCode = 1;
} catch (error) {
  console.error("Live verification failed: " + error.constructor.name + ". No credential or API payload printed.");
  process.exitCode = 1;
} finally {
  delete process.env.MOYSKLAD_TOKEN;
}
