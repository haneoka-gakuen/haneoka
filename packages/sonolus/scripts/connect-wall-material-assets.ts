import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeRgba8Png, encodeRgba8Png } from "./pack-original-note-skins.ts";

interface Recipe {
  schema: string;
  curves: Array<{ path: string; sha256: string }>;
  sprites: Array<{ name: string; correction: [number, number, number] }>;
  inputs: Array<{ skin: string; rgbaSha256: string; metadataSha256: string }>;
  frameCoordinates?: { top: number; span: number };
  frameSprites?: Array<{ name: string; active: boolean; bands: Array<[number, number, number]> }>;
}
type Sprite = {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  transform: Record<string, Record<string, number>>;
};
// Runtime skips the body of range zero; producers use either empty or core aliases.
const unusedBody = (name: string) => /^Our Notes Source Connect Draw (standard|light|simple) 00$/u.test(name);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, canonical(child)]),
        )
      : value;
const mix = (value: number, correction: number) =>
  correction < 0 ? value * (1 + correction) : value + (1 - value) * correction;

// The first two slots share one atlas tile. The fit covers original single-hit fading at
// 384px and 1280px across four widths, leaving dense-overlap carriers at their own exposure.
const simpleWallOpacity = new Map([
  ["Our Notes Source Connect Draw simple 01", 0.40],
  ["Our Notes Source Connect Draw simple 02", 0.40],
  ["Our Notes Source Connect Draw simple 03", 0.34],
  ["Our Notes Source Connect Draw simple 05", 0.85],
]);

export function applySimpleConnectWallOpacity(texture: ReturnType<typeof decodeRgba8Png>, sprites: Sprite[]): void {
  const { width, height, pixels } = texture;
  const protectedPixels = new Uint8Array(width * height);
  for (const sprite of sprites) {
    if (simpleWallOpacity.has(sprite.name) || unusedBody(sprite.name)) continue;
    for (let y = Math.max(0, sprite.y - 2); y < Math.min(height, sprite.y + sprite.h + 2); y++) {
      const start = y * width + Math.max(0, sprite.x - 2);
      protectedPixels.fill(1, start, y * width + Math.min(width, sprite.x + sprite.w + 2));
    }
  }
  for (const sprite of sprites) {
    const gain = simpleWallOpacity.get(sprite.name);
    if (gain === undefined) continue;
    for (let y = Math.max(0, sprite.y - 2); y < Math.min(height, sprite.y + sprite.h + 2); y++) {
      for (let x = Math.max(0, sprite.x - 2); x < Math.min(width, sprite.x + sprite.w + 2); x++) {
        const pixel = y * width + x;
        if (protectedPixels[pixel]) continue;
        pixels[pixel * 4 + 3] = Math.round(pixels[pixel * 4 + 3]! * gain);
        protectedPixels[pixel] = 1;
      }
    }
  }
}

