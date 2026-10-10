import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestScheduler, retryDelayMs } from "../src/scheduler.js";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("shared paced scheduling", () => {
  it("paces by weight and serializes starts rather than releasing a burst", async () => {
    const scheduler = new RequestScheduler(8, 2);
    const release = await scheduler.acquire(5);
    release();
    let granted = false;
    const second = scheduler.acquire().then((r) => {
      granted = true;
      r();
    });
    await vi.advanceTimersByTimeAsync(1874);
    expect(granted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(granted).toBe(true);
  });
  it("shares 429 cooldown with queued operations and uses backoff for tiny retry headers", async () => {
    const scheduler = new RequestScheduler(8, 2);
    const release = await scheduler.acquire();
    const grants: number[] = [];
    const tasks = [1, 2].map(() =>
      scheduler.acquire().then((r) => {
        grants.push(Date.now());
        r();
      }),
    );
    const start = Date.now();
    scheduler.observe(429, new Headers({ "X-Lognex-Retry-After": "1" }), 1, 1, 10);
    release();
    await vi.advanceTimersByTimeAsync(999);
    expect(grants).toEqual([]);
    await vi.advanceTimersByTimeAsync(376);
    await Promise.all(tasks);
    expect(grants).toEqual([start + 1000, start + 1375]);
  });
  it("honors depleted success headers and adapts pacing to API limits", async () => {
    const scheduler = new RequestScheduler(8, 2);
    const release = await scheduler.acquire();
    scheduler.observe(
      200,
      new Headers({
        "X-RateLimit-Limit": "4",
        "X-Lognex-Retry-TimeInterval": "3000",
        "X-RateLimit-Remaining": "0",
        "X-Lognex-Reset": "2500",
      }),
      1,
      1,
      10,
    );
    release();
    let granted = false;
    const next = scheduler.acquire().then((r) => {
      granted = true;
      r();
    });
    await vi.advanceTimersByTimeAsync(2499);
    expect(granted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(scheduler.diagnostics().configuration.pacing_ms_per_weight).toBe(750);
  });
  it("honors HTTP-date Retry-After without clipping a long server cooldown", async () => {
    const headers = new Headers({ "Retry-After": new Date(Date.now() + 120000).toUTCString() });
    expect(retryDelayMs(headers, 1)).toBe(120000);
    const scheduler = new RequestScheduler(8, 2, 3000, 60000);
    scheduler.observe(429, headers, 1, 1, 1, [1073]);
    const failed = expect(scheduler.acquire()).rejects.toThrow("RATE_WAIT_EXHAUSTED");
    await vi.advanceTimersByTimeAsync(60000);
    await failed;
    expect(scheduler.diagnostics().configuration.concurrency).toBe(1);
  });
  it("keeps diagnostic payloads numeric and bounded", async () => {
    const scheduler = new RequestScheduler();
    for (let i = 0; i < 120; i++)
      scheduler.observe(200, new Headers({ Authorization: "secret", "X-Customer": "private" }), 1, 1, 3);
    expect(scheduler.diagnostics(0).events).toEqual([]);
    expect(scheduler.diagnostics(20).events).toHaveLength(20);
    expect(JSON.stringify(scheduler.diagnostics())).not.toMatch(/secret|private|Authorization/);
  });
});
describe("API retry integration", () => {
  it("recovers concurrent requests without an immediate retry burst", async () => {
    vi.resetModules();
    vi.stubEnv("MOYSKLAD_TOKEN", "test");
    const times: number[] = [];
    const start = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        times.push(Date.now() - start);
        return new Response(times.length === 1 ? '{"errors":[{"code":1070}]}' : '{"ok":true}', {
          status: times.length === 1 ? 429 : 200,
          headers: { "X-Lognex-Retry-After": "1" },
        });
      }),
    );
    const client = await import("../src/client.js");
    const tasks = Promise.all([client.moyskladGet("/entity/product"), client.moyskladGet("/entity/product")]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await tasks).toHaveLength(2);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeGreaterThanOrEqual(1000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(375);
  });
  it("bounds exhausted retries, preserves cooldown and never returns payloads as success", async () => {
    vi.resetModules();
    vi.stubEnv("MOYSKLAD_TOKEN", "test");
    const fetch = vi.fn(
      async () => new Response('{"errors":[{"code":1073,"error":"private business data"}]}', { status: 429 }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = await import("../src/client.js");
    const failed = expect(client.moyskladGet("/entity/product")).rejects.toThrow("API_HTTP_429");
    await vi.advanceTimersByTimeAsync(10000);
    await failed;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(client.requestScheduler.diagnostics())).not.toContain("private business");
  });
  it("automatically accounts for weighted stock reports", async () => {
    vi.resetModules();
    vi.stubEnv("MOYSKLAD_TOKEN", "test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    const client = await import("../src/client.js");
    await client.moyskladGet("/report/stock/all?limit=25");
    expect(client.requestScheduler.diagnostics().events[0].weight).toBe(5);
  });
});
