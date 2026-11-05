// L3 — GEB
// Input: Compiled engine facets, their ROM and reachable lane-clip metadata rules.
// Output: Engine resources with unchanged programs and compact skin references.
// Pos: [Map](../../L2-2.md); shared engine resource loader for both hosts.
// Effects/Dependencies: Reads artifacts, filters unused virtual references and gzip-encodes metadata.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { compactNativeSkinReferences } from "../shared/nativeLaneClipReferences.ts";

const programFiles = {
  playData: "EnginePlayData",
  watchData: "EngineWatchData",
  previewData: "EnginePreviewData",
  tutorialData: "EngineTutorialData",
} as const;

type EngineResourceData = Record<keyof typeof programFiles | "configuration", Buffer> & { rom?: Buffer };
type ProgramNode = { value?: number; func?: string; args?: number[] };

function compactSkinReferences(bytes: Buffer): Buffer {
  const program = JSON.parse(gunzipSync(bytes).toString("utf8")) as {
    skin: { sprites: Array<{ name: string; id: number }> };
  };
  const original = program.skin.sprites;
  const sprites = compactNativeSkinReferences(original);
  if (sprites.length === original.length) return bytes;
  program.skin.sprites = sprites;
  return gzipSync(JSON.stringify(program));
}

export function referencesEngineRom(bytes: Buffer, name: string): boolean {
  const program = JSON.parse(gunzipSync(bytes).toString("utf8")) as { nodes?: ProgramNode[] };
  if (!Array.isArray(program.nodes)) throw new Error(`Invalid ${name}: missing program nodes`);
  return program.nodes.some(
    (node) =>
      (node.func === "Get" || node.func === "GetShifted") && program.nodes?.[node.args?.[0] ?? -1]?.value === 3000,
  );
}

function decodeEngineRom(bytes: Buffer, file: string): Buffer {
  let values: Buffer;
  try {
    values = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  } catch (cause) {
    throw new Error(`Invalid EngineRom gzip: ${file}`, { cause });
  }
  if (!values.length || values.length % 4 !== 0) throw new Error(`Invalid EngineRom Float32LE byte length: ${file}`);
  return values;
}

/** Both hosts register these exact bytes with their existing SRL producer. */
export function loadEngineResources(engineDirectory: string): EngineResourceData {
  const resources = Object.fromEntries(
    Object.entries({ ...programFiles, configuration: "EngineConfiguration" }).map(([key, file]) => [
      key,
      key === "configuration"
        ? readFileSync(resolve(engineDirectory, file))
        : compactSkinReferences(readFileSync(resolve(engineDirectory, file))),
    ]),
  ) as EngineResourceData;
  const references = Object.entries(programFiles)
    .filter(([key, name]) => referencesEngineRom(resources[key as keyof typeof programFiles], name))
    .map(([, name]) => name);
  if (!references.length) return resources;

  const file = resolve(engineDirectory, "EngineRom");
  if (!existsSync(file)) throw new Error(`EngineRom required by ${references.join(", ")} is missing: ${file}`);
  const bytes = readFileSync(file);
  const values = decodeEngineRom(bytes, file);
  const rom = bytes[0] === 0x1f && bytes[1] === 0x8b ? bytes : gzipSync(values);
  return { ...resources, rom };
}
