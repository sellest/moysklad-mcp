import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { startHttpTransport } from "../src/index.js";
import { loadOAuthConfig } from "../src/oauth.js";

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

describe("OAuth resource server", () => {
  let jwks: Server;
  let mcp: Server;
  let base: string;
  let key: Awaited<ReturnType<typeof generateKeyPair>>;
  const issuer = "http://localhost:8080";
  const resource = "http://localhost:8080/mcp";
  beforeAll(async () => {
    key = await generateKeyPair("ES256");
    const publicKey = { ...(await exportJWK(key.publicKey)), kid: "test", alg: "ES256" };
    jwks = createServer((req, res) => {
      if (req.url === "/unavailable") {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [publicKey] }));
    });
    await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("MOYSKLAD_TOOL_PROFILE", "analytics");
    vi.stubEnv("MCP_AUTH_MODE", "oauth");
    vi.stubEnv("MCP_AUTH_ISSUER", issuer);
    vi.stubEnv("MCP_AUTH_RESOURCE", resource);
    vi.stubEnv("MCP_AUTH_JWKS_URI", `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`);
    vi.stubEnv("MCP_AUTH_ALLOW_LOCAL_HTTP", "true");
    mcp = await startHttpTransport(0);
    base = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await close(mcp);
    await close(jwks);
    vi.unstubAllEnvs();
  });

  async function token(overrides: JWTPayload = {}, privateKey = key.privateKey, kid = "test") {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: issuer,
      aud: resource,
      sub: "employee",
      iat: now,
      exp: now + 300,
      scope: "moysklad:read",
      ...overrides,
    })
      .setProtectedHeader({ alg: "ES256", kid })
      .sign(privateKey);
  }
  async function request(bearer?: string, method = "tools/list", params?: object) {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    });
  }
  it("publishes fixed discovery without trusting the incoming host", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/mcp/.well-known/oauth-protected-resource",
    ]) {
      const res = await fetch(`${base}${path}`, { headers: { Host: "attacker.invalid" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resource,
        authorization_servers: [issuer],
        scopes_supported: ["moysklad:read"],
        bearer_methods_supported: ["header"],
      });
    }
  });
  it("challenges missing credentials before initialization or tool execution", async () => {
    for (const method of ["initialize", "tools/list", "tools/call", "resources/read"]) {
      const res = await request(undefined, method);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        'resource_metadata="http://localhost:8080/.well-known/oauth-protected-resource/mcp"',
      );
      expect(await res.json()).toEqual({ error: "missing_token" });
    }
  });
  it("allows a valid token and publishes only the readonly tools", async () => {
    const bearer = await token();
    const init = await request(bearer, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "auth-test", version: "1" },
    });
    expect(init.status).toBe(200);
    await init.json();
    const res = await request(bearer);
    expect(res.status).toBe(200);
    const tools = (await res.json()).result.tools;
    expect(tools).toHaveLength(22);
    for (const name of ["get_stock", "get_stock_by_store", "get_stock_current"])
      expect(tools.map((t: { name: string }) => t.name)).toContain(name);
    expect(tools.map((t: { name: string }) => t.name)).not.toContain("create_product");
    expect(tools[0]._meta.securitySchemes).toEqual([{ type: "oauth2", scopes: ["moysklad:read"] }]);
    const call = await request(bearer, "tools/call", { name: "get_mcp_diagnostics", arguments: {} });
    expect(call.status).toBe(200);
    expect((await call.json()).result.isError).not.toBe(true);
  });
  it("accepts Pocket ID/Fosite array scopes and audience lists", async () => {
    const res = await request(await token({ scope: ["openid", "moysklad:read"], aud: [issuer, resource] }));
    expect(res.status).toBe(200);
    await res.json();
  });
  it.each([
    ["wrong issuer", { iss: "https://attacker.invalid" }],
    ["wrong audience / ID token", { aud: "moysklad-chatgpt" }],
    ["expired", { exp: 1 }],
    ["not yet valid", { nbf: 9999999999 }],
    ["missing expiry", { exp: undefined }],
    ["missing subject", { sub: undefined }],
    ["blank subject", { sub: " " }],
    ["missing issued time", { iat: undefined }],
    ["excessive lifetime", { exp: Math.floor(Date.now() / 1000) + 3600 }],
    ["future issued time", { iat: Math.floor(Date.now() / 1000) + 60 }],
  ])("rejects %s", async (_, claims) => {
    const bearer = await token(claims);
    const res = await request(bearer);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain(bearer);
    expect(body).not.toContain("employee");
  });
  it("accepts code-exchange delay and refreshed tokens with preserved issued time", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const age of [15, 3600, 86400]) {
      const res = await request(await token({ iat: now - age, exp: now + 300 }));
      expect(res.status).toBe(200);
      await res.json();
    }
  });
  it("rejects valid signatures without the exact required permission", async () => {
    for (const scope of [undefined, "moysklad:read_all", "openid"]) {
      const res = await request(await token({ scope }));
      expect(res.status).toBe(403);
      expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
      await res.json();
    }
  });
  it("rejects forged signatures, unknown keys and malformed tokens", async () => {
    const other = await generateKeyPair("ES256");
    for (const bearer of [
      await token({}, other.privateKey),
      await token({}, other.privateKey, "unknown"),
      "not-a-jwt",
    ]) {
      const res = await request(bearer);
      expect(res.status).toBe(401);
      await res.json();
    }
  });
  it("does not accept query-string tokens or cookies", async () => {
    const bearer = await token();
    const res = await fetch(`${base}/mcp?access_token=${bearer}`, { headers: { Cookie: `access_token=${bearer}` } });
    expect(res.status).toBe(401);
    await res.json();
  });
  it("keeps health public and discovery read-only", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/.well-known/oauth-protected-resource`, { method: "POST" })).status).toBe(405);
  });
  it("fails closed during provider key-service failure", async () => {
    const old = process.env.MCP_AUTH_JWKS_URI!;
    vi.stubEnv("MCP_AUTH_JWKS_URI", old.replace("/jwks", "/unavailable"));
    const unavailable = await startHttpTransport(0);
    try {
      const address = (unavailable.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${address}/mcp`, {
        headers: { Authorization: `Bearer ${await token()}` },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "auth_unavailable" });
    } finally {
      await close(unavailable);
      vi.stubEnv("MCP_AUTH_JWKS_URI", old);
    }
  });
});

