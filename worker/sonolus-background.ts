// L3 — GEB
// Input: Pinned lightweight stage and song jacket PNGs.
// Output: The authored lightweight composite at its steady gameplay scale.
// Pos: [Map](L2.md); Sonolus catalog background image adapter.
// Effects/Dependencies: Uses the shared Our Notes compositor and a bounded PNG encoder.
export { composeSonolusSongBackground, sonolusSongBackgroundAspect } from "../packages/sonolus/src/shared/sonolusBackgroundImage";
export const sonolusSongBackgroundVersion = 2;
export const sonolusSongBackgroundImageRevision = 3;
export const sonolusSongBackgroundPath = /^\/sonolus\/backgrounds\/(haneoka-jacket-(jp|intl)-(r-[a-f0-9]{20})-([1-9]\d{0,15}))(?:\/(image|data|configuration))?$/u;