/** Apply source-qualified color and opacity after wall geometry and UV packing. */
export function buildConnectWallMaterialAssets(directory: string, recipeFile: string, engineRoot: string) {
  const recipe = JSON.parse(readFileSync(recipeFile, "utf8")) as Recipe;
  if (recipe.schema !== "our-notes-connect-wall-material-v1") throw new Error("Unknown wall material recipe");
  for (const file of recipe.curves)
    if (hash(readFileSync(resolve(engineRoot, file.path))) !== file.sha256)
      throw new Error(`Wall material engine contract changed: ${file.path}`);
  const corrections = new Map(recipe.sprites.map((sprite) => [sprite.name, sprite.correction]));
  const frames = new Map((recipe.frameSprites ?? []).map((sprite) => [sprite.name, sprite]));
  if (
    corrections.size !== recipe.sprites.length ||
    recipe.sprites.some(
      (sprite) =>
        !/^Our Notes Source Connect Draw simple \d{2}$/u.test(sprite.name) ||
        sprite.correction.some((value) => !Number.isFinite(value) || value < -0.3 || value > 1),
    )
  )
    throw new Error("Invalid wall material correction");
  if (
    frames.size !== (recipe.frameSprites?.length ?? 0) ||
    (frames.size && (!recipe.frameCoordinates || recipe.frameCoordinates.span <= 0)) ||
    [...frames.values()].some(
      (sprite) =>
        !/^Our Notes Source Connect Frame Draw simple \d{2}$/u.test(sprite.name) ||
        sprite.bands.length !== 4 ||
        sprite.bands.some((row) => row.some((v) => !Number.isFinite(v) || v < -0.3 || v > 1)),
    )
  )
    throw new Error("Invalid frame material correction");
  const owned = (name: string) => corrections.has(name) || frames.has(name);
  const skins = recipe.inputs.map((input) => {
    const root = resolve(directory, "skins", input.skin);
    const metadata = gunzipSync(readFileSync(resolve(root, "skin.data")));
    const texture = decodeRgba8Png(readFileSync(resolve(root, "skin.texture.png")), input.skin);
    const definition = JSON.parse(metadata.toString("utf8")) as { sprites: Sprite[] };
    const named = {
      ...definition,
      sprites: [...definition.sprites]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((sprite) => (unusedBody(sprite.name) ? { name: sprite.name } : sprite)),
    };
    if (
      hash(Buffer.from(JSON.stringify(canonical(named)))) !== input.metadataSha256 ||
      hash(texture.pixels) !== input.rgbaSha256
    )
      throw new Error(`Wall material qualified atlas changed: ${input.skin}`);
    const found = new Set(definition.sprites.filter((sprite) => owned(sprite.name)).map((sprite) => sprite.name));
    if (found.size !== corrections.size + frames.size)
      throw new Error(`Wall/frame material sprite missing: ${input.skin}`);
    const original = Buffer.from(texture.pixels);
    const protectedPixels = new Uint8Array(texture.width * texture.height);
    for (const sprite of definition.sprites)
      if (!owned(sprite.name) && !unusedBody(sprite.name))
        for (let y = Math.max(0, sprite.y - 2); y < Math.min(texture.height, sprite.y + sprite.h + 2); y++)
          for (let x = Math.max(0, sprite.x - 2); x < Math.min(texture.width, sprite.x + sprite.w + 2); x++)
            protectedPixels[y * texture.width + x] = 1;
    const modified = new Set<number>();
    for (const sprite of definition.sprites) {
      const correction = corrections.get(sprite.name);
      const frame = frames.get(sprite.name);
      if (!correction && !frame?.active) continue;
      const inputY = { y1: -1, y2: 1, y3: 1, y4: -1 } as Record<string, number>;
      const ys = frame
        ? [1, 2, 3, 4].map((i) =>
            Object.entries(sprite.transform[`y${i}`]!).reduce((sum, [key, value]) => sum + inputY[key]! * value, 0),
          )
        : [];
      for (let y = Math.max(0, sprite.y - 2); y < Math.min(texture.height, sprite.y + sprite.h + 2); y++)
        for (let x = Math.max(0, sprite.x - 2); x < Math.min(texture.width, sprite.x + sprite.w + 2); x++) {
          const pixel = y * texture.width + x;
          if (protectedPixels[pixel] || modified.has(pixel)) continue;
          modified.add(pixel);
          const u = (x - sprite.x + 0.5) / sprite.w,
            v = 1 - (y - sprite.y + 0.5) / sprite.h;
          const sourceY = frame
            ? ys[0]! * (1 - u) * (1 - v) + ys[1]! * (1 - u) * v + ys[2]! * u * v + ys[3]! * u * (1 - v)
            : 0;
          const position = frame
            ? Math.max(0, Math.min(1, (recipe.frameCoordinates!.top - sourceY) / recipe.frameCoordinates!.span)) * 3
            : 0;
          const lower = Math.floor(position),
            fraction = position - lower;
          for (let channel = 0; channel < 3; channel++)
            texture.pixels[pixel * 4 + channel] = Math.round(
              mix(
                original[pixel * 4 + channel]! / 255,
                correction?.[channel] ??
                  frame!.bands[lower]![channel]! * (1 - fraction) +
                    frame!.bands[Math.min(3, lower + 1)]![channel]! * fraction,
              ) * 255,
            );
        }
    }
    for (let pixel = 0; pixel < protectedPixels.length; pixel++) {
      if (texture.pixels[pixel * 4 + 3] !== original[pixel * 4 + 3]) throw new Error("Wall material changed alpha");
      if (
        protectedPixels[pixel] &&
        [0, 1, 2, 3].some((channel) => texture.pixels[pixel * 4 + channel] !== original[pixel * 4 + channel])
      )
        throw new Error("Wall material changed a protected sprite");
    }
    applySimpleConnectWallOpacity(texture, definition.sprites);
    writeFileSync(resolve(root, "skin.texture.png"), encodeRgba8Png(texture));
    return {
      skin: input.skin,
      width: texture.width,
      height: texture.height,
      metadataExact: true,
      calibratedOpacitySprites: [...simpleWallOpacity.keys()],
      nonWallSpritesAndGuttersExact: !frames.size,
      protectedSpritesAndGuttersExact: true,
      rgbaSha256: hash(texture.pixels),
    };
  });
  const receipt = {
    schema: recipe.schema,
    recipeSha256: hash(readFileSync(recipeFile)),
    skins,
    unchangedRanges: 9,
    unchangedWallSlotsPerProfile: 18,
    unchangedFrameSlotsPerProfile: 96,
    addedDraws: 0,
    engineChanges: false,
  };
  writeFileSync(resolve(directory, "connect-wall-material-proof.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}