describe("OAuth startup configuration", () => {
  const env = {
    MCP_AUTH_MODE: "oauth",
    MOYSKLAD_TOOL_PROFILE: "analytics",
    MCP_AUTH_ISSUER: "https://id.example.com",
    MCP_AUTH_RESOURCE: "https://mcp.example.com/mcp",
    MCP_AUTH_JWKS_URI: "https://id.example.com/.well-known/jwks.json",
  };
  it("rejects partial configuration rather than disabling authentication", () => {
    expect(() => loadOAuthConfig({ ...env, MCP_AUTH_ISSUER: undefined })).toThrow();
    expect(() => loadOAuthConfig({ MCP_AUTH_ISSUER: env.MCP_AUTH_ISSUER })).toThrow();
  });
  it("rejects insecure public URLs and write-capable profiles", () => {
    expect(() => loadOAuthConfig({ ...env, MCP_AUTH_ISSUER: "http://id.example.com" })).toThrow();
    expect(() => loadOAuthConfig({ ...env, MOYSKLAD_TOOL_PROFILE: "full" })).toThrow();
    expect(() => loadOAuthConfig({ ...env, MCP_AUTH_SCOPE: 'read"' })).toThrow();
  });
  it("requires explicit opt-ins for local HTTP and internal JWKS", () => {
    expect(loadOAuthConfig(env)?.scope).toBe("moysklad:read");
    expect(() => loadOAuthConfig({ ...env, MCP_AUTH_JWKS_URI: "http://auth:1411/keys" })).toThrow();
    expect(
      loadOAuthConfig({ ...env, MCP_AUTH_ALLOW_INTERNAL_JWKS_HTTP: "true", MCP_AUTH_JWKS_URI: "http://auth:1411/keys" })
        ?.jwksUri,
    ).toContain("auth:1411");
  });
});
