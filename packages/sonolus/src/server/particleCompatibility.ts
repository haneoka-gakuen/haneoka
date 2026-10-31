// Input: particle packs, source-empty evidence, and compiled engine imports.
// Output: compatibility validation or a named failure.
// Pos: Sonolus build-time validation; direct map: ../../L2-2.md.
// Effects: reads resource identities; allows exact optional effects with engine fallbacks.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { NATIVE_PARTICLE_OPTIONAL_EFFECTS } from "../shared/nativeDrawCapabilities.ts";
import {
  NATIVE_PARTICLE_PACKS,
  NATIVE_PARTICLE_SEMANTIC_PREFIX,
  nativeParticlePresencePolicy,
} from "../shared/particlePacks.ts";

type Effect = { name: string; transform?: unknown; groups: unknown[] };
type Particle = { effects: Effect[] };
type Identity = { bytes: number; sha1: string };
type PackReport = {
  key: string;
  name: string;
  sourcePrefix: string;
  semanticPrefix: string;
  effects: number;
  omittedEmptyEffects: string[];
  artifacts: { data: Identity; texture: Identity };
  provenance: { sourceId: string; releaseId: string; baseline: string };
};
type Manifest = {
  schema: string;
  baseline: string;
  sourceId: string;
  releaseId: string;
  packs: PackReport[];
  sourceEmptyProof: { file: string; bytes: number; sha256: string };
};
type EmptyProof = {
  schema: string;
  sourceId: string;
  releaseId: string;
  source: { file: string; bytes: number; sha256: string; jsonSha256: string };
  profiles: { key: string; sourcePrefix: string }[];
};

