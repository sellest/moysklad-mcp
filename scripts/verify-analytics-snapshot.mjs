import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getEncoding } from "js-tiktoken";
import { Exact } from "../dist/precision.js";
import {
  aggregateSizes,
  aggregatePrices,
  renderAnalytics,
  sizeReportSchema,
  priceReportSchema,
} from "../dist/tools/analytics.js";
import { cacheRules } from "../dist/analytics-data.js";
import { documentProductTotals } from "../dist/tools/reconciliation.js";
import { wrap } from "../dist/index.js";

const directory = process.argv[2];
if (!directory) throw Error("Usage: node scripts/verify-analytics-snapshot.mjs <snapshot work directory>");
const read = async (name) => JSON.parse(await readFile(join(directory, name), "utf8"));
const positions = await read("size-positions.json");
const products = new Map((await read("size-products.json")).map((p) => [p.id, p]));
const variants = new Map((await read("size-variants.json")).map((v) => [v.id, v]));
const sales = await read("size-mcp-sales.json");
const config = JSON.parse(await readFile(new URL("../examples/leotards-september-2026.json", import.meta.url), "utf8"));
const lines = positions.map((p) => {
  const assortment = (p.product_type === "variant" ? variants.get(p.product_id) : products.get(p.product_id)) ?? {
    id: p.product_id,
    name: p.product_name,
    meta: { type: p.product_type, href: p.product_href },
  };
  const parentId = p.product_type === "variant" ? assortment?.product?.meta?.href?.split("/").pop() : p.product_id;
  return {
    document_id: p.document_id,
    document_type: p.kind,
    moment: p.moment,
    position: {
      id: p.id,
      quantity: p.quantity,
      price: new Exact(String(p.price_rubles)).mul(100).toFixed(),
      discount: p.discount,
    },
    assortment,
    product: products.get(parentId) ?? null,
    parent_product_id: p.product_type === "product" || p.product_type === "variant" ? parentId : null,
    kind: p.kind === "demand" ? "sold" : "returned",
  };
});
const sizeData = aggregateSizes(lines, sizeReportSchema.parse(config));
const priceData = aggregatePrices(lines, priceReportSchema.parse(config));
const expectedSizes = [
  [1117, 25],
  [166, 20],
  [353, 6],
];
for (const [i, category] of ["female_sleeveless", "female_sleeved", "male"].entries()) {
  if (
    sizeData.totals[category].sold !== expectedSizes[i][0] ||
    sizeData.totals[category].returned !== expectedSizes[i][1]
  )
    throw Error("Size control failed: " + category);
}
const expectedPrices = [
  [239, 9],
  [444, 11],
  [244, 2],
  [14, 1],
  [3, 0],
  [94, 13],
];
for (const [i, row] of priceData.rows.entries())
  if (row.sold !== expectedPrices[i][0] || row.returned !== expectedPrices[i][1])
    throw Error("Price control failed: " + row.id);
if (priceData.outside.female_sleeveless.sold !== 190 || priceData.outside.female_sleeved.sold !== 55)
  throw Error("Outside control failed");
if (Object.keys(sizeData.unresolved).length || Object.keys(priceData.unresolved).length)
  throw Error("Unexpected unresolved values");
const controls = documentProductTotals(lines.filter((line) => line.product));
let mismatches = 0;
for (const [id, total] of controls) {
  const row = sales.items.find((item) => item.product_id === id);
  if (!row || row.sell_quantity !== total.sold || row.return_quantity !== total.returned) mismatches++;
}
if (mismatches) throw Error("Reconciliation failed");
const tokenizer = getEncoding("o200k_base");
const measure = (value) => {
  const text = JSON.stringify(value);
  return { tokens: tokenizer.encode(text).length, characters: text.length, bytes_utf8: Buffer.byteLength(text) };
};
const oldEnvelope = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const documents = new Map();
for (const p of positions) {
  const doc = documents.get(p.document_id) ?? {
    id: p.document_id,
    name: p.document,
    moment: p.moment,
    positions_export: { items: [] },
  };
  const { document, document_id, moment, kind, ...item } = p;
  doc.positions_export.items.push(item);
  documents.set(p.document_id, doc);
}
// Reconstruct exactly the available old normalized rows. No unavailable raw headers are invented.
const oldTaskEnvelopes = [oldEnvelope(sales)];
for (const kind of ["demand", "salesreturn"]) {
  const ids = new Set(positions.filter((p) => p.kind === kind).map((p) => p.document_id));
  const docs = [...documents.values()].filter((d) => ids.has(d.id));
  for (let i = 0; i < docs.length; i += 100)
    oldTaskEnvelopes.push(oldEnvelope({ total: docs.length, documents: docs.slice(i, i + 100) }));
}
for (const [array, key] of [
  [[...variants.values()], "variants"],
  [[...products.values()], "products"],
]) {
  for (let i = 0; i < array.length; i += 1000)
    oldTaskEnvelopes.push(oldEnvelope({ total: array.length, [key]: array.slice(i, i + 1000) }));
}
const documentsByType = Object.fromEntries(
  ["demand", "salesreturn", "retaildemand", "retailsalesreturn"].map((type) => [
    type,
    new Set(positions.filter((p) => p.kind === type).map((p) => p.document_id)).size,
  ]),
);
const source = {
  lines,
  documents: documentsByType,
  catalog: { version: "snapshot-2026-10-10", checked_at: "2026-10-10T00:00:00.000Z", cache: cacheRules },
};
// Invoke the production renderer: rules, period, catalog and source metadata are included.
const newSizeEnvelope = await wrap((p) => renderAnalytics(p, "sizes", source))(sizeReportSchema.parse(config));
const newPriceEnvelope = await wrap((p) => renderAnalytics(p, "prices", source))(priceReportSchema.parse(config));
const baselineTasks = oldTaskEnvelopes
  .map(measure)
  .reduce(
    (sum, m) => ({
      tokens: sum.tokens + m.tokens,
      characters: sum.characters + m.characters,
      bytes_utf8: sum.bytes_utf8 + m.bytes_utf8,
    }),
    { tokens: 0, characters: 0, bytes_utf8: 0 },
  );
const result = {
  source: "10.10.2026 local reference snapshot; no fresh API assertion",
  tokenizer: "o200k_base (ChatGPT model family; exact selected-model tokenizer unknown)",
  measurement_scope:
    "Entire JSON MCP result envelopes, including escaped text. Before task reconstructs old normalized document pages plus complete product/variant cards and sales report. Raw document headers unavailable; reconstruction is disclosed. Requests, prompts, model framing and schemas are not included in these result counts.",
  controls: {
    sizes: sizeData.totals,
    prices: priceData.rows.map(({ id, sold, returned, net }) => ({ id, sold, returned, net })),
    outside: priceData.outside,
    mismatches,
    source_rows: positions.length,
  },
  results: {
    old_task_total: baselineTasks,
    new_size_summary: measure(newSizeEnvelope),
    new_price_summary: measure(newPriceEnvelope),
    new_both_task_total: [newSizeEnvelope, newPriceEnvelope]
      .map(measure)
      .reduce(
        (sum, m) => ({
          tokens: sum.tokens + m.tokens,
          characters: sum.characters + m.characters,
          bytes_utf8: sum.bytes_utf8 + m.bytes_utf8,
        }),
        { tokens: 0, characters: 0, bytes_utf8: 0 },
      ),
  },
};
const folder = resolve("verification");
await mkdir(folder, { recursive: true });
await writeFile(join(folder, "analytics-measurements.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
