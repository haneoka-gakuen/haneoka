import { fileURLToPath } from "node:url";
import { buildServerBanner } from "./serverBanner.ts";
import { buildSquareThumbnail } from "../../scripts/presentation-thumbnails.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type {
  BackgroundItem,
  EffectItem,
  EngineItem,
  LevelItem,
  ParticleItem,
  PlaylistItem,
  ServerInfo,
  ServerItemDetails,
  ServerItemInfo,
  ServerItemList,
  ServerItemSectionTyped,
  SkinItem,
  Srl,
} from "@sonolus/core";
import { sonolusLevelName, sonolusPlaylistName, sonolusSourceRoot } from "@haneoka/sonolus-core";
import {
  OUR_NOTES_LANE_SKIN_NAMES,
  OUR_NOTES_NOTE_SE_GROUP_IDS,
  OUR_NOTES_NOTE_EFFECT_SKIN_NAMES,
  OUR_NOTES_NOTE_SE_GROUP_NAMES,
  OUR_NOTES_NOTE_SKIN_NAMES,
  OUR_NOTES_STAGE_NAMES,
} from "@haneoka/cassiopeia-plugin-our-notes";
import { chartToLevelData, convertChart } from "@haneoka/cassiopeia-plugin-sonolus";
import { SONOLUS_ITEM_VERSIONS, type SonolusItemType } from "./itemVersions";
import { resolveLocalReleaseFile, resolveSonolusReleaseWorkspace } from "./releaseWorkspace";
import { validateSonolusInputProvenance } from "./sonolusProvenance";
import {
  createOurNotesSonolusItemLabels,
  encodeSonolusLocalizedText,
  OUR_NOTES_SONOLUS_ITEM_NAMES,
  type SonolusLocalizedLabels,
} from "../sonolusLocalization";

const engineRoot = dirname(fileURLToPath(import.meta.resolve("@haneoka/sonolus-our-notes/package.json")));

const root = resolve(process.env.OUR_NOTES_ROOT || process.cwd());
const pkg = resolve(root, "packages/sonolus");

// The engine + presentation payload is server-agnostic: it changes only when the
// engine or its assets change, not per release. Built engine-only
// (`SONOLUS_ENGINE_ONLY`) into `SONOLUS_OUTPUT_DIR` (the shared global target) and
// served by every server; charts are projected dynamically per release at serve
// time, so they are never baked here. The legacy per-release bake still targets
// `SONOLUS_WORKER_ASSETS_DIR`.
const engineOnly = process.env.SONOLUS_ENGINE_ONLY === "1";
const outRoot = resolve(
  process.env.SONOLUS_OUTPUT_DIR || process.env.SONOLUS_WORKER_ASSETS_DIR || resolve(root, "dist"),
);
const finalSonolusRoot = resolve(outRoot, "sonolus");
const stagedSonolusRoot = resolve(outRoot, `.sonolus-build-${process.pid}`);
const repoRoot = resolve(stagedSonolusRoot, "repository");
const address = sonolusSourceRoot(process.env.SONOLUS_ADDRESS || "https://haneoka.org");
const haneokaBase = process.env.SONOLUS_HANEOKA_BASE || "https://haneoka.org";
const releaseServer = process.env.RELEASE_SERVER || "intl";
const workspace = resolveSonolusReleaseWorkspace(releaseServer, root);
const inputProvenance = validateSonolusInputProvenance(workspace, root);
const songsUrl = process.env.SONOLUS_SONGS_URL || `${haneokaBase}/api/v1/servers/${releaseServer}/songs`;
const localSongsFile = resolve(workspace.apiRoot, "songs.json");

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type LocalizedValue = string | Array<string | null> | { [locale: string]: string | null };

interface SongDifficulty {
  file?: string | null;
  chartUrl?: string | null;
  url?: string | null;
  difficultyName?: string | null;
  playLevel?: number | null;
  displayLevel?: string | number | null;
  publishedAt?: number | Array<number | null> | null;
}

interface SongAudio {
  playableUrl?: string | null;
}

