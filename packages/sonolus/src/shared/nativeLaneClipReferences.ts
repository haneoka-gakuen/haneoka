// L3 — GEB
// Input: Original or expanded native skin references.
// Output: Original skin sprites and unavailable compatibility probes for the compiled clipping ABI.
// Pos: [Map](../../L2-2.md); compact native skin metadata projection.
// Effects/Dependencies: Pure metadata projection; keeps program nodes, original IDs and texture coordinates.
export interface NativeSkinSpriteReference { name: string; id: number }
const CLIP_REFERENCE = / Lane Clip (\d+)$/u;
const COMPATIBILITY_PROBE = "Haneoka Lane Clip Compatibility Probe";

export function isNativeLaneClipReference(name: string): boolean {
  return CLIP_REFERENCE.test(name);
}

export function compactNativeSkinReferences<T extends NativeSkinSpriteReference>(sprites: readonly T[]): T[] {
  return sprites.flatMap(sprite => {
    const alias = CLIP_REFERENCE.exec(sprite.name);
    if (!alias) return [sprite];
    // Only node 2 is queried before the compiled engine selects its no-slice path.
    return alias[1] === "2" ? [{ ...sprite, name: COMPATIBILITY_PROBE }] : [];
  });
}
