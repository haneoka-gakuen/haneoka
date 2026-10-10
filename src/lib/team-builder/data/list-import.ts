import { type TeamBuilderData } from "../data";
import { practiceRanges, validateInventory, type InventoryKind, type InventoryV1 } from "../inventory";
import {
  sameBoxContext,
  type BoxCardProposal,
  type BoxPracticeField,
  type BoxPreview,
  type BoxReviewContext,
} from "../box-import/preview";

const FIELDS = ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"] as const;
const HEADERS: Record<string, string> = {
  kind: "kind",
  id: "id",
  cardid: "id",
  name: "name",
  level: "level",
  training: "training",
  awake: "training",
  awakecount: "training",
  awakening: "awakening",
  rank: "awakening",
  liveskilllevel: "liveSkillLevel",
  skilllevel: "liveSkillLevel",
  gekisoskilllevel: "gekisoSkillLevel",
  gekisouskilllevel: "gekisoSkillLevel",
};
const KINDS: Record<string, InventoryKind> = {
  member: "members",
  members: "members",
  support: "snapshots",
  snapshot: "snapshots",
  snapshots: "snapshots",
};
const kindOf = (value: string): InventoryKind | undefined => KINDS[value.toLowerCase()];

/** CSV/TSV clipboard input; quoted names may contain separators and newlines. */
export function parseInventoryList(text: string): string[][] {
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new RangeError("inventory-list-byte-limit");
  text = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  let delimiter = ",",
    inQuote = false;
  for (const char of text) {
    if (char === '"') inQuote = !inQuote;
    if (!inQuote && char === "\t") {
      delimiter = "\t";
      break;
    }
    if (!inQuote && char === "\n") break;
  }
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const pushCell = () => {
    row.push(cell.trim());
    cell = "";
    closed = false;
  };
  const pushRow = () => {
    pushCell();
    if (row.some((value) => value.length)) rows.push(row);
    row = [];
    if (rows.length > 5001) throw new RangeError("inventory-list-row-limit");
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (char === delimiter) pushCell();
    else if (char === "\n") pushRow();
    else if (char === '"') {
      if (cell.trim() || closed) throw new TypeError("inventory-list-invalid-quote");
      cell = "";
      quoted = true;
    } else if (closed && char.trim()) throw new TypeError("inventory-list-after-quote");
    else cell += char;
  }
  if (quoted) throw new TypeError("inventory-list-unclosed-quote");
  pushRow();
  return rows;
}

export interface InventoryListPreview {
  preview: BoxPreview;
  rows: { line: number; kind?: InventoryKind; cardId?: number; code?: string }[];
}

/** Same native IDs, domains and explicit merge confirmation as Box imports.
 * Numeric fields use native rank/awakeCount values, never minus-one display counts.
 */