interface Song {
  musicId: number;
  musicTitle: LocalizedValue;
  bandId?: number | null;
  bandIDs?: number[] | null;
  bandIds?: number[] | null;
  bandName?: LocalizedValue | null;
  band?: LocalizedValue | null;
  artist?: LocalizedValue | null;
  composer?: LocalizedValue | null;
  lyricist?: LocalizedValue | null;
  arranger?: LocalizedValue | null;
  difficulty?: SongDifficulty[] | null;
  jacketUrl?: string | null;
  musicUrl?: string | null;
  publishedAt?: number | Array<number | null> | null;
  audio?: SongAudio | null;
}

interface MasterTextRow {
  _id: string;
  _japanese: string;
  _english: string;
  _simplifiedChinese: string;
  _traditionalChinese: string;
  _korean: string;
}

interface MasterBandRow {
  _id: number;
  _nameTextID: string;
}

interface SonolusItemMap {
  playlist: PlaylistItem;
  level: LevelItem;
  skin: SkinItem;
  background: BackgroundItem;
  effect: EffectItem;
  particle: ParticleItem;
  engine: EngineItem;
}

type SonolusItem = SonolusItemMap[SonolusItemType];
type GroupInfo<T extends SonolusItemType> = Omit<ServerItemInfo, "sections"> & {
  sections: Array<ServerItemSectionTyped<T, SonolusItemMap[T]>>;
};
type GroupDetails<T extends SonolusItemType> = Omit<ServerItemDetails<SonolusItemMap[T]>, "sections"> & {
  sections: Array<ServerItemSectionTyped<T, SonolusItemMap[T]>>;
};

const emptySrl: Srl = {};
const difficultyNames = ["easy", "normal", "hard", "expert", "special", "master"] as const;
const randomDifficulties = new Set(["hard", "expert", "special", "master"]);

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: JsonValue | undefined): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function isLocalizedValue(value: JsonValue | undefined): value is LocalizedValue {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.every((entry) => entry === null || typeof entry === "string");
  return isJsonObject(value) && Object.values(value).every((entry) => entry === null || typeof entry === "string");
}

function isOptionalString(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalLocalizedValue(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || isLocalizedValue(value);
}

function isOptionalPublishedAt(value: JsonValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    typeof value === "number" ||
    (Array.isArray(value) && value.every((entry) => entry === null || typeof entry === "number"))
  );
}

function publishedAt(value: SongDifficulty["publishedAt"] | Song["publishedAt"] | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (Array.isArray(value)) {
    const timestamp = value.find(
      (entry): entry is number => typeof entry === "number" && Number.isFinite(entry) && entry > 0,
    );
    if (timestamp !== undefined) return Math.max(0, timestamp);
  }
  return 0;
}

function isSongDifficulty(value: JsonValue): value is JsonObject & SongDifficulty {
  if (!isJsonObject(value)) return false;
  return (
    isOptionalString(value.file) &&
    isOptionalString(value.chartUrl) &&
    isOptionalString(value.url) &&
    (value.difficultyName === undefined || value.difficultyName === null || typeof value.difficultyName === "string") &&
    (value.playLevel === undefined || value.playLevel === null || typeof value.playLevel === "number") &&
    (value.displayLevel === undefined ||
      value.displayLevel === null ||
      typeof value.displayLevel === "string" ||
      typeof value.displayLevel === "number") &&
    isOptionalPublishedAt(value.publishedAt)
  );
}

function isSongAudio(value: JsonValue): value is JsonObject & SongAudio {
  return isJsonObject(value) && isOptionalString(value.playableUrl);
}

function isSong(value: JsonValue): value is JsonObject & Song {
  if (!isJsonObject(value)) return false;
  return (
    typeof value.musicId === "number" &&
    isLocalizedValue(value.musicTitle) &&
    (value.bandId === undefined || value.bandId === null || typeof value.bandId === "number") &&
    (value.bandIDs === undefined || value.bandIDs === null || isNumberArray(value.bandIDs)) &&
    (value.bandIds === undefined || value.bandIds === null || isNumberArray(value.bandIds)) &&
    isOptionalLocalizedValue(value.bandName) &&
    isOptionalLocalizedValue(value.band) &&
    isOptionalLocalizedValue(value.artist) &&
    isOptionalLocalizedValue(value.composer) &&
    isOptionalLocalizedValue(value.lyricist) &&
    isOptionalLocalizedValue(value.arranger) &&
    (value.difficulty === undefined ||
      value.difficulty === null ||
      (Array.isArray(value.difficulty) && value.difficulty.every(isSongDifficulty))) &&
    isOptionalString(value.jacketUrl) &&
    isOptionalString(value.musicUrl) &&
    isOptionalPublishedAt(value.publishedAt) &&
    (value.audio === undefined || value.audio === null || isSongAudio(value.audio))
  );
}

