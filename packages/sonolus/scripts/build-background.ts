// Build the Sonolus background (image + thumbnail) from the ORIGINAL BanG
// Dream! Our Notes pre-rendered concert-stage backdrop. Brightness is applied
// by BackgroundConfiguration so standalone and Worker builds use one image.
//
// Output: packages/sonolus/dist/background/<stage>/{image.png,thumbnail.png}.
// Run: node packages/sonolus/scripts/build-background.ts   (requires `magick`).

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSquareThumbnail } from "./presentation-thumbnails.ts";
import { resolveSonolusReleaseWorkspace } from "../src/server/releaseWorkspace.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const OUT = resolve(here, "../dist/background");
const releaseServer = process.env.RELEASE_SERVER || "intl";
const workspace = resolveSonolusReleaseWorkspace(releaseServer, ROOT);

const magick = (args: readonly string[]): Buffer => execFileSync("magick", args, { stdio: ["ignore", "pipe", "pipe"] });

// Every native lightweight stage, keyed by the MasterBand id that names it.
const BACKGROUNDS = [
  { name: "stage", band: 0 },
  { name: "mygo", band: 1 },
  { name: "ave-mujica", band: 2 },
  { name: "mugendai-mewtype", band: 3 },
  { name: "millsage", band: 4 },
  { name: "ikka-dumb-rock", band: 5 },
].map((entry) => ({
  ...entry,
  source: resolve(
    workspace.assetsRoot,
    `Assets/AddressableResources/Band/${entry.band}/live_stage/lightweight_background.png`,
  ),
}));

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
  writeFileSync(resolve(target, "thumbnail.png"), buildSquareThumbnail(readFileSync(background.source), background.source));
}

console.log(`background built → ${OUT}`);
