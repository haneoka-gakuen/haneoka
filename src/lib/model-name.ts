// Input: Live2D catalog records and stable model identifiers.
// Output: Complete display names and matching alphabetical sort keys.
// Pos: [Map](L2-2.md); shared model naming for prerendered pages and viewers.
type Model = Record<string, unknown>;
const identifiers = new Intl.Collator("en", { numeric: true });

export function live2dModelName(model: Model): unknown {
  const live = /^\d+_live-mode_(.+)$/u.exec(String(model.live2dKey || ""));
  return live ? `live_${live[1]}` : model.title || model.live2dName || model.characterName || model.live2dKey || "";
}

export function live2dModelSortKey(key: string): string {
  return key.replace("_live-mode_", "_live_");
}

export function compareLive2dModelKeys(left: string, right: string): number {
  return identifiers.compare(live2dModelSortKey(left), live2dModelSortKey(right));
}
