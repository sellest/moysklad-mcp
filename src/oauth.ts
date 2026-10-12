import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface OAuthConfig {
  issuer: string;
  resource: string;
  jwksUri: string;
  scope: string;
}

export class AuthFailure extends Error {
  constructor(
    public status: 401 | 403 | 503,
    public code: string,
    public reason: string = code,
  ) {
    super(code);
  }
}

export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig | undefined {
  const mode = env.MCP_AUTH_MODE ?? "none";
  if (mode !== "none" && mode !== "oauth") throw new Error("AUTH_CONFIG: MCP_AUTH_MODE must be none or oauth.");
  const fields = [env.MCP_AUTH_ISSUER, env.MCP_AUTH_RESOURCE, env.MCP_AUTH_JWKS_URI, env.MCP_AUTH_SCOPE];
  if (mode === "none") {
    if (fields.some(Boolean)) throw new Error("AUTH_CONFIG: OAuth settings require MCP_AUTH_MODE=oauth.");
    return undefined;
  }
  if ((env.MOYSKLAD_TOOL_PROFILE ?? "full") !== "analytics") {
    throw new Error("AUTH_CONFIG: OAuth read access requires MOYSKLAD_TOOL_PROFILE=analytics.");
  }
  function url(value: string | undefined, internal = false): string {
    if (!value) throw new Error("AUTH_CONFIG: issuer, resource and JWKS URI are required.");
    const parsed = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    const allowedHttp =
      parsed.protocol === "http:" &&
      ((local && env.MCP_AUTH_ALLOW_LOCAL_HTTP === "true") ||
        (internal && env.MCP_AUTH_ALLOW_INTERNAL_JWKS_HTTP === "true"));
    if (
      (parsed.protocol !== "https:" && !allowedHttp) ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search
    ) {
      throw new Error("AUTH_CONFIG: use HTTPS without credentials, query or fragment.");
    }
    return value;
  }
  const scope = env.MCP_AUTH_SCOPE ?? "moysklad:read";
  if (!/^[A-Za-z0-9:._-]+$/.test(scope)) throw new Error("AUTH_CONFIG: configure one valid required scope.");
  return {
    issuer: url(env.MCP_AUTH_ISSUER),
    resource: url(env.MCP_AUTH_RESOURCE),
    jwksUri: url(env.MCP_AUTH_JWKS_URI, true),
    scope,
  };
}

export function createOAuthGuard(config: OAuthConfig) {
  const keys = createRemoteJWKSet(new URL(config.jwksUri), {
    timeoutDuration: 5000,
    cooldownDuration: 30000,
    cacheMaxAge: 300000,
  });
  const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", config.resource).href;
  const metadata = {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [config.scope],
    bearer_methods_supported: ["header"],
    resource_name: "MoySklad MCP",
  };
  function reject(res: ServerResponse, failure: AuthFailure) {
    console.warn(JSON.stringify({ event: "oauth_rejected", status: failure.status, reason: failure.reason }));
    res.setHeader("Cache-Control", "no-store");
    if (failure.status !== 503) {
      const detail = failure.code === "missing_token" ? "" : `, error="${failure.code}"`;
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}", scope="${config.scope}"${detail}`);
    }
    res.writeHead(failure.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: failure.status === 503 ? "auth_unavailable" : failure.code }));
  }
  async function verify(req: IncomingMessage) {
    const occurrences = req.rawHeaders.filter(
      (_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "authorization",
    ).length;
    if (occurrences > 1) throw new AuthFailure(401, "invalid_token", "duplicate_authorization");
    const header = req.headers.authorization;
    if (!header) throw new AuthFailure(401, "missing_token");
    if (header.length > 16384) throw new AuthFailure(401, "invalid_token", "authorization_too_long");
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
    if (!match) throw new AuthFailure(401, "invalid_token", "bearer_not_jwt");
    let payload;
    try {
      ({ payload } = await jwtVerify(match[1], keys, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ["RS256", "ES256", "EdDSA"],
        requiredClaims: ["exp", "iat", "sub"],
        clockTolerance: 0,
      }));
    } catch (error) {
      if (
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid ||
        (error instanceof errors.JOSEError && error.code === "ERR_JOSE_GENERIC") ||
        !(error instanceof errors.JOSEError)
      ) {
        throw new AuthFailure(503, "auth_unavailable");
      }
      const claim = error instanceof errors.JWTClaimValidationFailed ? error.claim : "";
      throw new AuthFailure(401, "invalid_token", `${error.code}:${claim}`);
    }
    // Pocket ID preserves iat across code exchange and refresh. Bound remaining
    // validity instead of token age; the issuer config sets a five-minute expiry.
    // Allow five seconds for issuance rounding/clock drift, without accepting expiry.
    const now = Math.floor(Date.now() / 1000);
    if (
      !payload.sub?.trim() ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.iat > now + 5 ||
      payload.exp <= payload.iat ||
      payload.exp - now > 305
    )
      throw new AuthFailure(401, "invalid_token", "subject_or_lifetime");
    // Fosite/Pocket ID may represent scope as an array; accept only explicit scopes.
    const raw = payload.scope ?? payload.scp;
    const scopes =
      typeof raw === "string"
        ? raw.split(/\s+/)
        : Array.isArray(raw) && raw.every((s) => typeof s === "string")
          ? raw
          : [];
    if (!scopes.includes(config.scope)) throw new AuthFailure(403, "insufficient_scope");
    return { subject: payload.sub, scopes };
  }
  return { metadata, metadataUrl, reject, verify };
}
