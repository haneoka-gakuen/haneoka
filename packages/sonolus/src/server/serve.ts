import { fileURLToPath } from "node:url";
import { buildServerBanner } from "./serverBanner.ts";
import { buildSquareThumbnail } from "../../scripts/presentation-thumbnails.ts";
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
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { sonolusLevelName, sonolusPlaylistName } from "@haneoka/sonolus-core";
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
import { chartToLevelData, convertChart } from "@haneoka/cassiopeia-plugin-sonolus";
import { OUR_NOTES_NOTE_SE_GROUP_IDS, OUR_NOTES_NOTE_SE_GROUP_NAMES } from "@haneoka/cassiopeia-plugin-our-notes";
import { encodeSonolusLocalizedText, OUR_NOTES_SONOLUS_ITEM_NAMES } from "../sonolusLocalization";
import { SONOLUS_ITEM_VERSIONS } from "./itemVersions";
import { buildLevelMetas, type BandRow, type LevelMeta, type MusicRow, type ScoreRow, type TextRow } from "./levelMeta";
import { resolveSonolusReleaseWorkspace } from "./releaseWorkspace";

// Repo root: the server is run from the repo root (cwd), or set OUR_NOTES_ROOT.
const engineRoot = process.env.SONOLUS_ENGINE_ROOT ?? dirname(fileURLToPath(import.meta.resolve("@haneoka/sonolus-our-notes/package.json")));

const ROOT = process.env.OUR_NOTES_ROOT ?? process.cwd();
const PORT = Number(process.env.PORT ?? 3000);
const ADDRESS = process.env.SONOLUS_ADDRESS ?? `http://localhost:${PORT}`;
const ENGINE_NAME = "ourNotes";
const releaseServer = process.env.RELEASE_SERVER || "intl";
const workspace = resolveSonolusReleaseWorkspace(releaseServer, ROOT);
const FEATURED_ITEM_COUNT = 5;
const RANDOM_LEVEL_DIFFICULTIES = ["hard", "expert", "special", "master"] as const;

const EMPTY_SRL: Srl = {};

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type MasterName =
  | "MasterLiveMusic"
  | "MasterLiveMusicScore"
  | "MasterText"
  | "MasterBand"
  | "MasterSoundCueSheet"
  | "MasterLiveNoteSkin";

interface SoundCueSheetRow {
  _id: number;
  _cueSheetName: string;
}

type MasterRow =
  | MusicRow
  | ScoreRow
  | TextRow
  | BandRow
  | SoundCueSheetRow
  | { _id: number; _assetName: string; _skinNameTextId: string };
type JsonRowGuard<T> = (value: JsonValue) => value is JsonObject & T;
type LevelEntry = { meta: LevelMeta; level: LevelItemModel };

