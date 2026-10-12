import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
vi.mock("../src/client.js", () => ({ moyskladGet: vi.fn() }));
import { moyskladGet } from "../src/client.js";
import { reportContext } from "../src/report-context.js";
import { credentialScope, storePath, atomicWrite, readJson } from "../src/report-store.js";
import { prefetchCatalog, catalogCardPath, migrateLegacyCatalog } from "../src/snapshot-catalog.js";
import { cachedEntity, clearCatalogCache } from "../src/analytics-data.js";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "catalog-regression-"));
  vi.stubEnv("MOYSKLAD_DATA_DIR", directory);
  vi.stubEnv("MOYSKLAD_TOKEN", "catalog-fixture");
  vi.mocked(moyskladGet).mockReset();
  clearCatalogCache();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
it("fetches twenty UUID cards per batch and reuses them after clearing memory", async () => {
  const scope = credentialScope(),
    catalogId = randomUUID();
  const references = Array.from({ length: 45 }, () => ({ id: randomUUID(), meta: { type: "product" } }));
  vi.mocked(moyskladGet).mockImplementation(async (path) => {
    const q = new URL(path, "https://fixture.invalid").searchParams;
    const ids = q
      .get("filter")!
      .split(";")
      .map((v) => v.slice(3));
    expect(ids.length).toBeLessThanOrEqual(20);
    const rows = ids.map((id) => ({ id, name: "swim fixture", pathName: "", meta: { type: "product" } }));
    return { rows, meta: { size: rows.length } };
  });
  await reportContext.run(
    { jobId: randomUUID(), catalogId, scope, signal: new AbortController().signal, progress: async () => {} },
    async () => {
      await prefetchCatalog(references);
      expect(moyskladGet).toHaveBeenCalledTimes(3);
      clearCatalogCache();
      await prefetchCatalog(references);
      for (const ref of references) expect((await cachedEntity("product", ref.id)).id).toBe(ref.id);
      expect(moyskladGet).toHaveBeenCalledTimes(3);
    },
  );
});
it("migrates a completed legacy job catalog to the shared snapshot without API work", async () => {
  const scope = credentialScope(),
    snapshot = randomUUID(),
    job = randomUUID();
  const path = catalogCardPath(scope, job, "product", "p1");
  await atomicWrite(path, JSON.stringify({ id: "p1", name: "swim fixture", pathName: "", meta: { type: "product" } }));
  await atomicWrite(
    storePath(scope, "jobs", job + ".json"),
    JSON.stringify({
      job_id: job,
      state: "succeeded",
      finished_at: new Date().toISOString(),
      result: { snapshot: { id: snapshot } },
    }),
  );
  await migrateLegacyCatalog(scope, snapshot);
  expect((await readJson(catalogCardPath(scope, snapshot, "product", "p1"))).id).toBe("p1");
  expect((await readdir(storePath(scope, "catalog", snapshot))).length).toBe(1);
  expect(moyskladGet).not.toHaveBeenCalled();
});
it("keeps refreshed catalog generations separate from existing cards", async () => {
  const scope = credentialScope(),
    original = randomUUID(),
    refreshed = randomUUID();
  await atomicWrite(catalogCardPath(scope, original, "product", "p1"), JSON.stringify({ id: "p1", name: "old" }));
  vi.mocked(moyskladGet).mockResolvedValue({ id: "p1", name: "new", pathName: "", meta: { type: "product" } });
  await reportContext.run(
    {
      jobId: randomUUID(),
      catalogId: refreshed,
      scope,
      signal: new AbortController().signal,
      progress: async () => {},
    },
    async () => {
      expect((await cachedEntity("product", "p1", undefined, true)).name).toBe("new");
      expect((await cachedEntity("product", "p1", undefined, true)).name).toBe("new");
    },
  );
  expect((await readJson(catalogCardPath(scope, original, "product", "p1"))).name).toBe("old");
  expect(moyskladGet).toHaveBeenCalledTimes(1);
});
