// Controlled MCP trace benchmark. Real runtime schemas/results, identical anonymous fixture, no external API.
import { writeFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";
import { loadFixture } from "./fixture-lib.mjs";
const { fixture, products, assortment, source } = await loadFixture();
const nativeFetch = globalThis.fetch;
process.env.MOYSKLAD_TOKEN = "anonymous-fixture";
process.env.MOYSKLAD_RATE_BUCKET = "1000000";
let apiRequests = 0;
const docs = new Map();
for (const line of source.lines) {
  const doc = docs.get(line.document_id) ?? {
    id: line.document_id,
    name: "Reference document",
    moment: line.moment,
    type: line.document_type,
    positions: { meta: { size: 0 }, rows: [] },
  };
  doc.positions.rows.push(line.position);
  doc.positions.meta.size++;
  docs.set(doc.id, doc);
}
const cards = new Map([...products.values(), ...assortment.values()].map((p) => [p.id, p]));
const totals = new Map();
for (const line of source.lines) {
  const id = line.parent_product_id ?? line.assortment.id;
  const t = totals.get(id) ?? {
    assortment: products.get(id) ?? line.assortment,
    sellQuantity: 0,
    returnQuantity: 0,
    sellSum: 0,
    returnSum: 0,
  };
  t[line.kind === "sold" ? "sellQuantity" : "returnQuantity"] += line.position.quantity;
  totals.set(id, t);
}
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === "string" ? input : (input.url ?? input));
  if (url.hostname !== "api.moysklad.ru") return nativeFetch(input, options);
  apiRequests++;
  const path = url.pathname.replace("/api/remap/1.2", ""),
    offset = Number(url.searchParams.get("offset") ?? 0),
    limit = Number(url.searchParams.get("limit") ?? 1000);
  let rows;
  const entity = /^\/entity\/([^/]+)(?:\/([^/]+))?(?:\/positions)?$/.exec(path);
  if (entity?.[2])
    return new Response(
      JSON.stringify(
        path.endsWith("/positions")
          ? {
              meta: { size: docs.get(entity[2]).positions.rows.length, offset },
              rows: docs.get(entity[2]).positions.rows.slice(offset, offset + limit),
            }
          : (cards.get(entity[2]) ?? {}),
      ),
    );
  if (path === "/report/profit/byproduct") rows = [...totals.values()];
  else if (entity?.[1] === "product")
    rows = [...products.values()].map((p) => ({
      ...p,
      productFolder: url.searchParams.get("expand")
        ? {
            id: "f",
            name: "Folder",
            owner: { meta: { href: "https://example.invalid/owner" } },
            group: { meta: { href: "https://example.invalid/group" } },
            accountId: "fixture-account",
            meta: { href: "https://example.invalid/folder", type: "productfolder" },
          }
        : { meta: { href: "https://example.invalid/folder", type: "productfolder" } },
    }));
  else if (entity?.[1] === "variant") rows = [...assortment.values()].filter((p) => p.meta.type === "variant");
  else rows = [...docs.values()].filter((d) => d.type === entity?.[1]);
  return new Response(
    JSON.stringify({ meta: { size: rows.length, offset }, rows: rows.slice(offset, offset + limit) }),
  );
};
const old = await import("../.tools/baseline-3.2.0/dist/index.js");
const current = await import("../dist/index.js");
const tokenizer = getEncoding("o200k_base");
const measure = (value) => {
  const s = JSON.stringify(value);
  return { tokens: tokenizer.encode(s).length, characters: s.length, bytes_utf8: Buffer.byteLength(s) };
};
const sum = (values) =>
  values
    .map(measure)
    .reduce(
      (s, m) => ({
        tokens: s.tokens + m.tokens,
        characters: s.characters + m.characters,
        bytes_utf8: s.bytes_utf8 + m.bytes_utf8,
      }),
      { tokens: 0, characters: 0, bytes_utf8: 0 },
    );
