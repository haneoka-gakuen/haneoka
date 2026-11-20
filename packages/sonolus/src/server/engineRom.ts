// L3 — GEB
// Input: Compiled engine facets, their ROM and reachable lane-clip metadata rules.
// Output: Engine resources with unchanged programs and compact skin references.
// Pos: [Map](../../L2-2.md); shared engine resource loader for both hosts.
// Effects/Dependencies: Reads artifacts, filters unused virtual references and gzip-encodes metadata.
export { loadEngineResources, referencesEngineRom } from "@haneoka/sonolus-our-notes/engine-resources";
