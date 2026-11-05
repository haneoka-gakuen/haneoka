// L3 — GEB
// Input: Validated release/Source assets, compiled engine facets and native packing contracts.
// Output: Original Sonolus skin, particle and audio resources with engine-reference coverage checks.
// Pos: [Map](../L2-2.md); original Sonolus resource generator.
// Effects/Dependencies: Reads release caches and engine artifacts; writes resource packs, engine draw tables and cache receipts.
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  buildNativeNoteSkinPacks,
  isOptionalOriginalSkinSprite,
  decodeRgba8Png,
  encodeRgba8Png,
} from "./pack-original-note-skins.ts";
import {
  buildProductionParticles,
  productionParticleInputs,
} from "./native-particles/production.ts";
import {
  NATIVE_PARTICLE_PACKS,
  nativeParticlePresencePolicy,
} from "../src/shared/particlePacks.ts";
import { buildPresentationThumbnails } from "./presentation-thumbnails.ts";
import {
  particleCacheKey,
  restoreParticleCache,
  saveParticleCache,
} from "./native-particles/cache.ts";
import { OUR_NOTES_NOTE_SE_GROUP_IDS } from "@haneoka/cassiopeia-plugin-our-notes";
import { resolveSonolusReleaseWorkspace } from "../src/server/releaseWorkspace.ts";
import { validateSonolusInputProvenance } from "../src/server/sonolusProvenance.ts";
import { buildConnectWallDrawAssets } from "./connect-wall-draw-assets.ts";
import { buildConnectFrameDrawAssets } from "./connect-frame-draw-assets.ts";
import { buildNativeRowSliceAssets } from "./native-row-slice-assets.ts";
import { buildNativeLoopFrameAssets } from "./native-loop-frame-assets.ts";
import { NATIVE_PARTICLE_OPTIONAL_EFFECTS } from "../src/shared/nativeDrawCapabilities.ts";

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type NormalizedRgba = readonly [
  red: number,
  green: number,
  blue: number,
  alpha: number,
];
type ByteRgba = readonly [
  red: number,
  green: number,
  blue: number,
  alpha: number,
];

const CHANNELS = [0, 1, 2, 3] as const;

