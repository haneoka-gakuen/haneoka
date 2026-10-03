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
    const fields = (proposal.kind === "members" ? ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"] : ["level", "awakening"]) as BoxPracticeField[];
    const rows: BoxReviewField[] = fields.map(field => {
      const values = proposal.values[field] ?? [], selected = choice.fields?.[field];
      const preset = proposal.defaultPractice?.[field];
      const defaultValue = existing ? proposal.existing[field] ?? null : values.length > 1 ? null : values.length === 1 ? values[0]! : preset ?? null;
      const defaultSource: BoxReviewField["source"] = existing ? "saved" : values.length > 1 ? "conflict" : values.length === 1 ? "box" : preset === undefined ? "unknown" : "preset";
      return { field, values, defaultValue, defaultSource, value: selected ?? defaultValue,
        source: selected === undefined ? defaultSource : "box",
        requiresChoice: selected === undefined ? defaultSource === "conflict" : !values.includes(selected) };
    });
    const unknownField = Object.keys(choice.fields ?? {}).some(field => !Object.hasOwn(proposal.values, field));
    if (choice.include) { included++; if (blocked || unknownField || rows.some(row => row.requiresChoice)) unresolved = true; }
    return { proposal, choice, fields: rows, blocked };
  });
  const maps = preview.maps.map(proposal => {
    const choice = confirmation.maps.find(value => value.key === proposal.key) ?? { key: proposal.key, include: false };
    const blocked = preview.issues.some(issue => issue.kind === proposal.map && issue.id === proposal.id);
    const defaultValue = proposal.values.length === 1 ? proposal.values[0]! : null;
    const value = choice.value ?? defaultValue;
    const requiresChoice = value === null || !proposal.values.includes(value);
    if (choice.include) { included++; if (blocked || requiresChoice) unresolved = true; }
    return { proposal, choice, value, defaultValue, requiresChoice, blocked };
  });
  return { cards, maps, included, canConfirm: included > 0 && !unresolved };
}

export function setBoxCardIncluded(confirmation: BoxConfirmation, key: string, include: boolean): BoxConfirmation {
  const cards = confirmation.cards.filter(choice => choice.key !== key);
  cards.push({ ...confirmation.cards.find(choice => choice.key === key), key, include });
  return { ...confirmation, cards };
}
export function setBoxField(confirmation: BoxConfirmation, key: string, field: BoxPracticeField, value: number | undefined): BoxConfirmation {
  const choice = confirmation.cards.find(item => item.key === key) ?? { key, include: false };
  const fields = { ...choice.fields };
  if (value === undefined) delete fields[field]; else fields[field] = value;
  return { ...confirmation, cards: [...confirmation.cards.filter(item => item.key !== key), { ...choice, fields }] };
}
export function setBoxMap(confirmation: BoxConfirmation, key: string, patch: { include?: boolean; value?: number }): BoxConfirmation {
  const choice = confirmation.maps.find(item => item.key === key) ?? { key, include: false };
  return { ...confirmation, maps: [...confirmation.maps.filter(item => item.key !== key), { ...choice, ...patch }] };
}
export function selectAvailableBoxItems(preview: BoxPreview, confirmation: BoxConfirmation, include: boolean): BoxConfirmation {
  const model = buildBoxImportReview(preview, confirmation);
  return {
    cards: model.cards.map(row => ({ ...row.choice, include: include && !row.blocked })),
    maps: model.maps.map(row => ({ ...row.choice, include: include && !row.blocked })),
  };
}
