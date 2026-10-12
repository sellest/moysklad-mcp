import { Decimal } from "decimal.js";

export const Exact = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });
export function decimal(value: unknown): Decimal | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return null;
  try {
    const d = new Exact(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

export function netUnitPrice(priceKopecks: unknown, discountPercent: unknown): string | null {
  const price = decimal(priceKopecks);
  const discount = decimal(discountPercent);
  if (!price || !discount || price.isNegative() || discount.lt(0) || discount.gt(100)) return null;
  return price.div(100).mul(new Exact(100).minus(discount)).div(100).toFixed();
}

export const priceRules = {
  currency: "RUB",
  source_price_unit: "kopecks",
  net_unit_price_unit: "rubles",
  formula: "price_kopecks / 100 * (1 - discount_percent / 100)",
  arithmetic:
    "decimal, precision 80 significant digits; API JSON numeric values use their decimal string representation",
  classification_rounding: "none; compare exact decimal before display rounding",
  display_rounding: "half-up, 2 decimal places; display value is never used for classification",
};
export function displayPrice(value: string | null): string | null {
  return value === null ? null : new Exact(value).toFixed(2);
}