const optionalCapabilities = new Set<string>(NATIVE_PARTICLE_OPTIONAL_EFFECTS);
const digest = (bytes: Buffer, algorithm: "sha1" | "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;
const readParticle = (path: string): Particle =>
  JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as Particle;
const fail = (message: string): never => {
  throw new Error(`Particle compatibility: ${message}`);
};

function effectNames(particle: Particle, context: string): Set<string> {
  const result = new Set<string>();
  for (const effect of particle.effects) {
    if (result.has(effect.name)) fail(`${context} duplicates ${effect.name}`);
    result.add(effect.name);
  }
  return result;
}

function imports(engineDir: string) {
  return ["Play", "Watch", "Tutorial"].map((facet) => {
    const engine = JSON.parse(
      gunzipSync(
        readFileSync(resolve(engineDir, `Engine${facet}Data`)),
      ).toString("utf8"),
    ) as {
      particle: { effects: { name: string }[] };
    };
    return {
      facet,
      names: [
        ...new Set(
          engine.particle.effects
            .map(({ name }) => name)
            .filter((name) => name !== "Our Notes Unused"),
        ),
      ],
    };
  });
}

function verifyIdentity(path: string, expected: Identity) {
  const bytes = readFileSync(path);
  if (
    bytes.length !== expected.bytes ||
    digest(bytes, "sha1") !== expected.sha1
  )
    fail(`resource identity mismatch: ${path}`);
}

/** Legacy packs remain strict; split packs require profile and source-empty evidence. */
export function verifyParticleEffects(
  resourceDir: string,
  engineDir: string,
): void {
  const facets = imports(engineDir);
  const manifestFile = resolve(resourceDir, "particle-packs.json");
  if (!existsSync(manifestFile)) {
    const names = effectNames(
      readParticle(resolve(resourceDir, "particle.data")),
      "legacy",
    );
    for (const facet of facets) {
      const missing = facet.names.filter(
        (name) => !names.has(name) && !optionalCapabilities.has(name),
      );
      if (missing.length)
        fail(
          `legacy pack is missing ${facet.facet} effects: ${missing.join(", ")}`,
        );
    }
    return;
  }

  const manifest = readJson<Manifest>(manifestFile);
  if (
    manifest.schema !== "our-notes-particle-packs-v1" ||
    !manifest.sourceId ||
    !manifest.releaseId ||
    !manifest.baseline ||
    manifest.packs.length !== NATIVE_PARTICLE_PACKS.length
  )
    fail("invalid split manifest identity");
  if (
    new Set(manifest.packs.map(({ key }) => key)).size !==
    NATIVE_PARTICLE_PACKS.length
  )
    fail("duplicate split profile");
  const proofDescriptor = manifest.sourceEmptyProof;
  if (proofDescriptor?.file !== "source-empty-proof.json")
    fail("source-empty proof descriptor missing");
  const proofBytes = readFileSync(resolve(resourceDir, proofDescriptor.file));
  if (
    proofBytes.length !== proofDescriptor.bytes ||
    digest(proofBytes, "sha256") !== proofDescriptor.sha256
  )
    fail("source-empty proof descriptor mismatch");
  const proof = JSON.parse(proofBytes.toString("utf8")) as EmptyProof;
  if (
    proof.schema !== "our-notes-particle-source-empty-v1" ||
    proof.sourceId !== manifest.sourceId ||
    proof.releaseId !== manifest.releaseId ||
    proof.source.file !== "source-empty-particle.data" ||
    !isDeepStrictEqual(
      proof.profiles,
      NATIVE_PARTICLE_PACKS.map(({ key, prefix }) => ({
        key,
        sourcePrefix: prefix,
      })),
    )
  )
    fail("source-empty proof identity mismatch");
  const sourceBytes = readFileSync(resolve(resourceDir, proof.source.file));
  const sourceJson = gunzipSync(sourceBytes);
  if (
    sourceBytes.length !== proof.source.bytes ||
    digest(sourceBytes, "sha256") !== proof.source.sha256 ||
    digest(sourceJson, "sha256") !== proof.source.jsonSha256
  )
    fail("source-empty resource identity mismatch");
  const source = JSON.parse(sourceJson.toString("utf8")) as Particle;
  effectNames(source, "source-empty");
  const sourceEffects = new Map(
    source.effects.map((effect) => [effect.name, effect]),
  );

  for (const pack of NATIVE_PARTICLE_PACKS) {
    const report = readJson<PackReport>(
      resolve(resourceDir, "particles", pack.key, "particle-pack-report.json"),
    );
    const entry = manifest.packs.find(({ key }) => key === pack.key);
    if (!isDeepStrictEqual(entry, report))
      fail(`${pack.key} report differs from manifest`);
    if (
      report.key !== pack.key ||
      report.name !== pack.name ||
      report.sourcePrefix !== pack.prefix ||
      report.semanticPrefix !== NATIVE_PARTICLE_SEMANTIC_PREFIX ||
      report.provenance.sourceId !== manifest.sourceId ||
      report.provenance.releaseId !== manifest.releaseId ||
      report.provenance.baseline !== manifest.baseline
    )
      fail(`${pack.key} profile/provenance mismatch`);
    const directory = resolve(resourceDir, "particles", pack.key);
    verifyIdentity(resolve(directory, "particle.data"), report.artifacts.data);
    verifyIdentity(
      resolve(directory, "particle.texture.png"),
      report.artifacts.texture,
    );
    const particle = readParticle(resolve(directory, "particle.data"));
    const names = effectNames(particle, pack.key);
    for (const effect of particle.effects)
      if (!effect.transform)
        fail(`${pack.key} effect has no transform: ${effect.name}`);
    if (names.size !== report.effects)
      fail(`${pack.key} effect count mismatch`);
    const policy = nativeParticlePresencePolicy(pack.key);
    for (const name of policy.required)
      if (!names.has(name))
        fail(`${pack.key} required effect missing: ${name}`);
    for (const name of policy.absent)
      if (names.has(name))
        fail(`${pack.key} disabled effect is present: ${name}`);
    const omitted = new Set(report.omittedEmptyEffects);
    if (omitted.size !== report.omittedEmptyEffects.length)
      fail(`${pack.key} duplicate source-empty omission`);
    for (const name of omitted) {
      if (
        !name.startsWith(`${NATIVE_PARTICLE_SEMANTIC_PREFIX} `) ||
        names.has(name)
      )
        fail(`${pack.key} invalid source-empty omission: ${name}`);
      const sourceName =
        pack.prefix + name.slice(NATIVE_PARTICLE_SEMANTIC_PREFIX.length);
      const effect = sourceEffects.get(sourceName);
      if (!effect || effect.groups.length !== 0)
        fail(
          `${pack.key} source-empty omission is not empty in frozen source: ${name}`,
        );
    }
    const allowedMissing = new Set([
      ...policy.absent,
      ...omitted,
      ...optionalCapabilities,
    ]);
    for (const facet of facets) {
      const missing = facet.names.filter(
        (name) => !names.has(name) && !allowedMissing.has(name),
      );
      if (missing.length)
        fail(
          `${pack.key} is missing ${facet.facet} effects: ${missing.join(", ")}`,
        );
    }
  }
}
