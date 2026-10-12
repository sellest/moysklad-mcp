import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { allTools, startHttpTransport } from "../src/index.js";
import { createExport } from "../src/output.js";

describe("stateless HTTP transport", () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    httpServer = await startHttpTransport(0);
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
      httpServer.closeAllConnections();
    });
  });

  async function post(message: object) {
    return fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(message),
    });
  }

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
  };

  it("handles repeated initialization, notification and tool discovery", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post(initialize);
      expect(response.status).toBe(200);
      expect((await response.json()).result.serverInfo.name).toBe("moysklad-mcp");
      const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      expect(notification.status).toBe(202);
      const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(tools.status).toBe(200);
      expect((await tools.json()).result.tools).toHaveLength(allTools.length);
    }
  });

  it("isolates concurrent requests using the same message ID", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => post(initialize)));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect((await response.json()).id).toBe(1);
    }
  });

  it("does not poison subsequent requests after an invalid GET", async () => {
    const invalid = await fetch(`${baseUrl}/mcp`);
    expect(invalid.status).toBe(406);
    await invalid.text();
    const response = await post(initialize);
    expect(response.status).toBe(200);
    await response.json();
  });

  it("publishes current schemas and reads an export over a later HTTP request", async () => {
    const response = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = (await response.json()).result.tools;
    const document = tools.find((t: { name: string }) => t.name === "get_document");
    expect(document.inputSchema.properties.positions_limit.maximum).toBe(100);
    expect(document.inputSchema.properties.detail.enum).toEqual(["summary", "rows", "raw"]);
    expect(document.inputSchema.properties.output.enum).toEqual(["inline", "file"]);
    expect(
      tools.find((t: { name: string }) => t.name === "get_documents").inputSchema.properties.expand.enum,
    ).toContain("positions.assortment");
    expect(tools.some((t: { name: string }) => t.name === "get_sales_by_size")).toBe(true);
    const ranking = tools.find((t: { name: string }) => t.name === "get_sales_ranking_by_article");
    expect(ranking.inputSchema.properties.quantity_basis.enum).toEqual(["sold", "returned", "net"]);
    expect(ranking.inputSchema.properties.top_n.maximum).toBe(100);
    expect(ranking.inputSchema.properties.refresh_source.type).toBe("boolean");
    expect(tools.find((t: { name: string }) => t.name === "get_sales_by_category")).toBeDefined();
    const saved = await createExport({ detail: [{ quantity: 2 }] });
    const resource = await post({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: saved.uri } });
    expect(resource.status).toBe(200);
    expect(JSON.parse((await resource.json()).result.contents[0].text)).toEqual({ detail: [{ quantity: 2 }] });
    const page = await post({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "read_report_export", arguments: { uri: saved.uri } },
    });
    expect(JSON.parse((await page.json()).result.content[0].text)).toMatchObject({
      total: 1,
      returned: 1,
      complete: true,
    });
  });
  it("publishes the explicit 19-tool analytics profile and restores all 71 tools", async () => {
    vi.stubEnv("MOYSKLAD_TOOL_PROFILE", "analytics");
    try {
      const tools = (await (await post({ jsonrpc: "2.0", id: 8, method: "tools/list" })).json()).result.tools;
      expect(tools).toHaveLength(19);
      expect(tools.some((t: { name: string }) => t.name === "create_demand")).toBe(false);
      const health = await (await fetch(`${baseUrl}/health`)).json();
      expect(health).toMatchObject({ tools: 19, version: "3.4.1", tool_profile: "analytics" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await (await post({ jsonrpc: "2.0", id: 9, method: "tools/list" })).json()).result.tools).toHaveLength(71);
  });
  it("returns a concise unavailable-resource error after expiration or lost registry", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "read_report_export",
        arguments: { uri: "moysklad-export://00000000-0000-0000-0000-000000000000" },
      },
    });
    const result = (await response.json()).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe("EXPIRED_EXPORT");
    expect(result.content[0].text).not.toContain("stack");
  });
});
