// L3 — GEB
// Input: Public native-stage projection version and source/output identities.
// Output: Shared browser and Worker chart-assets contracts.
// Pos: [Map](../../L2.md); transport-free native-stage API types.
// Effects/Dependencies: Type declarations and a constant; no browser or platform bindings.
export const HANEOKA_CHART_ASSETS_PROJECTION = 5;
export interface HaneokaChartAssetOutput {
  readonly objectId?: string | number;
  readonly type: string;
  readonly path: string;
  readonly serializedFile?: string;
}
export interface HaneokaChartAssetSource {
  readonly sourcePath: string;
  readonly outputs: readonly HaneokaChartAssetOutput[];
  readonly runtimeObjects: readonly { readonly type: string; readonly path: string }[];
  readonly serializedFile?: string;
  readonly runtimeProjectionPolicy?: string;
  readonly preloadObjectReferences?: readonly { readonly serializedFile: string; readonly pathId: string }[];
}
export interface HaneokaChartAssets {
  readonly schema: "haneoka-chart-assets-v1";
  readonly identity: { readonly server: string; readonly releaseId: string; readonly sourceId: string };
  readonly files: readonly string[];
  readonly sources: Readonly<Record<string, HaneokaChartAssetSource>>;
}
