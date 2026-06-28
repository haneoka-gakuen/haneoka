import { isRecord, parseBestdoriJson, type BestdoriInput } from "./input.js";
import type { BestdoriServer } from "./transport.js";

export interface BestdoriBuildDataFile {
  bundleName?: string;
  fileName?: string;
}

export interface BestdoriBuildData {
  Base?: {
    model?: BestdoriBuildDataFile;
    physics?: BestdoriBuildDataFile;
    textures?: BestdoriBuildDataFile[];
    motions?: BestdoriBuildDataFile[];
    expressions?: BestdoriBuildDataFile[];
    transition?: BestdoriBuildDataFile;
  };
}

export interface BestdoriBundlePathOptions {
  /** Bestdori's public model/motion files omit Unity's `.bytes` suffix. */
  removeBytesSuffix?: boolean;
  /** Texture references occasionally omit their public `.png` suffix. */
  ensurePngSuffix?: boolean;
}

export interface BestdoriLive2dContext {
  server: BestdoriServer | string;
  proxify: (rawBestdoriPath: string) => string;
  characterId?: number;
}

export interface BestdoriLive2dMotion {
  name: string;
  runtime: string;
}

export interface BestdoriLive2dProfile extends Record<string, unknown> {
  defaultMotionName?: string;
  presentationFadeInSeconds: number;
  playDefaultMotionBeforePresentation: boolean;
  preservePresentationOnHide: boolean;
  basePosition: { x: number; y: number; z: number };
  baseScale: number;
}

export interface BestdoriLive2dRuntime extends Record<string, unknown> {
  format: "cubism2";
  model: string;
  moc: string;
  physics: string;
  textures: string[];
  motions?: BestdoriLive2dMotion[];
  expressions?: BestdoriLive2dMotion[];
}

/** Source-neutral Live2D resource shape consumed by story and catalog hosts. */
export interface BestdoriLive2dEntry extends Record<string, unknown> {
  profile: BestdoriLive2dProfile;
  runtime: BestdoriLive2dRuntime;
  characterId?: number;
}

const createLive2dProfile = (): BestdoriLive2dProfile => ({
  basePosition: { x: 0, y: 0, z: 0 },
  baseScale: 1,
  presentationFadeInSeconds: -1,
  playDefaultMotionBeforePresentation: true,
  preservePresentationOnHide: true,
});

const buildData = (input: BestdoriInput): BestdoriBuildData => {
  const value = parseBestdoriJson(input, "Bestdori Live2D buildData");
  return isRecord(value) ? (value as BestdoriBuildData) : {};
};

/** Resolve a Unity bundle/file pair to Bestdori's public raw asset path. */
export const resolveBundlePath = (
  server: BestdoriServer | string,
  file?: BestdoriBuildDataFile,
  options: BestdoriBundlePathOptions = {},
): string => {
  if (!file?.bundleName || !file.fileName) return "";
  const segments = file.bundleName.split("/").filter(Boolean);
  if (!segments.length) return "";
  segments[segments.length - 1] = `${segments[segments.length - 1]}_rip`;
  let fileName = file.fileName;
  if (options.removeBytesSuffix && fileName.endsWith(".bytes")) fileName = fileName.slice(0, -6);
  if (options.ensurePngSuffix && !fileName.includes(".")) fileName = `${fileName}.png`;
  return `/assets/${server}/${segments.join("/")}/${fileName}`;
};

/** The optional transition asset contains the authored idle/default motion. */
export const bestdoriBuildDataTransitionPath = (input: BestdoriInput, server: BestdoriServer | string): string => {
  const transition = buildData(input).Base?.transition;
  if (!transition?.fileName) return "";
  return resolveBundlePath(server, {
    ...transition,
    fileName: transition.fileName.endsWith(".asset") ? transition.fileName : `${transition.fileName}.asset`,
  });
};

/** Convert Cubism 2 `buildData.asset` into a host-neutral Live2D resource entry. */
export const bestdoriBuildDataToLive2dEntry = (
  input: BestdoriInput,
  ctx: BestdoriLive2dContext,
): BestdoriLive2dEntry | null => {
  const base = buildData(input).Base;
  if (!base?.model) return null;
  const file = (value?: BestdoriBuildDataFile, options?: BestdoriBundlePathOptions): string => {
    const raw = resolveBundlePath(ctx.server, value, options);
    return raw ? ctx.proxify(raw) : "";
  };
  const runtime: BestdoriLive2dRuntime = {
    format: "cubism2",
    model: "",
    moc: file(base.model, { removeBytesSuffix: true }),
    physics: file(base.physics),
    // Texture numbers are authored into the MOC. Keep empty/malformed slots in
    // place so a missing texture 1 never shifts texture 2 onto the wrong atlas.
    textures: (base.textures ?? []).map((item) => file(item, { ensurePngSuffix: true })),
  };
  const motions = (base.motions ?? [])
    .map((item) => {
      const runtime = file(item, { removeBytesSuffix: true });
      const name = (item.fileName ?? "").replace(/\.mtn(\.bytes)?$/i, "");
      return runtime ? { name, runtime } : null;
    })
    .filter((item): item is BestdoriLive2dMotion => Boolean(item));
  const expressions = (base.expressions ?? [])
    .map((item) => {
      const runtime = file(item);
      const name = (item.fileName ?? "").replace(/\.(exp3?\.asset\.json|exp\.json)$/i, "");
      return runtime ? { name, runtime } : null;
    })
    .filter((item): item is BestdoriLive2dMotion => Boolean(item));
  if (motions.length) runtime.motions = motions;
  if (expressions.length) runtime.expressions = expressions;
  const entry: BestdoriLive2dEntry = {
    profile: createLive2dProfile(),
    runtime,
  };
  if (ctx.characterId !== undefined) entry.characterId = ctx.characterId;
  return entry;
};
