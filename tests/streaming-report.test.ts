import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn() }));
import { moyskladGet } from "../src/client.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReportJobs } from "../src/report-jobs.js";
import { tools as analyticsTools } from "../src/tools/analytics.js";
import { tools as rankingTools } from "../src/tools/rankings.js";
import { clearCatalogCache, clearSourceCache } from "../src/analytics-data.js";
import { readInlineResponse } from "../src/inline-response.js";
import { readPagedExport } from "../src/paged-export.js";
let directory: string;
const get = vi.mocked(moyskladGet);
const product = { id: "p1", name: "swim fixture", article: "001", pathName: "", meta: { type: "product" } };
const variant = {
  id: "v1",
  name: "fixture variant",
  characteristics: [{ name: "Размер", value: "36" }],
  product,
  meta: { type: "variant" },
};
const params = {
  moment_from: "2025-01-01",
  moment_to: "2025-01-31",
  scope_name_contains: "swim",
  category_overrides: [{ product_id: "p1", category: "male", evidence: "controlled fixture" }],
};
function installPages(fail = false) {
  get.mockImplementation(async (path) => {
    const url = new URL(path, "https://fixture.invalid");
    if (url.pathname === "/entity/variant/v1") return variant;
    if (url.pathname === "/entity/product/p1") return product;
    const type = url.pathname.split("/")[2];
    const total = type === "demand" ? 25 : type === "salesreturn" ? 2 : 0;
    const offset = Number(url.searchParams.get("offset") ?? 0),
      limit = Number(url.searchParams.get("limit"));
    if (fail && type === "demand" && offset === 20) throw new Error("API_TIMEOUT: Fixture page failure.");
    const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
      id: `${type}-${offset + i}`,
      moment: "2025-01-15 12:00:00",
      positions: {
        meta: { size: 15 },
        rows: Array.from({ length: 15 }, (_, j) => ({
          id: `position-${j}`,
          quantity: 1,
          price: 250000,
          discount: 20,
          assortment: variant,
        })),
      },
    }));
    return { meta: { size: total, offset }, rows };
  });
}
async function wait(jobs: ReportJobs, id: string) {
  for (let i = 0; i < 1000; i++) {
    const job = await jobs.status(id);
    if (["succeeded", "failed", "cancelled"].includes(job.state)) {
      await jobs.idle();
      return job;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Fixture timeout");
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moysklad-stream-test-"));
  vi.stubEnv("MOYSKLAD_DATA_DIR", directory);
  vi.stubEnv("MOYSKLAD_TOKEN", "stream-fixture-account");
  get.mockReset();
  clearCatalogCache();
  clearSourceCache();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe("bounded report pipeline", () => {
  it("retains explicit file exports for streaming reports", async () => {
    installPages();
    const jobs = new ReportJobs();
    jobs.register(analyticsTools);
    const started = await jobs.start("get_sales_by_size", { ...params, output: "file" });
    const job = await wait(jobs, started.job_id);
    expect(job.state).toBe("succeeded");
    const result = job.result as any;
    expect(result.export.uri).toMatch(/^moysklad-export:/);
    const page = JSON.parse(
      await readPagedExport({ uri: result.export.uri, section: "detail", offset: 399, limit: 100 }),
    );
    expect(page.items).toHaveLength(6);
  });
  it("captures all pages, aggregates exact quantities, and reuses the snapshot for prices", async () => {
    installPages();
    const jobs = new ReportJobs();
    jobs.register([...analyticsTools, ...rankingTools]);
    const started = await jobs.start("get_sales_by_size", params);
    const job = await wait(jobs, started.job_id);
    expect(job.state).toBe("succeeded");
    const result = job.result as any;
    expect(result.totals.male).toMatchObject({ sold: 375, returned: 30, net: 345 });
    expect(result.source.positions).toBe(405);
    expect(result.source.completeness.complete).toBe(true);
    expect(result.snapshot.reused).toBe(false);
    expect(result.export).toBeUndefined();
    const page = JSON.parse(
      await readInlineResponse(result.sections.detail.cursor.replace(/:0$/, ":399"), "get_sales_by_size"),
    );
    expect(page.detail).toHaveLength(6);
    expect(page.next_cursor).toBeNull();
    const dictionary = JSON.parse(await readInlineResponse(result.sections.dictionary.cursor, "get_sales_by_size"));
    expect(dictionary.dictionary).toHaveLength(1);
    const fetched = get.mock.calls.length;
    clearCatalogCache();
    const price = await jobs.start("get_sales_by_price", {
      ...params,
      bands: [{ id: "band", category: "male", min: "1000", max: "3000", include_min: true, include_max: false }],
    });
    const priced = await wait(jobs, price.job_id);
    expect(priced.state).toBe("succeeded");
    const prices = priced.result as any;
    expect(prices.rows[0]).toMatchObject({ sold: 375, returned: 30, net: 345 });
    expect(prices.snapshot.id).toBe(result.snapshot.id);
    expect(prices.snapshot.reused).toBe(true);
    expect(get.mock.calls.length).toBe(fetched);
    expect(prices.catalog.version).toBe(result.catalog.version);
    clearCatalogCache();
    const category = await jobs.start("get_sales_by_category", params);
    const categorized = await wait(jobs, category.job_id);
    expect(categorized.state).toBe("succeeded");
    expect(get.mock.calls.length).toBe(fetched);
    expect((categorized.result as any).included).toMatchObject({ sold: 375, returned: 30, net: 345 });
    clearCatalogCache();
    const ranking = await jobs.start("get_sales_ranking_by_article", params);
    const ranked = await wait(jobs, ranking.job_id);
    expect(ranked.state).toBe("succeeded");
    expect(get.mock.calls.length).toBe(fetched);
    expect((ranked.result as any).catalog.version).toBe(result.catalog.version);
  }, 20000);
  it("keeps service identifiers and names and excludes delivery before swim classification", async () => {
    const service = { id: "delivery", name: "Delivery fixture", meta: { type: "service" } };
    get.mockImplementation(async (path) => {
      const type = new URL(path, "https://fixture.invalid").pathname.split("/")[2];
      const quantity = type === "demand" ? 507 : 13;
      const rows = ["demand", "salesreturn"].includes(type)
        ? [
            {
              id: type,
              moment: "2025-01-15",
              positions: {
                meta: { size: 1 },
                rows: [{ id: "service-position", quantity, price: 10000, assortment: service }],
              },
            },
          ]
        : [];
      return { meta: { size: rows.length, offset: 0 }, rows };
    });
    const jobs = new ReportJobs();
    jobs.register(analyticsTools);
    const started = await jobs.start("get_sales_by_size", params);
    const job = await wait(jobs, started.job_id);
    expect(job.state).toBe("succeeded");
    const result = job.result as any;
    expect(result.excluded.service).toMatchObject({ sold: 507, returned: 13, net: 494 });
    const dictionary = JSON.parse(await readInlineResponse(result.sections.dictionary.cursor, "get_sales_by_size"));
    expect(dictionary.dictionary[0].value).toMatchObject({ id: "delivery", type: "service", name: "Delivery fixture" });
    expect(get.mock.calls).toHaveLength(4);
  });
  it("rejects duplicate documents instead of declaring unique completeness", async () => {
    installPages();
    const normal = get.getMockImplementation()!;
    get.mockImplementation(async (path) => {
      const response = (await normal(path)) as any;
      if (path.startsWith("/entity/demand?")) response.rows[1].id = response.rows[0].id;
      return response;
    });
    const jobs = new ReportJobs();
    jobs.register(analyticsTools);
    const started = await jobs.start("get_sales_by_size", params);
    const job = await wait(jobs, started.job_id);
    expect(job.state).toBe("failed");
    expect(job.error?.code).toBe("INCOMPLETE_SOURCE");
    expect(job.result).toBeUndefined();
  });
  it("keeps failure history and never publishes a complete result after a missing page", async () => {
    installPages(true);
    const jobs = new ReportJobs();
    jobs.register(analyticsTools);
    const started = await jobs.start("get_sales_by_size", params);
    const job = await wait(jobs, started.job_id);
    expect(job.state).toBe("failed");
    expect(job.error?.code).toBe("UPSTREAM_TIMEOUT");
    expect(job.result).toBeUndefined();
    expect(job.progress.positions).toBe(300);
    expect(job.recoverable).toBe(true);
  }, 15000);
});
