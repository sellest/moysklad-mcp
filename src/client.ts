import { PKG_NAME, VERSION } from "./version.js";
import { RequestScheduler, retryDelayMs } from "./scheduler.js";

const BASE_URL = "https://api.moysklad.ru/api/remap/1.2";
const TIMEOUT = 15_000;
const MAX_RETRIES = 3;

const USER_AGENT = `${PKG_NAME}/${VERSION}`;

// --- Rate limiting -----------------------------------------------------------
//
// MoySklad uses a "request weight per 3-second window" model. The window size
// (45 for a public-solution token) shrinks for login/password and user tokens
// (≈22 now, dropping toward ≈11 by the end of 2026) and some reports cost more
// than one unit (stock/all and stock/bystore cost 5). Because we can't tell
// which auth tier the configured token belongs to, the default bucket is kept
// deliberately conservative to avoid the API auto-disabling access on repeated
// 429s (which can only be restored via MoySklad support). Solution-token users
// can raise it via MOYSKLAD_RATE_BUCKET.

const REFILL_MS = 3000;

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const BUCKET_MAX = envInt("MOYSKLAD_RATE_BUCKET", 8);
const MAX_CONCURRENT = envInt("MOYSKLAD_MAX_CONCURRENT", 2);
export const requestScheduler = new RequestScheduler(BUCKET_MAX, MAX_CONCURRENT, REFILL_MS);

/**
 * Compatibility test hook; production requests retain the scheduled slot
 * until the response body has been consumed.
 */
async function acquireToken(weight = 1): Promise<void> {
  const release = await requestScheduler.acquire(weight);
  release();
}

// --- Concurrency cap (MoySklad: max 5 parallel requests per user) ------------

// --- Auth --------------------------------------------------------------------

function getAuthHeader(): string {
  const token = process.env.MOYSKLAD_TOKEN;
  if (token) return `Bearer ${token}`;

  const login = process.env.MOYSKLAD_LOGIN;
  const password = process.env.MOYSKLAD_PASSWORD;
  if (login && password) {
    const encoded = Buffer.from(`${login}:${password}`).toString("base64");
    return `Basic ${encoded}`;
  }

  throw new Error(
    "AUTH_NOT_CONFIGURED: Auth not configured. Set MOYSKLAD_TOKEN or both MOYSKLAD_LOGIN and MOYSKLAD_PASSWORD.",
  );
}

// --- HTTP --------------------------------------------------------------------

export async function moyskladGet(path: string, weight = 1): Promise<unknown> {
  return moyskladRequest("GET", path, undefined, weight);
}

export async function moyskladPost(path: string, body: unknown, weight = 1): Promise<unknown> {
  return moyskladRequest("POST", path, body, weight);
}

export async function moyskladPut(path: string, body: unknown, weight = 1): Promise<unknown> {
  return moyskladRequest("PUT", path, body, weight);
}

export async function moyskladDelete(path: string, weight = 1): Promise<unknown> {
  return moyskladRequest("DELETE", path, undefined, weight);
}

/** Parse a MoySklad error body (`{ errors: [...] }`) into a readable message. */
function formatApiError(status: number, text: string): string {
  const codes = apiCodes(text)
    .slice(0, 3)
    .map((code) => `[${code}]`)
    .join(" ");
  const action =
    status === 429
      ? "Rate limit exhausted; retry later, reduce competing processes or request budget."
      : status >= 500
        ? "API unavailable; retry later."
        : "Check permissions and tool parameters; API codes are shown without business payloads.";
  return `API_HTTP_${status}: ${codes} ${action}`;
}

/** Compute the retry delay, preferring MoySklad's own headers. */
function apiCodes(text: string): number[] {
  try {
    return (JSON.parse(text).errors ?? [])
      .map((e: { code?: unknown }) => Number(e.code))
      .filter((n: number) => Number.isInteger(n) && n >= 0)
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function moyskladRequest(method: string, path: string, body?: unknown, weight = 1): Promise<unknown> {
  const actualWeight = Math.max(weight, /^\/report\/stock\/(?:all|bystore)(?:\?|$)/.test(path) ? 5 : 1);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const release = await requestScheduler.acquire(actualWeight);
    const started = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);

    try {
      const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
      // NOTE: we intentionally do NOT set Accept-Encoding. Node's fetch
      // (undici) already sends `gzip` and transparently decompresses the
      // response — which satisfies MoySklad's mandatory-gzip rule. Setting
      // the header manually makes undici skip decompression and hand back raw
      // gzip bytes, breaking JSON.parse. Do not "fix" this by adding it.
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json;charset=utf-8",
          Accept: "application/json;charset=utf-8",
          "User-Agent": USER_AGENT,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      clearTimeout(timer);
      requestScheduler.observe(
        response.status,
        response.headers,
        attempt,
        actualWeight,
        Date.now() - started,
        response.ok ? [] : apiCodes(text),
      );

      if (response.ok) {
        return text ? JSON.parse(text) : { success: true };
      }

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `API_HTTP_${response.status}: MoySklad auth error ${response.status}; check credentials and required permissions`,
        );
      }

      if (response.status === 415) {
        throw new Error(
          "MoySklad HTTP 415: the API requires gzip-encoded responses. This usually means the runtime's fetch isn't sending Accept-Encoding: gzip — check your Node version (>=18).",
        );
      }

      throw new Error(formatApiError(response.status, text));
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof DOMException && error.name === "AbortError" && attempt < MAX_RETRIES) {
        console.error(`[moysklad-mcp] Timeout, retry (${attempt}/${MAX_RETRIES})`);
        continue;
      }
      if (error instanceof DOMException && error.name === "AbortError")
        throw new Error("API_TIMEOUT: API did not respond after 3 attempts; retry later.");
      if (error instanceof SyntaxError) throw new Error("API_PROTOCOL_ERROR: API returned invalid JSON; retry later.");
      if (error instanceof TypeError)
        throw new Error("API_NETWORK_ERROR: API connection failed; check network access and retry.");
      throw error;
    } finally {
      clearTimeout(timer);
      release();
    }
  }
  throw new Error("MoySklad: all retries exhausted");
}

export {
  acquireToken as _acquireToken,
  getAuthHeader as _getAuthHeader,
  formatApiError as _formatApiError,
  retryDelayMs as _retryDelayMs,
  BASE_URL,
};
