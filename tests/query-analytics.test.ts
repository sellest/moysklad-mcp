import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn() }));
import { moyskladGet } from "../src/client.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyticsQuerySchema, queryPeriod, localEpoch } from "../src/analytics-query-schema.js";
import { handleQueryAnalytics, tools } from "../src/tools/query-analytics.js";
import { clearCatalogCache } from "../src/analytics-data.js";
import { ReportJobs } from "../src/report-jobs.js";
import { reportContext } from "../src/report-context.js";
import { readPagedExport } from "../src/paged-export.js";
const get = vi.mocked(moyskladGet);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const regular = uuid(1),
  cancelled = uuid(2),
  returnState = uuid(3),
  pickupCancelled = uuid(4),
  folder = uuid(10),
  unit = uuid(11),
  currency = uuid(12);
const product = (id = uuid(20), article = "SAME") => ({
  id,
  name: "Fixture model",
  article,
  pathName: "",
  meta: { type: "product" },
  productFolder: { meta: { href: `/entity/productfolder/${folder}` } },
  uom: { meta: { href: `/entity/uom/${unit}` } },
});
const variant = (id: string, parent: ReturnType<typeof product>, size = "36") => ({
  id,
  name: "Fixture variant",
  meta: { type: "variant" },
  characteristics: [{ name: "Размер", value: size }],
  product: parent,
});
const position = (id: string, a: any, quantity = 1, price = 500000, discount = 20) => ({
  id,
  assortment: a,
  quantity,
  price,
  discount,
});
const order = (id: string, rows: any[], state = regular, applicable = true) => ({
  id,
  updated: "2026-10-01 01:00:00",
  moment: "2026-09-10 12:00:00",
  applicable,
  state: { id: state },
  rate: { currency: { id: currency } },
  positions: { meta: { size: rows.length }, rows },
});
const query = (extra: any = {}) =>
  analyticsQuerySchema.parse({
    dataset: "orders",
    date_range: { from: "2026-09-01T00:00:00", to_exclusive: "2026-10-01T00:00:00", timezone: "Europe/Moscow" },
    ...extra,
  });
let directory: string;
let docs: any[];
let mutateVerification = false;
function install() {
  get.mockImplementation(async (path) => {
    const url = new URL(path, "https://fixture.invalid"),
      offset = Number(url.searchParams.get("offset") ?? 0),
      limit = Number(url.searchParams.get("limit") ?? 1000);
    if (url.pathname === "/entity/customerorder/metadata")
      return {
        states: [
          { id: regular, name: "Regular", stateType: "Regular" },
          { id: cancelled, name: "Cancelled", stateType: "Unsuccessful" },
          { id: returnState, name: "Return", stateType: "Unsuccessful" },
          { id: pickupCancelled, name: "Pickup cancelled", stateType: "Regular" },
        ],
      };
    let rows: any[] = [];
    if (url.pathname === "/entity/productfolder")
      rows = [{ id: folder, name: "Sleeveless category", pathName: "Fixture" }];
    else if (url.pathname === "/entity/uom") rows = [{ id: unit, code: "796", name: "Piece" }];
    else if (url.pathname === "/entity/currency") rows = [{ id: currency, isoCode: "643", code: "RUB" }];
    else if (url.pathname === "/entity/product/metadata/attributes") rows = [];
    else if (url.pathname === "/entity/customerorder") {
      rows = docs;
      if (!url.searchParams.has("expand") && mutateVerification)
        rows = rows.map((d, i) => (i ? d : { ...d, updated: "2026-10-02 01:00:00" }));
    } else if (url.pathname.includes("/positions")) {
      const doc = docs.find((d) => url.pathname.includes(d.id));
      rows = doc.positions.rows;
    } else if (/^\/entity\/(product|variant|bundle)\//.test(url.pathname)) {
      const id = url.pathname.split("/").pop();
      for (const doc of docs)
        for (const p of doc.positions.rows) {
          if (p.assortment.id === id) return p.assortment;
          if (p.assortment.product?.id === id) return p.assortment.product;
        }
      throw new Error("API_HTTP_404: Fixture missing");
    } else throw new Error("Unexpected fixture endpoint: " + url.pathname);
    return { meta: { size: rows.length, offset }, rows: rows.slice(offset, offset + limit) };
  });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "query-analytics-"));
  vi.stubEnv("MOYSKLAD_DATA_DIR", directory);
  vi.stubEnv("MOYSKLAD_TOKEN", "fixture-only");
  vi.stubEnv("MOYSKLAD_REPORT_TIMEZONE", "Europe/Moscow");
  const policy = join(directory, "policy.json");
  await writeFile(
    policy,
    JSON.stringify({
      default_policy: { cancellation_mapping_confirmed: true, cancelled_state_ids: [cancelled, pickupCancelled] },
      states: [regular, cancelled, returnState, pickupCancelled].map((id) => ({ id })),
    }),
  );
  vi.stubEnv("MCP_ANALYTICS_ORDER_POLICY_FILE", policy);
  docs = [];
  mutateVerification = false;
  get.mockReset();
  clearCatalogCache();
  install();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  clearCatalogCache();
  await rm(directory, { recursive: true, force: true });
});

