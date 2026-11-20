// L3 — GEB
// Input: Stage images selected by the asset author.
// Output: Content for each band's Sonolus background image and square thumbnail.
// Pos: [Map](../L2-2.md); stage asset preparation shared by both local and Worker hosts.
// Effects/Dependencies: Reads the authored PNGs and writes the generated presentation directory.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSquareThumbnail } from "./presentation-thumbnails.ts";
import { resolveSonolusReleaseWorkspace } from "../src/server/releaseWorkspace.ts";

export function buildSonolusBackgrounds(assetsRoot: string, output: string) {
  for (const bandId of [0, 1, 2, 3, 4, 5]) {
    const path = resolve(assetsRoot, `Assets/AddressableResources/Band/${bandId}/live_stage/lightweight_background.png`);
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
