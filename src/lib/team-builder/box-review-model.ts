import type { BoxConfirmation } from "./box-import/merge";
import type { BoxPreview, BoxPracticeField } from "./box-import/preview";

export interface BoxReviewField {
  field: BoxPracticeField;
  values: readonly number[];
  value: number | null;
  source: "box" | "saved" | "preset" | "conflict" | "unknown";
  /** Value/source after clearing an explicit field choice. */
  defaultValue: number | null;
  defaultSource: BoxReviewField["source"];
  requiresChoice: boolean;
}

/** A display/selection model only. The parser's preview and confirmation stay
 * intact; the native merge remains the final validation and persistence boundary.
 */
export function buildBoxImportReview(preview: BoxPreview, confirmation: BoxConfirmation) {
  let included = 0, unresolved = false;
  const cards = preview.cards.map(proposal => {
    const choice = confirmation.cards.find(value => value.key === proposal.key) ?? { key: proposal.key, include: false };
    const blocked = preview.issues.some(issue => issue.kind === proposal.kind && issue.id === proposal.cardId);
    const existing = proposal.existingInstanceId !== null;
    const keep = existing && !["overwrite", "updates"].includes(confirmation.existingValues ?? "keep");
    const fields = (proposal.kind === "members" ? ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"] : ["level", "awakening"]) as BoxPracticeField[];
    const rows: BoxReviewField[] = fields.map(field => {
      const values = proposal.values[field] ?? [], selected = choice.fields?.[field];
      const saved = keep || (existing && values.length === 0) || (confirmation.existingValues === "updates" && values.length === 1 && proposal.existing[field] != null && values[0]! < proposal.existing[field]!);
      const defaultValue = saved ? proposal.existing[field] ?? null : values.length > 1 ? null : values.length === 1 ? values[0]! : null;
      const defaultSource: BoxReviewField["source"] = saved ? "saved" : values.length > 1 ? "conflict" : values.length === 1 ? "box" : "unknown";
      return { field, values, defaultValue, defaultSource, value: selected === "keep" ? proposal.existing[field] ?? null : selected ?? defaultValue,
        source: selected === "keep" ? "saved" : selected === undefined ? defaultSource : "box",
        requiresChoice: selected === "keep" ? !existing : selected === undefined ? defaultSource === "conflict" : !values.includes(selected) };
    });
    const unknownField = Object.keys(choice.fields ?? {}).some(field => !Object.hasOwn(proposal.values, field));
    if (choice.include) { included++; if (blocked || unknownField || rows.some(row => row.requiresChoice)) unresolved = true; }
    const unchanged = existing && rows.every(row => row.values.length <= 1 && (row.values.length === 0 || row.values[0] === proposal.existing[row.field]));
    const decreases = rows.some(row => row.values.some(value => proposal.existing[row.field] != null && value < proposal.existing[row.field]!));
    return { proposal, choice, fields: rows, blocked, unchanged, decreases };
  });
  const maps = preview.maps.map(proposal => {
    const choice = confirmation.maps.find(value => value.key === proposal.key) ?? { key: proposal.key, include: false };
    const blocked = preview.issues.some(issue => issue.kind === proposal.map && issue.id === proposal.id);
    const existing = Object.hasOwn(preview.original[proposal.map], String(proposal.id));
    const keep = existing && (confirmation.existingValues === "keep" || confirmation.existingValues === undefined ||
      (confirmation.existingValues === "updates" && proposal.values.length === 1 && proposal.existing !== null && proposal.values[0]! < proposal.existing));
    const defaultValue = keep ? proposal.existing : proposal.values.length === 1 ? proposal.values[0]! : null;
    const value = choice.value === "keep" ? proposal.existing : choice.value ?? defaultValue;
    const requiresChoice = choice.value === "keep" ? !existing : choice.value === undefined && keep ? false :
      value === null || !proposal.values.includes(value);
    if (choice.include) { included++; if (blocked || requiresChoice) unresolved = true; }
    return { proposal, choice, value, defaultValue, requiresChoice, blocked, existing };
  });
  included += confirmation.modifiers?.filter(row => row.include).length ?? 0;
  return { cards, maps, included, canConfirm: included > 0 && !unresolved };
}

export function setBoxCardIncluded(confirmation: BoxConfirmation, key: string, include: boolean): BoxConfirmation {
  const cards = confirmation.cards.filter(choice => choice.key !== key);
  cards.push({ ...confirmation.cards.find(choice => choice.key === key), key, include });
  return { ...confirmation, cards };
}
export function setBoxField(confirmation: BoxConfirmation, key: string, field: BoxPracticeField, value: number | "keep" | undefined): BoxConfirmation {
  const choice = confirmation.cards.find(item => item.key === key) ?? { key, include: false };
  const fields = { ...choice.fields };
  if (value === undefined) delete fields[field]; else fields[field] = value;
  return { ...confirmation, cards: [...confirmation.cards.filter(item => item.key !== key), { ...choice, fields }] };
}
export function setBoxMap(confirmation: BoxConfirmation, key: string, patch: { include?: boolean; value?: number | "keep" }): BoxConfirmation {
  const choice = confirmation.maps.find(item => item.key === key) ?? { key, include: false };
  return { ...confirmation, maps: [...confirmation.maps.filter(item => item.key !== key), { ...choice, ...patch }] };
}
export function selectAvailableBoxItems(preview: BoxPreview, confirmation: BoxConfirmation, include: boolean): BoxConfirmation {
  const model = buildBoxImportReview(preview, confirmation);
  return {
    ...confirmation,
    cards: model.cards.map(row => ({ ...row.choice, include: include && !row.blocked })),
    maps: model.maps.map(row => ({ ...row.choice, include: include && !row.blocked })),
  };
}

/** Apply a default to reviewed existing entries without changing inclusion or new-card choices. */
export function setBoxExistingValues(preview: BoxPreview, confirmation: BoxConfirmation, existingValues: "keep" | "overwrite" | "updates"): BoxConfirmation {
  return {
    ...confirmation,
    existingValues,
    cards: confirmation.cards.map(choice => preview.cards.find(card => card.key === choice.key)?.existingInstanceId != null
      ? { ...choice, fields: undefined } : choice),
    maps: confirmation.maps.map(choice => {
      const map = preview.maps.find(proposal => proposal.key === choice.key);
      return map && Object.hasOwn(preview.original[map.map], String(map.id)) ? { ...choice, value: undefined } : choice;
    }),
  };
}
