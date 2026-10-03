#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { compileLaneStripDelta, type LaneParticleData } from "./native-particles/laneStrips.ts";

const [baselineArgument, releaseArgument, outputArgument] = process.argv.slice(2);
if (!baselineArgument || !releaseArgument || !outputArgument)
  throw new Error("Usage: build-native-lane-assets.ts BASELINE_DIRECTORY SOURCE_RELEASE_ROOT OUTPUT_DIRECTORY");
const baselineDirectory = resolve(baselineArgument), releaseRoot = resolve(releaseArgument), out = resolve(outputArgument);
if (baselineDirectory === out) throw new Error("Lane delta must preserve the approved baseline");
const original = readFileSync(resolve(baselineDirectory, "particle.data"));
const texture = readFileSync(resolve(baselineDirectory, "particle.texture.png"));
const baseline = JSON.parse(gunzipSync(original).toString()) as LaneParticleData;
const compiled = await compileLaneStripDelta(baseline, texture, releaseRoot);
const data = gzipSync(JSON.stringify(compiled.data), { level: 9 });
const hash = (bytes: Buffer, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const artifact = (bytes: Buffer) => ({ bytes: bytes.length, sha1: hash(bytes, "sha1"), sha256: hash(bytes) });
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "particle.data"), data);
writeFileSync(resolve(out, "particle.texture.png"), texture);
const sourceUrls = [import.meta.url, new URL("./native-particles/laneStrips.ts", import.meta.url).href,
  new URL("./native-particles/trace.ts", import.meta.url).href, new URL("./native-particles/bake.ts", import.meta.url).href];
const report = { ...compiled.report, baselineDirectory, releaseRoot, baseline: { data: artifact(original), texture: artifact(texture) },
  artifacts: { "particle.data": artifact(data), "particle.texture.png": artifact(texture) },
  sourceHashes: Object.fromEntries(sourceUrls.map((url) => [new URL(url).pathname, hash(readFileSync(new URL(url)))])),
  nativeClientTested: false };
writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ artifacts: report.artifacts, effects: report.effects, unchangedEffects: report.unchangedEffects }));
