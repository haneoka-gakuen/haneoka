import aliases from "./catalog-query-aliases.json";
import type { CatalogRecord } from "./catalog-filters";

export type CatalogQueryGame = keyof typeof aliases.attributes;
export type CatalogQueryFacets = Record<string, string[]>;
export interface CatalogQueryAlias {
  key: string;
  value: string;
  names: string[];
}
export interface CatalogQueryContext {
  game: CatalogQueryGame;
  kind: "song" | "card";
  aliases: readonly CatalogQueryAlias[];
  attributeKey?: string;
}
/** JSON-compatible query plan; facet keys are the catalogue's existing filter model. */
export interface CatalogQuery {
  schema: "haneoka-catalog-query-v1";
  text: string;
  facets: CatalogQueryFacets;
}

const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
const identity = (value: string) => normalize(value).replace(/[^\p{L}\p{N}]/gu, "");
export function catalogQueryNames(record: CatalogRecord, kind: "character" | "band"): string[] {
  const fields =
    kind === "character"
      ? [record.characterName, record.englishName]
      : [record.bandName, record.englishName, record.shortName];
  const names = fields
    .flatMap((field) => (Array.isArray(field) ? field : [field]))
    .filter((name): name is string => typeof name === "string" && !!name.trim());
  const normalized = new Set(names.map(identity));
  const groups = kind === "character" ? aliases.characters : aliases.bands;
  for (const group of groups) if (group.some((name) => normalized.has(identity(name)))) names.push(...group);
  if (kind === "character")
    for (const name of [...names]) names.push(...name.split(/\s+/u).filter((part) => part.length > 1));
  return [...new Set(names)];
}

