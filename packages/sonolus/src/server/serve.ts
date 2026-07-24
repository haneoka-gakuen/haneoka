// Standalone Sonolus server for "BanG Dream! Our Notes" (Live section).
//
// Programmatic @sonolus/express server: loads free-pack defaults (skin/effect/
// particle/background), registers the `ourNotes` play engine (built by
// sonolus-cli into engine/play/dist), and generates one level per registered
// (music × difficulty) by converting its Ss chart → LevelData at boot.
//
// Run: `node packages/sonolus/dist/serve.mjs` (bundle via scripts/build-serve.ts).
// Connect the Sonolus app to http://<host>:<port>/sonolus.
//
// Assets are resolved through the selected release-server workspace (paths derived in
// jacketPath/chartPath). Decoded CRI music is attached when its mapped mp3 is
// present; missing cues degrade to a silent level without breaking chart data.

import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { Srl } from "@sonolus/core";
import {
  Sonolus,
  type BackgroundItemModel,
  type EffectItemModel,
  type EngineItemModel,
  type LevelItemModel,
  type ParticleItemModel,
  type PlaylistItemModel,
  type SkinItemModel,
} from "@sonolus/express";
import { packPath } from "@sonolus/free-pack";
import { chartToLevelData, convertChart } from "../convert";
import { SONOLUS_ITEM_VERSIONS } from "./itemVersions";
import { buildLevelMetas, type BandRow, type LevelMeta, type MusicRow, type ScoreRow, type TextRow } from "./levelMeta";
import { resolveSonolusReleaseWorkspace } from "./releaseWorkspace";

// Repo root: the server is run from the repo root (cwd), or set OUR_NOTES_ROOT.
const ROOT = process.env.OUR_NOTES_ROOT ?? process.cwd();
const PORT = Number(process.env.PORT ?? 3000);
const ADDRESS = process.env.SONOLUS_ADDRESS ?? `http://localhost:${PORT}`;
const ENGINE_NAME = "ourNotes";
const releaseServer = process.env.RELEASE_SERVER || "jp-cbt";
const workspace = resolveSonolusReleaseWorkspace(releaseServer, ROOT);
const FEATURED_ITEM_COUNT = 5;
const RANDOM_LEVEL_DIFFICULTIES = ["hard", "expert", "special", "master"] as const;

const EMPTY_SRL: Srl = {};

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type MasterName = "MasterLiveMusic" | "MasterLiveMusicScore" | "MasterText" | "MasterBand" | "MasterSoundCueSheet";

interface SoundCueSheetRow {
  _id: number;
  _cueSheetName: string;
}

type MasterRow = MusicRow | ScoreRow | TextRow | BandRow | SoundCueSheetRow;
type JsonRowGuard<T> = (value: JsonValue) => value is JsonObject & T;
type LevelEntry = { meta: LevelMeta; level: LevelItemModel };

function pickRandomItems<T>(items: readonly T[], count = FEATURED_ITEM_COUNT): T[] {
  const shuffled = [...items];
  const limit = Math.min(count, shuffled.length);
  for (let index = 0; index < limit; index++) {
    const selected = index + Math.floor(Math.random() * (shuffled.length - index));
    [shuffled[index], shuffled[selected]] = [shuffled[selected], shuffled[index]];
  }
  return shuffled.slice(0, limit);
}

function isRandomLevelCandidate(level: LevelItemModel): boolean {
  return RANDOM_LEVEL_DIFFICULTIES.some((difficulty) => level.name.endsWith(`-${difficulty}`));
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: JsonValue | undefined): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function isMusicRow(value: JsonValue): value is JsonObject & MusicRow {
  if (!isJsonObject(value)) return false;
  return (
    typeof value._id === "number" &&
    typeof value._titleTextID === "string" &&
    (value._bandIDs === undefined || isNumberArray(value._bandIDs)) &&
    (value._bandNameTextID === undefined || typeof value._bandNameTextID === "string") &&
    typeof value._lyricistTextID === "string" &&
    typeof value._composerTextID === "string" &&
    typeof value._arrangerTextID === "string" &&
    typeof value._jacketAssetName === "string" &&
    typeof value._musicSoundID === "number" &&
    typeof value._liveScoreRankGroup === "number" &&
    typeof value._easyID === "number" &&
    typeof value._normalID === "number" &&
    typeof value._hardID === "number" &&
    typeof value._expertID === "number"
  );
}

