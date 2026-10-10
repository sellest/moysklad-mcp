import { readFile } from "node:fs/promises";
export async function loadFixture() {
  const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/september-2026.json", import.meta.url), "utf8"));
  const href = (type, id) => `https://api.moysklad.ru/api/remap/1.2/entity/${type}/${id}`;
  const products = new Map(
    fixture.products.map((p) => [p.id, { ...p, meta: { type: "product", href: href("product", p.id) } }]),
  );
  const assortment = new Map(
    fixture.assortment.map((a) => [
      a.id,
      a.type === "product" && products.has(a.parent_product_id)
        ? products.get(a.parent_product_id)
        : {
            id: a.id,
            name: a.name,
            meta: { type: a.type, href: href(a.type, a.id) },
            characteristics: a.characteristics,
            product: products.get(a.parent_product_id),
          },
    ]),
  );
  const lines = fixture.lines.map(([document_id, type, id, quantity, price, discount], index) => {
    const a = assortment.get(id),
      parent = fixture.assortment.find((item) => item.id === id).parent_product_id;
    return {
      document_id,
      document_type: type,
      moment: "2026-09-15 12:00:00",
      position: { id: "l" + index, quantity, price, discount, assortment: a },
      assortment: a,
      product: products.get(parent) ?? null,
      parent_product_id: parent,
      kind: type === "demand" ? "sold" : "returned",
    };
  });
  const documents = {};
  for (const type of ["demand", "salesreturn", "retaildemand", "retailsalesreturn"])
    documents[type] = new Set(lines.filter((l) => l.document_type === type).map((l) => l.document_id)).size;
  return {
    fixture,
    products,
    assortment,
    source: {
      lines,
      documents,
      catalog: {
        version: "stable-september-fixture",
        checked_at: "2026-10-10T00:00:00.000Z",
        cache: { ttl_seconds: 300, scope: "anonymous stable fixture" },
      },
    },
  };
}