export function previewInventoryList(
  text: string,
  current: InventoryV1,
  data: TeamBuilderData,
  context: BoxReviewContext,
  defaultKind: InventoryKind,
): InventoryListPreview {
  if (
    !sameBoxContext(context, data) ||
    !validateInventory(current, data).valid ||
    !["members", "snapshots"].includes(defaultKind)
  )
    throw new TypeError("inventory-list-context");
  const parsed = parseInventoryList(text);
  if (!parsed.length) throw new TypeError("inventory-list-empty");
  const first = parsed[0]!.map((value) => HEADERS[value.toLowerCase()]);
  const hasHeader = first.includes("id") || first.includes("name");
  if (hasHeader && (first.some((value) => !value) || new Set(first).size !== first.length))
    throw new TypeError("inventory-list-header");
  const lines = hasHeader ? parsed.slice(1) : parsed;
  if (!lines.length) throw new TypeError("inventory-list-empty");
  if (lines.length > 5000) throw new RangeError("inventory-list-row-limit");
  const cards = new Map<string, BoxCardProposal>(),
    issues: BoxPreview["issues"] = [];
  const rows: InventoryListPreview["rows"] = [];
  const names = new Map<InventoryKind, Map<string, number[]>>();
  for (const kind of ["members", "snapshots"] as const) {
    const index = new Map<string, number[]>();
    for (const card of Object.values(kind === "members" ? data.members : data.snapshots))
      for (const name of new Set(Array.isArray(card.name) ? card.name : [card.name]))
        if (typeof name === "string" && name.trim()) {
          const previous = index.get(name.trim()) ?? [];
          previous.push(card.id);
          index.set(name.trim(), previous);
        }
    names.set(kind, index);
  }
  for (const [offset, cells] of lines.entries()) {
    const line = offset + (hasHeader ? 2 : 1);
    let kind: InventoryKind | undefined, cardId: number | undefined;
    try {
      if (cells.length > (hasHeader ? first.length : 1)) throw new TypeError("inventory-list-extra-columns");
      const input = hasHeader
        ? Object.fromEntries(first.map((field, index) => [field!, cells[index] ?? ""]))
        : { id: cells[0]! };
      kind = input.kind ? kindOf(input.kind) : defaultKind;
      if (!kind) throw new TypeError("inventory-list-kind");
      const value = input.id || input.name || "";
      const prefixed = /^(member|support)-(?:card-)?([1-9]\d*)$/u.exec(value);
      if (prefixed) {
        const prefixKind = kindOf(prefixed[1]!);
        if (input.kind && prefixKind !== kind) throw new TypeError("inventory-list-kind-id-mismatch");
        kind = prefixKind!;
        cardId = Number(prefixed[2]);
      } else if (/^[1-9]\d*$/u.test(value)) cardId = Number(value);
      else {
        const matches = names.get(kind)!.get(value) ?? [];
        if (matches.length !== 1)
          throw new TypeError(matches.length ? "inventory-list-name-ambiguous" : "inventory-list-card-unknown");
        cardId = matches[0]!;
      }
      const card = (kind === "members" ? data.members : data.snapshots)[String(cardId)];
      if (!Number.isSafeInteger(cardId) || !card) throw new TypeError("inventory-list-card-unknown");
      const owned = current[kind].find((entry) => entry.cardId === cardId);
      const supplied: Partial<Record<BoxPracticeField, number>> = {};
      for (const field of FIELDS) {
        const raw = input[field];
        if (!raw) continue;
        if (kind === "snapshots" && !["level", "awakening"].includes(field))
          throw new TypeError("inventory-list-snapshot-field");
        if (!/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(Number(raw)))
          throw new TypeError("inventory-list-practice-value");
        supplied[field] = Number(raw);
      }
      const state = { ...owned, ...supplied };
      const ranges = practiceRanges(data, kind, cardId, state);
      for (const [field, value] of Object.entries(supplied))
        if (!ranges[field]?.includes(value)) throw new TypeError("inventory-list-practice-range");
      const key = `${context.server}:${kind}:${cardId}`;
      let proposal = cards.get(key);
      if (!proposal) {
        proposal = {
          key,
          kind,
          cardId,
          existingInstanceId: owned?.instanceId ?? null,
          existing: owned
            ? Object.fromEntries(
                FIELDS.filter((field) => kind === "members" || ["level", "awakening"].includes(field)).map((field) => [
                  field,
                  (owned as unknown as Record<string, unknown>)[field] ?? null,
                ]),
              )
            : {},
          values: {},
        };
        cards.set(key, proposal);
      }
      for (const [field, value] of Object.entries(supplied) as [BoxPracticeField, number][])
        proposal.values[field] = [...new Set([...(proposal.values[field] ?? []), value])].sort((a, b) => a - b);
      rows.push({ line, kind, cardId });
    } catch (error) {
      const code = error instanceof Error ? error.message : "inventory-list-invalid-row";
      rows.push({ line, ...(kind ? { kind } : {}), ...(cardId === undefined ? {} : { cardId }), code });
      issues.push({ kind: cardId === undefined ? "input" : (kind ?? "input"), id: cardId ?? line, field: "row", code });
    }
  }
  return {
    rows,
    preview: {
      schema: "haneoka-box-preview-v1",
      context: { ...context },
      candidateId: crypto.randomUUID(),
      original: structuredClone(current),
      cards: [...cards.values()],
      maps: [],
      issues,
    },
  };
}

export const inventoryListTemplate = () => "kind,id,level,training,awakening,liveSkillLevel,gekisoSkillLevel\n";
