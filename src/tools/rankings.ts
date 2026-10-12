import { PagedExport } from "../paged-export.js";
import { reportContext } from "../report-context.js";
import { z } from "zod";
import { loadSourceLines, type LoadedSource, type SourceLine } from "../analytics-data.js";
import { categoryIds, classify } from "../classification.js";
import { outputResult } from "../output.js";
import { Exact } from "../precision.js";
import { addCount, emptyCounts, analyticsCommon, type Counts } from "./analytics.js";
import type { ToolDef } from "../types.js";

const basis = z
  .enum(["sold", "returned", "net"])
  .default("sold")
  .describe("Ranking/share quantity basis. net = sold minus returned, not inventory.");
const auditFields = analyticsCommon.fields.describe(
  "Accepted for compatibility; category/article reports always use their compact audit dictionary and line records.",
);
export const articleRankingSchema = z.object({
  ...analyticsCommon,
  fields: auditFields,
  quantity_basis: basis,
  top_n: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});
export const categoryReportSchema = z.object({ ...analyticsCommon, fields: auditFields, quantity_basis: basis });
type Params = z.infer<typeof articleRankingSchema> | z.infer<typeof categoryReportSchema>;
const accumulate = (map: Record<string, Counts>, key: string, line: SourceLine) =>
  addCount((map[key] ??= emptyCounts()), line);

