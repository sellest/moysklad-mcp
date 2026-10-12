import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregateSizes, aggregatePrices, sizeReportSchema, priceReportSchema } from "../src/tools/analytics.js";
import { aggregateCategoriesAndArticles, articleRankingSchema, categoryReportSchema } from "../src/tools/rankings.js";
import { catalogVersion, type SourceLine } from "../src/analytics-data.js";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/analytics-synthetic.json", import.meta.url), "utf8"));
const products = new Map<string, any>(fixture.products.map((p: any) => [p.id, p]));
const assortment = new Map<string, any>(fixture.assortment.map((a: any) => [a.id, a]));
const lines: SourceLine[] = fixture.lines.map(
  ([document_id, document_type, id, quantity, price, discount]: any[], index: number) => {
    const a = assortment.get(id),
      product = products.get(a.parent_product_id) ?? null;
    return {
      document_id,
      document_type,
      moment: "2024-01-15",
      position: { id: `l${index}`, quantity, price, discount },
      assortment: { ...a, meta: { type: a.type }, product, characteristics: a.characteristics },
      product,
      parent_product_id: a.parent_product_id,
      kind: document_type === "demand" ? "sold" : "returned",
    };
  },
);
const source = { lines, documents: { demand: 5, salesreturn: 4 }, catalog: catalogVersion() };
describe("fully synthetic analytics fixture", () => {
  it("preserves restricted sizes and exact price controls", () => {
    const sizes = aggregateSizes(lines, sizeReportSchema.parse(fixture.config));
    expect(Object.values(sizes.totals).map((c) => [c.sold, c.returned, c.net])).toEqual([
      [14, 3, 11],
      [5, 2, 3],
      [7, 1, 6],
    ]);
    expect(sizes.rows).toHaveLength(3);
    const prices = aggregatePrices(lines, priceReportSchema.parse(fixture.config));
    expect(prices.rows.map((r) => r.sold)).toEqual([10, 0, 0, 5, 10, 0]);
    expect(prices.outside.female_sleeveless.sold).toBe(4);
    expect(prices.outside.female_sleeved?.sold ?? 0).toBe(0);
  });
  it("preserves the unrestricted category quantities and shares", () => {
    const result = aggregateCategoriesAndArticles(
      source,
      categoryReportSchema.parse(fixture.config),
      "categories",
    ).result;
    expect(
      result.rows.map((r) => [r.sold, r.returned, r.net, r.quantity, "percentage" in r ? r.percentage : null]),
    ).toEqual([
      [14, 3, 11, 14, 48.28],
      [5, 2, 3, 5, 17.24],
      [10, 1, 9, 10, 34.48],
    ]);
    expect(result.denominator?.quantity).toBe(29);
    expect(result.unresolved).toEqual({});
  });
  it("preserves article ranking and returns-only activity", () => {
    const result = aggregateCategoriesAndArticles(
      source,
      articleRankingSchema.parse({ ...fixture.config, categories: ["female_sleeveless", "female_sleeved"] }),
      "articles",
    ).result;
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toMatchObject({ article: "DEMO-A", sold: 10 });
    expect(result.page_quantity).toBe(19);
    expect(result.products_with_activity).toBe(4);
    expect(result.returns_only_products).toBe(1);
  });
  it("keeps the explicit synthetic override necessary", () => {
    const result = aggregateCategoriesAndArticles(
      source,
      categoryReportSchema.parse({ ...fixture.config, category_overrides: [] }),
      "categories",
    ).result;
    expect(result.unresolved.sleeve_not_explicit.rows).toBeGreaterThan(0);
  });
});