function isScoreRow(value: JsonValue): value is JsonObject & ScoreRow {
  if (!isJsonObject(value)) return false;
  return (
    typeof value._id === "number" &&
    typeof value._musicScoreTextFileName === "string" &&
    typeof value._musicScoreLevel === "number" &&
    typeof value._fullComboCount === "number"
  );
}

function isTextRow(value: JsonValue): value is JsonObject & TextRow {
  if (!isJsonObject(value)) return false;
  return (
    typeof value._id === "string" &&
    typeof value._japanese === "string" &&
    typeof value._english === "string" &&
    typeof value._simplifiedChinese === "string" &&
    typeof value._traditionalChinese === "string" &&
    typeof value._korean === "string"
  );
}

function isBandRow(value: JsonValue): value is JsonObject & BandRow {
  return isJsonObject(value) && typeof value._id === "number" && typeof value._nameTextID === "string";
}

function isSoundCueSheetRow(value: JsonValue): value is JsonObject & SoundCueSheetRow {
  return isJsonObject(value) && typeof value._id === "number" && typeof value._cueSheetName === "string";
}

function validateMasterRows<T>(name: MasterName, values: JsonValue[], guard: JsonRowGuard<T>): T[] {
  const rows: T[] = [];
  for (const [index, value] of values.entries()) {
    if (!guard(value)) throw new Error(`${name}.json contains an invalid row at _allData[${index}]`);
    rows.push(value);
  }
  return rows;
}

function master(name: "MasterLiveMusic"): MusicRow[];
function master(name: "MasterLiveMusicScore"): ScoreRow[];
function master(name: "MasterText"): TextRow[];
function master(name: "MasterBand"): BandRow[];
function master(name: "MasterSoundCueSheet"): SoundCueSheetRow[];
function master(name: MasterName): MasterRow[] {
  const parsed: JsonValue = JSON.parse(readFileSync(resolve(workspace.masterRoot, `${name}.json`), "utf8"));
  if (!isJsonObject(parsed) || !Array.isArray(parsed._allData)) {
    throw new Error(`${name}.json is missing an _allData array`);
  }

  switch (name) {
    case "MasterLiveMusic":
      return validateMasterRows(name, parsed._allData, isMusicRow);
    case "MasterLiveMusicScore":
      return validateMasterRows(name, parsed._allData, isScoreRow);
    case "MasterText":
      return validateMasterRows(name, parsed._allData, isTextRow);
    case "MasterBand":
      return validateMasterRows(name, parsed._allData, isBandRow);
    case "MasterSoundCueSheet":
      return validateMasterRows(name, parsed._allData, isSoundCueSheetRow);
  }
}

function jacketPath(jacketAsset: string): string | null {
  const file = resolve(workspace.assetsRoot, "Assets/AddressableResources/Image/Jacket", `${jacketAsset}.png`);
  return existsSync(file) ? file : null;
}

function chartPath(chartFile: string): string | null {
  const file = resolve(workspace.assetsRoot, "Assets/AddressableResources/Live/MusicScore", `${chartFile}.bytes`);
  return existsSync(file) ? file : null;
}

// BGM cue name → mp3. Rule (verified, 33/33 songs): "M_Mayoiuta" → letter
// subfolder from the prefix + "<rest>", file = "<cueName>.mp3"; a cue with no
// "_" (e.g. "kk") sits directly under "<cueName>". CRI media lives under the
// release runtime CRI audio. musicSoundID → cueName via MasterSoundCueSheet
// (loaded in main).
function bgmPath(cueName: string | undefined): string | null {
  if (!cueName) return null;
  const us = cueName.indexOf("_");
  const relative =
    us >= 0
      ? `cri/sound/${cueName.slice(0, us).toLowerCase()}/${cueName.slice(us + 1).toLowerCase()}`
      : `cri/sound/${cueName.toLowerCase()}`;
  const p = resolve(workspace.runtimeRoot, relative, `${cueName}.mp3`);
  return existsSync(p) ? p : null;
}

