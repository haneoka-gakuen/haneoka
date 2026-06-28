export interface StoryJsonDraftBase {
  /** Deterministic project JSON at the moment editing began. */
  snapshot: string;
  /** Monotonic editor revision at the moment editing began. */
  revision: number;
}

export type StoryJsonDraftConflict = "missing-base" | "project-changed" | "scene-draft-orphaned";

export const storyJsonDraftBaseForValue = (
  existing: StoryJsonDraftBase | undefined,
  baseline: string,
  nextValue: string,
  revision: number,
): StoryJsonDraftBase | undefined => {
  if (nextValue === baseline) return undefined;
  return existing ?? { snapshot: baseline, revision };
};

export const storyJsonDraftConflict = (options: {
  base?: StoryJsonDraftBase;
  currentSnapshot: string;
  currentRevision: number;
  nextSceneIds?: readonly string[];
  sceneDraftIds?: readonly string[];
}): StoryJsonDraftConflict | undefined => {
  if (!options.base) return "missing-base";
  if (options.currentRevision !== options.base.revision || options.currentSnapshot !== options.base.snapshot) {
    return "project-changed";
  }
  if (options.nextSceneIds && options.sceneDraftIds?.length) {
    const nextSceneIds = new Set(options.nextSceneIds);
    if (options.sceneDraftIds.some((sceneId) => !nextSceneIds.has(sceneId))) return "scene-draft-orphaned";
  }
  return undefined;
};

export const hasPendingStoryCodeDrafts = (projectCodeDirty: boolean, sceneDraftIds: readonly string[]): boolean =>
  projectCodeDirty || sceneDraftIds.length > 0;

export const reconcileStorySceneCodeDraft = <Context>(options: {
  sceneId: string;
  baseline: string;
  drafts: Readonly<Record<string, string>>;
  contexts: Readonly<Record<string, Context>>;
}): { value: string; drafts: Record<string, string>; contexts: Record<string, Context> } => {
  const draft = options.drafts[options.sceneId];
  if (draft !== options.baseline) {
    return { value: draft ?? options.baseline, drafts: { ...options.drafts }, contexts: { ...options.contexts } };
  }
  const { [options.sceneId]: _draft, ...drafts } = options.drafts;
  const { [options.sceneId]: _context, ...contexts } = options.contexts;
  return { value: options.baseline, drafts, contexts };
};
