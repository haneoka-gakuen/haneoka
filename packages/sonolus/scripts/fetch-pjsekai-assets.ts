// Download pjsekai's ORIGINAL Sekai-styled resources (skin / particle / effect)
// from a live PySekai Sonolus server into packages/sonolus/dist/pjsekai. These
// are the genuine assets the vendored engine was authored for, so gameplay looks
// exactly like Project Sekai (which matches the BanG Dream! Our Notes footage).
// Only the BACKGROUND is Our Notes (built separately by build-background.ts).
//
// Run: node packages/sonolus/scripts/fetch-pjsekai-assets.ts
// (network required; assets are cached in dist/pjsekai and committed via the
//  build, so this only needs re-running to refresh them.)

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../dist/pjsekai");
const BASE = process.env.PJSEKAI_SERVER ?? "https://coconut.sonolus.com/pysekai-dev";
const NAME = process.env.PJSEKAI_ITEM ?? "coconut-pysekai-dev-1";

mkdirSync(OUT, { recursive: true });

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type ItemType = "skins" | "particles" | "effects";
type ItemField = "data" | "texture" | "audio";
type DownloadJob = readonly [type: ItemType, field: ItemField, outputName: string];

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function itemUrl(type: ItemType, field: ItemField): Promise<string> {
  const res = await fetch(`${BASE}/sonolus/${type}/${NAME}?localization=en`);
  if (!res.ok) throw new Error(`${type} item HTTP ${res.status}`);
  const document = (await res.json()) as JsonValue;
  if (!isJsonObject(document)) throw new Error(`${type} item response must be an object`);
  const item = document.item;
  if (!isJsonObject(item)) throw new Error(`${type} item response is missing item`);
  const resource = item[field];
  if (!isJsonObject(resource)) throw new Error(`${type}.${field} missing`);
  const url = resource.url;
  if (typeof url !== "string" || !url) throw new Error(`${type}.${field}.url missing`);
  return url.startsWith("http") ? url : `${BASE}${url}`;
}

async function download(type: ItemType, field: ItemField, outputName: string): Promise<void> {
  const url = await itemUrl(type, field);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${type}.${field} data HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(resolve(OUT, outputName), buf);
  console.log(`  ${type}.${field} → ${outputName} (${buf.length} B)`);
}

const jobs = [
  ["skins", "data", "skin.data"],
  ["skins", "texture", "skin.texture.png"],
  ["particles", "data", "particle.data"],
  ["particles", "texture", "particle.texture.png"],
  ["effects", "data", "effect.data"],
  ["effects", "audio", "effect.audio"],
] as const satisfies readonly DownloadJob[];

console.log(`fetching pjsekai resources from ${BASE} (${NAME})`);
for (const [type, field, outputName] of jobs) {
  try {
    await download(type, field, outputName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  FAILED ${type}.${field}: ${message}`);
    if (!existsSync(resolve(OUT, outputName))) process.exitCode = 1;
  }
}
console.log(`done → ${OUT}`);