describe("orders analytical query", () => {
  it("aggregates every order before top N, combines sizes, keeps identical articles separate and computes discounted line revenue", async () => {
    const a = product(),
      b = product(uuid(21));
    docs = [
      order(uuid(30), [
        position(uuid(100), variant(uuid(40), a), 3),
        position(uuid(101), variant(uuid(41), a, "38"), 2),
      ]),
      order(uuid(31), [position(uuid(102), a, 4, 400001, 0), position(uuid(103), b, 7, 300000, 0)]),
    ];
    const result = JSON.parse(
      await handleQueryAnalytics(
        query({
          dimensions: ["product", "product.article"],
          measures: ["ordered_quantity", "ordered_revenue", "orders_count"],
          filters: [{ field: "position.net_unit_price_rub", op: "lte", value: 4000 }],
          limit: 1,
        }),
      ),
    );
    expect(result.rows[0]).toMatchObject({
      product_id: b.id,
      article: "SAME",
      ordered_quantity: "7",
      orders_count: 1,
      ordered_revenue_rub: "21000",
    });
    expect(result.total_groups).toBe(2);
    expect(result.next_offset).toBe(1);
    expect(result.data_complete).toBe(true);
    const second = JSON.parse(
      await handleQueryAnalytics(
        query({
          dimensions: ["product", "product.article"],
          measures: ["ordered_quantity", "ordered_revenue", "orders_count"],
          filters: [{ field: "position.net_unit_price_rub", op: "lte", value: 4000 }],
          offset: 1,
          limit: 1,
        }),
      ),
    );
    expect(second.rows[0]).toMatchObject({
      product_id: a.id,
      ordered_quantity: "5",
      orders_count: 1,
      ordered_revenue_rub: "20000",
    });
    expect(second.metadata.snapshot.reused).toBe(true);
    expect(get.mock.calls.filter(([p]) => p.startsWith("/entity/customerorder?"))).toHaveLength(2);
  });
  it("excludes both confirmed cancellation IDs, preserves returns and applies explicit status/unposted policies", async () => {
    const p = product();
    docs = [
      order(uuid(30), [position(uuid(100), p)], cancelled),
      order(uuid(31), [position(uuid(101), p)], pickupCancelled),
      order(uuid(32), [position(uuid(102), p)], returnState),
      order(uuid(33), [position(uuid(103), p)], regular, false),
    ];
    const result = JSON.parse(await handleQueryAnalytics(query()));
    expect(result.rows[0].ordered_quantity).toBe("1");
    expect(result.metadata.excluded.cancelled).toBe(2);
    expect(result.metadata.excluded.unposted).toBe(1);
    const explicit = JSON.parse(
      await handleQueryAnalytics(query({ filters: [{ field: "order.state_id", op: "eq", value: pickupCancelled }] })),
    );
    expect(explicit.rows[0].ordered_quantity).toBe("1");
    expect(explicit.metadata.order_policy.exclude_cancelled).toBe(false);
    const all = JSON.parse(await handleQueryAnalytics(query({ include_unposted: true, include_cancelled: true })));
    expect(all.rows[0].ordered_quantity).toBe("4");
  });
  it("uses authoritative folder/attribute values, never product-name inference, and reports unresolved categories", async () => {
    const p = product();
    delete (p as any).productFolder;
    p.name = "Женский купальник без рукавов";
    docs = [order(uuid(30), [position(uuid(100), p)])];
    const result = JSON.parse(
      await handleQueryAnalytics(
        query({ filters: [{ field: "product.category", op: "eq", value: "female_sleeveless" }] }),
      ),
    );
    expect(result.rows).toEqual([]);
    expect(result.status).toBe("partial");
    expect(result.metadata.unresolved.category).toBe(1);
    expect(result.data_complete).toBe(false);
    const attr = { ...p, attributes: [{ id: uuid(90), name: "Категория", value: "Actual source category" }] };
    docs = [order(uuid(30), [position(uuid(100), attr)])];
    const explicit = JSON.parse(
      await handleQueryAnalytics(
        query({
          refresh_source: true,
          category: { source: "attribute", attribute_id: uuid(90) },
          filters: [{ field: "product.category", op: "eq", value: "Actual source category" }],
        }),
      ),
    );
    expect(explicit.rows[0].ordered_quantity).toBe("1");
  });
  it("excludes delivery services and exposes missing price, unit, ID and unsupported currency instead of zero", async () => {
    const p = product(),
      unknown = { ...product(uuid(21)), uom: undefined };
    docs = [
      order(uuid(30), [
        position(uuid(100), { id: uuid(50), name: "Delivery", meta: { type: "service" } }, 999),
        { ...position(uuid(101), p), price: null },
        position(uuid(102), unknown),
        position(uuid(103), { meta: { type: "product" } }),
      ]),
    ];
    const result = JSON.parse(await handleQueryAnalytics(query({ measures: ["ordered_quantity", "ordered_revenue"] })));
    expect(result.metadata.excluded.services).toBe(1);
    expect(result.metadata.unresolved.price).toBeGreaterThan(0);
    expect(result.metadata.unresolved.unit).toBeGreaterThan(0);
    expect(result.metadata.unresolved.product).toBeGreaterThan(0);
    expect(result.rows).toEqual([]);
    expect(result.data_complete).toBe(false);
    docs = [{ ...order(uuid(31), [position(uuid(110), p)]), rate: { currency: { id: uuid(999) } } }];
    const foreign = JSON.parse(
      await handleQueryAnalytics(query({ refresh_source: true, measures: ["ordered_quantity", "ordered_revenue"] })),
    );
    expect(foreign.metadata.unresolved.currency).toBe(1);
  });
  it("processes 1928 orders in server pages with compact inline output and no export", async () => {
    const p = product();
    docs = Array.from({ length: 1928 }, (_, i) => order(uuid(10000 + i), [position(uuid(20000 + i), p, 2)]));
    const result = JSON.parse(await handleQueryAnalytics(query({ measures: ["ordered_quantity", "orders_count"] })));
    expect(result.rows[0]).toMatchObject({ ordered_quantity: "3856", orders_count: 1928 });
    expect(result.metadata.documents_processed).toBe(1928);
    expect(result.metadata.positions_processed).toBe(1928);
    expect(result.export).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(10000);
  }, 20000);
  it("rejects changed headers and duplicate documents rather than publishing a complete ranking", async () => {
    docs = [order(uuid(30), [position(uuid(100), product())])];
    mutateVerification = true;
    await expect(handleQueryAnalytics(query())).rejects.toThrow("INCOMPLETE_SOURCE");
    mutateVerification = false;
    docs.push(docs[0]);
    await expect(handleQueryAnalytics(query({ refresh_source: true }))).rejects.toThrow("INCOMPLETE_SOURCE");
  });
  it("supports metadata discovery without an order scan or fabricated canonical categories", async () => {
    const result = JSON.parse(
      await handleQueryAnalytics(analyticsQuerySchema.parse({ dataset: "orders", operation: "describe" })),
    );
    expect(result.states).toHaveLength(4);
    expect(result.categories[0].name).toBe("Sleeveless category");
    expect(get.mock.calls.some(([p]) => p.startsWith("/entity/customerorder?"))).toBe(false);
  });
  it("fetches all separately paged positions when an archived product has a truncated expansion", async () => {
    const p = { ...product(), archived: true };
    docs = [
      order(
        uuid(30),
        Array.from({ length: 130 }, (_, i) => position(uuid(30000 + i), p)),
      ),
    ];
    const base = get.getMockImplementation()!;
    get.mockImplementation(async (path, ...rest) => {
      const result: any = await base(path, ...rest);
      if (path.startsWith("/entity/customerorder?") && path.includes("expand="))
        return {
          ...result,
          rows: result.rows.map((d: any) => ({
            ...d,
            positions: { ...d.positions, rows: d.positions.rows.slice(0, 3) },
          })),
        };
      return result;
    });
    const result = JSON.parse(await handleQueryAnalytics(query()));
    expect(result.rows[0].ordered_quantity).toBe("130");
    expect(result.data_complete).toBe(true);
    expect(get.mock.calls.filter(([path]) => path.includes("/positions?"))).toHaveLength(2);
  });
  it("counts unique orders rather than positions and keeps ties deterministic", async () => {
    const a = product(uuid(20)),
      b = product(uuid(21));
    docs = [order(uuid(30), [position(uuid(101), b, 4), position(uuid(102), a, 2), position(uuid(103), a, 2)])];
    const q = query({ measures: ["ordered_quantity", "orders_count"] });
    const result = JSON.parse(await handleQueryAnalytics(q));
    expect(result.rows.map((r: any) => r.product_id)).toEqual([a.id, b.id]);
    expect(result.rows.map((r: any) => r.orders_count)).toEqual([1, 1]);
  });
  it("keeps different category IDs separate even when their names are identical", async () => {
    const otherFolder = uuid(15),
      a = product(),
      b = { ...product(uuid(21)), productFolder: { id: otherFolder } };
    docs = [order(uuid(30), [position(uuid(100), a), position(uuid(101), b)])];
    const base = get.getMockImplementation()!;
    get.mockImplementation(async (path, ...rest) => {
      const r: any = await base(path, ...rest);
      if (path.startsWith("/entity/productfolder?"))
        return { meta: { size: 2, offset: 0 }, rows: [...r.rows, { id: otherFolder, name: "Sleeveless category" }] };
      return r;
    });
    const result = JSON.parse(await handleQueryAnalytics(query({ dimensions: ["product.category"] })));
    expect(result.rows).toHaveLength(2);
    expect(new Set(result.rows.map((r: any) => r.category_id)).size).toBe(2);
  });
  it("creates an export only on explicit request and keeps inline rows", async () => {
    docs = [order(uuid(30), [position(uuid(100), product())])];
    vi.stubEnv("MOYSKLAD_REPORT_JOBS", "true");
    const result = JSON.parse(await handleQueryAnalytics(query({ output: "file" })));
    const saved = JSON.parse(await readPagedExport({ uri: result.export.uri, section: "rows", offset: 0, limit: 10 }));
    expect(saved.items[0].ordered_quantity).toBe("1");
    expect(result.rows).toHaveLength(1);
  });
  it("queues one durable computation for 20 simultaneous identical submissions and preserves inline output", async () => {
    const jobs = new ReportJobs();
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    jobs.register([
      {
        ...tools[0],
        handler: async (p) => {
          calls++;
          expect(p.output).toBe("inline");
          await hold;
          return '{"rows":[{"ordered_quantity":"12"}]}';
        },
      },
    ]);
    const accepted = await Promise.all(Array.from({ length: 20 }, () => jobs.execute("query_analytics", query())));
    expect(new Set(accepted.map((s) => JSON.parse(s).job_id)).size).toBe(1);
    release();
    await jobs.idle();
    expect(calls).toBe(1);
    const result = await jobs.status(JSON.parse(accepted[0]).job_id);
    expect(result.result).toEqual({ rows: [{ ordered_quantity: "12" }] });
  });
  it("honors cancellation before doing further source reads", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      reportContext.run(
        { jobId: uuid(999), scope: "a".repeat(64), signal: controller.signal, progress: async () => {} },
        () => handleQueryAnalytics(query()),
      ),
    ).rejects.toThrow("JOB_CANCELLED");
  });
});
describe("bounded analytical DSL and timezones", () => {
  it("rejects unknown datasets, SQL, endpoint fields, invalid operators and oversized result limits", () => {
    for (const extra of [
      { dataset: "sales" },
      { sql: "select *" },
      { filters: [{ field: "endpoint", op: "eq", value: "/entity/employee" }] },
      { filters: [{ field: "product.id", op: "contains", value: uuid(1) }] },
      { filters: [{ field: "product.article", op: "in", value: "scalar" }] },
      { limit: 101 },
    ])
      expect(() => query(extra)).toThrow();
  });
  it("converts explicit timezones to accounting time and handles exclusive midnight and DST failures", () => {
    const period = queryPeriod(
      query({
        date_range: { from: "2026-08-01T00:00:00", to_exclusive: "2026-10-15T00:00:00", timezone: "Europe/Moscow" },
      }),
    );
    expect(period.apiTo).toBe("2026-10-15 00:00:00.000");
    const utc = queryPeriod(
      query({ date_range: { from: "2026-09-01T00:00:00", to_exclusive: "2026-10-01T00:00:00", timezone: "UTC" } }),
    );
    expect(utc.apiFrom).toBe("2026-09-01 03:00:00.000");
    expect(() => localEpoch("2026-03-08T02:30:00", "America/New_York")).toThrow();
    expect(() => localEpoch("2026-11-01T01:30:00", "America/New_York")).toThrow();
    expect(() =>
      queryPeriod(
        query({
          date_range: { from: "2026-09-01T00:00:00", to_exclusive: "2026-09-01T00:00:00", timezone: "Invalid/Zone" },
        }),
      ),
    ).toThrow();
  });
});
