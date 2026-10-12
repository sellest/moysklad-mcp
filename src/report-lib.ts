import { z } from "zod";
import { buildFilter, listQuery } from "./lib.js";
import { pageInfo } from "./output.js";

export function normalizeReportMoment(value: string, endOfDay = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(\.\d{3})?)?$/.exec(value);
  if (!match) throw new Error("Use YYYY-MM-DD or YYYY-MM-DD HH:mm:ss[.SSS], without a timezone offset.");
  const [, year, month, day, hour, minute, second, fraction] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value.slice(0, 10) ||
    Number(hour ?? 0) > 23 ||
    Number(minute ?? 0) > 59 ||
    Number(second ?? 0) > 59
  )
    throw new Error("Invalid report date or time.");
  return `${year}-${month}-${day} ${hour ? `${hour}:${minute}:${second}${fraction ?? ""}` : endOfDay ? "23:59:59.999" : "00:00:00"}`;
}

const reportMoment = z.string().superRefine((value, ctx) => {
  try {
    normalizeReportMoment(value);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
  }
});

export const reportPeriodSchema = {
  limit: z.number().int().min(1).max(1000).default(25).describe("Page size; use offset until next_offset is null"),
  offset: z.number().int().min(0).default(0).describe("Offset for pagination"),
  moment_from: reportMoment
    .optional()
    .describe(
      "YYYY-MM-DD (start of day) or YYYY-MM-DD HH:mm:ss[.SSS]. API report timezone; no conversion or UTC offset.",
    ),
  moment_to: reportMoment
    .optional()
    .describe(
      "YYYY-MM-DD (through 23:59:59.999) or YYYY-MM-DD HH:mm:ss[.SSS]. API report timezone; explicit time is preserved.",
    ),
  organization_href: z
    .string()
    .optional()
    .describe("Organization meta href. Omit for all organizations accessible to the token."),
};

export interface ReportPeriod {
  limit: number;
  offset: number;
  moment_from?: string;
  moment_to?: string;
  organization_href?: string;
}

export function reportQuery(params: ReportPeriod): string {
  const query = new URLSearchParams(
    listQuery({
      limit: params.limit,
      offset: params.offset,
      filter: buildFilter([["organization", params.organization_href ?? ""]]),
    }),
  );
  if (params.moment_from) query.set("momentFrom", normalizeReportMoment(params.moment_from));
  if (params.moment_to) query.set("momentTo", normalizeReportMoment(params.moment_to, true));
  if (
    params.moment_from &&
    params.moment_to &&
    Date.parse(query.get("momentFrom")!.replace(" ", "T") + "Z") >
      Date.parse(query.get("momentTo")!.replace(" ", "T") + "Z")
  ) {
    throw new Error("moment_from must not be after moment_to.");
  }
  return query.toString();
}

export function assortmentFields(raw: unknown, characteristicNames = ["Размер"]) {
  const item = (raw ?? {}) as {
    id?: string;
    name?: string;
    pathName?: string;
    meta?: { href?: string; type?: string };
    product?: unknown;
    characteristics?: { name: string; value: unknown }[];
    attributes?: { name: string; value: unknown }[];
    productFolder?: { meta?: { href?: string } };
  };
  const href = item.meta?.href ?? null;
  const id = item.id ?? href?.split("?")[0].split("/").pop() ?? null;
  const type = item.meta?.type ?? null;
  const parent = item.product as
    | {
        id?: string;
        meta?: { href?: string };
        pathName?: string;
        productFolder?: { meta?: { href?: string } };
        attributes?: { name: string; value: unknown }[];
      }
    | undefined;
  const parentHref = type === "variant" ? (parent?.meta?.href ?? null) : type === "product" ? href : null;
  const ownSize = [...(item.characteristics ?? []), ...(item.attributes ?? [])].some(
    (c) => c.name.toLocaleLowerCase() === "размер",
  );
  const parentSize =
    !ownSize && type === "variant"
      ? (parent?.attributes ?? []).filter((c) => c.name.toLocaleLowerCase() === "размер")
      : [];
  const source = [...(item.characteristics ?? []), ...(item.attributes ?? []), ...parentSize];
  const sizeValues = source.filter((c) => c.name.toLocaleLowerCase() === "размер").map((c) => c.value);
  const sizeRaw =
    sizeValues.length === 1 && (typeof sizeValues[0] === "string" || typeof sizeValues[0] === "number")
      ? String(sizeValues[0])
      : null;
  const sizeMatch = sizeRaw ? /^(\d{1,3})(?:\s*\([^)]*\))?\s*$/.exec(sizeRaw.trim()) : null;
  const characteristics = source
    .filter((c) => characteristicNames.some((n) => n.toLocaleLowerCase() === c.name.toLocaleLowerCase()))
    .map((c) => ({ name: c.name, value: c.value ?? null }));
  return {
    assortment_id: id,
    assortment_type: type,
    assortment_name: item.name ?? null,
    assortment_href: href,
    parent_product_id:
      type === "variant"
        ? (parent?.id ?? parentHref?.split("?")[0].split("/").pop() ?? null)
        : type === "product"
          ? id
          : null,
    parent_product_href: parentHref,
    characteristics: characteristics.length ? characteristics : null,
    size: sizeMatch ? Number(sizeMatch[1]) : null,
    size_raw: sizeRaw,
    product_path_name: item.pathName ?? parent?.pathName ?? null,
    product_folder_href: item.productFolder?.meta?.href ?? parent?.productFolder?.meta?.href ?? null,
    product_id: id,
    product_href: href,
    product_type: item.meta?.type ?? null,
    product_name: item.name ?? null,
  };
}

export function compactAssortment(raw: unknown, characteristicNames = ["Размер"]) {
  const {
    product_href: _href,
    product_type: _type,
    product_name: _name,
    ...fields
  } = assortmentFields(raw, characteristicNames);
  return fields;
}

/** 3.3 compact contract: exactly one id/type/name; compatibility aliases only in full. */
export function projectAssortment(
  raw: unknown,
  fields: "quantity" | "analysis" | "full" = "analysis",
  characteristicNames = ["Размер"],
) {
  const item = (raw ?? {}) as Record<string, any>;
  const identity = assortmentFields(raw, characteristicNames);
  if (fields === "full") return { ...identity, article: typeof item.article === "string" ? item.article : null };
  return {
    id: identity.assortment_id,
    type: identity.assortment_type,
    name: identity.assortment_name,
    article: typeof item.article === "string" ? item.article : null,
    ...(identity.assortment_type === "variant"
      ? { parent_product_id: identity.parent_product_id, size: identity.size, size_raw: identity.size_raw }
      : {}),
    ...(fields === "quantity"
      ? {}
      : {
          path_name: identity.product_path_name,
          folder_id: item.productFolder?.id ?? identity.product_folder_href?.split("?")[0].split("/").pop() ?? null,
          ...(identity.assortment_type === "variant" ? { characteristics: identity.characteristics } : {}),
        }),
  };
}

export function reportPage(raw: unknown, params: ReportPeriod) {
  const data = (raw ?? {}) as { meta?: { size?: number }; rows?: unknown[] };
  const returned = data.rows?.length ?? 0;
  const total = data.meta?.size;
  return pageInfo(total, returned, params.offset, params.limit);
}
