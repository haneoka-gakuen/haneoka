export type StoryResourceKind = "background" | "still" | "sound" | "frame" | "effect" | "video" | "live2d";

const identity = (value: unknown): string => String(value ?? "").trim();

/**
 * Every semantic identity accepted by story hydration for one authored asset.
 * Validation and playback must use this same list: otherwise a reference can
 * be playable while the editor incorrectly reports it as missing.
 */
export const storyResourceAliases = (
  kind: StoryResourceKind,
  entry: Readonly<Record<string, unknown>>,
): readonly string[] => {
  const common = [entry.resourceRef, entry.id, entry.assetId, entry.sourcePath, entry.url];
  let values: unknown[];

  switch (kind) {
    case "background":
      values = [entry.assetName, entry.stageRef, ...common];
      break;
    case "still":
      values = [entry.assetName, ...common];
      break;
    case "sound": {
      const cueSheet = identity(entry.cueSheetName);
      const cue = identity(entry.cueName);
      values = [
        entry.resourceRef,
        cueSheet && cue ? `${cueSheet}/${cue}` : "",
        entry.soundId,
        entry.id,
        entry.originalId,
        entry.assetId,
        entry.cueName,
        entry.cueSheetName,
        entry.runtimePath,
        entry.sourcePath,
        entry.url,
      ];
      break;
    }
    case "frame":
    case "effect":
      values = [entry.assetName, entry.name, ...common];
      break;
    case "video":
      values = [
        entry.resourceRef,
        entry.videoId,
        entry.id,
        entry.assetId,
        entry.assetName,
        entry.sourcePath,
        entry.url,
      ];
      break;
    case "live2d":
      values = [
        entry.live2dKey,
        entry.characterKey,
        entry.assetName,
        entry.resourceRef,
        entry.id,
        entry.assetId,
        entry.sourcePath,
        entry.url,
      ];
      break;
  }

  return [...new Set(values.map(identity).filter(Boolean))];
};
