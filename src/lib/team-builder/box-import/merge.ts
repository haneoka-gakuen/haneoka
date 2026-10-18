import {
  addInventoryEntries,
  updateInventoryEntries,
  validateInventory,
  upgradeInventory,
  type InventoryV1,
} from "../inventory";
import type { TeamBuilderData } from "../data";
import { BoxImportError } from "@haneoka/game-data-exporter";
import { sameBoxContext, type BoxPreview, type BoxPracticeField, type BoxReviewContext } from "./preview";
export interface BoxConfirmation {
  ownership?: "merge" | "replace";
  /** Existing-card fields only; account bonuses use their individual map choices. */
  existingValues?: "keep" | "overwrite" | "updates";
  cards: { key: string; include: boolean; fields?: Partial<Record<BoxPracticeField, number | "keep">> }[];
  maps: { key: string; include: boolean; value?: number | "keep" }[];
  scalars?: { key: "vipRank"; include: boolean; value?: number | "keep" }[];
}
/** Pure merge: card defaults and individual account-bonus choices remain independent. */
export function applyConfirmedBoxImport(
  current: InventoryV1,
  preview: BoxPreview,
  confirmation: BoxConfirmation,
  data: TeamBuilderData,
  context: BoxReviewContext,
): InventoryV1 {
  if (
    !sameBoxContext(context, data) ||
    !["ownerId", "revision", "server", "releaseId", "sourceId"].every(
      (key) => context[key as keyof BoxReviewContext] === preview.context[key as keyof BoxReviewContext],
    ) ||
    JSON.stringify(current) !== JSON.stringify(preview.original)
  )
    throw new BoxImportError("box_review_changed");
  let next = structuredClone(current);
  const seen = new Set<string>();
  for (const choice of confirmation.cards) {
    if (seen.has(choice.key)) throw new BoxImportError("box_duplicate_confirmation");
    seen.add(choice.key);
    const proposal = preview.cards.find((r) => r.key === choice.key);
    if (!proposal) throw new BoxImportError("box_unknown_confirmation");
    if (!choice.include) continue;
    if (preview.issues.some((issue) => issue.kind === proposal.kind && issue.id === proposal.cardId))
      throw new BoxImportError("box_unresolved_values");
    const owned = next[proposal.kind].find((r) => r.cardId === proposal.cardId);
    if (!owned) next = addInventoryEntries(next, proposal.kind, [{ cardId: proposal.cardId }], data);
    const entry = next[proposal.kind].find((r) => r.cardId === proposal.cardId)!;
    const fields: Record<string, number> = {};
    for (const [field, values] of Object.entries(proposal.values) as [BoxPracticeField, number[]][]) {
      const selected = choice.fields?.[field];
      if (selected === "keep") {
        if (!owned) throw new BoxImportError("box_unconfirmed_value");
      } else if (selected !== undefined) {
        if (!values.includes(selected)) throw new BoxImportError("box_unconfirmed_value");
        fields[field] = selected;
      } else if (!owned || confirmation.existingValues === "overwrite" || confirmation.existingValues === "updates") {
        if (values.length > 1) throw new BoxImportError("box_conflict_required");
        const before = proposal.existing[field];
        if (
          values.length === 1 &&
          (confirmation.existingValues !== "updates" || !owned || before == null || values[0]! > before)
        )
          fields[field] = values[0]!;
      }
    }
    if (Object.keys(choice.fields || {}).some((field) => !Object.hasOwn(proposal.values, field)))
      throw new BoxImportError("box_unconfirmed_value");
    next = updateInventoryEntries(next, proposal.kind, [entry.instanceId], fields);
  }
  seen.clear();
  for (const choice of confirmation.maps) {
    if (seen.has(choice.key)) throw new BoxImportError("box_duplicate_confirmation");
    seen.add(choice.key);
    const proposal = preview.maps.find((r) => r.key === choice.key);
    if (!proposal) throw new BoxImportError("box_unknown_confirmation");
    if (!choice.include) continue;
    const existing = Object.hasOwn(preview.original[proposal.map], String(proposal.id));
    if (choice.value === "keep") {
      if (!existing) throw new BoxImportError("box_unconfirmed_value");
      continue;
    }
    const selected = choice.value ?? (proposal.values.length === 1 ? proposal.values[0] : undefined);
    if (selected === undefined || !proposal.values.includes(selected))
      throw new BoxImportError("box_conflict_required");
    next = { ...next, [proposal.map]: { ...next[proposal.map], [String(proposal.id)]: selected } };
  }
  seen.clear();
  for (const choice of confirmation.scalars ?? []) {
    if (seen.has(choice.key)) throw new BoxImportError("box_duplicate_confirmation");
    seen.add(choice.key);
    const proposal = preview.scalars?.find((row) => row.key === choice.key);
    if (!proposal) throw new BoxImportError("box_unknown_confirmation");
    if (!choice.include) continue;
    if (proposal.blocked) throw new BoxImportError("box_unresolved_values");
    if (choice.value === "keep") {
      if (!proposal.exists) throw new BoxImportError("box_unconfirmed_value");
      continue;
    }
    const value = choice.value ?? (proposal.values.length === 1 ? proposal.values[0] : undefined);
    if (value === undefined || !proposal.values.includes(value)) throw new BoxImportError("box_conflict_required");
    const upgraded = upgradeInventory(next);
    next = { ...upgraded, playerModifiers: { ...upgraded.playerModifiers, [proposal.key]: value } };
  }
  if (confirmation.ownership === "replace") {
    const selected = new Set(confirmation.cards.filter((choice) => choice.include).map((choice) => choice.key));
    if (!preview.cards.some((card) => selected.has(card.key))) throw new BoxImportError("box_unresolved_values");
    for (const kind of ["members", "snapshots"] as const) {
      const ids = new Set(
        preview.cards.filter((card) => card.kind === kind && selected.has(card.key)).map((card) => card.cardId),
      );
      next = { ...next, [kind]: next[kind].filter((card) => ids.has(card.cardId)) };
    }
  }
  if (!validateInventory(next, data).valid) throw new BoxImportError("box_invalid_confirmed_inventory");
  return next;
}
