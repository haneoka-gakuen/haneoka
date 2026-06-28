export const STORY_PROJECT_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type StorySourceFormat = "adv-json" | "webgal" | "project-json" | "unknown" | (string & {});

export interface StorySourceLocation {
  format: StorySourceFormat;
  raw?: string;
  line?: number;
  command?: string;
  arguments?: JsonObject;
}

/**
 * The numeric opcode is deliberately separate from `fields`. `fields` is an
 * open JSON object so new player fields and localized arrays survive edits and
 * project saves without changing the canonical project version.
 */
export interface StoryProjectCommand {
  id: string;
  command: number | null;
  fields: JsonObject;
  source?: StorySourceLocation;
  extensions: JsonObject;
}

export interface StoryScene {
  id: string;
  name: string;
  commands: StoryProjectCommand[];
  /** Scene-specific authoring data that is not part of the compiled AdvStory. */
  extensions: JsonObject;
}

export interface StoryProjectMeta {
  title: string;
  description?: string;
  locale?: string;
  assetServer?: string;
  tags?: string[];
  provenance?: JsonObject;
  extra?: JsonObject;
}

export interface StoryProject {
  version: typeof STORY_PROJECT_VERSION;
  meta: StoryProjectMeta;
  entrySceneId: string;
  scenes: StoryScene[];
  /** Current Haneoka AdvStory resource snapshot, retained losslessly as JSON. */
  assets: JsonObject;
  /** Current Haneoka runtime snapshot, retained losslessly as JSON. */
  runtime: JsonObject;
  /** Unknown top-level fields from an imported AdvStory. */
  storyFields: JsonObject;
  /** Editor/adapter data. External formats must not silently discard this. */
  extensions: JsonObject;
}

const safeIdPart = (value: string | number): string =>
  String(value)
    .normalize("NFKC")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";

/** Stable ID for the same imported source and source position. */
export const importedStoryId = (format: string, ...parts: Array<string | number>): string =>
  [safeIdPart(format), ...parts.map(safeIdPart)].join("-");

/** ID for a newly authored scene or command. */
export const createStoryId = (prefix = "item"): string => {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("crypto.randomUUID is required to create story IDs");
  }
  return `${safeIdPart(prefix)}-${globalThis.crypto.randomUUID()}`;
};

export const cloneStoryValue = <T>(value: T): T => {
  const clone = (globalThis as { structuredClone?: <V>(input: V) => V }).structuredClone;
  if (clone) {
    try {
      return clone(value);
    } catch {
      // Vue exposes objects stored in `ref()` as proxies. They are still valid
      // JSON authoring data, but the platform structured clone algorithm
      // rejects the proxy wrapper. Fall through to the property-wise clone so
      // IndexedDB autosave always receives plain data.
    }
  }
  if (Array.isArray(value)) return value.map((item) => cloneStoryValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneStoryValue(item)]),
    ) as T;
  }
  return value;
};

export const createEmptyStoryProject = (meta: Partial<StoryProjectMeta> = {}): StoryProject => ({
  version: STORY_PROJECT_VERSION,
  meta: {
    title: meta.title ?? "",
    ...(meta.description === undefined ? {} : { description: meta.description }),
    ...(meta.locale === undefined ? {} : { locale: meta.locale }),
    ...(meta.assetServer === undefined ? {} : { assetServer: meta.assetServer }),
    ...(meta.tags === undefined ? {} : { tags: [...meta.tags] }),
    ...(meta.provenance === undefined ? {} : { provenance: cloneStoryValue(meta.provenance) }),
    ...(meta.extra === undefined ? {} : { extra: cloneStoryValue(meta.extra) }),
  },
  entrySceneId: "scene-main",
  scenes: [{ id: "scene-main", name: "Main", commands: [], extensions: {} }],
  assets: {},
  runtime: {},
  storyFields: {},
  extensions: {},
});

export const findStoryScene = (project: StoryProject, sceneId = project.entrySceneId): StoryScene | undefined =>
  project.scenes.find((scene) => scene.id === sceneId);