export function parseCatalogQuery(
  query: string,
  context: CatalogQueryContext,
  consumed?: (start: number, end: number, keys: string[]) => void,
): CatalogQuery {
  const facets: CatalogQueryFacets = {};
  const add = (key: string, value: string) => {
    const values = (facets[key] ??= []);
    if (/^(min|max)/u.test(key))
      facets[key] = [String((key.startsWith("min") ? Math.max : Math.min)(...values.map(Number), Number(value)))];
    else if (!values.includes(value)) values.push(value);
  };
  const dictionary = new Map<string, Array<{ key: string; value: string }>>();
  const register = (name: string, key: string, value: string) => {
    const token = identity(name);
    if (!token) return;
    const values = dictionary.get(token) ?? [];
    if (!values.some((entry) => entry.key === key && entry.value === value)) values.push({ key, value });
    dictionary.set(token, values);
  };
  for (const alias of context.aliases) for (const name of alias.names) register(name, alias.key, alias.value);
  for (const [value, names] of Object.entries(
    context.kind === "card" || context.game === "our-notes" ? aliases.attributes[context.game] : {},
  ))
    for (const name of names) register(name, context.attributeKey ?? "type", value);
  const tokens = [...query.matchAll(/"([^"]*)"|'([^']*)'|\S+/gu)].map((match) => ({
    value: match[1] ?? match[2] ?? match[0],
    quoted: match[1] !== undefined || match[2] !== undefined,
    start: match.index!,
    end: match.index! + match[0].length,
  }));
  const remaining: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.quoted) {
      remaining.push(token.value);
      continue;
    }
    let numericMatched = false;
    for (let length = Math.min(5, tokens.length - index); length >= 1; length--) {
      const parts = tokens.slice(index, index + length);
      if (parts.some((part) => part.quoted)) continue;
      const expression = normalize(parts.map((part) => part.value).join(" "));
      const numeric =
        /^(?:(lv|level|rarity|stars?|星[级級]?|稀有度|等[级級]|[级級]|レベル|[★☆*])\s*:?\s*)?(>=|<=|>|<|=|≥|≤)?\s*(\d+(?:\.\d+)?)\s*(星[级級]?|等[级級]|[级級]|レベル|[★☆*])?\s*(?:(\+)|-\s*(\d+(?:\.\d+)?)|(以上|以下))?$/u.exec(
          expression,
        );
      if (!numeric || !numeric.slice(1).some((value, index) => index !== 2 && value)) continue;
      if (context.kind === "card" && Number(numeric[3]) > 5 && !numeric[1] && !numeric[4]) continue;
      const fieldFor = (marker: string) =>
        /^(rarity|stars?|星[级級]?|稀有度|[★☆*])$/u.test(marker) ? "Rarity" : "Level";
      if (numeric[1] && numeric[4] && fieldFor(numeric[1]) !== fieldFor(numeric[4])) continue;
      const field =
        numeric[1] || numeric[4] ? fieldFor(numeric[1] || numeric[4]) : context.kind === "song" ? "Level" : "Rarity";
      const value = Number(numeric[3]);
      const comparison = numeric[2] || (numeric[7] === "以上" || numeric[5] ? ">=" : numeric[7] === "以下" ? "<=" : "");
      if (comparison === ">=" || comparison === "≥") add(`min${field}`, String(value));
      else if (comparison === ">") add(`min${field}`, String(value + (field === "Rarity" ? 1 : 0.000001)));
      else if (comparison === "<=" || comparison === "≤") add(`max${field}`, String(value));
      else if (comparison === "<") add(`max${field}`, String(value - (field === "Rarity" ? 1 : 0.000001)));
      else {
        add(`min${field}`, String(value));
        add(`max${field}`, numeric[6] ?? String(value));
      }
      consumed?.(token.start, tokens[index + length - 1]!.end, [`min${field}`, `max${field}`]);
      index += length - 1;
      numericMatched = true;
      break;
    }
    if (numericMatched) continue;
    const mission = /^(?:(only|contains):)?(combo|just|luck|mix)$/u.exec(normalize(token.value));
    if (context.kind === "song" && context.game === "our-notes" && mission) {
      add(
        "gekisouType",
        ({ combo: "Combo", just: "JustCount", luck: "Luck", mix: "Mix" } as Record<string, string>)[mission[2]],
      );
      if (mission[1]) facets.gekisouMatch = [mission[1]];
      consumed?.(token.start, token.end, ["gekisouType", "gekisouMatch"]);
      continue;
    }
    let recognized = false;
    for (let length = Math.min(5, tokens.length - index); length >= 1; length--) {
      if (
        tokens
          .slice(index, index + length)
          .some((part) => part.quoted || /^[-+★☆*<>=≥≤]+$/u.test(normalize(part.value)))
      )
        continue;
      const entries = dictionary.get(
        identity(
          tokens
            .slice(index, index + length)
            .map((part) => part.value)
            .join(" "),
        ),
      );
      if (!entries?.length) continue;
      const keys = new Set(entries.map((entry) => entry.key));
      if (keys.size > 1) continue;
      for (const entry of entries) add(entry.key, entry.value);
      consumed?.(token.start, tokens[index + length - 1]!.end, [...keys]);
      index += length - 1;
      recognized = true;
      break;
    }
    if (!recognized) remaining.push(token.value);
  }
  return {
    schema: "haneoka-catalog-query-v1",
    text: Object.keys(facets).length ? remaining.join(" ") : query.trim(),
    facets,
  };
}

/** Remove recognized filter terms without reinterpreting quoted free text. */
export function removeCatalogQueryFacets(
  query: string,
  context: CatalogQueryContext,
  keys?: readonly string[],
): string {
  const ranges: [number, number][] = [];
  parseCatalogQuery(query, context, (start, end, facets) => {
    if (!keys || facets.some((key) => keys.includes(key))) ranges.push([start, end]);
  });
  for (const [start, end] of ranges.reverse()) query = query.slice(0, start) + query.slice(end);
  return query.trim();
}

export function intersectCatalogFacets(left: CatalogQueryFacets, right: CatalogQueryFacets): CatalogQueryFacets {
  const result = { ...left };
  for (const [key, values] of Object.entries(right)) {
    const previous = left[key] ?? [];
    if (!previous.length) result[key] = values;
    else if (/^(min|max)/u.test(key))
      result[key] = [
        String((key.startsWith("min") ? Math.max : Math.min)(...previous.map(Number), ...values.map(Number))),
      ];
    else if (key === "gekisouMatch") result[key] = values;
    else result[key] = values.filter((value) => previous.includes(value));
    if (!result[key].length) result[key] = ["\u0000"];
  }
  return result;
}
