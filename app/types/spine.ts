/** Public, release-scoped Spine catalog contracts. */
export interface SpineResource {
  url?: string;
  path?: string;
  sourcePath?: string;
  sourcePathKey?: string;
  name?: string;
  pma?: boolean;
}

export interface SpineAtlas {
  atlas?: SpineResource;
  pages?: SpineResource[];
}

export interface SpinePreview {
  status?: "rendered" | "unavailable" | string;
  /** Versioned policy proving this is a current static setup-pose capture. */
  schema?: string;
  url?: string;
  /** Content fingerprint used to separate browser caches across releases. */
  sha256?: string;
  width?: number;
  height?: number;
  renderer?: string;
  reason?: string | Record<string, unknown>;
  /** Provenance for a non-animated Spine setup-pose screenshot. */
  pose?: {
    kind?: "setup" | string;
    animationApplied?: boolean;
    animationStateAdvanced?: boolean;
    physics?: "none" | string;
    /** Present for previews whose static setup visibility is explicitly front-facing. */
    facing?: "front" | string;
  };
}

export interface SpineRuntime {
  status?: "ready" | "unavailable" | string;
  format?: "json" | string;
  package?: string;
  packageVersion?: string;
  runtimeSeries?: string;
  loader?: string;
  scale?: number;
  atlas?: SpineResource;
  json?: SpineResource;
  reason?: string | Record<string, unknown>;
}

export interface SpineModel {
  id: string;
  /** Exact raw Unity SkeletonDataAsset.m_Name behind the shortened route ID. */
  resourceKey?: string;
  status?: "available" | "unavailable" | string;
  reason?: string | Record<string, unknown>;
  family?: string;
  sourcePathKey?: string;
  spineVersion?: string;
  scale?: number;
  animations?: string[];
  animationCount?: number;
  skins?: string[];
  skinCount?: number;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  preview?: SpinePreview;
  runtime?: SpineRuntime;
  atlases?: SpineAtlas[];
}

export interface SpineCatalog {
  schema: string;
  /** Present only when rendered previews use the current static-preview policy. */
  previewSchema?: string;
  server: string;
  sourceId: string;
  available: boolean;
  status?: string;
  reason?: string;
  counts?: {
    models?: number;
    playableModels?: number;
    unavailableModels?: number;
    renderedPreviews?: number;
    unavailablePreviews?: number;
  };
  models?: Record<string, SpineModel>;
  modelOrder?: string[];
  unavailableModels?: Record<string, SpineModel>;
  unavailableModelOrder?: string[];
  runtime?: SpineRuntime & { preview?: SpinePreview };
}
