// Input: Live2D catalog records and stable model identifiers.
// Output: Model names without their character prefix and natural identifier order.
// Pos: [Map](L2-2.md); shared model naming for prerendered pages and viewers.
type Model = Record<string, unknown>;
const identifiers = new Intl.Collator("en", { numeric: true });

export function live2dModelName(model: Model): string {
  const key = String(model.live2dKey ?? "");
  const character = String(model.characterKey ?? "");
  if (character && key.startsWith(`${character}_`)) return key.slice(character.length + 1);
  return key || String(model.live2dName ?? "");
}

export function compareLive2dModelKeys(left: string, right: string): number {
  return identifiers.compare(left, right);
}