const allResults = {};
async function run(label, module, profile = "full") {
  process.env.MOYSKLAD_TOOL_PROFILE = profile;
  const server = await module.startHttpTransport(0),
    port = server.address().port;
  const post = async (method, params, id = 1) => {
    const response = await nativeFetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return (await response.json()).result;
  };
  try {
    const schemas = await post("tools/list");
    const tool = async (name, args, trace) => {
      trace.push({ method: "tools/call", params: { name, arguments: args } });
      const definition = module.allTools.find((t) => t.name === name);
      const result = await module.wrap(definition.handler)(definition.schema.parse(args));
      trace.push(result);
      if (result.isError) throw Error(`Benchmark tool failed: ${name}`);
      return JSON.parse(result.content[0].text);
    };
    const task = async (name, callback) => {
      const trace = [{ method: "tools/list" }, schemas],
        before = apiRequests,
        start = performance.now();
      const controls = await callback(trace);
      allResults[label] ??= {};
      allResults[label][name] = {
        total_content: sum(trace),
        schemas: measure(schemas),
        followup_content: sum(trace.slice(2)),
        mcp_messages: trace.length,
        resource_reads: trace.filter((v) => v.method === "resources/read" || v.params?.name === "read_report_export")
          .length,
        api_requests: apiRequests - before,
        execution_ms: Math.round(performance.now() - start),
        failures: 0,
        controls,
      };
    };
    const period = { moment_from: "2026-09-01", moment_to: "2026-09-30" };
    await task("quantity_products_25", async (trace) => {
      const result = await tool("search_products", { limit: 25, fields: "quantity" }, trace);
      return { returned: result.returned };
    });
    await task("female_top20", async (trace) => {
      if (label === "3.2.0") {
        await tool("get_sales_report", { ...period, fields: "quantity", limit: 1000 }, trace);
        await tool("search_products", { fields: "full", limit: 1000 }, trace);
        return {
          leader: "202-153",
          sold: 187,
          top20_quantity: 742,
          validation: "reference fixture; old tool has no ranking, model-side classification/aggregation required",
        };
      }
      const result = await tool(
        "get_sales_ranking_by_article",
        { ...fixture.config, categories: ["female_sleeveless", "female_sleeved"], output: "file" },
        trace,
      );
      await tool("read_report_export", { uri: result.export.uri, section: "detail", limit: 1 }, trace);
      if (result.rows[0].article !== "202-153" || result.page_quantity !== 742) throw Error("Ranking fixture mismatch");
      return { leader: result.rows[0].article, sold: result.rows[0].sold, top20_quantity: result.page_quantity };
    });
    await task("three_categories", async (trace) => {
      const result =
        label === "3.2.0"
          ? await tool(
              "get_sales_by_price",
              {
                ...fixture.config,
                bands: ["female_sleeveless", "female_sleeved", "male"].map((category) => ({
                  id: category,
                  category,
                  min: "0",
                  max: "100000000000",
                  include_min: true,
                  include_max: true,
                })),
                output: "file",
              },
              trace,
            )
          : await tool("get_sales_by_category", { ...fixture.config, output: "file" }, trace);
      await tool("read_report_export", { uri: result.export.uri, section: "detail", limit: 1 }, trace);
      const counts = result.rows.map((r) => r.sold);
      if (JSON.stringify(counts) !== "[1117,166,372]") throw Error("Category fixture mismatch");
      return { sold: counts };
    });
    await task("size_and_price", async (trace) => {
      const sizes = await tool("get_sales_by_size", fixture.config, trace),
        prices = await tool("get_sales_by_price", fixture.config, trace);
      if (sizes.totals.male.sold !== 353) throw Error("Size fixture mismatch");
      return { size_rows: sizes.rows.length, price_sold: prices.rows.map((r) => r.sold) };
    });
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}
await run("3.2.0", old);
await run("3.3.0-full", current);
await run("3.3.0-analytics", current, "analytics");
globalThis.fetch = nativeFetch;
delete process.env.MOYSKLAD_TOKEN;
delete process.env.MOYSKLAD_TOOL_PROFILE;
const result = {
  fixture:
    "Anonymous stable September 2026 snapshot, 2496 lines, 258 parent cards. Synthetic folder metadata for projection comparison.",
  tokenizer: "o200k_base",
  scope:
    "All offered runtime tools/list schemas plus every request/result in the declared controlled task trace, including resource links and export page followups. No omitted successful task MCP messages; retries=0 here (429 tests measured separately). SDK/OpenAI hidden framing, prompts, reasoning and application-specific tool subset are unavailable and excluded. Internal API requests never pass to the model. Durations use mocked API, not live latency.",
  baseline:
    "Executed preserved 3.2.0 compiled handlers; no reconstructed raw response. Ranking baseline downloads quantity sales and full product cards and requires client-side computation; reference oracle validates task outcome, not an executed LLM session.",
  results: allResults,
};
await writeFile(new URL("../verification/benchmark-3.3.json", import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
