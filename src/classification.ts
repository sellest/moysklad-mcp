import { z } from "zod";
import type { SourceLine } from "./analytics-data.js";

export const categoryIds = ["female_sleeveless", "female_sleeved", "male"] as const;
export const categorySchema = z.enum(categoryIds);
export const overrideSchema = z.object({
  product_id: z.string(),
  category: categorySchema,
  evidence: z.string().min(1).describe("Explicit source for manual classification, e.g. verified photo"),
});
export const classificationSchema = {
  categories: z
    .array(categorySchema)
    .min(1)
    .refine((values) => new Set(values).size === values.length, "Categories must be unique")
    .optional()
    .describe("Included categories; default all three"),
  scope_name_contains: z
    .string()
    .min(1)
    .optional()
    .describe("Parent product name must contain this; default купальник"),
  exclude_name_contains: z.array(z.string().min(1)).optional().describe("Default: комплект"),
  exclude_path_contains: z.array(z.string().min(1)).optional().describe("Default: плавание"),
  category_overrides: z
    .array(overrideSchema)
    .optional()
    .describe("Explicit per-product classifications with evidence; never infer sleeves from brand"),
};
export interface ClassificationOptions {
  categories?: (typeof categoryIds)[number][];
  scope_name_contains?: string;
  exclude_name_contains?: string[];
  exclude_path_contains?: string[];
  category_overrides?: z.infer<typeof overrideSchema>[];
}
export type Classification = {
  category: (typeof categoryIds)[number] | null;
  status: "included" | "excluded" | "unresolved" | "out_of_scope";
  reason: string | null;
  evidence: string | null;
};
function lower(value: unknown) {
  return typeof value === "string" ? value.toLocaleLowerCase() : "";
}

export function classify(line: SourceLine, options: ClassificationOptions): Classification {
  const type = line.assortment.meta?.type;
  const product = line.product;
  const name = lower(product?.name ?? line.assortment.name);
  const path = lower(product?.pathName);
  const result = (
    status: Classification["status"],
    reason: string | null,
    category: Classification["category"] = null,
    evidence: string | null = null,
  ): Classification => ({ status, reason, category, evidence });
  if (type === "service") return result("excluded", "service");
  if (line.assortment.unavailable || line.product?.unavailable) return result("unresolved", "catalog_card_unavailable");
  if (!name) return result("unresolved", "scope_unknown");
  if (!name.includes(lower(options.scope_name_contains ?? "купальник")))
    return result("out_of_scope", "not_in_name_scope");
  if (type === "bundle" || (options.exclude_name_contains ?? ["комплект"]).some((word) => name.includes(lower(word))))
    return result("excluded", "bundle_or_set");
  if (
    (options.exclude_path_contains ?? ["плавание"]).some((word) => path.includes(lower(word))) ||
    name.includes("плавания")
  )
    return result("excluded", "swimming");
  if (!product) return result("unresolved", "missing_parent_product");
  let category: Classification["category"] = null;
  let evidence: string | null = null;
  const overrides = (options.category_overrides ?? []).filter((rule) => rule.product_id === product.id);
  if (overrides.length > 1) return result("unresolved", "conflicting_overrides");
  if (overrides.length === 1) {
    category = overrides[0].category;
    evidence = overrides[0].evidence;
  } else if (/муж/.test(name) || /мужские купальники|gymru мужские/.test(path)) {
    category = "male";
    evidence = "explicit_gender_in_name_or_path";
  } else {
    if (!/жен/.test(name) && !/gks без рукава|gks с рукавом/.test(path))
      return result("unresolved", "gender_not_explicit");
    const attributes = product.attributes as { name?: string; value?: unknown }[] | undefined;
    const sources = [
      { field: "path", text: path },
      { field: "name", text: name },
      { field: "short_description", text: lower(attributes?.find((a) => a.name === "short_description")?.value) },
      { field: "description", text: lower(product.description) },
      ...["h1", "page_title", "meta_description"].map((field) => ({
        field,
        text: lower(attributes?.find((a) => a.name === field)?.value),
      })),
    ];
    for (const source of sources) {
      const sleeveless = /без рукав/.test(source.text);
      const sleeved = /(?:с|длинным|коротким)\s+(?:длинным\s+|коротким\s+)?рукав/.test(source.text);
      if (sleeveless && sleeved) return result("unresolved", "conflicting_sleeve_signals");
      if (sleeveless || sleeved) {
        category = sleeveless ? "female_sleeveless" : "female_sleeved";
        evidence = `explicit_sleeve_in_${source.field}`;
        break;
      }
    }
  }
  if (!category) return result("unresolved", "sleeve_not_explicit");
  if (options.categories && !options.categories.includes(category))
    return result("excluded", "category_filter", category, evidence);
  return result("included", null, category, evidence);
}
