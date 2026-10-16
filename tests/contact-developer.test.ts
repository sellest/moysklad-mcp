import { afterEach, describe, expect, it, vi } from "vitest";
import { contactDeveloperSchema, handleContactDeveloper, tools } from "../src/tools/contact-developer.js";
import { allTools, wrap } from "../src/index.js";

const request = {
  summary: "Не удалось посчитать популярный товар",
  client_request: "Найди самый популярный товар по всем заказам за сентябрь.",
  reproduction_steps: ["Вызван get_documents за сентябрь.", "Получен экспорт вместо результата."],
  actual_result: "Повторные запросы разрешения скачать файл. Ответ не получен.",
  expected_result: "Название товара и заказанное количество по всей выборке.",
  tools_used: ["get_documents"],
};
afterEach(() => vi.unstubAllEnvs());

describe("developer email handoff", () => {
  it("prepares a complete report for the configured recipient without sending or fetching", async () => {
    vi.stubEnv("MCP_DEVELOPER_EMAIL", "developer@example.com");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const response = JSON.parse(await handleContactDeveloper(contactDeveloperSchema.parse(request)));
      expect(response).toMatchObject({
        status: "email_prepared",
        delivery_status: "not_sent",
        email: { to: "developer@example.com" },
      });
      expect(response.email.body).toContain(request.client_request);
      expect(response.email.body).toContain("1. " + request.reproduction_steps[0]);
      expect(response.email.body).toContain(request.actual_result);
      expect(response.email.body).toContain(request.expected_result);
      expect(response.next_action).toContain("Gmail");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("does not accept caller-controlled recipients or header injection", () => {
    const parsed = contactDeveloperSchema.parse({ ...request, to: "other@example.com" });
    expect(parsed).not.toHaveProperty("to");
    expect(contactDeveloperSchema.safeParse({ ...request, summary: "title\r\nBcc: other@example.com" }).success).toBe(
      false,
    );
  });
  it("removes known credentials from every free-text field and URL queries", async () => {
    vi.stubEnv("MCP_DEVELOPER_EMAIL", "developer@example.com");
    vi.stubEnv("MOYSKLAD_TOKEN", "secret-from-config");
    const result = await handleContactDeveloper(
      contactDeveloperSchema.parse({
        ...request,
        summary: "secret-from-config",
        client_request: "Bearer abc123 api_key=othersecret password=hidden ghp_synthetictesttoken",
        actual_result: "https://u:p@example.com/callback?code=privatecode&state=privatestate#privatefragment",
        reproduction_steps: ['token="value with spaces"'],
      }),
    );
    for (const secret of [
      "secret-from-config",
      "abc123",
      "othersecret",
      "hidden",
      "ghp_synthetictesttoken",
      "privatecode",
      "privatestate",
      "privatefragment",
      "value with spaces",
      "u:p@",
    ])
      expect(result).not.toContain(secret);
    expect(result).toContain("REDACTED");
  });
  it.each([undefined, "a@example.com\r\nBcc: b@example.com", "a@example.com,b@example.com"])(
    "fails explicitly when contact configuration is unavailable or invalid",
    async (address) => {
      if (address === undefined) vi.stubEnv("MCP_DEVELOPER_EMAIL", "");
      else vi.stubEnv("MCP_DEVELOPER_EMAIL", address);
      const result = await wrap(handleContactDeveloper)(contactDeveloperSchema.parse(request));
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error.code).toBe("CONTACT_NOT_CONFIGURED");
      expect(JSON.stringify(result)).not.toContain("INTERNAL_ERROR");
    },
  );
  it("registers the email helper without the abandoned order-summary tool", () => {
    expect(allTools).toContain(tools[0]);
    expect(allTools.some((tool) => tool.name === "get_orders_summary")).toBe(false);
  });
});
