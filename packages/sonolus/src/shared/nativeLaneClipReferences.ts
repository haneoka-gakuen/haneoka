// L3 — GEB
// Input: Original or expanded native skin references.
// Output: Original skin sprites and unavailable compatibility probes for the compiled clipping ABI.
// Pos: [Map](../../L2-2.md); compact native skin metadata projection.
// Effects/Dependencies: Pure metadata projection; keeps program nodes, original IDs and texture coordinates.
export { compactNativeSkinReferences, isNativeLaneClipReference } from "@haneoka/sonolus-our-notes/engine-resources";
export type { NativeSkinSpriteReference } from "@haneoka/sonolus-our-notes/engine-resources";
