/** Source comparison is separate from entity identity and never discards a source version. */
import { CONTENT_SOURCE_IDS, contentSourceFamily } from "../content-sources";
type Row = Record<string, unknown>;
export interface ContentVariant {
  identity: { server: string; releaseId?: string; sourceId?: string };
  row: Row;
}
export const isFormalCatalogSource = (server: string): boolean => server === "jp" || server === "intl";
const unknown = Symbol("unresolved-summary");

export function catalogSourceOrder(sources: readonly string[], selected: string): string[] {
  const family = contentSourceFamily;
  const available = new Set(sources);
  const stable = [...new Set([...CONTENT_SOURCE_IDS.filter(source => available.has(source)), ...sources])];
  const selectedFamily = family(selected);
  return [...(available.has(selected) ? [selected] : []),
    ...stable.filter(source => source !== selected && selectedFamily && family(source) === selectedFamily),
    ...stable.filter(source => source !== selected && (!selectedFamily || family(source) !== selectedFamily))];
}

export function preferredCatalogVariant<T extends ContentVariant>(variants: readonly T[], selected: string): T | undefined {
  const server = catalogSourceOrder(variants.map(variant => variant.identity.server), selected)[0];
  return variants.find(variant => variant.identity.server === server);
}

/** Native owner fields distinguish reused primary IDs; delivery paths never do. */
export function semanticOwnerKey(row: Row, resource: string): string | undefined {
  if (resource === "stories") {
    const key = row.storyKey ?? row._storyKey ?? row.scenarioKey ?? row._scenarioKey;
    if (typeof key === "string" && key.length > 0 && key.length <= 256 &&
      !/[\\/\u0000-\u001f\u007f]/u.test(key) && key !== "." && key !== "..")
      return JSON.stringify({ scenario: key });
  }
  const owners: Row = {};
  const ownerId = (value: unknown): value is string | number =>
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  for (const [name, fields] of [
    ["characters", ["characterIds", "characterId", "_characterId"]],
    ["bands", ["bandIds", "bandId", "_bandId"]],
  ] as const) {
    const field = fields.find((key) => row[key] !== undefined);
    if (!field) continue;
    const value = row[field],
      values = Array.isArray(value) ? value : [value];
    if (!values.every(ownerId)) return undefined;
    owners[name] = [...new Set(values.map(String))].sort();
  }
  for (const key of ["musicId", "storyChapterId"])
    if (row[key] !== undefined || row[`_${key}`] !== undefined) {
      const value = row[key] ?? row[`_${key}`];
      if (!ownerId(value)) return undefined;
      owners[key] = String(value);
    }
  return JSON.stringify(owners);
}

export function semanticOwnersConflict(left: Row, right: Row, resource: string): boolean {
  const a = semanticOwnerKey(left, resource),
    b = semanticOwnerKey(right, resource);
  if (a === undefined || b === undefined) return false;
  const first = JSON.parse(a) as Row,
    second = JSON.parse(b) as Row;
  return Object.keys(first).some(
    (key) => Object.hasOwn(second, key) && JSON.stringify(first[key]) !== JSON.stringify(second[key]),
  );
}

function summaryValue(value: unknown, identity: ContentVariant["identity"]): unknown {
  if (typeof value === "string") {
    if (!value.startsWith("/")) return value;
    const url = new URL(value, "https://asset.invalid"),
      parts = url.pathname.split("/");
    const media = ["assets", "runtime", "objects", "artifacts", "game-client"].includes(parts[1] || "");
    if (media && parts[2] === identity.server) parts.splice(2, 1);
    else if (parts[1] === identity.server) parts.splice(1, 1);
    else return value;
    for (const [key, pin] of [
      ["release", identity.releaseId],
      ["releaseId", identity.releaseId],
      ["source", identity.sourceId],
      ["sourceId", identity.sourceId],
    ])
      if (pin && url.searchParams.get(key!) === pin) url.searchParams.delete(key!);
    url.searchParams.sort();
    return parts.join("/") + url.search + url.hash;
  }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return value;
  if (Array.isArray(value)) {
    const entries = value.map((entry) => summaryValue(entry, identity));
    return entries.includes(unknown) ? unknown : entries;
  }
  if (!value || typeof value !== "object") return unknown;
  const result: Row = {};
  for (const key of Object.keys(value).sort()) {
    const entry = summaryValue((value as Row)[key], identity);
    if (entry === unknown) return unknown;
    Object.defineProperty(result, key, { value: entry, enumerable: true });
  }
  return result;
}

export function sourceVariantGroups(variants: readonly ContentVariant[]): string[][] {
  const groups: string[][] = [],
    observed = new Map<string, string[]>();
  for (const variant of variants) {
    const row = { ...variant.row };
    for (const key of ["server", "releaseId", "sourceId"] as const)
      if (row[key] === variant.identity[key]) delete row[key];
    const value = summaryValue(row, variant.identity),
      key = value === unknown ? undefined : JSON.stringify(value);
    const prior = key === undefined ? undefined : observed.get(key);
    if (prior) prior.push(variant.identity.server);
    else {
      const group = [variant.identity.server];
      groups.push(group);
      if (key !== undefined) observed.set(key, group);
    }
  }
  return groups;
}

/** Additional entities require both formal catalogues to be observed and absent. */
export function visibleSourceVariants<T extends ContentVariant>(variants: readonly T[], formalComplete: boolean): T[] {
  const formal = variants.filter((variant) => isFormalCatalogSource(variant.identity.server));
  return formal.length ? formal : formalComplete ? [...variants] : [];
}