function main() {
  const music = master("MasterLiveMusic");
  const scores = master("MasterLiveMusicScore");
  const texts = master("MasterText");
  const bands = master("MasterBand");
  const metasJa = buildLevelMetas(music, scores, texts, "_japanese", bands);
  const metasEn = buildLevelMetas(music, scores, texts, "_english", bands);
  const enByName = new Map(metasEn.map((m) => [m.name, m]));

  // musicSoundID → BGM cue name (MasterSoundCueSheet), for bgmPath().
  const cueByMsid = new Map<number, string>();
  for (const r of master("MasterSoundCueSheet")) cueByMsid.set(r._id, r._cueSheetName);
  // cache the added bgm SRL per song (shared across its 4 difficulties).
  const bgmCache = new Map<string, Srl>();

  const s = new Sonolus({ address: ADDRESS, fallbackLocale: "ja" });
  // Keep the free pack's server plumbing, but do not expose its pixel/8bit
  // gameplay resources. This engine is only valid with its projected Our Notes
  // resources; substituting a generic pack silently changes the presentation.
  s.load(packPath);
  s.skin.items.length = 0;
  s.particle.items.length = 0;
  s.effect.items.length = 0;
  s.background.items.length = 0;
  // NOTE: load() overwrites title/description from the pack's db.info, so set
  // our identity AFTER loading.
  s.title = { ja: "haneoka", en: "haneoka" };
  s.description = { ja: "BanG Dream! Our Notes", en: "BanG Dream! Our Notes" };
  const bannerFile = resolve(ROOT, "packages/sonolus/assets/server-banner.png");
  if (!existsSync(bannerFile)) throw new Error(`Sonolus server banner missing: ${bannerFile}`);
  const banner = s.add(readFileSync(bannerFile));

  // The note/lane skin is generated from skin001, the note sounds come from
  // the original CRI cues, and supported effect001 ParticleSystem data is
  // projected into Sonolus particle graphs. Missing source-derived artifacts
  // are fatal: no pixel/8bit replacement is visually equivalent.
  const resourceDir = resolve(ROOT, "packages/sonolus/dist/our-notes");
  const SKIN_NAME = "ourNotesSkin";
  const PARTICLE_NAME = "ourNotesParticle";
  const EFFECT_NAME = "ourNotesEffect";
  const requiredResourceFiles = [
    "skin.data",
    "skin.texture.png",
    "particle.data",
    "particle.texture.png",
    "effect.data",
    "effect.audio",
  ] as const;
  const missingResourceFiles = requiredResourceFiles.filter((file) => !existsSync(resolve(resourceDir, file)));
  if (missingResourceFiles.length) {
    throw new Error(`Our Notes resource artifact missing under ${resourceDir}: ${missingResourceFiles.join(", ")}`);
  }

  const skin: SkinItemModel = {
    name: SKIN_NAME,
    version: SONOLUS_ITEM_VERSIONS.skin,
    title: { ja: "Our Notes", en: "Our Notes" },
    subtitle: { ja: "オリジナル skin001", en: "Original skin001" },
    author: { en: "haneoka" },
    tags: [],
    thumbnail: EMPTY_SRL,
    data: s.add(readFileSync(resolve(resourceDir, "skin.data"))),
    texture: s.add(readFileSync(resolve(resourceDir, "skin.texture.png"))),
  };
  s.skin.items.push(skin);
  const particle: ParticleItemModel = {
    name: PARTICLE_NAME,
    version: SONOLUS_ITEM_VERSIONS.particle,
    title: { ja: "Our Notes", en: "Our Notes" },
    subtitle: { ja: "オリジナル effect001 投影", en: "Projected original effect001" },
    author: { en: "haneoka" },
    tags: [],
    thumbnail: EMPTY_SRL,
    data: s.add(readFileSync(resolve(resourceDir, "particle.data"))),
    texture: s.add(readFileSync(resolve(resourceDir, "particle.texture.png"))),
  };
  s.particle.items.push(particle);
  const effect: EffectItemModel = {
    name: EFFECT_NAME,
    version: SONOLUS_ITEM_VERSIONS.effect,
    title: { ja: "Our Notes", en: "Our Notes" },
    subtitle: { ja: "オリジナルノートSE", en: "Original note sounds" },
    author: { en: "haneoka" },
    tags: [],
    thumbnail: EMPTY_SRL,
    data: s.add(readFileSync(resolve(resourceDir, "effect.data"))),
    audio: s.add(readFileSync(resolve(resourceDir, "effect.audio"))),
  };
  s.effect.items.push(effect);
  const engineSkin = SKIN_NAME;
  const engineParticle = PARTICLE_NAME;
  const engineEffect = EFFECT_NAME;

  // --- BACKGROUNDS = both original lightweight concert stages. Sonolus can
  // override an engine default per play, so expose both instead of baking a
  // song/video-derived choice into the engine. ---
  const bgDir = resolve(ROOT, "packages/sonolus/dist/background");
  const backgroundSources = [
    {
      name: "ourNotesBgBlue",
      directory: "blue",
      title: { ja: "ブルーステージ", en: "Blue Stage" },
    },
    {
      name: "ourNotesBgTheatre",
      directory: "theatre",
      title: { ja: "シアターステージ", en: "Theatre Stage" },
    },
  ];
  const engineBg = backgroundSources[0].name;
  for (const background of backgroundSources) {
    const bgImageFile = resolve(bgDir, background.directory, "image.png");
    const bgThumbFile = resolve(bgDir, background.directory, "thumbnail.png");
    if (!existsSync(bgImageFile) || !existsSync(bgThumbFile)) {
      throw new Error(`Our Notes background artifact missing under ${resolve(bgDir, background.directory)}`);
    }
    const item: BackgroundItemModel = {
      name: background.name,
      version: SONOLUS_ITEM_VERSIONS.background,
      title: background.title,
      subtitle: { ja: "バンドリ！", en: "BanG Dream!" },
      author: { ja: "haneoka", en: "haneoka" },
      tags: [],
      thumbnail: s.add(readFileSync(bgThumbFile)),
      data: s.add(gzipSync(Buffer.from(JSON.stringify({ aspectRatio: 1536 / 1212, fit: "cover", color: "#03030a" })))),
      image: s.add(readFileSync(bgImageFile)),
      // Match the native BackgroundBrightness=.7 with a separate black layer.
      configuration: s.add(gzipSync(Buffer.from(JSON.stringify({ blur: 0, mask: "#0000004d" })))),
    };
    s.background.items.push(item);
  }

  // --- engine item — play/watch/preview/tutorial data. Settings come from the
  // built EngineConfiguration (speed, mirror, note-speed,
  // effects, connector alpha, preview/tutorial toggles, ...). ---
  const distDir = resolve(ROOT, "packages/sonolus/engine/dist");
  const playFile = resolve(distDir, "EnginePlayData");
  const watchFile = resolve(distDir, "EngineWatchData");
  const configFile = resolve(distDir, "EngineConfiguration");
  const previewFile = resolve(distDir, "EnginePreviewData");
  const tutorialFile = resolve(distDir, "EngineTutorialData");
  if (
    !existsSync(playFile) ||
    !existsSync(watchFile) ||
    !existsSync(previewFile) ||
    !existsSync(tutorialFile) ||
    !existsSync(configFile)
  ) {
    throw new Error(`engine artifact missing under ${distDir}`);
  }
  const engine: EngineItemModel = {
    name: ENGINE_NAME,
    version: SONOLUS_ITEM_VERSIONS.engine,
    title: { ja: "Our Notes", en: "Our Notes" },
    subtitle: { ja: "バンドリ！", en: "BanG Dream!" },
    author: { ja: "haneoka", en: "haneoka" },
    tags: [],
    skin: engineSkin,
    background: engineBg,
    effect: engineEffect,
    particle: engineParticle,
    thumbnail: EMPTY_SRL,
    playData: s.add(readFileSync(playFile)), // already gzipped by sonolus-cli
    watchData: s.add(readFileSync(watchFile)),
    previewData: s.add(readFileSync(previewFile)),
    tutorialData: s.add(readFileSync(tutorialFile)),
    configuration: s.add(readFileSync(configFile)),
  };
  s.engine.items.push(engine);

  // --- level items (one per registered chart) ---
  let added = 0;
  let skipped = 0;
  const levelEntries: LevelEntry[] = [];
  for (const meta of metasJa) {
    const cp = chartPath(meta.chartFile);
    if (!cp) {
      skipped++;
      continue;
    }
    let data: Srl;
    try {
      const chart = convertChart(readFileSync(cp, "utf8"));
      const levelData = chartToLevelData(chart);
      data = s.add(gzipSync(Buffer.from(JSON.stringify(levelData))));
    } catch (error) {
      skipped++;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  skip ${meta.name}: ${message}`);
      continue;
    }
    const jp = jacketPath(meta.jacketAsset);
    const cover: Srl = jp ? s.add(readFileSync(jp)) : EMPTY_SRL;
    // BGM (per-song, cached): resolve the cue name → mp3 → SRL.
    const cueName = cueByMsid.get(meta.musicSoundId);
    let bgm: Srl = EMPTY_SRL;
    if (cueName) {
      const cached = bgmCache.get(cueName);
      if (cached) {
        bgm = cached;
      } else {
        const mp3 = bgmPath(cueName);
        bgm = mp3 ? s.add(readFileSync(mp3)) : EMPTY_SRL;
        bgmCache.set(cueName, bgm);
      }
    }
    const en = enByName.get(meta.name);
    const level: LevelItemModel = {
      name: meta.name,
      version: SONOLUS_ITEM_VERSIONS.level,
      rating: meta.rating,
      title: { ja: meta.title, en: en?.title || meta.title },
      artists: { ja: meta.artists, en: en?.artists || meta.artists },
      author: { ja: meta.artists, en: en?.artists || meta.artists },
      tags: [{ title: { ja: meta.difficulty, en: meta.difficulty } }],
      engine: ENGINE_NAME,
      useSkin: { useDefault: true },
      useBackground: { useDefault: true },
      useEffect: { useDefault: true },
      useParticle: { useDefault: true },
      cover,
      bgm,
      data,
    };
    levelEntries.push({ meta, level });
    added++;
  }

  // MasterLiveMusic is ordered from older to newer songs. Reverse the level
  // entries so both normal lists and the #NEWEST section lead with new songs;
  // every song's difficulties are then Expert → Easy.
  levelEntries.reverse();
  s.level.items.push(...levelEntries.map(({ level }) => level));

  // Sonolus playlists represent songs. Their embedded levels are the
  // available difficulties, while their thumbnail/title come from the song's
  // highest available difficulty.
  const levelsByMusicId = new Map<number, LevelEntry[]>();
  for (const entry of levelEntries) {
    const entries = levelsByMusicId.get(entry.meta.musicId);
    if (entries) entries.push(entry);
    else levelsByMusicId.set(entry.meta.musicId, [entry]);
  }

  const featuredLevels: LevelItemModel[] = [];
  for (const entries of levelsByMusicId.values()) {
    const primary = entries[0];
    if (!primary) continue;
    const en = enByName.get(primary.meta.name);
    const playlist: PlaylistItemModel = {
      name: `ourNotes-${primary.meta.musicId}`,
      version: 1,
      title: { ja: primary.meta.title, en: en?.title || primary.meta.title },
      subtitle: { ja: primary.meta.artists, en: en?.artists || primary.meta.artists },
      author: { ja: "haneoka", en: "haneoka" },
      tags: [],
      levels: entries.map(({ level }) => level),
      thumbnail: primary.level.cover,
    };
    s.playlist.items.push(playlist);
    featuredLevels.push(primary.level);
  }
  const preferredRandomLevels = featuredLevels.filter(isRandomLevelCandidate);
  const randomLevels = preferredRandomLevels;

  s.level.infoHandler = () => ({
    sections: [
      {
        title: { ja: "ランダム", en: "#RANDOM" },
        icon: "shuffle",
        itemType: "level",
        items: pickRandomItems(randomLevels),
      },
      {
        title: { ja: "最新", en: "#NEWEST" },
        itemType: "level",
        items: featuredLevels.slice(0, FEATURED_ITEM_COUNT),
      },
    ],
  });
  s.playlist.infoHandler = () => ({
    sections: [
      {
        title: { ja: "ランダム", en: "#RANDOM" },
        icon: "shuffle",
        itemType: "playlist",
        items: pickRandomItems(s.playlist.items),
      },
      {
        title: { ja: "最新", en: "#NEWEST" },
        itemType: "playlist",
        items: s.playlist.items.slice(0, FEATURED_ITEM_COUNT),
      },
    ],
  });
  s.serverInfoHandler = () => ({
    title: s.title,
    description: s.description,
    banner,
    buttons: [
      { type: "playlist" },
      { type: "level" },
      { type: "skin" },
      { type: "background" },
      { type: "effect" },
      { type: "particle" },
      { type: "engine" },
      { type: "configuration" },
    ],
    configuration: { options: {} },
  });

  const app = express();
  app.use(s.router);
  app.listen(PORT, () => {
    const bgmSongs = [...bgmCache.values()].filter((v) => v !== EMPTY_SRL).length;
    console.log(`Sonolus server listening: ${ADDRESS}/sonolus`);
    console.log(`  engine: ${ENGINE_NAME} (play + watch), skin: ${engineSkin}`);
    console.log(`  levels: ${added} added, ${skipped} skipped; bgm: ${bgmSongs} songs`);
    console.log(
      `  defaults: skin=[${s.skin.items.map((i) => i.name)}] effect=[${s.effect.items.map(
        (i) => i.name,
      )}] particle=[${s.particle.items.map((i) => i.name)}] background=[${s.background.items.map((i) => i.name)}]`,
    );
  });
}

main();