function createCategoryAccumulator(params: Params, kind: "categories" | "articles") {
  const categories = params.categories ?? [...categoryIds];
  const categoryCounts = Object.fromEntries(categories.map((c) => [c, emptyCounts()]));
  const articles = new Map<string, Counts>();
  const missingArticles = emptyCounts(),
    excluded: Record<string, Counts> = {},
    unresolved: Record<string, Counts> = {},
    outOfScope = emptyCounts();
  const included = emptyCounts(),
    inScope = emptyCounts();
  const productActivity = new Map<string, Counts>();
  const dictionary: Record<string, unknown> = {},
    detail: Record<string, unknown>[] = [];
  const classifications = new Map<string, ReturnType<typeof classify>>();
  const dirty: string[] = [];
  function add(line: SourceLine) {
    const key = line.parent_product_id ?? `${line.assortment.meta?.type}:${line.assortment.id}`;
    const classification = classifications.get(key) ?? classify(line, { ...params, categories });
    classifications.set(key, classification);
    if (classifications.size > 50000) throw new Error("STORAGE_LIMIT: Catalog cardinality budget exceeded.");
    if (classification.status === "out_of_scope") {
      addCount(outOfScope, line);
      return;
    }
    addCount(inScope, line);
    const rawArticle = line.product?.article;
    const article = typeof rawArticle === "string" && rawArticle.trim().length ? rawArticle : null;
    if (classification.status === "included") {
      addCount(included, line);
      addCount(categoryCounts[classification.category!], line);
      const activity = productActivity.get(key) ?? emptyCounts();
      addCount(activity, line);
      productActivity.set(key, activity);
      if (article === null) addCount(missingArticles, line);
      else {
        const counts = articles.get(article) ?? emptyCounts();
        addCount(counts, line);
        articles.set(article, counts);
      }
    } else accumulate(classification.status === "unresolved" ? unresolved : excluded, classification.reason!, line);
    if (!(key in dictionary)) dirty.push(key);
    dictionary[key] ??= {
      id: line.parent_product_id,
      name: line.product?.name ?? line.assortment.name ?? null,
      article,
      category: classification.category,
      evidence: classification.evidence,
    };
    detail.push({
      document_id: line.document_id,
      position_id: line.position.id ?? null,
      assortment_id: line.assortment.id ?? null,
      product_ref: key,
      kind: line.kind,
      quantity: line.position.quantity,
      status: classification.status,
      reason: classification.reason,
    });
  }
  function finish(source: LoadedSource) {
    const quantity = params.quantity_basis;
    const denominator = included[quantity];
    const categoryRows = categories.map((category) => ({
      category,
      ...categoryCounts[category],
      quantity: categoryCounts[category][quantity],
      percentage:
        denominator === 0
          ? null
          : new Exact(categoryCounts[category][quantity]).div(denominator).mul(100).toDecimalPlaces(2).toNumber(),
    }));
    // Binary string ordering is independent of locale and does not strip leading zeros/spelling.
    const ranked = [...articles]
      .map(([article, counts]) => ({ article, ...counts, quantity: counts[quantity] }))
      .sort((a, b) => b.quantity - a.quantity || (a.article < b.article ? -1 : a.article > b.article ? 1 : 0))
      .map((row, index) => ({ rank: index + 1, ...row }));
    const offset = kind === "articles" ? (params as z.infer<typeof articleRankingSchema>).offset : 0;
    const rows =
      kind === "articles"
        ? ranked.slice(offset, offset + (params as z.infer<typeof articleRankingSchema>).top_n)
        : categoryRows;
    const total = kind === "articles" ? ranked.length : categories.length;
    return {
      result: {
        period: { from: params.moment_from, to: params.moment_to },
        organizations: params.organization_hrefs?.length ? [...new Set(params.organization_hrefs)] : "all_accessible",
        quantity_basis: quantity,
        rows,
        total,
        returned: rows.length,
        next_offset: offset + rows.length < total ? offset + rows.length : null,
        complete: offset === 0 && rows.length === total,
        source_complete: true,
        ...(source.passport ? { source_passport: source.passport, source_completeness: source.completeness } : {}),
        included,
        excluded,
        unresolved,
        out_of_scope: outOfScope,
        accounting: { in_scope: inScope, included },
        ...(kind === "categories"
          ? {
              denominator: {
                quantity: denominator,
                basis: quantity,
                scope: "resolved requested categories only; excluded and unresolved omitted",
                zero_result: "percentage=null",
                negative_net: "negative quantities and shares are retained, not clamped",
              },
            }
          : {
              missing_articles: missingArticles,
              products_with_activity: productActivity.size,
              products_with_sales: [...productActivity.values()].filter((c) => c.sold > 0).length,
              returns_only_products: [...productActivity.values()].filter((c) => c.sold === 0 && c.returned > 0).length,
              page_quantity: rows.reduce((sum, row) => new Exact(sum).plus(row.quantity).toNumber(), 0),
            }),
        rules: {
          return_price_basis: "return_document",
          quantities: "sold and returned separate; net=sold-returned, not inventory",
          scope: "no size or price restrictions",
          article_basis: "exact parent product.article string; never name or code",
          tie_order: "quantity descending, article binary ascending",
          percentages: "unit quantities, decimal ROUND_HALF_UP to 2 places",
        },
        source: { documents: source.documents, positions: source.position_count ?? source.lines.length },
        catalog: source.catalog,
        ...(source.snapshot ? { snapshot: source.snapshot } : {}),
      },
      audit: { dictionary, detail, ...(kind === "articles" ? { ranking: ranked } : {}) },
    };
  }

  return {
    add,
    finish,
    drain: () => ({
      detail: detail.splice(0),
      dictionary: dirty.splice(0).map((key) => ({ key, value: dictionary[key] })),
    }),
  };
}
export function aggregateCategoriesAndArticles(source: LoadedSource, params: Params, kind: "categories" | "articles") {
  const accumulator = createCategoryAccumulator(params, kind);
  for (const line of source.lines) accumulator.add(line);
  return accumulator.finish(source);
}
export async function renderCategoryOrRanking(source: LoadedSource, params: Params, kind: "categories" | "articles") {
  if (source.lineStream) {
    const accumulator = createCategoryAccumulator(params, kind);
    const writer = new PagedExport(undefined, reportContext.getStore()?.jobId ?? null);
    let count = 0;
    const flush = async () => {
      const audit = accumulator.drain();
      await writer.append("detail", audit.detail);
      await writer.append("dictionary", audit.dictionary);
    };
    for await (const line of source.lineStream) {
      accumulator.add(line);
      if (++count % 100 === 0) await flush();
    }
    await flush();
    const { result, audit } = accumulator.finish(source);
    await writer.append("rows", result.rows);
    if ("ranking" in audit) await writer.append("ranking", audit.ranking!);
    const { rows: _rows, ...metadata } = result;
    return JSON.stringify({
      ...result,
      source_completeness: source.completeness,
      export: await writer.finish(metadata, source.snapshot?.id, source.snapshot?.captured_at),
    });
  }
  const { result, audit } = aggregateCategoriesAndArticles(source, params, kind);
  const full = { ...result, ...audit };
  return outputResult(
    params.output === "file" || params.detail === "rows" || params.detail === "raw" ? full : result,
    result,
    params,
  );
}
export const handleArticleRanking = async (params: z.infer<typeof articleRankingSchema>) =>
  renderCategoryOrRanking(await loadSourceLines({ ...params, limit: 100, offset: 0 }), params, "articles");
export const handleCategoryReport = async (params: z.infer<typeof categoryReportSchema>) =>
  renderCategoryOrRanking(await loadSourceLines({ ...params, limit: 100, offset: 0 }), params, "categories");
export const tools: ToolDef[] = [
  {
    name: "get_sales_ranking_by_article",
    description:
      "Sales ranking grouped by exact parent product.article, combining variants and products with the same article. Default top 20 by gross sold, deterministic ties. Missing articles separate. Follow next_offset; full supporting detail via file. No size or price restrictions.",
    schema: articleRankingSchema,
    handler: handleArticleRanking,
  },
  {
    name: "get_sales_by_category",
    description:
      "Sales/returns/net and unit percentages for explicitly classified categories, without size or price bands. Denominator excludes unresolved/excluded classifications. Basis sold/returned/net is explicit. Shares may be negative for net returns. Default three rows.",
    schema: categoryReportSchema,
    handler: handleCategoryReport,
  },
];