function parseJson(text: string, sourceName: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceName} is not valid JSON: ${detail}`, {
      cause: error,
    });
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireJsonObject(
  value: JsonValue | undefined,
  path: string,
): JsonObject {
  if (!value || !isJsonObject(value))
    throw new Error(`${path} must be an object`);
  return value;
}

function byteAt(buffer: Uint8Array, index: number, context: string): number {
  const value = buffer[index];
  if (value === undefined)
    throw new Error(
      `${context}: byte ${index} is out of bounds for ${buffer.length} bytes`,
    );
  return value;
}

const root = resolve(process.env.OUR_NOTES_ROOT || process.cwd());
const releaseServer = process.env.RELEASE_SERVER || "intl";
const workspace = resolveSonolusReleaseWorkspace(releaseServer, root);
const inputProvenance = validateSonolusInputProvenance(workspace, root);
const source = resolve(
  process.env.SONOLUS_ORIGINAL_ASSETS_DIR ||
    resolve(root, "packages/sonolus/assets/original"),
);
const out = resolve(root, "packages/sonolus/dist/our-notes");
const engineRoot = dirname(
  fileURLToPath(import.meta.resolve("@haneoka/sonolus-our-notes/package.json")),
);
const optionalCapabilities = new Set(NATIVE_PARTICLE_OPTIONAL_EFFECTS);

function connectWallCacheInput(baseCacheKey: string) {
  const module = resolve(
    root,
    "packages/sonolus/scripts/connect-wall-assets.ts",
  );
  const contract = resolve(
    root,
    ".dependencies/sonolus-our-notes/shared/src/engine/data/connectWallContract.ts",
  );
  return {
    schema: "our-notes-connect-wall-aggregate-cache-v1",
    baseCacheKey,
    producerSha256: createHash("sha256")
      .update(readFileSync(module))
      .digest("hex"),
    contractSha256: createHash("sha256")
      .update(readFileSync(contract))
      .digest("hex"),
  };
}

function connectFrameCacheInput() {
  const bank = resolve(
    root,
    "packages/sonolus/assets/native-particles/source-connect-frame-v1",
  );
  const manifest = JSON.parse(
    readFileSync(resolve(bank, "manifest.json"), "utf8"),
  ) as { formalInputs: Array<{ path: string }> };
  const sha256 = (file: string) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  return {
    schema: "our-notes-connect-frame-draw-cache-v1",
    producerSha256: sha256(
      resolve(root, "packages/sonolus/scripts/connect-frame-draw-assets.ts"),
    ),
    manifestSha256: sha256(resolve(bank, "manifest.json")),
    textureSha256: sha256(resolve(bank, "carriers.png")),
    curveSha256: sha256(
      resolve(
        engineRoot,
        "shared/src/engine/data/connectFrameDraw.generated.ts",
      ),
    ),
    contractSha256: sha256(
      resolve(engineRoot, "shared/src/engine/data/connectWallDrawContract.ts"),
    ),
    runtimeRecipeSha256: sha256(
      resolve(
        root,
        "packages/sonolus/assets/native-particles/production.v1.json",
      ),
    ),
    formalInputs: manifest.formalInputs.map(({ path }) => ({
      path,
      sha256: sha256(resolve(workspace.releaseRoot, path)),
    })),
  };
}

function connectWallMaterialInput() {
  const digest = (path: string) =>
    createHash("sha256")
      .update(readFileSync(resolve(root, path)))
      .digest("hex");
  return {
    recipeSha256: digest("packages/sonolus/assets/native-particles/connect-wall-material.v1.json"),
    producerSha256: digest("packages/sonolus/scripts/connect-wall-material-assets.ts"),
  };
}

if (
  process.argv.includes("--particle-cache-key") ||
  process.argv.includes("--particle-base-cache-key")
) {
  const baseKey = productionParticleInputs(root, inputProvenance).cacheKey;
  console.log(
    process.argv.includes("--particle-base-cache-key")
      ? baseKey
      : particleCacheKey({
          connectWall: connectWallCacheInput(baseKey),
          frame: connectFrameCacheInput(),
          wallMaterial: connectWallMaterialInput(),
          nativeRowsProducerSha256: createHash("sha256")
            .update(readFileSync(resolve(root, "packages/sonolus/scripts/native-row-slice-assets.ts")))
            .digest("hex"),
          loopFrameProducerSha256: createHash("sha256")
            .update(readFileSync(resolve(root, "packages/sonolus/scripts/native-loop-frame-assets.ts")))
            .update(readFileSync(resolve(engineRoot, "shared/src/engine/data/loopFrameContract.ts")))
            .digest("hex"),
        }),
  );
  process.exit(0);
}

const particleBuild = await buildProductionParticles(
  root,
  workspace.releaseRoot,
  inputProvenance,
);
try {
  const connectInput = connectWallCacheInput(particleBuild.cacheKey);
  const connectCacheKey = particleCacheKey(connectInput);
  const connectReused = restoreParticleCache(
    root,
    connectCacheKey,
    particleBuild.directory,
  );
  if (!connectReused) {
    const inputs = productionParticleInputs(root, inputProvenance);
    const hook = inputs.runtime.register();
    try {
      const { buildConnectWallAggregateAssets } =
        await import("./connect-wall-assets.ts");
      await buildConnectWallAggregateAssets({
        destination: particleBuild.directory,
        baseline: particleBuild.directory,
        releaseRoot: workspace.releaseRoot,
        contractFile: inputs.runtime.modules.contract,
      });
    } finally {
      hook.deregister();
    }
    const reportPath = resolve(
      particleBuild.directory,
      "native-particle-report.json",
    );
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      pipeline: string[];
      proofs: Array<{ file: string; sha256: string }>;
      connectWallAggregate?: typeof connectInput & { cacheKey: string };
    };
    const file = "connect-wall-aggregate-proof.json";
    report.pipeline.push("connect-wall-aggregate");
    report.proofs.push({
      file,
      sha256: createHash("sha256")
        .update(readFileSync(resolve(particleBuild.directory, file)))
        .digest("hex"),
    });
    report.connectWallAggregate = {
      ...connectInput,
      cacheKey: connectCacheKey,
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    saveParticleCache(
      root,
      connectCacheKey,
      particleBuild.directory,
      connectInput,
    );
  }
  console.log(
    connectReused
      ? "reused verified Connect wall aggregate"
      : "rebuilt Connect wall aggregate over verified base particles",
  );
  mkdirSync(out, { recursive: true });

  function bakeSlideLineColors(input: Buffer): Buffer {
    const decoded = decodeRgba8Png(input, "skin.texture.png");
    const { width, height, pixels } = decoded;
    if (width < 862 || height < 3717) {
      throw new Error(
        `skin.texture.png is too small for compatibility sprites: ${width}x${height}`,
      );
    }
    const stride = width * 4;

    const sourceSlideRow = Buffer.from(
      pixels.subarray(3716 * stride, 3716 * stride + 100 * 4),
    );
    const writePaddedSlideStrip = (
      spriteX: number,
      rgba: NormalizedRgba,
    ): void => {
      // The declared sprite occupies y=3693..3700. Duplicate it once above and
      // below so bilinear filtering at either UV boundary never samples alpha 0.
      for (let y = 3692; y <= 3701; y++) {
        for (let x = -1; x <= 100; x++) {
          const sourceX = Math.max(0, Math.min(99, x));
          const sourceOffset = sourceX * 4;
          const targetOffset = y * stride + (spriteX + x) * 4;
          pixels[targetOffset] = Math.round(
            byteAt(sourceSlideRow, sourceOffset, "slide source") * rgba[0],
          );
          pixels[targetOffset + 1] = Math.round(
            byteAt(sourceSlideRow, sourceOffset + 1, "slide source") * rgba[1],
          );
          pixels[targetOffset + 2] = Math.round(
            byteAt(sourceSlideRow, sourceOffset + 2, "slide source") * rgba[2],
          );
          pixels[targetOffset + 3] = Math.round(
            byteAt(sourceSlideRow, sourceOffset + 3, "slide source") * rgba[3],
          );
        }
      }
    };

    // The plain strip stays for Sonolus fallback sprite names; the three
    // coloured strips are baked per skin inside pack-original-note-skins from
    // each skin's authored SlideLine gradient + glow (see bakeSkinSlideStrips).
    writePaddedSlideStrip(401, [1, 1, 1, 1]);

    const writePaddedSolid = (spriteX: number, rgba: ByteRgba): void => {
      for (let y = 3692; y <= 3701; y++) {
        for (let x = -1; x <= 8; x++) {
          const targetOffset = y * stride + (spriteX + x) * 4;
          for (const channel of CHANNELS) {
            pixels[targetOffset + channel] = rgba[channel];
          }
        }
      }
    };
    // lane_base's opaque centre is exactly sRGBA(9,19,46,1). The orthographic
    // preview uses that flat colour; borders follow the judgement white and
    // dividers use the serialized lane-line grey at restrained alpha.
    writePaddedSolid(817, [9, 19, 46, 255]);
    writePaddedSolid(829, [250, 246, 255, 255]);
    writePaddedSolid(841, [156, 156, 156, 72]);
    // The pair-note prefab uses Sprite-Unlit-Default with an untinted white
    // SpriteRenderer. Keep this independent from the purple SlideLine strips.
    writePaddedSolid(853, [255, 255, 255, 255]);

    // LiveLaneLine styles 0/2. Main lines interpolate alpha 1 -> 0 from
    // judgment to horizon; Space ticks use the serialized uniform gray.
    const lanePixels: ReadonlyArray<
      readonly [x: number, y: number, rgba: NormalizedRgba]
    > = [
      [326, 3692, [0.6156863, 0.6156863, 0.6156863, 0]],
      [326, 3693, [0.6132076, 0.6132076, 0.6132076, 1]],
      [328, 3692, [0.6117647, 0.6117647, 0.6117647, 1]],
      [330, 3692, [250 / 255, 246 / 255, 1, 1]],
    ];
    for (const [x, y, rgba] of lanePixels) {
      const targetOffset = y * stride + x * 4;
      for (const channel of CHANNELS) {
        pixels[targetOffset + channel] = Math.round(rgba[channel] * 255);
      }
    }

    return encodeRgba8Png(decoded);
  }

  const commonTexture = decodeRgba8Png(
    bakeSlideLineColors(readFileSync(resolve(source, "skin.texture.png"))),
    "baked common Sonolus texture",
  );
  const nativeSkinPacks = buildNativeNoteSkinPacks(
    resolve(out, "skins"),
    commonTexture,
  );
  for (const retired of ["skin.data", "skin.texture.png"])
    rmSync(resolve(out, retired), { force: true });
  cpSync(particleBuild.directory, out, { recursive: true });
  const draw = buildConnectWallDrawAssets({
    source: out,
    destination: out,
    generatedFile: resolve(
      engineRoot,
      "shared/src/engine/data/connectWallDraw.generated.ts",
    ),
  });
  console.log(
    `Connect wall Draw: ${draw.skins[0]!.addedSprites} sprites per skin, unchanged atlas dimensions`,
  );
  const frameInput = {
    ...connectFrameCacheInput(),
    sourceArtifacts: NATIVE_PARTICLE_PACKS.flatMap(({ key }, index) => [
      `particles/${key}/particle.data`,
      `skins/skin00${index + 1}/skin.data`,
      `skins/skin00${index + 1}/skin.texture.png`,
    ]).map((file) => ({
      file,
      sha256: createHash("sha256")
        .update(readFileSync(resolve(out, file)))
        .digest("hex"),
    })),
  };
  const frameKey = particleCacheKey(frameInput);
  const frameReused = restoreParticleCache(root, frameKey, out);
  if (!frameReused) {
    buildConnectFrameDrawAssets({
      source: out,
      destination: out,
      generatedFile: resolve(
        engineRoot,
        "shared/src/engine/data/connectFrameDraw.generated.ts",
      ),
      releaseRoot: workspace.releaseRoot,
    });
    const cached = resolve(
      particleBuild.temporaryDirectory,
      "connect-frame-cache",
    );
    mkdirSync(cached, { recursive: true });
    for (const file of [
      "skins",
      "particles",
      "particle-packs.json",
      "connect-frame-draw-proof.json",
    ])
      cpSync(resolve(out, file), resolve(cached, file), { recursive: true });
    saveParticleCache(root, frameKey, cached, frameInput);
  }
  const frame = JSON.parse(
    readFileSync(resolve(out, "connect-frame-draw-proof.json"), "utf8"),
  ) as ReturnType<typeof buildConnectFrameDrawAssets>;
  console.log(
    `Connect frame Draw: ${frame.skins[0]!.addedSprites} sprites per skin, ${frameReused ? "reused verified cache" : "built from fixed Source bank"}`,
  );

  const { buildConnectWallMaterialAssets } = await import("./connect-wall-material-assets.ts");
  buildConnectWallMaterialAssets(
    out,
    resolve(root, "packages/sonolus/assets/native-particles/connect-wall-material.v1.json"),
    engineRoot,
  );

  const rows = buildNativeRowSliceAssets(out);
  console.log(`Simple row slices: ${rows.mergedTriples} triples merged, unchanged atlas dimensions`);
  const loopFrames = buildNativeLoopFrameAssets(out);
  console.log(`Slide loop frames: ${loopFrames.length} single-cycle effects`);

  const referencedParticleNames = new Set<string>();

  // Engine-facing sprite coverage: every "Our Notes ..." sprite in the compiled
  // engine facets must exist in the default skin pack, or Sonolus would silently
  // fall back to stock sprites. The published engine package contains compiled
  // Engine*Data artifacts but not the source skin.ts files.
  {
    const referencedNames = new Set<string>();
    for (const artifact of [
      "EnginePlayData",
      "EngineWatchData",
      "EnginePreviewData",
      "EngineTutorialData",
    ] as const) {
      const artifactFile = resolve(engineRoot, "dist", artifact);
      if (!existsSync(artifactFile))
        throw new Error(`missing compiled engine artifact: ${artifactFile}`);
      const compiled = JSON.parse(
        gunzipSync(readFileSync(artifactFile)).toString("utf8"),
      ) as {
        skin?: { sprites?: unknown };
        particle?: { effects?: Array<{ name: string }> };
      };
      if (!compiled.skin || !Array.isArray(compiled.skin.sprites)) {
        throw new Error(
          `compiled engine artifact has no skin.sprites array: ${artifactFile}`,
        );
      }
      for (const effect of compiled.particle?.effects ?? [])
        if (effect.name !== "Our Notes Unused")
          referencedParticleNames.add(effect.name);
      for (const [index, sprite] of compiled.skin.sprites.entries()) {
        if (
          !sprite ||
          typeof sprite !== "object" ||
          typeof (sprite as { name?: unknown }).name !== "string"
        ) {
          throw new Error(
            `compiled engine artifact has an invalid skin sprite at ${artifact}[${index}]`,
          );
        }
        const name = (sprite as { name: string }).name;
        if (name.startsWith("Our Notes ")) referencedNames.add(name);
      }
    }
    const defaultSkin = JSON.parse(
      gunzipSync(
        readFileSync(resolve(out, "skins", "skin001", "skin.data")),
      ).toString("utf8"),
    ) as {
      sprites: Array<{ name?: unknown }>;
    };
    const available = new Set(
      defaultSkin.sprites.map((sprite) => String(sprite.name)),
    );
    const missing = [...referencedNames].filter(
      (name) => !available.has(name) && !isOptionalOriginalSkinSprite(name),
    );
    if (missing.length) {
      throw new Error(
        `Skin pack skin001 is missing engine-referenced sprites: ${missing.join(", ")}`,
      );
    }
    console.log(
      `skin001 covers all ${referencedNames.size} engine-referenced sprite names`,
    );
  }

  // The qualified bake input and its Source deltas are one production path.
  let particleEffectCount = 0;
  for (const pack of NATIVE_PARTICLE_PACKS) {
    const directory = resolve(out, "particles", pack.key);
    const data = JSON.parse(
      gunzipSync(readFileSync(resolve(directory, "particle.data"))).toString(
        "utf8",
      ),
    ) as {
      effects: Array<{ name: string }>;
    };
    const report = JSON.parse(
      readFileSync(resolve(directory, "particle-pack-report.json"), "utf8"),
    ) as {
      omittedEmptyEffects: string[];
    };
    const available = new Set(data.effects.map(({ name }) => name));
    const omitted = new Set(report.omittedEmptyEffects);
    const absent = new Set(nativeParticlePresencePolicy(pack.key).absent);
    const missing = [...referencedParticleNames].filter(
      (name) =>
        !absent.has(name) &&
        !available.has(name) &&
        !omitted.has(name) &&
        !optionalCapabilities.has(name),
    );
    if (missing.length)
      throw new Error(
        pack.key +
          " particle pack is missing engine effects: " +
          missing.join(", "),
      );
    particleEffectCount += data.effects.length;
  }
  writeFileSync(
    resolve(out, "native-particle-use.json"),
    JSON.stringify(
      {
        schema: "our-notes-particle-use-v1",
        cacheKey: particleBuild.cacheKey,
        reused: particleBuild.reused,
        sourceId: particleBuild.report.sourceId,
        releaseId: particleBuild.report.releaseId,
        requestedSourceId: inputProvenance.sourceId,
        requestedReleaseId: inputProvenance.releaseId,
        requestParticleProjectionInputs: particleBuild.requestInputCount,
        requestProjectionMatchesQualifiedInputs:
          particleBuild.projectionMatches,
      },
      null,
      2,
    ) + "\n",
  );
  buildPresentationThumbnails(out);
  console.log(
    `${particleBuild.reused ? "reused verified" : "rebuilt qualified"} native particles and phase16 ROM: ${particleEffectCount} profile effects`,
  );

  rmSync(resolve(out, "effects"), { recursive: true, force: true });
  for (const group of OUR_NOTES_NOTE_SE_GROUP_IDS) {
    const effectSourceDir =
      group === 1 ? source : resolve(source, "effects", String(group));
    const effectOutputDir = resolve(out, "effects", String(group));
    mkdirSync(effectOutputDir, { recursive: true });
    const effectSourceFile = resolve(effectSourceDir, "effect.data");
    const effectData = requireJsonObject(
      parseJson(
        gunzipSync(readFileSync(effectSourceFile)).toString("utf8"),
        effectSourceFile,
      ),
      `effect.data group ${group}`,
    );
    const effectClips = effectData.clips;
    if (!Array.isArray(effectClips))
      throw new Error(`effect.data group ${group} clips must be an array`);
    for (const [index, value] of effectClips.entries()) {
      const entry = requireJsonObject(
        value,
        `effect.data group ${group} clips[${index}]`,
      );
      if (typeof entry.name !== "string")
        throw new Error(
          `effect.data group ${group} clips[${index}].name must be a string`,
        );
      entry.name = entry.name.replace(/^Sekai /, "Our Notes ");
    }
    writeFileSync(
      resolve(effectOutputDir, "effect.data"),
      gzipSync(JSON.stringify(effectData), { level: 9 }),
    );
    copyFileSync(
      resolve(effectSourceDir, "effect.audio"),
      resolve(effectOutputDir, "effect.audio"),
    );
    if (group === 1) {
      copyFileSync(
        resolve(effectOutputDir, "effect.data"),
        resolve(out, "effect.data"),
      );
      copyFileSync(
        resolve(effectOutputDir, "effect.audio"),
        resolve(out, "effect.audio"),
      );
    }
  }

  console.log(
    `built Our Notes Sonolus resources: ${nativeSkinPacks.map((pack) => `${pack.skinName}=${pack.sprites + draw.skins.find(({ key }) => key === pack.skinName)!.addedSprites + frame.skins.find(({ key }) => key === pack.skinName)!.addedSprites} sprites/${pack.nativeArea} native px`).join(", ")}, ` +
      `${particleEffectCount} profile particle effects ` +
      `-> ${out} (validated release inputs: ${inputProvenance.sourceId}/${inputProvenance.releaseId})`,
  );
} finally {
  rmSync(particleBuild.temporaryDirectory, { recursive: true, force: true });
}
