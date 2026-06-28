// Build the Sonolus background (image + thumbnail) from the ORIGINAL BanG
// Dream! Our Notes pre-rendered concert-stage backdrop. Brightness is applied
// by BackgroundConfiguration so standalone and Worker builds use one image.
//
// Output: packages/sonolus/dist/background/{blue,theatre}/{image.png,thumbnail.png}.
// Run: node packages/sonolus/scripts/build-background.ts   (requires `magick`).

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSonolusReleaseWorkspace } from "../src/server/releaseWorkspace.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const OUT = resolve(here, "../dist/background");
const server = process.env.ASSET_SERVER || "jp-cbt";
const workspace = resolveSonolusReleaseWorkspace(server, ROOT);

const magick = (args: readonly string[]): Buffer => execFileSync("magick", args, { stdio: ["ignore", "pipe", "pipe"] });

const BACKGROUNDS = [
  {
    name: "blue",
    source: resolve(workspace.assetsRoot, "Assets/AddressableResources/Band/1/live_stage/lightweight_background.png"),
  },
  {
    name: "theatre",
    source: resolve(workspace.assetsRoot, "Assets/AddressableResources/Band/2/live_stage/lightweight_background.png"),
  },
];

rmSync(OUT, { recursive: true, force: true });
for (const background of BACKGROUNDS) {
  if (!existsSync(background.source)) {
    throw new Error(`background source missing: ${background.source}`);
  }
  const target = resolve(OUT, background.name);
  mkdirSync(target, { recursive: true });
  // Keep the authored alpha and colors intact. Sonolus applies the native
  // BackgroundBrightness=.7 through a separate 30% black mask.
  magick([background.source, "-resize", "1920x", resolve(target, "image.png")]);
  magick([background.source, "-resize", "256x192", resolve(target, "thumbnail.png")]);
}

console.log(`background built → ${OUT}`);
