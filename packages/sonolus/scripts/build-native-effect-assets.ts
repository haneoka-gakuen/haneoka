#!/usr/bin/env node

// Build the Sonolus effect pack from the HCA cues prepared by the CRI stage.
// No PJS/Sekai sound is retained in this pack.

import { copyFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { resolveSonolusReleaseWorkspace } from "../src/server/releaseWorkspace.ts";

const root = resolve(process.env.OUR_NOTES_ROOT || process.cwd());
const server = process.env.ASSET_SERVER || "jp-cbt";
const workspace = resolveSonolusReleaseWorkspace(server, root);
const source = resolve(workspace.runtimeRoot, "note-se");
const output = resolve(process.env.SONOLUS_ORIGINAL_ASSETS_DIR || resolve(root, "packages/sonolus/assets/original"));
const ffmpeg = process.env.FFMPEG || "ffmpeg";

const clips = [
  ["#PERFECT", "default_perfect"],
  ["#GREAT", "default_great"],
  ["#GOOD", "default_good"],
  ["#HOLD", "default_long"],
  ["#PERFECT_ALTERNATIVE", "default_flick"],
  ["#GREAT_ALTERNATIVE", "default_great"],
  ["#GOOD_ALTERNATIVE", "default_good"],
  ["#HOLD_ALTERNATIVE", "default_long"],
  ["#STAGE", "default_in_vain"],
  ["Our Notes Tick", "default_trace"],
  ["Our Notes Trace", "default_trace"],
  ["Our Notes Critical Tap", "default_perfect"],
  ["Our Notes Critical Trace", "default_trace"],
  ["Our Notes Critical Hold", "default_long"],
  ["Our Notes Critical Flick", "default_flick"],
  ["Our Notes Critical Tick", "default_trace"],
  ["Our Notes Flick Side", "default_flick_side"],
] as const;

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
}

function encode(input: string, destination: string): void {
  run(ffmpeg, [
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-map_metadata",
    "-1",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "320k",
    "-write_xing",
    "0",
    destination,
  ]);
}

const staging = mkdtempSync(resolve(tmpdir(), "our-notes-sonolus-effect-"));
try {
  const encoded = new Map<string, string>();
  for (const [, cue] of clips) {
    if (encoded.has(cue)) continue;
    const destination = resolve(staging, `${cue}.mp3`);
    if (cue === "default_long") {
      run(ffmpeg, [
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        resolve(source, "default_long_1.mp3"),
        "-i",
        resolve(source, "default_long_2.mp3"),
        "-filter_complex",
        "[0:a]volume=0.85[a0];[1:a]volume=0.75[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=0[out]",
        "-map",
        "[out]",
        "-map_metadata",
        "-1",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "320k",
        "-write_xing",
        "0",
        destination,
      ]);
    } else {
      encode(resolve(source, `${cue}.mp3`), destination);
    }
    encoded.set(cue, destination);
  }

  const epoch = new Date("2000-01-01T00:00:00Z");
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    if (!clip) throw new Error(`Missing effect clip at index ${index}`);
    const cue = clip[1];
    const destination = resolve(staging, String(index));
    const encodedFile = encoded.get(cue);
    if (!encodedFile) throw new Error(`Encoded effect cue is missing: ${cue}`);
    copyFileSync(encodedFile, destination);
    utimesSync(destination, epoch, epoch);
  }

  const archive = resolve(staging, "effect.audio");
  run("zip", ["-X", "-j", "-0", archive, ...clips.map((_, index) => resolve(staging, String(index)))]);
  copyFileSync(archive, resolve(output, "effect.audio"));
  writeFileSync(
    resolve(output, "effect.data"),
    gzipSync(
      JSON.stringify({
        clips: clips.map(([name], index) => ({ name, filename: String(index) })),
      }),
      { level: 9 },
    ),
  );

  // Make failures obvious if an empty/partial decode was accidentally used.
  const bytes = clips.reduce((sum, [, cue]) => {
    const encodedFile = encoded.get(cue);
    if (!encodedFile) throw new Error(`Encoded effect cue is missing: ${cue}`);
    return sum + readFileSync(encodedFile).length;
  }, 0);
  console.log(`built native Our Notes Sonolus effect pack: ${clips.length} clips, ${bytes} encoded bytes`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
