// L3 — GEB
// Input: Stage images selected by the asset author.
// Output: Content for each band's Sonolus background image and square thumbnail, dimmed to the native background brightness default.
// Pos: [Map](../L2-2.md); stage asset preparation shared by both local and Worker hosts.
// Effects/Dependencies: Reads the authored PNGs and writes the generated presentation directory.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSquareThumbnail } from "./presentation-thumbnails.ts";
import { decodeRgba8Png, encodeRgba8Png } from "./pack-original-note-skins.ts";

/** The native live dims the background with a black overlay to 70% by default. */
export function dimBackground(bytes: Buffer): Buffer {
  const image = decodeRgba8Png(bytes, "lightweight_background.png");
  for (let index = 0; index < image.pixels.length; index += 4) {
    for (const channel of [0, 1, 2]) {
      const value = image.pixels[index + channel]! / 255;
      const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      const dimmed = linear * 0.7;
      image.pixels[index + channel] = Math.round(
        (dimmed <= 0.0031308 ? dimmed * 12.92 : 1.055 * dimmed ** (1 / 2.4) - 0.055) * 255,
      );
    }
  }
  return encodeRgba8Png(image) as Buffer;
}
import { resolveSonolusReleaseWorkspace } from "../src/server/releaseWorkspace.ts";

export function buildSonolusBackgrounds(assetsRoot: string, output: string) {
  for (const bandId of [0, 1, 2, 3, 4, 5]) {
    const path = resolve(
      assetsRoot,
      `Assets/AddressableResources/Band/${bandId}/live_stage/lightweight_background.png`,
    );
    const image = readFileSync(path);
    const directory = resolve(output, String(bandId));
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "image.png"), image);
    writeFileSync(resolve(directory, "thumbnail.png"), buildSquareThumbnail(image, path));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const root = resolve(process.env.OUR_NOTES_ROOT || process.cwd());
  const workspace = resolveSonolusReleaseWorkspace(process.env.RELEASE_SERVER || "intl", root);
  buildSonolusBackgrounds(workspace.assetsRoot, resolve(root, "packages/sonolus/dist/our-notes/backgrounds"));
}
