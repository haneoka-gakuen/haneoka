import type { AdvStory } from "@haneoka/vega/engine";
import type { EmbedLoader } from "@haneoka/embed-core";

// Document resource fields, including the standard character provider tuple.
// Text, opcode parameters, IDs and source provenance remain authored values.
const urls = new Set([
  "url",
  "src",
  "playableUrl",
  "imageUrl",
  "image",
  "model",
  "modelUrl",
  "model3Json",
  "moc",
  "moc3",
  "physics",
  "pose",
  "userData",
  "atlas",
  "skel",
  "skeleton",
  "textureUrl",
  "texture",
  "maskTexture",
  "defaultDataRoot",
  "modelSource",
  "manifestSource",
  "mocSource",
  "physicsSource",
  "poseSource",
  "userDataSource",
]);
const maps = new Set([
  "compressedTextureVariants",
  "iconImagesByAsset",
  "sprites",
  "uiSprites",
  "textures",
  "dataRootsByWindowAsset",
]);
const urlArrays = new Set(["textures", "pptrTextures"]);

/** Collect without cloning: shared records remain intact until preparation finishes. */
export function collectPlaybackUrls(story: AdvStory, signal: AbortSignal): Set<string> {
  const keys = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown, field = ""): void => {
    signal.throwIfAborted();
    if (typeof value === "string") {
      if (field === "playableUrl" && value) keys.add(value);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    } else {
      for (const [key, entry] of Object.entries(value)) visit(entry, key);
    }
  };
  visit(story);
  return keys;
}

/** Clone resource fields and preserve shared model identity across commands. */
export async function resolveStoryUrls(
  story: AdvStory,
  loader: EmbedLoader<AdvStory>,
  signal: AbortSignal,
  playbackUrl?: (key: string) => Promise<string>,
  modelUrl?: (key: string) => Promise<string>,
  inspectModel?: (record: Record<string, unknown>) => void,
): Promise<AdvStory> {
  const seen = new WeakMap<object, unknown>();
  const resolve = (value: string) => (value ? loader.resourceUrl(value, { signal }) : Promise.resolve(value));
  const visit = async (value: unknown, field = "", parent = "", mapValue = false): Promise<unknown> => {
    signal.throwIfAborted();
    if (typeof value === "string") {
      if (modelUrl && ["model", "modelUrl", "model3Json"].includes(field)) return modelUrl(value);
      if (
        urls.has(field) ||
        (field === "json" && parent === "runtime") ||
        (field === "source" && ["fonts", "motions", "expressions", "textureVariants"].includes(parent)) ||
        (field === "runtime" && ["motions", "expressions"].includes(parent)) ||
        mapValue
      )
        return field === "playableUrl" && playbackUrl ? playbackUrl(value) : resolve(value);
      return value;
    }
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      seen.set(value, output);
      for (const item of value) output.push(await visit(item, "", field, urlArrays.has(field)));
      return output;
    }
    if (field === "windowRectsByDataRoot") {
      const output: Record<string, unknown> = {};
      seen.set(value, output);
      for (const [key, entry] of Object.entries(value)) output[await resolve(key)] = entry;
      return output;
    }
    const output: Record<string, unknown> = Object.create(null);
    seen.set(value, output);
    const record = value as Record<string, unknown>;
    inspectModel?.(record);
    for (const [key, entry] of Object.entries(record)) {
      // Array elements carry their declaration kind into the resource record.
      // Map values can be URLs; nested record fields keep their own semantics.
      output[key] = await visit(entry, key, field || parent, maps.has(field) || (key === "json" && !!record.atlas));
    }
    return output;
  };
  return (await visit(story)) as AdvStory;
}
