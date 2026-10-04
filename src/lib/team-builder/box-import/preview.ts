import { nativeRow, type TeamBuilderData } from "../data";
import {
  bandItemLevelValues,
  practiceRanges,
  validateInventory,
  type InventoryV1,
  type InventoryKind,
} from "../inventory";
import { maximumNewCardPractice } from "../manual-card-defaults";
import { BoxImportError, decimal, integer, type BoxCandidate } from "./types";
export interface BoxReviewContext {
  ownerId: string;
  revision: number;
  server: string;
  releaseId: string;
  sourceId: string;
}
export type BoxPracticeField = "level" | "training" | "awakening" | "liveSkillLevel" | "gekisoSkillLevel";
export interface BoxCardProposal {
  key: string;
  kind: InventoryKind;
  cardId: number;
  existingInstanceId: string | null;
  values: Partial<Record<BoxPracticeField, number[]>>;
  existing: Partial<Record<BoxPracticeField, number | null>>;
  defaultPractice: Record<string, number> | null;
}
export interface BoxMapProposal {
  key: string;
  map: "bandItems" | "characterRanks";
  id: number;
  values: number[];
  existing: number | null;
}
export interface BoxPreview {
  schema: "haneoka-box-preview-v1";
  context: BoxReviewContext;
  candidateId: string;
  original: InventoryV1;
  cards: BoxCardProposal[];
  maps: BoxMapProposal[];
  issues: { kind: string; id: number; field: string; code: string }[];
}
export function sameBoxContext(context: BoxReviewContext, data: TeamBuilderData) {
  return (
    !!context.ownerId &&
    Number.isSafeInteger(context.revision) &&
    context.revision >= 0 &&
    context.server === data.identity.server &&
    context.releaseId === data.identity.releaseId &&
    context.sourceId === data.identity.sourceId
  );
}
function fromExp(
  rows: Record<string, unknown>[],
  exp: string | null,
  group: number | null,
  key: "level" | "rank",
): number | null {
  if (exp === null) return null;
  let best: number | null = null;
  for (const raw of rows) {
    const row = nativeRow(raw),
      threshold = decimal(row.exp),
      value = integer(row[key]);
    if ((group !== null && Number(row.group) !== group) || threshold === null || value === null) continue;
    if (BigInt(threshold) <= BigInt(exp) && (best === null || value > best)) best = value;
  }
  return best;
}
/** Pure preview: the supplied Box is unbound to a game server until the user confirms the current data context. */
export function previewBoxImport(
  candidate: BoxCandidate,
  current: InventoryV1,
  data: TeamBuilderData,
  context: BoxReviewContext,
): BoxPreview {
  if (!sameBoxContext(context, data) || !validateInventory(current, data).valid)
    throw new BoxImportError("box_review_context");
  if (candidate.declaredIdentity && candidate.declaredIdentity.server !== context.server)
    throw new BoxImportError("box_review_context");
  const issues: BoxPreview["issues"] = [],
    cards = new Map<string, BoxCardProposal>(),
    maps = new Map<string, BoxMapProposal>();
  for (const kind of ["members", "snapshots"] as const)
    for (const source of candidate[kind]) {
      const card = (kind === "members" ? data.members : data.snapshots)[String(source.cardId)];
      if (!card) {
        issues.push({ kind, id: source.cardId, field: "cardId", code: "unknown_current_card" });
        continue;
      }
      const key = `${context.server}:${kind}:${source.cardId}`,
        owned = current[kind].find((r) => r.cardId === source.cardId),
        member = kind === "members" ? (source as BoxCandidate["members"][number]) : null;
      // Haneoka stores the native awakeCount/rank domain. The reference's *_count fields are minus-one display counts, a different schema.
      const raw: Partial<Record<BoxPracticeField, number | null>> = {
        awakening: source.rank,
        level:
          source.level ??
          fromExp(
            data.progression[kind === "members" ? "memberCardLevels" : "supportCardLevels"] || [],
            source.exp,
            card.levelGroup,
            "level",
          ),
        ...(member
          ? {
              training: member.awakeCount,
              liveSkillLevel: member.liveSkillLevel,
              gekisoSkillLevel: member.performanceSkillLevel,
            }
          : {}),
      };
      const allowed = practiceRanges(data, kind, source.cardId, raw);
      let proposal = cards.get(key);
      if (!proposal) {
        proposal = {
          key,
          kind,
          cardId: source.cardId,
          existingInstanceId: owned?.instanceId || null,
          values: {},
          existing: owned
            ? Object.fromEntries(
                Object.keys(raw).map((field) => [
                  field,
                  (owned as unknown as Record<string, number | null>)[field] ?? null,
                ]),
              )
            : {},
          defaultPractice: null,
        };
        cards.set(key, proposal);
      }
      for (const [field, value] of Object.entries(raw) as [BoxPracticeField, number | null][]) {
        if (value === null) continue;
        if (!allowed[field]?.includes(value)) {
          issues.push({
            kind,
            id: source.cardId,
            field,
            code: allowed[field]?.length ? "out_of_current_range" : "current_domain_unavailable",
          });
          continue;
        }
        const values = proposal.values[field] || [];
        if (!values.includes(value)) values.push(value);
        proposal.values[field] = values.sort((a, b) => a - b);
      }
    }
  for (const proposal of cards.values())
    if (!proposal.existingInstanceId) {
      const supplied = Object.fromEntries(
        Object.entries(proposal.values)
          .filter(([, v]) => v?.length === 1)
          .map(([k, v]) => [k, v![0]]),
      );
      proposal.defaultPractice = maximumNewCardPractice(data, proposal.kind, proposal.cardId, supplied);
    }
  for (const [map, rows] of [
    ["bandItems", candidate.bandItems],
    ["characterRanks", candidate.characters],
  ] as const)
    for (const source of rows) {
      const record = (map === "bandItems" ? data.bandItems : data.characters)[String(source.id)];
      if (!record) {
        issues.push({ kind: map, id: source.id, field: "id", code: "unknown_current_entity" });
        continue;
      }
      const value =
        map === "bandItems"
          ? (source as BoxCandidate["bandItems"][number]).level
          : ((source as BoxCandidate["characters"][number]).rank ??
            fromExp(
              data.progression.characterRanks || [],
              (source as BoxCandidate["characters"][number]).exp,
              null,
              "rank",
            ));
      if (value === null) continue;
      const allowed =
        map === "bandItems"
          ? bandItemLevelValues(data, source.id)
          : (data.progression.characterRanks || []).map((r) => Number(r.rank));
      if (!allowed.includes(value)) {
        issues.push({ kind: map, id: source.id, field: "level", code: "out_of_current_range" });
        continue;
      }
      const key = `${map}:${source.id}`,
        proposal = maps.get(key) || {
          key,
          map,
          id: source.id,
          values: [],
          existing: current[map][String(source.id)] ?? null,
        };
      if (!proposal.values.includes(value)) proposal.values.push(value);
      maps.set(key, proposal);
    }
  return {
    schema: "haneoka-box-preview-v1",
    context: { ...context },
    candidateId: candidate.id,
    original: structuredClone(current),
    cards: [...cards.values()],
    maps: [...maps.values()],
    issues,
  };
}
