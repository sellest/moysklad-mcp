import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn() }));
import { moyskladGet } from "../src/client.js";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleQueryAnalytics, tools } from "../src/tools/query-analytics.js";
import { normalizeAnalyticsQuery } from "../src/analytics-query-schema.js";
import { credentialScope, storePath } from "../src/report-store.js";
import { readPagedExport } from "../src/paged-export.js";
import { ReportJobs } from "../src/report-jobs.js";
import { reportContext } from "../src/report-context.js";
const get = vi.mocked(moyskladGet);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const regular = id(1),
  cancelled = id(2),
  pickupCancelled = id(3),
  returns = id(4),
  rub = id(5),
  usd = id(6);
let directory: string, docs: any[], changeOnVerify: "sum" | "city" | null, listPass: number;
const query = (extra: any = {}) => ({
  dataset: "orders",
  date_range: { from: "2026-09-01T00:00:00", to_exclusive: "2026-10-01T00:00:00", timezone: "Europe/Moscow" },
  dimensions: ["order.delivery.city"],
  measures: ["orders_count", "orders_total_rub"],
  ...extra,
});
const order = (n: number, city: string | null = "Fixture City", sum: number | null = 100001) => ({
  id: id(n),
  moment: "2026-09-15 12:00:00",
  updated: "2026-09-15 12:00:00",
  applicable: true,
  state: { id: regular },
  rate: { currency: { id: rub } },
  sum,
  agent: { name: "PRIVATE_CUSTOMER", phone: "PRIVATE_PHONE" },
  description: "PRIVATE_DESCRIPTION",
  shipmentAddressFull: { city, postalCode: "PRIVATE_POSTCODE", street: "PRIVATE_STREET", house: "PRIVATE_HOUSE" },
  positions: { meta: { size: 100 }, rows: [{ quantity: 100, price: 1 }] },
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "analytics-document-test-"));
  vi.stubEnv("MOYSKLAD_DATA_DIR", directory);
  vi.stubEnv("MOYSKLAD_TOKEN", "document-fixture");
  vi.stubEnv("MOYSKLAD_REPORT_TIMEZONE", "Europe/Moscow");
  const policy = join(directory, "policy.json");
  await writeFile(
    policy,
    JSON.stringify({
      default_policy: { cancellation_mapping_confirmed: true, cancelled_state_ids: [cancelled, pickupCancelled] },
      states: [regular, cancelled, pickupCancelled, returns].map((id) => ({ id })),
    }),
  );
  vi.stubEnv("MCP_ANALYTICS_ORDER_POLICY_FILE", policy);
  docs = [];
  changeOnVerify = null;
  listPass = 0;
  get.mockReset();
  get.mockImplementation(async (path) => {
    const url = new URL(path, "https://fixture.invalid"),
      offset = Number(url.searchParams.get("offset") ?? 0),
      limit = Number(url.searchParams.get("limit") ?? 1000);
    if (url.pathname === "/entity/customerorder/metadata")
      return { states: [regular, cancelled, pickupCancelled, returns].map((id) => ({ id, name: "Fixture status" })) };
    if (url.pathname === "/entity/currency")
      return {
        meta: { size: 2, offset: 0 },
        rows: [
          { id: rub, isoCode: "643" },
          { id: usd, isoCode: "840" },
        ],
      };
    if (url.pathname === "/entity/region/77") return { id: "77", name: "Explicit Region" };
    if (url.pathname === "/entity/region/404") throw new Error("API_HTTP_404: Region missing");
    if (url.pathname === "/entity/customerorder") {
      expect(url.searchParams.has("expand")).toBe(false);
      if (offset === 0) listPass++;
      let rows = docs.slice(offset, offset + limit);
      if (listPass > 1 && changeOnVerify)
        rows = rows.map((d, i) =>
          i
            ? d
            : changeOnVerify === "sum"
              ? { ...d, sum: d.sum + 1 }
              : { ...d, shipmentAddressFull: { ...d.shipmentAddressFull, city: "Changed City" } },
        );
      return { meta: { size: docs.length, offset }, rows };
    }
    throw new Error("Unexpected endpoint: position/catalog loading is forbidden in this fixture");
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe("document-level order analytics", () => {
  it("keeps legacy channel defaults and selects document counts for new geography dimensions", () => {
    expect(normalizeAnalyticsQuery(query({ dimensions: ["order.channel"], measures: undefined })).measures).toEqual([
      "ordered_quantity",
    ]);
    expect(normalizeAnalyticsQuery(query({ measures: undefined })).measures).toEqual(["orders_count"]);
  });
  it("aggregates 912 orders server-side, excludes exactly 11 empty cities and counts full order totals once", async () => {
    docs = Array.from({ length: 912 }, (_, n) => order(100 + n, n < 901 ? `City ${n % 3}` : null, 100000));
    const result = JSON.parse(await handleQueryAnalytics(query()));
    expect(result.metadata).toMatchObject({
      grain: "documents",
      documents_processed: 912,
      documents_matched: 901,
      positions_processed: 0,
      source_missing: { city: 11, region: 912 },
      excluded: { missing_city: 11 },
    });
    expect(result.rows.reduce((n: number, r: any) => n + r.orders_count, 0)).toBe(901);
    expect(result.rows.reduce((n: number, r: any) => n + Number(r.orders_total_rub), 0)).toBe(901000);
    expect(result.data_complete).toBe(true);
    expect(result.export).toBeUndefined();
    expect(JSON.stringify(result).length).toBeLessThan(10000);
    expect(get.mock.calls.filter(([p]) => p.startsWith("/entity/customerorder?"))).toHaveLength(10);
    expect(get.mock.calls.some(([p]) => /positions|product|variant|uom/.test(p))).toBe(false);
  });
  it("counts orders with no positions and service-only orders, including their delivery in the document total", async () => {
    docs = [
      { ...order(100, "City", 130000), positions: { meta: { size: 0 }, rows: [] } },
      {
        ...order(101, "City", 30000),
        positions: { rows: [{ quantity: 999, price: 1, assortment: { meta: { type: "service" } } }] },
      },
    ];
    const result = JSON.parse(await handleQueryAnalytics(query()));
    expect(result.rows[0]).toMatchObject({ orders_count: 2, orders_total_rub: "1600" });
  });
  it("keeps missing regions null even for Moscow and never copies a region from another order", async () => {
    const a = order(100, "Москва"),
      b = order(101, "Москва");
    b.shipmentAddressFull = { ...b.shipmentAddressFull, region: { id: "77", name: "Explicit Region" } } as any;
    docs = [a, b];
    const result = JSON.parse(
      await handleQueryAnalytics(query({ dimensions: ["order.delivery.city", "order.delivery.region"] })),
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((r: any) => r.region === null)).toMatchObject({
      city: "Москва",
      region_id: null,
      region_status: "absent",
      orders_count: 1,
    });
    expect(result.rows.find((r: any) => r.region !== null).region).toBe("Explicit Region");
    expect(result.metadata.missing.region).toBe(1);
    expect(result.data_complete).toBe(true);
    expect(get.mock.calls.some(([p]) => p.startsWith("/entity/region/"))).toBe(false);
  });
  it("resolves explicit source references once, supports known-region filtering and treats broken references as unresolved", async () => {
    docs = [order(100, "A"), order(101, "B"), order(102, "C")];
    for (const d of docs.slice(0, 2)) d.shipmentAddressFull.region = { meta: { href: "/entity/region/77" } };
    const q = query({
      dimensions: ["order.delivery.region"],
      filters: [{ field: "order.delivery.region", op: "is_set", value: true }],
    });
    const result = JSON.parse(await handleQueryAnalytics(q));
    expect(result.rows[0]).toMatchObject({ region: "Explicit Region", region_id: "77", orders_count: 2 });
    expect(get.mock.calls.filter(([p]) => p === "/entity/region/77")).toHaveLength(1);
    docs = [order(103)];
    docs[0].shipmentAddressFull.region = { id: "404" };
    const bad = JSON.parse(await handleQueryAnalytics({ ...q, refresh_source: true }));
    expect(bad.status).toBe("partial");
    expect(bad.metadata.unresolved.region).toBe(1);
    expect(bad.metadata.missing.region).toBe(0);
  });
  it("applies posted/cancelled policies before geography and preserves return statuses", async () => {
    docs = [
      order(100),
      { ...order(101), applicable: false },
      { ...order(102), state: { id: cancelled } },
      { ...order(103), state: { id: pickupCancelled } },
      { ...order(104), state: { id: returns } },
    ];
    const result = JSON.parse(await handleQueryAnalytics(query()));
    expect(result.rows[0].orders_count).toBe(2);
    expect(result.metadata.excluded).toMatchObject({ unposted: 1, cancelled: 2 });
    const all = JSON.parse(await handleQueryAnalytics(query({ include_cancelled: true, include_unposted: true })));
    expect(all.rows[0].orders_count).toBe(5);
    expect(all.metadata.snapshot.reused).toBe(true);
    const selected = JSON.parse(
      await handleQueryAnalytics(query({ filters: [{ field: "order.state_id", op: "eq", value: pickupCancelled }] })),
    );
    expect(selected.rows[0].orders_count).toBe(1);
  });
  it("reports unknown/foreign currencies and missing amounts rather than summing them as rubles or zero", async () => {
    docs = [
      order(100, "City", 0),
      { ...order(101), rate: { currency: { id: usd } } },
      { ...order(102), rate: {} },
      order(103, "City", null),
    ];
    const result = JSON.parse(await handleQueryAnalytics(query()));
    expect(result.rows[0]).toMatchObject({ orders_count: 1, orders_total_rub: "0" });
    expect(result.metadata.excluded).toMatchObject({ currency: 2, amount: 1 });
    expect(result.metadata.unresolved.documents).toBe(3);
    expect(result.data_complete).toBe(false);
    const counts = JSON.parse(await handleQueryAnalytics(query({ measures: ["orders_count"] })));
    expect(counts.rows.reduce((n: number, r: any) => n + r.orders_count, 0)).toBe(4);
    expect(counts.data_complete).toBe(true);
  });
  it("uses a reusable document snapshot without persisting personal address/customer fields", async () => {
    docs = [order(100, "A"), order(101, "B")];
    const first = JSON.parse(await handleQueryAnalytics(query({ measures: ["orders_count"], limit: 1 })));
    const second = JSON.parse(
      await handleQueryAnalytics(
        query({ order_by: { field: "orders_total_rub", direction: "desc" }, offset: 1, limit: 1 }),
      ),
    );
    expect(second.metadata.snapshot.reused).toBe(true);
    expect(second.rows[0].orders_total_rub).toBe("1000.01");
    expect(get.mock.calls.filter(([p]) => p.startsWith("/entity/customerorder?"))).toHaveLength(2);
    const path = storePath(credentialScope(), "captures", first.metadata.snapshot.id);
    const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    expect(manifest.schema_version).toBe(2);
    expect(manifest.grain).toBe("documents");
    const captured = await readFile(join(path, manifest.files[0]), "utf8");
    expect(captured).not.toContain("PRIVATE_");
    expect(captured).not.toContain('"positions"');
  });
  it.each(["sum", "city"] as const)(
    "rejects a changed %s even if the source updated timestamp stays the same",
    async (field) => {
      docs = [order(100)];
      changeOnVerify = field;
      await expect(handleQueryAnalytics(query())).rejects.toThrow("INCOMPLETE_SOURCE");
    },
  );
  it("rejects mixed document and position semantics before any upstream requests", async () => {
    for (const q of [
      query({ measures: ["ordered_quantity"] }),
      query({ dimensions: ["product"], measures: ["orders_total_rub"] }),
      query({ filters: [{ field: "position.net_unit_price_rub", op: "lte", value: 4000 }] }),
    ])
      await expect(handleQueryAnalytics(q)).rejects.toThrow("INVALID_ARGUMENT");
    expect(get).not.toHaveBeenCalled();
  });
  it("has deterministic paging and creates an aggregate export only on explicit request", async () => {
    vi.stubEnv("MOYSKLAD_REPORT_JOBS", "true");
    docs = [order(100, "B"), order(101, "A")];
    const first = JSON.parse(await handleQueryAnalytics(query({ limit: 1 })));
    expect(first.rows[0].city).toBe("A");
    expect(first.next_offset).toBe(1);
    expect(first.export).toBeUndefined();
    const exported = JSON.parse(await handleQueryAnalytics(query({ limit: 1, offset: 1, output: "file" })));
    const saved = JSON.parse(
      await readPagedExport({ uri: exported.export.uri, section: "rows", offset: 0, limit: 10 }),
    );
    expect(saved.items).toHaveLength(2);
    expect(exported.rows[0].city).toBe("B");
  });
  it("deduplicates defaulted and explicit document requests in the report worker", async () => {
    const jobs = new ReportJobs();
    jobs.register(tools);
    docs = [order(100)];
    const implicit = query({ measures: undefined }),
      explicit = normalizeAnalyticsQuery(implicit);
    const [a, b] = await Promise.all([
      jobs.start("query_analytics", implicit),
      jobs.start("query_analytics", explicit),
    ]);
    expect(a.job_id).toBe(b.job_id);
    await jobs.idle();
    const done = await jobs.status(a.job_id);
    expect(done.state).toBe("succeeded");
    expect((done.result as any).metadata.grain).toBe("documents");
    expect((done.result as any).export).toBeUndefined();
  });
  it("honors cancellation on the document path", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      reportContext.run(
        { jobId: id(999), scope: credentialScope(), signal: controller.signal, progress: async () => {} },
        () => handleQueryAnalytics(query()),
      ),
    ).rejects.toThrow("JOB_CANCELLED");
    expect(get).not.toHaveBeenCalled();
  });
});
