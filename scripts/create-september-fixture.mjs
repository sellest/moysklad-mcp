import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { classify } from "../dist/classification.js";
import { Exact } from "../dist/precision.js";
const directory = process.argv[2];
if (!directory) throw Error("Specify the reference work directory. Output contains anonymous IDs and synthetic names.");
const read = async (name) => JSON.parse(await readFile(join(directory, name), "utf8"));
const products = new Map((await read("size-products.json")).map((p) => [p.id, p]));
const variants = new Map((await read("size-variants.json")).map((p) => [p.id, p]));
const positions = await read("size-positions.json");
const config = JSON.parse(await readFile(new URL("../examples/leotards-september-2026.json", import.meta.url), "utf8"));
const productRecords = new Map(),
  assortmentRecords = new Map(),
  documentIds = new Map();
const lines = [];
for (const p of positions) {
  const original = (p.product_type === "variant" ? variants.get(p.product_id) : products.get(p.product_id)) ?? {
    id: p.product_id,
    name: p.product_name,
    meta: { type: p.product_type },
  };
  const originalParentId = p.product_type === "variant" ? original.product?.meta?.href?.split("/").pop() : p.product_id;
  const parent = products.get(originalParentId);
  const classification = classify(
    { assortment: original, product: parent ?? null, parent_product_id: originalParentId },
    config,
  );
  let parentId = null;
  if (parent) {
    if (!productRecords.has(parent.id)) {
      const id = "p" + productRecords.size;
      let name =
        classification.category === "male"
          ? "Купальник мужской"
          : classification.category === "female_sleeved"
            ? "Купальник женский с рукавом"
            : "Купальник женский без рукава";
      let pathName = "";
      if (classification.reason === "bundle_or_set") name = "Купальник комплект";
      if (classification.reason === "swimming") pathName = "Плавание";
      if (classification.status === "out_of_scope") name = "Товар вне области отчёта";
      if (classification.status === "unresolved" || config.category_overrides.some((o) => o.product_id === parent.id))
        name = "Купальник женский Quatro";
      productRecords.set(parent.id, {
        id,
        name,
        pathName,
        article: typeof parent.article === "string" ? parent.article : null,
        meta: { type: "product" },
      });
    }
    parentId = productRecords.get(parent.id).id;
  }
  if (!assortmentRecords.has(p.product_id))
    assortmentRecords.set(p.product_id, {
      id: "a" + assortmentRecords.size,
      type: p.product_type,
      parent_product_id: parentId,
      name: parentId ? "Модификация" : "Товар вне области отчёта",
      characteristics: original.characteristics?.filter((c) => c.name === "Размер") ?? [],
    });
  if (!documentIds.has(p.document_id)) documentIds.set(p.document_id, "d" + documentIds.size);
  lines.push([
    documentIds.get(p.document_id),
    p.kind,
    assortmentRecords.get(p.product_id).id,
    p.quantity,
    new Exact(String(p.price_rubles)).mul(100).toFixed(),
    p.discount,
  ]);
}
const fixture = {
  reference:
    "September 2026, verified 10.10.2026. Anonymous IDs, synthetic names; original articles, sizes, decimal prices and quantities.",
  config: {
    moment_from: config.moment_from,
    moment_to: config.moment_to,
    bands: config.bands,
    category_overrides: config.category_overrides.map((o) => ({
      ...o,
      product_id: productRecords.get(o.product_id).id,
    })),
  },
  products: [...productRecords.values()],
  assortment: [...assortmentRecords.values()],
  lines,
};
await mkdir(new URL("../tests/fixtures/", import.meta.url), { recursive: true });
await writeFile(new URL("../tests/fixtures/september-2026.json", import.meta.url), JSON.stringify(fixture));
console.log(
  JSON.stringify({
    products: fixture.products.length,
    assortment: fixture.assortment.length,
    lines: lines.length,
    documents: documentIds.size,
  }),
);