function parseSongs(value: JsonValue): Song[] {
  const values = Array.isArray(value) ? value : isJsonObject(value) ? Object.values(value) : null;
  if (!values) throw new Error("songs payload must be an object or array");

  const songs: Song[] = [];
  for (const [index, entry] of values.entries()) {
    if (!isSong(entry)) throw new Error(`songs payload contains an invalid entry at index ${index}`);
    songs.push(entry);
  }
  return songs;
}

function absoluteUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("http") ? value : `${haneokaBase}${value}`;
}

function chartUrl(_song: Song, _difficultyIndex: number, difficulty: SongDifficulty): string | undefined {
  return absoluteUrl(difficulty.file || difficulty.chartUrl || difficulty.url);
}

function externalSrl(value: string | null | undefined): Srl {
  const url = absoluteUrl(value);
  return url ? { url } : emptySrl;
}

function writeFile(path: string, body: Buffer | string) {
  const relativePath = path.replace(/^sonolus\//, "");
  const file = resolve(stagedSonolusRoot, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function writeJson<T>(path: string, body: T) {
  writeFile(path, JSON.stringify(body));
}

function addRaw(body: Buffer): Srl {
  const h = createHash("sha1").update(body).digest("hex");
  const file = resolve(repoRoot, h);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, body);
  return { hash: h, url: `/sonolus/repository/${h}` };
}

function addJson<T>(body: T): Srl {
  return addRaw(gzipSync(JSON.stringify(body), { level: 9 }));
}

function addFile(path: string): Srl {
  return addRaw(readFileSync(path));
}

async function addSquareThumbnail(url: string): Promise<Srl> {
  const pathname = new URL(url, haneokaBase).pathname;
  const local = resolveLocalReleaseFile(workspace, pathname);
  let bytes: Buffer;
  if (local && existsSync(local)) bytes = readFileSync(local);
  else {
    const response = await fetch(new URL(url, haneokaBase), { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Sonolus thumbnail source HTTP ${response.status}: ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  return addRaw(buildSquareThumbnail(bytes, url));
}

function text(value: LocalizedValue | null | undefined, fallback = ""): string {
  if (Array.isArray(value)) {
    return String(value[0] || value[1] || fallback);
  }
  return typeof value === "string" ? value : fallback;
}

const localMasterCache = new Map<string, JsonValue[]>();

function localMasterRows(name: string): JsonValue[] {
  const cached = localMasterCache.get(name);
  if (cached) return cached;
  const path = resolve(workspace.masterRoot, `${name}.json`);
  if (!existsSync(path)) return [];
  const parsed: JsonValue = JSON.parse(readFileSync(path, "utf8"));
  if (!isJsonObject(parsed) || !Array.isArray(parsed._allData)) {
    throw new Error(`${name}.json is missing an _allData array`);
  }
  const rows = parsed._allData;
  localMasterCache.set(name, rows);
  return rows;
}

function isMasterTextRow(value: JsonValue): value is JsonObject & MasterTextRow {
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

function isMasterBandRow(value: JsonValue): value is JsonObject & MasterBandRow {
  return isJsonObject(value) && typeof value._id === "number" && typeof value._nameTextID === "string";
}

function localMaster<T>(name: string, guard: (value: JsonValue) => value is JsonObject & T): T[] {
  const result: T[] = [];
  for (const [index, row] of localMasterRows(name).entries()) {
    if (!guard(row)) throw new Error(`${name}.json contains an invalid row at _allData[${index}]`);
    result.push(row);
  }
  return result;
}

function buildBandNames(): Map<number, string> {
  const texts = new Map(localMaster("MasterText", isMasterTextRow).map((row) => [row._id, row]));
  const bandNames = new Map<number, string>();

  for (const band of localMaster("MasterBand", isMasterBandRow)) {
    const row = texts.get(band._nameTextID);
    const name = row
      ? text(
          [row._japanese, row._english, row._simplifiedChinese, row._traditionalChinese, row._korean],
          band._nameTextID,
        )
      : band._nameTextID;
    if (name) bandNames.set(Number(band._id), name);
  }

  return bandNames;
}

function songBandName(song: Song, bandNames: Map<number, string>) {
  const bandIds = [
    ...new Set(
      [
        song.bandId,
        ...(Array.isArray(song.bandIDs) ? song.bandIDs : []),
        ...(Array.isArray(song.bandIds) ? song.bandIds : []),
      ]
        .map(Number)
        .filter(Number.isFinite),
    ),
  ];

  return (
    bandIds
      .map((id) => bandNames.get(Number(id)))
      .filter(Boolean)
      .join(" / ") ||
    text(song.bandName) ||
    text(song.band) ||
    text(song.artist)
  );
}

async function fetchJson(url: string): Promise<JsonValue> {
  // The Cloudflare API projection and decoded charts are build inputs already
  // present in this workspace. Prefer them so deploying the Worker does not
  // depend on the old production Worker being reachable. An explicit URL
  // override remains remote for staging/fixture builds.
  if (!process.env.SONOLUS_SONGS_URL && url === songsUrl && existsSync(localSongsFile)) {
    const value: JsonValue = JSON.parse(readFileSync(localSongsFile, "utf8"));
    return value;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  const value: JsonValue = JSON.parse(await res.text());
  return value;
}

async function fetchText(url: string): Promise<string> {
  let pathname: string | undefined;
  try {
    pathname = new URL(url, haneokaBase).pathname;
  } catch {
    // Fall through to fetch so the caller receives the original URL error.
  }
  const candidate = pathname ? resolveLocalReleaseFile(workspace, pathname) : null;
  if (candidate && existsSync(candidate)) {
    return readFileSync(candidate, "utf8");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.text();
}

function itemBase<TVersion extends SonolusItem["version"]>(
  name: string,
  version: TVersion,
  title: string,
  subtitle: string,
  author: string,
) {
  return {
    name,
    source: address,
    version,
    title,
    subtitle,
    author,
    tags: [],
  };
}

function nativeTitle(labels: Readonly<Record<string, SonolusLocalizedLabels>>, itemName: string): string {
  const label = labels[itemName];
  if (!label) throw new Error(`Missing native title for ${itemName}`);
  return encodeSonolusLocalizedText(label);
}

function assertItemVersions(type: SonolusItemType, items: readonly SonolusItem[]) {
  const expected = SONOLUS_ITEM_VERSIONS[type];
  for (const item of items) {
    if (item.version !== expected) {
      throw new Error(`invalid Sonolus ${type} version for ${item.name}: expected ${expected}, got ${item.version}`);
    }
  }
}

function paginate<T>(items: readonly T[], page: number, perPage = 20): ServerItemList<T> {
  return {
    pageCount: Math.ceil(items.length / perPage),
    items: items.slice(page * perPage, (page + 1) * perPage),
    searches: [],
  };
}

function sampleRandom<T>(items: readonly T[], count = 5): T[] {
  const remaining = [...items];
  const result: T[] = [];
  while (remaining.length && result.length < count) {
    const index = Math.floor(Math.random() * remaining.length);
    const [item] = remaining.splice(index, 1);
    if (item !== undefined) result.push(item);
  }
  return result;
}

function writeGroup<T extends SonolusItemType>(
  path: string,
  type: T,
  items: SonolusItemMap[T][],
  randomItems?: readonly SonolusItemMap[T][],
) {
  const sections: Array<ServerItemSectionTyped<T, SonolusItemMap[T]>> = [
    ...(randomItems ? [{ title: "#RANDOM", icon: "shuffle", itemType: type, items: randomItems.slice(0, 5) }] : []),
    { title: "#NEWEST", itemType: type, items: items.slice(0, 5) },
  ];
  const info: GroupInfo<T> = {
    creates: [],
    searches: [],
    sections,
  };
  writeJson(`sonolus/${path}/info`, info);

  const pageCount = Math.max(1, Math.ceil(items.length / 20));
  for (let page = 0; page < pageCount; page++) {
    writeJson(`sonolus/${path}/list/page-${page}`, paginate(items, page));
  }

  for (const [index, item] of items.entries()) {
    const details: GroupDetails<T> = {
      item,
      actions: [],
      hasCommunity: false,
      leaderboards: [],
      sections:
        type === "playlist"
          ? []
          : [
              {
                title: "#RECOMMENDED",
                icon: "star",
                itemType: type,
                items: items.slice(index + 1, index + 6),
              },
            ],
    };
    writeJson(`sonolus/${path}/${item.name}`, details);
  }
}

function requireFile(path: string) {
  if (!existsSync(path)) throw new Error(`missing required Sonolus build artifact: ${path}`);
  return path;
}

async function main() {
  // Fetching and converting every chart can fail midway. Build beside the
  // published tree so a transient upstream/network failure cannot turn a
  // previously valid server into a repository-only `/sonolus` directory.
  rmSync(stagedSonolusRoot, { recursive: true, force: true });
  mkdirSync(repoRoot, { recursive: true });

  const resourceDir = resolve(pkg, "dist/our-notes");
  const engineDir = resolve(engineRoot, "dist");
  const bannerFile = requireFile(resolve(pkg, "assets/server-banner.png"));
  const banner = addFile(bannerFile);
  const serverBanner = addFile(buildServerBanner(root));
  const itemThumbnail = addRaw(buildSquareThumbnail(readFileSync(bannerFile), bannerFile));

  const nativeLabels = createOurNotesSonolusItemLabels({
    noteSkins: OUR_NOTES_NOTE_SKIN_NAMES,
    laneSkins: OUR_NOTES_LANE_SKIN_NAMES,
    noteEffectSkins: OUR_NOTES_NOTE_EFFECT_SKIN_NAMES,
    stages: OUR_NOTES_STAGE_NAMES,
    noteSeGroups: OUR_NOTES_NOTE_SE_GROUP_NAMES,
  });
  const skinItems: SkinItem[] = (
    Object.keys(OUR_NOTES_SONOLUS_ITEM_NAMES.skins) as Array<"skin001" | "skin002" | "skin003">
  ).map((skinId) => {
    const name = OUR_NOTES_SONOLUS_ITEM_NAMES.skins[skinId];
    return {
      ...itemBase(name, SONOLUS_ITEM_VERSIONS.skin, nativeTitle(nativeLabels, name), "Our Notes", "haneoka"),
      thumbnail: addFile(requireFile(resolve(resourceDir, "skins", skinId, "thumbnail.png"))),
      data: addFile(requireFile(resolve(resourceDir, "skins", skinId, "skin.data"))),
      texture: addFile(requireFile(resolve(resourceDir, "skins", skinId, "skin.texture.png"))),
    };
  });
  const skin = skinItems[0];
  if (!skin) throw new Error("Native skin item list is empty");
  const particle: ParticleItem = {
    ...itemBase(
      OUR_NOTES_SONOLUS_ITEM_NAMES.particle,
      SONOLUS_ITEM_VERSIONS.particle,
      nativeTitle(nativeLabels, OUR_NOTES_SONOLUS_ITEM_NAMES.particle),
      "Our Notes",
      "haneoka",
    ),
    thumbnail: addFile(requireFile(resolve(resourceDir, "particle.thumbnail.png"))),
    data: addFile(requireFile(resolve(resourceDir, "particle.data"))),
    texture: addFile(requireFile(resolve(resourceDir, "particle.texture.png"))),
  };
  const effectItems: EffectItem[] = OUR_NOTES_NOTE_SE_GROUP_IDS.map((group) => {
    const name = OUR_NOTES_SONOLUS_ITEM_NAMES.effects[group];
    const effectResourceDir = resolve(resourceDir, "effects", String(group));
    return {
      ...itemBase(name, SONOLUS_ITEM_VERSIONS.effect, nativeTitle(nativeLabels, name), "Our Notes", "haneoka"),
      thumbnail: itemThumbnail,
      data: addFile(requireFile(resolve(effectResourceDir, "effect.data"))),
      audio: addFile(requireFile(resolve(effectResourceDir, "effect.audio"))),
    };
  });
  const effect = effectItems[0];
  if (!effect) throw new Error("Native effect item list is empty");
  const backgroundItems: BackgroundItem[] = [];
  for (const stageId of [0, 1, 2, 3, 4, 5] as const) {
    const name = OUR_NOTES_SONOLUS_ITEM_NAMES.stages[stageId];
    const image = `/assets/${releaseServer}/Assets/AddressableResources/Band/${stageId}/live_stage/lightweight_background.png`;
    backgroundItems.push({
      ...itemBase(name, SONOLUS_ITEM_VERSIONS.background, nativeTitle(nativeLabels, name), "BanG Dream!", "haneoka"),
      thumbnail: await addSquareThumbnail(image),
      data: addJson({ aspectRatio: 1536 / 1212, fit: "cover", color: "#03030a" }),
      image: externalSrl(image),
      // 0x4d is the closest 8-bit alpha to the native .3 black overlay,
      // preserving MasterOptionDefault BackgroundBrightness=.7.
      configuration: addJson({ blur: 0, mask: "#0000004d" }),
    });
  }
  const backgroundMyGO = backgroundItems[1];
  if (!backgroundMyGO) throw new Error("Native background item list is missing stage 1");
  const engine: EngineItem = {
    ...itemBase("ourNotes", SONOLUS_ITEM_VERSIONS.engine, "Our Notes", "BanG Dream!", "haneoka"),
    skin,
    background: backgroundMyGO,
    effect,
    particle,
    thumbnail: itemThumbnail,
    playData: addFile(requireFile(resolve(engineDir, "EnginePlayData"))),
    watchData: addFile(requireFile(resolve(engineDir, "EngineWatchData"))),
    previewData: addFile(requireFile(resolve(engineDir, "EnginePreviewData"))),
    tutorialData: addFile(requireFile(resolve(engineDir, "EngineTutorialData"))),
    configuration: addFile(requireFile(resolve(engineDir, "EngineConfiguration"))),
  };

  // Charts are projected dynamically per release at serve time, so the baked
  // level/playlist tree is only relevant to the legacy per-release payload. Skip it
  // entirely in engine-only mode and keep just the engine + presentation items.
  const levels: LevelItem[] = [];
  const levelsByMusicId = new Map<number, LevelItem[]>();
  const levelMusicId = new Map<string, number>();
  const levelPublishedAt = new Map<string, number>();
  const songPublishedAt = new Map<number, number>();

  if (!engineOnly) {
    const songs = parseSongs(await fetchJson(songsUrl));
    const bandNames = buildBandNames();

    for (const song of songs.sort((a, b) => Number(a.musicId) - Number(b.musicId))) {
      const artist =
        songBandName(song, bandNames) ||
        text(song.composer) ||
        text(song.lyricist) ||
        text(song.arranger) ||
        "BanG Dream!";
      for (const [index, diff] of (song.difficulty || []).entries()) {
        const fileUrl = chartUrl(song, index, diff);
        if (!fileUrl) continue;

        const chart = convertChart(await fetchText(fileUrl));
        const levelData = chartToLevelData(chart);
        const difficulty =
          diff.difficultyName?.toLocaleLowerCase("en-US") || difficultyNames[index] || `difficulty-${index}`;
        const item: LevelItem = {
          name: sonolusLevelName(releaseServer, song.musicId, difficulty),
          source: address,
          version: SONOLUS_ITEM_VERSIONS.level,
          rating: Number(diff.playLevel || diff.displayLevel || 0),
          engine,
          useSkin: { useDefault: true },
          useBackground: { useDefault: true },
          useEffect: { useDefault: true },
          useParticle: { useDefault: true },
          title: text(song.musicTitle, `Music ${song.musicId}`),
          artists: artist,
          author: artist,
          tags: [{ title: difficulty }],
          cover: externalSrl(song.jacketUrl),
          bgm: externalSrl(song.musicUrl || song.audio?.playableUrl),
          data: addJson(levelData),
        };
        levels.push(item);
        levelMusicId.set(item.name, song.musicId);
        const songLevels = levelsByMusicId.get(song.musicId);
        if (songLevels) songLevels.push(item);
        else levelsByMusicId.set(song.musicId, [item]);
        const releaseAt = publishedAt(diff.publishedAt ?? song.publishedAt);
        levelPublishedAt.set(item.name, releaseAt);
        songPublishedAt.set(song.musicId, Math.max(songPublishedAt.get(song.musicId) ?? 0, releaseAt));
      }
    }
  }

  const difficultyOrder = (item: LevelItem): number => {
    const difficulty = item.name.split("-").at(-1)?.toLocaleLowerCase("en-US");
    return { master: 0, special: 1, expert: 2, hard: 3, normal: 4, easy: 5 }[difficulty ?? ""] ?? 99;
  };
  const latestLevels = [...levels].sort((left, right) => {
    const published = (levelPublishedAt.get(right.name) ?? 0) - (levelPublishedAt.get(left.name) ?? 0);
    if (published) return published;
    const songId = (levelMusicId.get(right.name) ?? 0) - (levelMusicId.get(left.name) ?? 0);
    return songId || difficultyOrder(left) - difficultyOrder(right);
  });
  const playlists: PlaylistItem[] = [...levelsByMusicId.entries()]
    .sort(([leftId], [rightId]) => {
      const published = (songPublishedAt.get(rightId) ?? 0) - (songPublishedAt.get(leftId) ?? 0);
      return published || rightId - leftId;
    })
    .flatMap(([musicId, songLevels]) => {
      const orderedLevels = [...songLevels].sort((left, right) => difficultyOrder(left) - difficultyOrder(right));
      const primary = orderedLevels[0];
      if (!primary) return [];
      return [
        {
          ...itemBase(
            sonolusPlaylistName(releaseServer, musicId),
            SONOLUS_ITEM_VERSIONS.playlist,
            primary.title,
            primary.artists,
            primary.artists,
          ),
          levels: orderedLevels,
          thumbnail: primary.cover,
        },
      ];
    });

  if (!engineOnly) {
    assertItemVersions("level", levels);
    assertItemVersions("playlist", playlists);
  }
  assertItemVersions("skin", skinItems);
  assertItemVersions("background", backgroundItems);
  assertItemVersions("effect", effectItems);
  assertItemVersions("particle", [particle]);
  assertItemVersions("engine", [engine]);

  // Keep the Haneoka MPL terms, source location, and upstream MIT notice in
  // the deployed engine distribution, not only in the source checkout and CI artifact.
  writeFile("sonolus/licenses/haneoka-mpl-2.0.txt", readFileSync(resolve(root, "LICENSE")));
  const sourceRevision = [process.env.GITHUB_SHA, process.env.CF_PAGES_COMMIT_SHA].find((value) =>
    /^[0-9a-f]{40}$/i.test(value ?? ""),
  );
  const sourceUrl = sourceRevision
    ? `https://github.com/haneoka-gakuen/haneoka/tree/${sourceRevision}`
    : "https://github.com/haneoka-gakuen/haneoka";
  writeFile("sonolus/licenses/haneoka-source.txt", `Corresponding Haneoka Source Code Form:\n${sourceUrl}\n`);
  writeFile("sonolus/licenses/sonolus-pjsekai-engine.txt", readFileSync(resolve(engineRoot, "LICENSE.pjsekai.txt")));

  const serverInfo = {
    title: "haneoka",
    description: "BanG Dream! Our Notes",
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
    configuration: { options: [] },
  } satisfies ServerInfo;
  writeJson("sonolus/info", serverInfo);
  writeJson("sonolus/thumbnail-fallback", { thumbnail: itemThumbnail });

  if (!engineOnly) {
    const randomLevels = playlists.flatMap((playlist) => {
      const level = playlist.levels.find((item) => randomDifficulties.has(item.name.split("-").at(-1) ?? ""));
      return level ? [level] : [];
    });
    writeGroup("playlists", "playlist", playlists, sampleRandom(playlists));
    writeGroup("levels", "level", latestLevels, sampleRandom(randomLevels));
  }
  writeGroup("skins", "skin", skinItems);
  writeGroup("backgrounds", "background", backgroundItems);
  writeGroup("effects", "effect", effectItems);
  writeGroup("particles", "particle", [particle]);
  writeGroup("engines", "engine", [engine]);

  rmSync(finalSonolusRoot, { recursive: true, force: true });
  renameSync(stagedSonolusRoot, finalSonolusRoot);

  console.log(
    `built Sonolus ${engineOnly ? "engine payload" : `Worker assets: ${levels.length} levels`} ` +
      `from ${inputProvenance.sourceId}/${inputProvenance.releaseId} -> ${outRoot}`,
  );
}

try {
  await main();
} finally {
  rmSync(stagedSonolusRoot, { recursive: true, force: true });
}
