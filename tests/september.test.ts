import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregateSizes, aggregatePrices, sizeReportSchema, priceReportSchema } from "../src/tools/analytics.js";
import { aggregateCategoriesAndArticles, articleRankingSchema, categoryReportSchema } from "../src/tools/rankings.js";
import { catalogVersion, type SourceLine } from "../src/analytics-data.js";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/september-2026.json", import.meta.url), "utf8"));
const products = new Map<string, any>(fixture.products.map((p: any) => [p.id, p]));
const assortment = new Map<string, any>(fixture.assortment.map((a: any) => [a.id, a]));
const lines: SourceLine[] = fixture.lines.map(
  ([document_id, document_type, id, quantity, price, discount]: any[], index: number) => {
    const a = assortment.get(id),
      product = products.get(a.parent_product_id) ?? null;
    return {
      document_id,
      document_type,
      moment: "2026-09-15",
      position: { id: `l${index}`, quantity, price, discount },
      assortment: { ...a, meta: { type: a.type }, product, characteristics: a.characteristics },
      product,
      parent_product_id: a.parent_product_id,
      kind: document_type === "demand" ? "sold" : "returned",
    };
  },
);
const source = { lines, documents: { demand: 788, salesreturn: 60 }, catalog: catalogVersion() };
describe("stable September 2026 fixture", () => {
  it("preserves restricted sizes and exact price controls", () => {
    const sizes = aggregateSizes(lines, sizeReportSchema.parse(fixture.config));
    expect(Object.values(sizes.totals).map((c) => [c.sold, c.returned, c.net])).toEqual([
      [1117, 25, 1092],
      [166, 20, 146],
      [353, 6, 347],
    ]);
    expect(sizes.rows).toHaveLength(12);
    const prices = aggregatePrices(lines, priceReportSchema.parse(fixture.config));
    expect(prices.rows.map((r) => r.sold)).toEqual([239, 444, 244, 14, 3, 94]);
    expect(prices.outside.female_sleeveless.sold).toBe(190);
    expect(prices.outside.female_sleeved.sold).toBe(55);
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
      [1117, 25, 1092, 1117, 67.49],
      [166, 20, 146, 166, 10.03],
      [372, 7, 365, 372, 22.48],
    ]);
    expect(result.denominator?.quantity).toBe(1655);
    expect(result.unresolved).toEqual({});
  });
  it("preserves article ranking and returns-only activity", () => {
    const result = aggregateCategoriesAndArticles(
      source,
      articleRankingSchema.parse({ ...fixture.config, categories: ["female_sleeveless", "female_sleeved"] }),
      "articles",
    ).result;
    expect(result.rows).toHaveLength(20);
    expect(result.rows[0]).toMatchObject({ article: "202-153", sold: 187 });
    expect(result.page_quantity).toBe(742);
    expect(result.products_with_activity).toBe(203);
    expect(result.returns_only_products).toBe(1);
  });
  it("keeps the photo override necessary", () => {
    const result = aggregateCategoriesAndArticles(
      source,
      categoryReportSchema.parse({ ...fixture.config, category_overrides: [] }),
      "categories",
    ).result;
    expect(result.unresolved.sleeve_not_explicit.rows).toBeGreaterThan(0);
  });
});
