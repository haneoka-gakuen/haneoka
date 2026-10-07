/**
 * Intrinsic sizes of artwork, known before the bytes arrive.
 *
 * A page can only reserve the right box for an image if it knows the image's
 * shape at first paint. Sizing a frame from `naturalWidth` after the load
 * event — what tiles and the gallery used to do — moves everything below it
 * once per image, which on a story collection is the whole grid, repeatedly.
 *
 * Two sources, both available synchronously at render time:
 *
 *   1. Families. The catalogue payloads carry asset paths, not dimensions,
 *      but every family of game artwork is exported at one fixed size, so the
 *      path identifies the size. Each entry was read from the PNG headers of
 *      the released assets.
 *   2. Memory. Artwork outside those families (scene backgrounds vary) is
 *      measured when it loads and remembered in localStorage. The memory is
 *      snapshotted when this module loads and never changes within a page
 *      session, so a frame keeps the size it was first drawn with; the
 *      measurement only benefits the next visit.
 *
 * Callers that get `undefined` must keep a fixed frame and fit the image
 * inside it. They must never resize a frame after its image loads.
 */
export interface ImageSize {
  width: number;
  height: number;
}

const FAMILIES: ReadonlyArray<readonly [RegExp, ImageSize]> = [
  [/\/Gacha\/Banner\/gacha_banner_/u, { width: 420, height: 180 }],
  [/\/Gacha\/Logo\/gacha_logo_/u, { width: 460, height: 240 }],
  [/\/Image\/Event\/[^/]+\/Top\/event_top_/u, { width: 1920, height: 1440 }],
  [/\/Image\/Event\/[^/]+\/Logo\/event_logo_/u, { width: 460, height: 240 }],
  [/\/Story\/Banner\/Chapter\/ui_banner_chapter_/u, { width: 420, height: 180 }],
  [/\/Story\/Banner\/Episode\/ui_banner_storyfriend_/u, { width: 370, height: 160 }],
  [/\/Story\/Banner\/Episode\/ui_banner_chapter_/u, { width: 490, height: 160 }],
  [/\/Story\/Image\/Episode\/ui_image_chapter_/u, { width: 1024, height: 768 }],
  [/\/Story\/Image\/Chapter\/ui_image_chapter_/u, { width: 1564, height: 1268 }],
  [/\/Story\/Icon\/ui_icon_chapter_event_/u, { width: 460, height: 240 }],
  [/\/Story\/Icon\/ui_icon_chapter_/u, { width: 750, height: 290 }],
  [/\/Adv\/Still\/[^/]+\/adv_still_/u, { width: 1920, height: 1080 }],
  [/\/Character\/Image\/[^/]+\/character_thumbnail/u, { width: 270, height: 740 }],
  [/\/Character\/Image\/[^/]+\/character_face_icon/u, { width: 256, height: 256 }],
];

const STORAGE_KEY = "haneoka.image-sizes.v1";
const MEMORY_LIMIT = 1500;

/** A stable key: the asset path without origin, release query or locale suffix. */
const keyOf = (source: string) => {
  const path = (source.split("?")[0] || source).replace(/^https?:\/\/[^/]+/u, "");
  return path.replace(/\((?:en|ko|ja|zh-Hant|zh-Hans)\)(?=\.[a-z0-9]+$)/iu, "");
};

function readMemory(): Map<string, ImageSize> {
  const memory = new Map<string, ImageSize>();
  if (typeof localStorage === "undefined") return memory;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, [number, number]>;
    for (const [key, value] of Object.entries(stored))
      if (Array.isArray(value) && value[0] > 0 && value[1] > 0) memory.set(key, { width: value[0], height: value[1] });
  } catch {
    /* A corrupt memory is the same as none. */
  }
  return memory;
}

/** What this session draws with: fixed from module load onwards. */
const snapshot = readMemory();
/** What the next session will know. */
const learned = new Map(snapshot);
let flush = 0;

/** The intrinsic size of a released artwork URL, when its family is known. */
export function familyImageSize(source: unknown): ImageSize | undefined {
  if (typeof source !== "string" || !source) return undefined;
  const path = source.split("?")[0] || source;
  for (const [pattern, size] of FAMILIES) if (pattern.test(path)) return size;
  return undefined;
}

/** The size to reserve for `source` at first paint, or undefined when it is not known yet. */
export function knownImageSize(source: unknown): ImageSize | undefined {
  if (typeof source !== "string" || !source) return undefined;
  return familyImageSize(source) ?? snapshot.get(keyOf(source));
}

/** Records a loaded image's natural size for future sessions. Never affects this one. */
export function rememberImageSize(source: unknown, width: number, height: number): void {
  if (typeof source !== "string" || !source || !(width > 0) || !(height > 0)) return;
  if (familyImageSize(source)) return;
  const key = keyOf(source);
  const existing = learned.get(key);
  if (existing && existing.width === width && existing.height === height) return;
  learned.delete(key);
  learned.set(key, { width, height });
  while (learned.size > MEMORY_LIMIT) learned.delete(learned.keys().next().value as string);
  if (flush || typeof localStorage === "undefined") return;
  flush = window.setTimeout(() => {
    flush = 0;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(Object.fromEntries([...learned].map(([name, size]) => [name, [size.width, size.height]]))),
      );
    } catch {
      /* Storage may be full or unavailable; reserving falls back to the fixed frame. */
    }
  }, 1500);
}
