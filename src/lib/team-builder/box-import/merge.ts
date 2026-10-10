import { addInventoryEntries, updateInventoryEntries, validateInventory, type InventoryV1 } from "../inventory";
import type { TeamBuilderData } from "../data";
import { BoxImportError } from "./types";
import { sameBoxContext, type BoxPreview, type BoxPracticeField, type BoxReviewContext } from "./preview";
export interface BoxConfirmation {
  /** updates: an existing value only changes when the import raises it. */
  existingValues?: "keep" | "overwrite" | "updates";
  cards: { key: string; include: boolean; fields?: Partial<Record<BoxPracticeField, number | "keep">> }[];
  maps: { key: string; include: boolean; value?: number | "keep" }[];
}
/** No persistence. Existing values/flags survive unless the user selects a supplied concrete field. */
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
    if (preview.issues.some(issue=>issue.kind===proposal.kind && issue.id===proposal.cardId)) throw new BoxImportError("box_unresolved_values");
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
        if (values.length === 1 && (confirmation.existingValues !== "updates" || !owned || before == null || values[0]! > before))
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
    const policy = confirmation.existingValues ?? "keep";
    if (choice.value === undefined && existing && policy === "keep") continue;
    const selected = choice.value ?? (proposal.values.length === 1 ? proposal.values[0] : undefined);
    if (selected === undefined || !proposal.values.includes(selected))
      throw new BoxImportError("box_conflict_required");
    if (choice.value === undefined && existing && policy === "updates" && proposal.existing !== null && selected <= proposal.existing) continue;
    next = { ...next, [proposal.map]: { ...next[proposal.map], [String(proposal.id)]: selected } };
  }
  if (!validateInventory(next, data).valid) throw new BoxImportError("box_invalid_confirmed_inventory");
  return next;
}