function pickRandomItems<T>(items: readonly T[], count = FEATURED_ITEM_COUNT): T[] {
  const shuffled = [...items];
  const limit = Math.min(count, shuffled.length);
  for (let index = 0; index < limit; index++) {
    const selected = index + Math.floor(Math.random() * (shuffled.length - index));
    [shuffled[index], shuffled[selected]] = [shuffled[selected]!, shuffled[index]!];
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
function master(name: "MasterLiveNoteSkin"): Array<{ _id: number; _assetName: string; _skinNameTextId: string }>;
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
    case "MasterLiveNoteSkin":
      return parsed._allData as Array<{ _id: number; _assetName: string; _skinNameTextId: string }>;
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

// BGM cue name → mp3. Current release layout (r-31fd…): music lives under
// cri/sound/musicscore/<cueName>/1_<cueName>.mp3. The legacy rule ("M_x" →
// letter subfolder + "<cueName>.mp3") is kept as a fallback for older
// release layouts. musicSoundID → cueName via MasterSoundCueSheet.
function bgmPath(cueName: string | undefined): string | null {
  if (!cueName) return null;
  const us = cueName.indexOf("_");
  const relative =
    us >= 0
      ? `cri/sound/${cueName.slice(0, us).toLowerCase()}/${cueName.slice(us + 1).toLowerCase()}`
      : `cri/sound/${cueName.toLowerCase()}`;
  const legacy = resolve(workspace.runtimeRoot, relative, `${cueName}.mp3`);
  if (existsSync(legacy)) return legacy;
  const musicscore = resolve(workspace.runtimeRoot, "cri/sound/musicscore", cueName, `1_${cueName}.mp3`);
  return existsSync(musicscore) ? musicscore : null;
}

function main() {
  const music = master("MasterLiveMusic");
  const scores = master("MasterLiveMusicScore");
  const texts = master("MasterText");
  const bands = master("MasterBand");
  const metasJa = buildLevelMetas(music, scores, texts, "_japanese", bands);
  const metasEn = buildLevelMetas(music, scores, texts, "_english", bands);
  const enByName = new Map(metasEn.map((m) => [m.name, m]));

  const localizedMetas = {
    ja: new Map(metasJa.map((meta) => [meta.name, meta])),
    en: enByName,
    zhs: new Map(buildLevelMetas(music, scores, texts, "_simplifiedChinese", bands).map((meta) => [meta.name, meta])),
    zht: new Map(buildLevelMetas(music, scores, texts, "_traditionalChinese", bands).map((meta) => [meta.name, meta])),
    ko: new Map(buildLevelMetas(music, scores, texts, "_korean", bands).map((meta) => [meta.name, meta])),
  };
  const localizedMeta = (meta: LevelMeta, field: "title" | "artists"): Record<string, string> =>
    Object.fromEntries(
      Object.entries(localizedMetas).map(([locale, values]) => [locale, values.get(meta.name)?.[field] || meta[field]]),
    );

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
  const serverBanner = s.add(readFileSync(buildServerBanner(ROOT)));
  const iconFile = resolve(ROOT, "packages/sonolus/assets/engine-icon.png");
  if (!existsSync(iconFile)) throw new Error(`Sonolus application icon missing: ${iconFile}`);
  const itemThumbnail = s.add(readFileSync(iconFile));

  // The note/lane skin is generated from skin001, the note sounds come from
  // the original CRI cues, and supported effect001 ParticleSystem data is
  // projected into Sonolus particle graphs. Missing source-derived artifacts
  // are fatal: no pixel/8bit replacement is visually equivalent.
  const resourceDir = resolve(ROOT, "packages/sonolus/dist/our-notes");
  const PARTICLE_NAME = "ourNotesParticle";
  // SONOLUS_PARTICLE_DIR serves a candidate particle pack (particle.data/.texture.png) for local playtests.
  const particleDir = process.env.SONOLUS_PARTICLE_DIR ?? resourceDir;
  const requiredResourceFiles = [
    "skins/skin001/skin.data",
    "skins/skin001/skin.texture.png",
    "skins/skin001/thumbnail.png",
    "skins/skin002/skin.data",
    "skins/skin002/skin.texture.png",
    "skins/skin002/thumbnail.png",
    "skins/skin003/skin.data",
    "skins/skin003/skin.texture.png",
    "skins/skin003/thumbnail.png",
    "particle.data",
    "particle.texture.png",
    "particle.thumbnail.png",
    ...OUR_NOTES_NOTE_SE_GROUP_IDS.flatMap((group) => [
      `effects/${group}/effect.data`,
      `effects/${group}/effect.audio`,
    ]),
  ] as const;
  const missingResourceFiles = requiredResourceFiles.filter((file) => !existsSync(resolve(resourceDir, file)));
  if (missingResourceFiles.length) {
    throw new Error(`Our Notes resource artifact missing under ${resourceDir}: ${missingResourceFiles.join(", ")}`);
  }

  // The note/lane skins are the Cassiopeia-migrated skin001/002/003 packs;
  // skin001 stays the engine default. Titles come from MasterLiveNoteSkin's
  // own text ids so the local server names them exactly like the game
  // (アワーノーツ / ガルパ / ハニカム in the current release).
  const textById = new Map(master("MasterText").map((row) => [row._id, row]));
  const localizedText = (id: string): { ja: string; en: string } => {
    const row = textById.get(id);
    return { ja: row?._japanese ?? id, en: row?._english ?? row?._japanese ?? id };
  };
  const skinNameByAsset = new Map(master("MasterLiveNoteSkin").map((row) => [row._assetName, row._skinNameTextId]));
  const skinItems: SkinItemModel[] = (
    [
      ["skin001", "ourNotesSkin"],
      ["skin002", "ourNotesSkin002"],
      ["skin003", "ourNotesSkin003"],
    ] as const
  ).map(([skinId, name]) => ({
    name,
    version: SONOLUS_ITEM_VERSIONS.skin,
    title: localizedText(skinNameByAsset.get(skinId) ?? `NoteSkinName_${skinId.slice(-1)}`),
    subtitle: { ja: "Our Notes", en: "Our Notes" },
    author: { en: "haneoka" },
    tags: [],
    thumbnail: s.add(readFileSync(resolve(resourceDir, "skins", skinId, "thumbnail.png"))),
    data: s.add(readFileSync(resolve(resourceDir, "skins", skinId, "skin.data"))),
    texture: s.add(readFileSync(resolve(resourceDir, "skins", skinId, "skin.texture.png"))),
  }));
  for (const skin of skinItems) s.skin.items.push(skin);
  const engineSkin = "ourNotesSkin";
  const particle: ParticleItemModel = {
    name: PARTICLE_NAME,
    version: SONOLUS_ITEM_VERSIONS.particle,
    title: { ja: "Our Notes", en: "Our Notes" },
    subtitle: { ja: "オリジナル effect001 投影", en: "Projected original effect001" },
    author: { en: "haneoka" },
    tags: [],
    thumbnail: s.add(readFileSync(resolve(resourceDir, "particle.thumbnail.png"))),
    data: s.add(readFileSync(resolve(particleDir, "particle.data"))),
    texture: s.add(readFileSync(resolve(particleDir, "particle.texture.png"))),
  };
  s.particle.items.push(particle);
  const effectItems: EffectItemModel[] = OUR_NOTES_NOTE_SE_GROUP_IDS.map((group) => {
    const effectResourceDir = resolve(resourceDir, "effects", String(group));
    return {
      name: OUR_NOTES_SONOLUS_ITEM_NAMES.effects[group],
      version: SONOLUS_ITEM_VERSIONS.effect,
      title: { ja: encodeSonolusLocalizedText(OUR_NOTES_NOTE_SE_GROUP_NAMES[group]!, "ja") },
      subtitle: { ja: "オリジナルノートSE", en: "Original note sounds" },
      author: { en: "haneoka" },
      tags: [],
      thumbnail: itemThumbnail,
      data: s.add(readFileSync(resolve(effectResourceDir, "effect.data"))),
      audio: s.add(readFileSync(resolve(effectResourceDir, "effect.audio"))),
    };
  });
  s.effect.items.push(...effectItems);
  const defaultEffect = effectItems[0];
  if (!defaultEffect) throw new Error("Native effect item list is empty");
  const engineParticle = PARTICLE_NAME;
  const engineEffect = defaultEffect.name;

  // --- BACKGROUNDS = both original lightweight concert stages. Sonolus can
  // override an engine default per play, so expose both instead of baking a
  // song/video-derived choice into the engine. ---
  const bgDir = resolve(ROOT, "packages/sonolus/dist/background");
  // Every native lightweight stage, named from MasterBand so the local server
  // matches the game's stage list; band 0 is the generic stage. Item ids use
  // the band names (MyGO!!!!!/Ave Mujica/...), not legacy colour codenames.
  const bandNameById = new Map(master("MasterBand").map((row) => [row._id, row._nameTextID]));
  const backgroundSources = (
    [
      [0, "ourNotesBgStage", "stage", { ja: "ステージ", en: "Stage" }],
      [1, "ourNotesBgMyGO", "mygo", null],
      [2, "ourNotesBgAveMujica", "ave-mujica", null],
      [3, "ourNotesBgMugendaiMewType", "mugendai-mewtype", null],
      [4, "ourNotesBgMillsage", "millsage", null],
      [5, "ourNotesBgIkkaDumbRock", "ikka-dumb-rock", null],
    ] as const
  ).map(([bandId, name, directory, fallback]) => ({
    bandId,
    name,
    directory,
    title: fallback ?? localizedText(bandNameById.get(bandId) ?? ""),
  }));
  const engineBg = "ourNotesBgMyGO";
  for (const background of backgroundSources) {
    const bgImageFile = resolve(bgDir, background.directory, "image.png");
    const bgThumbFile = resolve(bgDir, background.directory, "thumbnail.png");
    if (!existsSync(bgImageFile) || !existsSync(bgThumbFile)) {
      throw new Error(`Our Notes background artifact missing under ${resolve(bgDir, background.directory)}`);
    }
    const thumbnailSource = resolve(
      workspace.assetsRoot,
      `Assets/AddressableResources/Band/${background.bandId}/live_stage/lightweight_background.png`,
    );
    if (!existsSync(thumbnailSource)) throw new Error(`Background thumbnail source missing: ${thumbnailSource}`);
    const item: BackgroundItemModel = {
      name: background.name,
      version: SONOLUS_ITEM_VERSIONS.background,
      title: background.title,
      subtitle: { ja: "バンドリ！", en: "BanG Dream!" },
      author: { ja: "haneoka", en: "haneoka" },
      tags: [],
      thumbnail: s.add(buildSquareThumbnail(readFileSync(thumbnailSource), thumbnailSource)),
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
  const distDir = resolve(engineRoot, "dist");
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
    thumbnail: itemThumbnail,
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
    const cover: Srl = jp ? s.add(readFileSync(jp)) : itemThumbnail;
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
    const level: LevelItemModel = {
      name: sonolusLevelName(releaseServer, meta.musicId, meta.difficulty),
      version: SONOLUS_ITEM_VERSIONS.level,
      rating: meta.rating,
      title: localizedMeta(meta, "title"),
      artists: localizedMeta(meta, "artists"),
      author: localizedMeta(meta, "artists"),
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
    const playlist: PlaylistItemModel = {
      name: sonolusPlaylistName(releaseServer, primary.meta.musicId),
      version: 1,
      title: localizedMeta(primary.meta, "title"),
      subtitle: localizedMeta(primary.meta, "artists"),
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
    banner: serverBanner,
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

  const imageHashes = new Set<string>();
  if (serverBanner.hash) imageHashes.add(serverBanner.hash);
  const resourceUrls = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string" && record.url.startsWith("/sonolus/repository/")) {
      record.url = new URL(record.url, ADDRESS).href;
    }
    for (const [key, entry] of Object.entries(record)) {
      if ((key === "thumbnail" || key === "cover") && entry && typeof entry === "object") {
        const hash = (entry as Srl).hash;
        if (typeof hash === "string" && hash) imageHashes.add(hash);
      }
      resourceUrls(entry);
    }
  };
  resourceUrls([
    serverBanner,
    s.level.items,
    s.playlist.items,
    s.skin.items,
    s.background.items,
    s.effect.items,
    s.particle.items,
    s.engine.items,
  ]);
  const app = express();
  app.use((request, response, next) => {
    const hash = /^\/sonolus\/repository\/([a-f0-9]{40})$/u.exec(request.path)?.[1];
    if ((request.method === "GET" || request.method === "HEAD") && hash && imageHashes.has(hash))
      response.type("image/png");
    next();
  });
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
