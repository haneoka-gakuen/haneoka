import { providerFetch, providerEdgeCache, type ProviderSourceReader, type ProviderExecutionContext, type ProviderFetchInit } from "./provider-source";
let sourceReader: ProviderSourceReader | undefined;
export function setSekaiSourceReader(reader?: ProviderSourceReader): void { sourceReader = reader; }
const sourceResponse = (input: RequestInfo | URL, init?: ProviderFetchInit): Promise<Response> => sourceReader ? sourceReader.response(input, init) : providerFetch(input, init);
import { BESTDORI_CACHE_POLICY, bestdoriCacheControl } from "@haneoka/bestdori/cache-policy";
import { convertBestdoriScenario, type BestdoriScenarioBase } from "@haneoka/bestdori/scenario";
import { SEKAI_UNITS as UNITS, sekaiUnitBands } from "../src/lib/sekai-units";

/**
 * Project Sekai data from Sekai Viewer, projected into the record shapes the
 * song catalogue and the story workspace already read from the Bestdori
 * provider. Japan carries the timeline; a regional server supplies titles and
 * scenario text for whatever it has released.
 */

type Obj = Record<string, unknown>;

const SOURCES = {
  jp: { master: "sekai-master-db-diff", assets: "sekai-jp-assets" },
  en: { master: "sekai-master-db-en-diff", assets: "sekai-en-assets" },
  tw: { master: "sekai-master-db-tc-diff", assets: "sekai-tc-assets" },
  cn: { master: "sekai-master-db-cn-diff", assets: "sekai-cn-assets" },
  kr: { master: "sekai-master-db-kr-diff", assets: "sekai-kr-assets" },
} as const;
export type SekaiRegion = keyof typeof SOURCES;
const isRegion = (value: string): value is SekaiRegion => value in SOURCES;

const MASTER_ORIGIN = "https://sekai-world.github.io";
const ASSET_ORIGIN = "https://storage.sekai.best";
export const SEKAI_API_PREFIX = "/api/v1/sekai";
export { songRecords as projectSekaiSongs, unitRecords as projectSekaiBands, storyList as projectSekaiEventStories, unitStoryList as projectSekaiUnitStories, characterStoryList as projectSekaiCharacterStories, cardStoryList as projectSekaiCardStories, areaTalkList as projectSekaiAreaStories, specialStoryList as projectSekaiSpecialStories, mysekaiTalkList as projectSekaiMySekaiStories, virtualLiveList as projectSekaiLiveStories, storyDetail as projectSekaiStory };
/** Bump when a projection changes so cached responses are not reused. */
const RESPONSE_VERSION = "6";
const JSON_CACHE_CONTROL = bestdoriCacheControl(BESTDORI_CACHE_POLICY.catalog);
const MEDIA_CACHE_CONTROL = bestdoriCacheControl(BESTDORI_CACHE_POLICY.media);
const CORS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, Content-Type",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, ETag",
};
const MEDIA_PATH =
  /^(?:music\/(?:jacket|long|music_score)|home\/banner|event_story|story\/(?:chapter_image|episode_image)|scenario\/background|sound\/(?:scenario|card_scenario|actionset)\/(?:voice|bgm|se)|character\/member_small|mysekai\/talk\/voice|virtual_live\/(?:mc\/voice|select\/banner))\/[\w./ ()★・-]+\.(?:webp|png|mp3|txt)$/u;

const DIFFICULTIES = ["easy", "normal", "hard", "expert", "master", "append"] as const;
const BACKGROUND_ASPECT = 2048 / 1261;
const BACKGROUND_STAGE_REF = "sekai:background";
/** Model size and vertical placement on the 1280×720 stage. */
const LIVE2D_SCALE = 1.9;
const LIVE2D_OFFSET_Y = -60;

const media = (region: SekaiRegion, path: string) => `${SEKAI_API_PREFIX}/${region}/media/${path}`;

const masterFlights = new Map<string, Promise<Obj[]>>();
const master = (region: SekaiRegion, name: string): Promise<Obj[]> => {
  const url = `${MASTER_ORIGIN}/${SOURCES[region].master}/${name}.json`;
  let pending = masterFlights.get(url);
  if (!pending) {
    pending = (sourceReader ? sourceReader.json(url).then(value => value as Obj[]) : sourceResponse(url, { cf: { cacheTtl: BESTDORI_CACHE_POLICY.upstream.edgeTtlSeconds, cacheEverything: true } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${name} ${region}: HTTP ${response.status}`);
        return (await response.json()) as Obj[];
      }))
      .finally(() => masterFlights.delete(url));
    masterFlights.set(url, pending);
  }
  return pending;
};
/** A regional table is optional: Japan alone is a complete answer. */
const regional = (region: SekaiRegion, name: string): Promise<Obj[]> =>
  region === "jp" ? Promise.resolve([]) : master(region, name).catch(() => []);
const byId = (rows: Obj[], key = "id") => new Map(rows.map((row) => [Number(row[key]), row]));

const serveJson = async (request: Request, ctx: ProviderExecutionContext, producer: () => Promise<unknown>) => {
  const key = new URL(request.url);
  const ids = key.searchParams.getAll("id").sort();
  key.search = `?_cv=${RESPONSE_VERSION}${ids.map((id) => `&id=${encodeURIComponent(id)}`).join("")}`;
  if (request.method === "GET") {
    const hit = await providerEdgeCache().match(new Request(key));
    if (hit) return hit;
  }
  let body: string;
  try {
    body = JSON.stringify(await producer());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: { code: "sekai_upstream", message } }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const response = new Response(request.method === "HEAD" ? null : body, {
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": JSON_CACHE_CONTROL },
  });
  if (request.method === "GET") ctx.waitUntil(providerEdgeCache().put(new Request(key), response.clone()));
  return response;
};

const proxyMedia = async (request: Request, bucket: string, path: string) => {
  const upstream = new Request(`${ASSET_ORIGIN}/${bucket}/${encodeURI(path)}`, {
    method: request.method,
  });
  for (const header of ["range", "if-range", "if-none-match"]) {
    const value = request.headers.get(header);
    if (value) upstream.headers.set(header, value);
  }
  const response = await sourceResponse(upstream, {
    cf: { cacheTtl: BESTDORI_CACHE_POLICY.media.maxAgeSeconds, cacheEverything: true },
  });
  const headers = new Headers(CORS);
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "etag"]) {
    const value = response.headers.get(header);
    if (value) headers.set(header, value);
  }
  headers.set("Cache-Control", response.ok ? MEDIA_CACHE_CONTROL : "no-store");
  return new Response(response.body, { status: response.status, headers });
};

/* ------------------------------------------------------------------ songs */

const songRecords = async (): Promise<Obj> => {
  const [musics, difficulties, vocals, tags] = await Promise.all([
    master("jp", "musics"),
    master("jp", "musicDifficulties"),
    master("jp", "musicVocals"),
    master("jp", "musicTags"),
  ]);
  const now = Date.now();
  const group = (rows: Obj[]) => {
    const groups = new Map<number, Obj[]>();
    for (const row of rows) {
      const id = Number(row.musicId);
      const list = groups.get(id);
      if (list) list.push(row);
      else groups.set(id, [row]);
    }
    return groups;
  };
  const levels = group(difficulties),
    versions = group(vocals),
    units = group(tags);
  return Object.fromEntries(
    musics
      .filter((music) => Number(music.publishedAt) <= now)
      .map((music) => {
        const id = Number(music.id);
        const bundle = String(music.assetbundleName);
        const jacket = media("jp", `music/jacket/${bundle}/${bundle}.webp`);
        const rows = levels.get(id) ?? [];
        const tagged = (units.get(id) ?? []).map((row) => String(row.musicTag));
        // A unit's cover of a virtual singer song carries both tags; the unit is the performer.
        const unit = tagged.find((tag) => tag !== "all" && tag !== "vocaloid") ?? "vocaloid";
        const audio = (versions.get(id) ?? [])
          .sort((a, b) => Number(a.seq) - Number(b.seq))
          .map((row) => media("jp", `music/long/${String(row.assetbundleName)}/${String(row.assetbundleName)}.mp3`));
        return [
          String(id),
          {
            musicId: id,
            musicTitle: String(music.title),
            bandId: UNITS.findIndex(([tag]) => tag === unit) + 1,
            jacketUrl: jacket,
            jacketThumbUrl: jacket,
            musicUrl: audio[0] ?? "",
            composer: String(music.composer),
            lyricist: String(music.lyricist),
            arranger: String(music.arranger),
            publishedAt: Number(music.publishedAt),
            releaseAt: Number(music.publishedAt),
            sourceServer: "jp",
            sourceUrl: `https://sekai.best/music/${id}`,
            difficulty: DIFFICULTIES.flatMap((difficulty) => {
              const row = rows.find((entry) => entry.musicDifficulty === difficulty);
              return row
                ? [
                    {
                      difficulty,
                      difficultyName: difficulty,
                      playLevel: Number(row.playLevel),
                      noteCount: Number(row.totalNoteCount),
                      file: media("jp", `music/music_score/${String(id).padStart(4, "0")}_01/${difficulty}.txt`),
                    },
                  ]
                : [];
            }),
            musicCategories: [],
            musicType: 0,
            // The chart starts this long after the audio does.
            chartOffsetMs: Number(music.fillerSec) * 1000,
          },
        ];
      }),
  );
};

const unitRecords = (): Obj => sekaiUnitBands();

/* ---------------------------------------------------------------- stories */

interface ResolvedEvent {
  /** The server whose text is served: the requested region once it has released the event. */
  server: SekaiRegion;
  event: Obj;
  story: Obj;
  startAt: number;
}

const resolveEvents = async (region: SekaiRegion): Promise<ResolvedEvent[]> => {
  const [events, stories, localEvents, localStories] = await Promise.all([
    master("jp", "events"),
    master("jp", "eventStories"),
    regional(region, "events"),
    regional(region, "eventStories"),
  ]);
  const now = Date.now();
  const eventById = byId(events),
    localEventById = byId(localEvents),
    localStoryByEvent = byId(localStories, "eventId");
  return stories.flatMap((story) => {
    const eventId = Number(story.eventId);
    const event = eventById.get(eventId);
    if (!event || Number(event.startAt) > now) return [];
    const localEvent = localEventById.get(eventId),
      localStory = localStoryByEvent.get(eventId);
    const released = localEvent && localStory && Number(localEvent.startAt) <= now;
    return [
      {
        server: released ? region : "jp",
        event: released ? localEvent : event,
        story: released ? localStory : story,
        startAt: Number(event.startAt),
      },
    ];
  });
};

const storyList = async (region: SekaiRegion): Promise<Obj> => {
  const items: [string, Obj][] = [];
  for (const { server, event, story, startAt } of await resolveEvents(region)) {
    const eventId = Number(story.eventId);
    const bundle = String(story.assetbundleName);
    const banner = media(server, `home/banner/${bundle}/${bundle}.webp`);
    for (const raw of story.eventStoryEpisodes as Obj[]) {
      const episodeNumber = Number(raw.episodeNo);
      const storyId = `event.${eventId}-${episodeNumber}`;
      items.push([
        storyId,
        {
          storyId,
          storyKey: storyId,
          scenarioId: String(raw.scenarioId),
          episodeNumber,
          chapterId: eventId,
          chapterKey: `sekai:event:${eventId}`,
          chapterName: String(event.name),
          chapterSort: startAt,
          storySort: eventId * 100 + episodeNumber,
          title: String(raw.title),
          publishedAt: startAt,
          releaseAt: startAt,
          sourceServer: server,
          eventId,
          eventName: String(event.name),
          image: banner,
          thumbnail: banner,
          episodeImage: media(server, `event_story/${bundle}/episode_image/${String(raw.assetbundleName)}.webp`),
        },
      ]);
    }
  }
  return Object.fromEntries(items);
};

const lowerFirst = (key: string) => key.charAt(0).toLowerCase() + key.slice(1);
const camel = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(camel)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [lowerFirst(key), camel(entry)]))
      : value;

/** Keeps a Sekai Character2dId clear of BanG Dream's character ids, which the converter gives icons. */
const CHARACTER_ID_BASE = 1_000_000;
const character = (value: unknown): { characterId?: number } =>
  Number(value) > 0 ? { characterId: CHARACTER_ID_BASE + Number(value) } : {};

/**
 * The game's scenario asset is the same structure the Bestdori converter
 * reads, with capitalised keys, `Character2dId`/`FacialName` in place of
 * `characterId`/`expressionName`, and its own asset layout.
 */
export const sekaiScenarioBase = (
  source: Obj,
  effects: ReadonlyMap<string, string> = new Map(),
  voices?: ReadonlySet<string>,
): BestdoriScenarioBase => {
  const asset = (path: string) => `/assets/jp/${path}`;
  const rows = (key: string) => (camel(source[key] ?? []) as Obj[]) ?? [];
  const background = (name: unknown) => asset(`scenario/background/${String(name)}/${String(name)}.webp`);
  const bgm = (name: unknown) =>
    name ? `BESTDORI##URL:${asset(`sound/scenario/bgm/${String(name)}/${String(name)}.mp3`)}` : "";
  return {
    scenarioSceneId: String(source.ScenarioId),
    firstBgm: bgm(source.FirstBgm),
    ...(source.FirstBackground
      ? { firstBackground: background(source.FirstBackground), firstBackgroundBundleName: "BESTDORI##URL" }
      : {}),
    appearCharacters: rows("AppearCharacters").map((entry) => ({
      ...character(entry.character2dId),
      costumeType: String(entry.costumeType ?? ""),
    })),
    layoutData: rows("LayoutData").map((layout) => ({
      type: Number(layout.type),
      ...character(layout.character2dId),
      costumeType: String(layout.costumeType ?? ""),
      motionName: String(layout.motionName ?? ""),
      expressionName: String(layout.facialName ?? ""),
      sideFrom: Number(layout.sideFrom),
      sideFromOffsetX: Number(layout.sideFromOffsetX),
      sideTo: Number(layout.sideTo),
      sideToOffsetX: Number(layout.sideToOffsetX),
      depthType: Number(layout.depthType),
      moveSpeedType: Number(layout.moveSpeedType),
    })),
    snippets: rows("Snippets").map((snippet) => ({
      actionType: Number(snippet.action),
      progressType: Number(snippet.progressBehavior),
      referenceIndex: Number(snippet.referenceIndex),
      delay: Number(snippet.delay),
    })),
    talkData: rows("TalkData").map((talk) => ({
      talkCharacters: ((talk.talkCharacters as Obj[]) ?? []).map((entry) => ({
        ...character(entry.character2dId),
      })),
      windowDisplayName: String(talk.windowDisplayName ?? ""),
      body: String(talk.body ?? ""),
      lipSyncMode: Number(talk.lipSync),
      motions: ((talk.motions as Obj[]) ?? []).map((motion) => ({
        ...character(motion.character2dId),
        motionName: String(motion.motionName ?? ""),
        expressionName: String(motion.facialName ?? ""),
        timingSyncValue: Number(motion.timingSyncValue),
      })),
      voices: ((talk.voices as Obj[]) ?? [])
        .filter((voice) => !voices || voices.has(`${String(voice.voiceId)}.mp3`))
        .map((voice) => ({
          ...character(voice.character2dId),
          voiceId: String(voice.voiceId),
          volume: Number(voice.volume),
        })),
      whenFinishCloseWindow: Number(talk.whenFinishCloseWindow),
    })),
    soundData: rows("SoundData").map((sound) => {
      const effect = effects.get(String(sound.se));
      return {
        bgm: bgm(sound.bgm),
        volume: Number(sound.volume),
        ...(effect ? { se: asset(effect), seBundleName: "BESTDORI##URL" } : {}),
      };
    }),
    specialEffectData: rows("SpecialEffectData").map((effect) =>
      effect.effectType === 7
        ? { effectType: 7, stringVal: "BESTDORI##URL", stringValSub: background(effect.stringVal) }
        : {
            effectType: Number(effect.effectType),
            stringVal: String(effect.stringVal ?? ""),
            duration: Number(effect.duration),
          },
    ),
  };
};

/**
 * An event's own effects sit beside its scenarios; the rest are in the shared
 * pack. The scenario does not say which, and a few names exist in neither, so
 * each is checked before the player is told to load it.
 */
const soundEffects = async (scenario: Obj, own: string): Promise<Map<string, string>> => {
  const names = [...new Set(((scenario.SoundData as Obj[]) ?? []).map((sound) => String(sound.Se ?? "")))].filter(
    Boolean,
  );
  const found = await Promise.all(
    names.map(async (name) => {
      const paths = [
        `sound/scenario/se/se_pack00001/${name}.mp3`,
        `sound/scenario/se/se_pack00001_b/${name}.mp3`,
        ...(own ? [`${own}/${name}.mp3`] : []),
      ];
      for (const path of paths) {
        const response = await sourceResponse(`${ASSET_ORIGIN}/${SOURCES.jp.assets}/${encodeURI(path)}`, {
          method: "HEAD",
          cf: { cacheTtl: BESTDORI_CACHE_POLICY.upstream.edgeTtlSeconds, cacheEverything: true },
        });
        if (response.ok) return [name, path] as const;
      }
      return undefined;
    }),
  );
  return new Map(found.filter((entry) => entry !== undefined));
};

/** Unit story keys in the game's order, with the units' official names. */
const STORY_UNITS: Readonly<Record<string, string>> = {
  piapro: "VIRTUAL SINGER",
  light_sound: "Leo/need",
  idol: "MORE MORE JUMP！",
  street: "Vivid BAD SQUAD",
  theme_park: "ワンダーランズ×ショウタイム",
  school_refusal: "25時、ナイトコードで。",
};

interface UnitEpisode {
  server: SekaiRegion;
  unit: Obj;
  chapter: Obj;
  episode: Obj;
}
const unitEpisodes = async (region: SekaiRegion): Promise<UnitEpisode[]> => {
  const [units, local] = await Promise.all([master("jp", "unitStories"), regional(region, "unitStories")]);
  const localEpisodes = new Map(
    local.flatMap((unit) =>
      (unit.chapters as Obj[]).flatMap((chapter) =>
        (chapter.episodes as Obj[]).map((episode) => [String(episode.scenarioId), episode] as const),
      ),
    ),
  );
  return units.flatMap((unit) =>
    (unit.chapters as Obj[]).flatMap((chapter) =>
      (chapter.episodes as Obj[]).map((episode) => {
        const translated = localEpisodes.get(String(episode.scenarioId));
        return { server: translated ? region : "jp", unit, chapter, episode: translated ?? episode };
      }),
    ),
  );
};

const unitStoryList = async (region: SekaiRegion): Promise<Obj> =>
  Object.fromEntries(
    (await unitEpisodes(region)).map(({ server, unit, chapter, episode }) => {
      // Numbered ids keep a unit's episodes in reading order wherever ids are sorted.
      const storyId = `unit.${String(unit.unit)}-${Number(episode.episodeNo)}`;
      const bundle = String(chapter.assetbundleName);
      const banner = media("jp", `story/chapter_image/chapter${Number(chapter.chapterNo)}/${bundle}.webp`);
      const name = STORY_UNITS[String(unit.unit)] ?? String(unit.unit);
      return [
        storyId,
        {
          storyId,
          storyKey: storyId,
          scenarioId: String(episode.scenarioId),
          episodeNumber: Number(episode.episodeNo),
          chapterId: Number(chapter.id),
          chapterKey: `sekai:unit:${String(unit.unit)}`,
          chapterName: name,
          chapterSort: Number(unit.seq),
          storySort: Number(unit.seq) * 1000 + Number(episode.episodeNo),
          title: String(episode.title),
          sourceServer: server,
          image: banner,
          thumbnail: banner,
          episodeImage: media("jp", `story/episode_image/${bundle}/${String(episode.assetbundleName)}.webp`),
        },
      ];
    }),
  );

interface ScenarioSource {
  server: SekaiRegion;
  scenarioId: string;
  path: string;
  /** Folder of the voice files; most scenarios keep them under `sound/scenario/voice`. */
  voices?: string;
  /** Lines from a script the game does not ship as an ADV scenario. */
  script?: () => Promise<Obj>;
  /** Where an event keeps its own sound effects. */
  effects: string;
}
const scenarioSource = async (region: SekaiRegion, storyId: string): Promise<ScenarioSource | undefined> => {
  let match: RegExpMatchArray | null;
  if ((match = /^event\.(\d+)-(\d+)$/.exec(storyId))) {
    const resolved = (await resolveEvents(region)).find(({ story }) => Number(story.eventId) === Number(match![1]));
    const episode = (resolved?.story.eventStoryEpisodes as Obj[] | undefined)?.find(
      (entry) => Number(entry.episodeNo) === Number(match![2]),
    );
    if (!resolved || !episode) return undefined;
    const bundle = String(resolved.story.assetbundleName);
    const scenarioId = String(episode.scenarioId);
    return {
      server: resolved.server,
      scenarioId,
      path: `event_story/${bundle}/scenario/${scenarioId}.asset`,
      effects: `event_story/${bundle}/scenario_se`,
    };
  }
  if ((match = /^unit\.([a-z_]+)-(\d+)$/.exec(storyId))) {
    const found = (await unitEpisodes(region)).find(
      ({ unit, episode }) => unit.unit === match![1] && Number(episode.episodeNo) === Number(match![2]),
    );
    if (!found) return undefined;
    const scenarioId = String(found.episode.scenarioId);
    return {
      server: found.server,
      scenarioId,
      path: `scenario/unitstory/${String(found.chapter.assetbundleName)}/${scenarioId}.asset`,
      effects: "",
    };
  }
  return undefined;
};

const otherSource = async (storyId: string): Promise<ScenarioSource | undefined> => {
  let match: RegExpMatchArray | null;
  const adv = (scenarioId: string, path: string, voices: string): ScenarioSource => ({
    server: "jp",
    scenarioId,
    path,
    effects: "",
    voices: `${voices}/${voiceFolder(scenarioId)}/`,
  });
  if ((match = /^character\.(\d+)$/.exec(storyId))) {
    const row = (await master("jp", "characterProfiles")).find((entry) => entry.characterId === Number(match![1]));
    if (!row?.scenarioId) return undefined;
    return adv(String(row.scenarioId), `scenario/profile/${String(row.scenarioId)}.asset`, "sound/scenario/voice");
  }
  if ((match = /^card\.(\d+)$/.exec(storyId))) {
    const episode = (await master("jp", "cardEpisodes")).find((entry) => entry.id === Number(match![1]));
    if (!episode) return undefined;
    const card = (await master("jp", "cards")).find((entry) => entry.id === episode.cardId);
    const bundle = String(episode.assetbundleName || card?.assetbundleName || "");
    const id = String(episode.scenarioId);
    return adv(id, `character/member/${bundle}/${id}.asset`, "sound/card_scenario/voice");
  }
  if ((match = /^area\.(\d+)$/.exec(storyId))) {
    const set = (await master("jp", "actionSets")).find((entry) => entry.id === Number(match![1]));
    if (!set?.scenarioId) return undefined;
    const id = String(set.scenarioId);
    return adv(id, `scenario/actionset/group${Math.floor(Number(set.id) / 100)}/${id}.asset`, "sound/actionset/voice");
  }
  if ((match = /^special\.(\d+)-(\d+)$/.exec(storyId))) {
    const story = (await master("jp", "specialStories")).find((entry) => entry.id === Number(match![1]));
    const episode = (story?.episodes as Obj[] | undefined)?.find((entry) => entry.episodeNo === Number(match![2]));
    if (!story || !episode) return undefined;
    const id = String(episode.scenarioId);
    // The opening's area conversation is stored with its action set.
    if (id.startsWith("op")) {
      const set = (await master("jp", "actionSets")).find((entry) => entry.scenarioId === id);
      if (set) return adv(id, `scenario/actionset/group${Math.floor(Number(set.id) / 100)}/${id}.asset`, "sound/actionset/voice");
    }
    const bundle = id.startsWith("op") ? story.assetbundleName : episode.assetbundleName;
    return adv(id, `scenario/special/${String(bundle)}/${id}.asset`, "sound/scenario/voice");
  }
  if ((match = /^mysekai\.(\d+)$/.exec(storyId))) {
    const talk = (await master("jp", "mysekaiCharacterTalks")).find((entry) => entry.id === Number(match![1]));
    if (!talk?.lua) return undefined;
    const id = String(talk.lua);
    return {
      server: "jp",
      scenarioId: id,
      path: `mysekai/talk/scenario/talk/${id}.lua.txt`,
      effects: "",
      voices: `mysekai/talk/voice/${id}/`,
      script: async () => {
        const response = await sourceResponse(`${ASSET_ORIGIN}/${SOURCES.jp.assets}/mysekai/talk/scenario/talk/${id}.lua.txt`);
        if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
        return scriptScenario(id, mysekaiLines(await response.text()));
      },
    };
  }
  if ((match = /^live\.(\d+)-(\d+)$/.exec(storyId))) {
    const live = (await master("jp", "virtualLives")).find((entry) => entry.id === Number(match![1]));
    const entry = ((live?.virtualLiveSetlists as Obj[] | undefined) ?? []).find(
      (row) => row.virtualLiveSetlistType === "mc" && row.seq === Number(match![2]),
    );
    if (!entry) return undefined;
    const id = String(entry.assetbundleName);
    return {
      server: "jp",
      scenarioId: id,
      path: `virtual_live/mc/scenario/${id}/${id}.asset`,
      effects: "",
      voices: `virtual_live/mc/voice/${id}/`,
      script: async () => {
        const [response, characters3d, names] = await Promise.all([
          sourceResponse(`${ASSET_ORIGIN}/${SOURCES.jp.assets}/virtual_live/mc/scenario/${id}/${id}.asset`),
          master("jp", "character3ds"),
          characterNames(),
        ]);
        if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
        const mc = (await response.json()) as { characterTalkEvents?: Obj[] };
        const character3d = byId(characters3d);
        const lines = [...(mc.characterTalkEvents ?? [])]
          .sort((a, b) => Number(a.Time) - Number(b.Time))
          .map((event) => ({
            speaker: names.get(Number(character3d.get(Number(event.Character3dId))?.characterId)) ?? "",
            text: String(event.Serif ?? ""),
            ...(event.VoiceKey ? { voice: String(event.VoiceKey) } : {}),
          }));
        return scriptScenario(id, lines);
      },
    };
  }
  return undefined;
};

const storyDetail = async (region: SekaiRegion, storyId: string): Promise<Obj> => {
  const source = (await scenarioSource(region, storyId)) ?? (await otherSource(storyId));
  if (!source) throw new Error(`unknown sekai story: ${storyId}`);
  const { scenarioId, path } = source;
  const voiceBundle = source.voices ?? `sound/scenario/voice/${voiceFolder(scenarioId)}/`;
  const voices = await listing(voiceBundle);
  // A regional server may list an episode before its text is uploaded.
  const servers = source.server === "jp" ? (["jp"] as const) : ([source.server, "jp"] as const);
  for (const server of servers) {
    let scenario: Obj;
    if (source.script) scenario = await source.script();
    else {
      const response = await sourceResponse(`${ASSET_ORIGIN}/${SOURCES[server].assets}/${encodeURI(path)}`, {
        cf: { cacheTtl: BESTDORI_CACHE_POLICY.upstream.edgeTtlSeconds, cacheEverything: true },
      });
      if (!response.ok) continue;
      scenario = (await response.json()) as Obj;
    }
    const { story } = convertBestdoriScenario(
      { Base: sekaiScenarioBase(scenario, await soundEffects(scenario, source.effects), voices) },
      {
        server,
        voiceBundle,
        // Backgrounds, music and voices are the same files on every server.
        proxify: (raw) => media("jp", raw.replace(/^\/assets\/[a-z]+\//, "")),
      },
    );
    const stage = story.runtime.stage;
    story.runtime.stages[BACKGROUND_STAGE_REF] = {
      ...stage,
      backgroundSize: { width: stage.backgroundSize.width, height: stage.backgroundSize.width / BACKGROUND_ASPECT },
    };
    for (const background of Object.values(story.assets.backgrounds)) {
      background.sourceAspectRatio = BACKGROUND_ASPECT;
      background.stageRef = BACKGROUND_STAGE_REF;
    }
    return { ...story, storyId, sourceServer: server };
  }
  throw new Error(`sekai story ${storyId} is unavailable`);
};

/* ------------------------------------------------------- other sections */

const listing = async (prefix: string): Promise<Set<string>> => {
  const response = await sourceResponse(
    `${ASSET_ORIGIN}/${SOURCES.jp.assets}/?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`,
    { cf: { cacheTtl: BESTDORI_CACHE_POLICY.upstream.edgeTtlSeconds, cacheEverything: true } },
  );
  if (!response.ok) return new Set();
  return new Set(
    [...(await response.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1]!.slice(prefix.length)),
  );
};

/** Given names as the game prints them over a line. */
const characterNames = async (): Promise<Map<number, string>> =>
  new Map((await master("jp", "gameCharacters")).map((row) => [Number(row.id), String(row.givenName)]));
const fullNames = async (): Promise<Map<number, string>> =>
  new Map(
    (await master("jp", "gameCharacters")).map((row) => [
      Number(row.id),
      `${String(row.firstName ?? "")}${String(row.givenName)}`,
    ]),
  );

type Item = Obj & { storyId: string };
const listItem = (
  storyId: string,
  chapter: { id: number; name: string; sort: number },
  episode: { number: number; title: string; sort: number; image?: string; publishedAt?: number },
): Item => ({
  storyId,
  storyKey: storyId,
  episodeNumber: episode.number,
  chapterId: chapter.id,
  chapterKey: `sekai:${storyId.slice(0, storyId.indexOf("."))}:${chapter.id}`,
  chapterName: chapter.name,
  chapterSort: chapter.sort,
  storySort: episode.sort,
  title: episode.title,
  sourceServer: "jp",
  ...(episode.publishedAt ? { publishedAt: episode.publishedAt, releaseAt: episode.publishedAt } : {}),
  ...(episode.image ? { image: episode.image, thumbnail: episode.image, episodeImage: episode.image } : {}),
});
const record = (items: Item[]): Obj => Object.fromEntries(items.map((item) => [item.storyId, item]));

const characterStoryList = async (): Promise<Obj> => {
  const [profiles, names, units] = await Promise.all([
    master("jp", "characterProfiles"),
    fullNames(),
    master("jp", "gameCharacterUnits"),
  ]);
  const unitOf = new Map<number, string>();
  for (const row of units)
    if (!unitOf.has(Number(row.gameCharacterId))) unitOf.set(Number(row.gameCharacterId), String(row.unit));
  const order = Object.keys(STORY_UNITS);
  return record(
    profiles
      .filter((row) => row.scenarioId)
      .map((row) => {
        const id = Number(row.characterId);
        const unit = unitOf.get(id) ?? "piapro";
        return listItem(
          `character.${id}`,
          { id: order.indexOf(unit) + 1, name: STORY_UNITS[unit] ?? unit, sort: order.indexOf(unit) },
          { number: id, title: names.get(id) ?? String(id), sort: id },
        );
      }),
  );
};

const cardStoryList = async (): Promise<Obj> => {
  const [episodes, cards, names] = await Promise.all([
    master("jp", "cardEpisodes"),
    master("jp", "cards"),
    fullNames(),
  ]);
  const now = Date.now();
  const cardById = byId(cards);
  return record(
    episodes.flatMap((episode) => {
      const card = cardById.get(Number(episode.cardId));
      if (!card || Number(card.releaseAt) > now) return [];
      const character = Number(card.characterId);
      const bundle = String(card.assetbundleName);
      return [
        listItem(
          `card.${Number(episode.id)}`,
          { id: character, name: names.get(character) ?? String(character), sort: character },
          {
            number: Number(episode.seq),
            title: `${String(card.prefix)} ${String(episode.title)}`,
            // Newest cards first within a character.
            sort: -Number(card.releaseAt) * 10 + Number(episode.seq),
            image: media("jp", `character/member_small/${bundle}/card_normal.webp`),
            publishedAt: Number(card.releaseAt),
          },
        ),
      ];
    }),
  );
};

const areaTalkList = async (): Promise<Obj> => {
  const [sets, areas, characters2d, names] = await Promise.all([
    master("jp", "actionSets"),
    master("jp", "areas"),
    master("jp", "character2ds"),
    characterNames(),
  ]);
  const areaById = byId(areas);
  const character2d = byId(characters2d);
  return record(
    sets
      .filter((set) => set.scenarioId)
      .map((set) => {
        const area = areaById.get(Number(set.areaId));
        const cast = ((set.characterIds as number[]) ?? [])
          .map((id) => names.get(Number(character2d.get(id)?.characterId)))
          .filter(Boolean);
        return listItem(
          `area.${Number(set.id)}`,
          { id: Number(set.areaId), name: String(area?.name ?? set.areaId), sort: Number(set.areaId) },
          { number: Number(set.id), title: cast.join("・") || String(set.scenarioId), sort: Number(set.id) },
        );
      }),
  );
};

/** Stories whose scenario is uploaded: the master can list an episode before its text exists. */
const uploaded = async (storyIds: readonly string[]): Promise<Set<string>> => {
  const sources = await Promise.all(
    storyIds.map(async (id) => [id, (await scenarioSource("jp", id)) ?? (await otherSource(id))] as const),
  );
  const folders = new Map<string, Promise<Set<string>>>();
  const present = new Set<string>();
  for (const [id, source] of sources) {
    if (!source || source.script) {
      if (source) present.add(id);
      continue;
    }
    const folder = source.path.slice(0, source.path.lastIndexOf("/") + 1);
    if (!folders.has(folder)) folders.set(folder, listing(folder));
    if ((await folders.get(folder)!).has(source.path.slice(folder.length))) present.add(id);
  }
  return present;
};

const specialStoryList = async (): Promise<Obj> => {
  const now = Date.now();
  const stories = (await master("jp", "specialStories")).filter((story) => Number(story.startAt) <= now);
  const id = (story: Obj, episode: Obj) => `special.${Number(story.id)}-${Number(episode.episodeNo)}`;
  const present = await uploaded(stories.flatMap((story) => (story.episodes as Obj[]).map((episode) => id(story, episode))));
  return record(
    stories
      .flatMap((story) =>
        (story.episodes as Obj[]).filter((episode) => present.has(id(story, episode))).map((episode) =>
          listItem(
            id(story, episode),
            // Newest first, as the game lists them.
            { id: Number(story.id), name: String(story.title), sort: -Number(story.startAt) },
            {
              number: Number(episode.episodeNo),
              title: String(episode.title),
              sort: Number(episode.episodeNo),
              publishedAt: Number(story.startAt),
            },
          ),
        ),
      ),
  );
};

const mysekaiTalkList = async (): Promise<Obj> => {
  const [talks, groups, units, names] = await Promise.all([
    master("jp", "mysekaiCharacterTalks"),
    master("jp", "mysekaiGameCharacterUnitGroups"),
    master("jp", "gameCharacterUnits"),
    characterNames(),
  ]);
  const groupById = byId(groups);
  const unitById = byId(units);
  const full = await fullNames();
  return record(
    talks.map((talk) => {
      const group = groupById.get(Number(talk.mysekaiGameCharacterUnitGroupId)) ?? {};
      const cast = Object.keys(group)
        .filter((key) => key.startsWith("gameCharacterUnitId"))
        .map((key) => Number(unitById.get(Number(group[key]))?.gameCharacterId))
        .filter((id) => id > 0);
      const lead = cast[0] ?? 0;
      return listItem(
        `mysekai.${Number(talk.id)}`,
        { id: lead, name: full.get(lead) ?? String(lead), sort: lead },
        {
          number: Number(talk.id),
          title: cast.map((id) => names.get(id)).join("・"),
          sort: Number(talk.id),
        },
      );
    }),
  );
};

const virtualLiveList = async (): Promise<Obj> => {
  const now = Date.now();
  return record(
    (await master("jp", "virtualLives"))
      .filter((live) => Number(live.startAt) <= now)
      .flatMap((live) =>
        ((live.virtualLiveSetlists as Obj[]) ?? [])
          .filter((entry) => entry.virtualLiveSetlistType === "mc")
          .map((entry, index) =>
            listItem(
              `live.${Number(live.id)}-${Number(entry.seq)}`,
              { id: Number(live.id), name: String(live.name), sort: -Number(live.startAt) },
              {
                number: index + 1,
                title: `MC ${index + 1}`,
                sort: Number(entry.seq),
                publishedAt: Number(live.startAt),
                image: media(
                  "jp",
                  `virtual_live/select/banner/${String(live.assetbundleName)}/${String(live.assetbundleName)}.webp`,
                ),
              },
            ),
          ),
      ),
  );
};

interface ScriptLine {
  speaker: string;
  text: string;
  voice?: string;
}
/** Talk lines of a My Sekai conversation script. */
const mysekaiLines = (lua: string): ScriptLine[] => {
  const lines: ScriptLine[] = [];
  let speaker = "",
    voice: string | undefined;
  const quoted = (value: string) => JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string;
  for (const raw of lua.split("\n")) {
    const line = raw.trim();
    let match: RegExpMatchArray | null;
    if ((match = /^label\("(.*)"\)$/.exec(line))) speaker = match[1]!;
    else if ((match = /^voice\("[^"]*",\s*"([^"]+)"/.exec(line))) voice = match[1];
    else if ((match = /^text\("(.*)"\)$/.exec(line))) {
      lines.push({ speaker, text: quoted(match[1]!.replace(/\\"/g, '"')), ...(voice ? { voice } : {}) });
      voice = undefined;
    }
  }
  return lines;
};

/** A spoken run as an ADV scenario: one talk per line, nothing staged. */
const scriptScenario = (id: string, lines: ScriptLine[]): Obj => ({
  ScenarioId: id,
  Snippets: lines.map((_, index) => ({ Action: 1, ProgressBehavior: 1, ReferenceIndex: index, Delay: 0 })),
  TalkData: lines.map((line) => ({
    TalkCharacters: [],
    WindowDisplayName: line.speaker,
    Body: line.text,
    Voices: line.voice ? [{ VoiceId: line.voice, Volume: 1 }] : [],
    Motions: [],
  })),
});

/** The game's own corrections for scenario ids whose voice folder is named differently. */
const VOICE_FOLDERS: Readonly<Record<string, string>> = {
  "areatalk03_266(20230607修正)": "areatalk03_266",
  "★4冬弥・泉_前半": "012043_touya01",
  "★4司・千秋_前半": "013042_tsukasa01",
  "★4類・夏目_後半": "016042_rui02",
};
const voiceFolder = (scenarioId: string) => {
  const event = /event_(\d+)/.exec(scenarioId);
  // Events 167–176 shipped their voices one number ahead.
  if (event && Number(event[1]) > 166 && Number(event[1]) < 177)
    return scenarioId.replace(/event_(\d+)/, `event_${Number(event[1]) + 1}`);
  return VOICE_FOLDERS[scenarioId] ?? scenarioId;
};

/* ----------------------------------------------------------------- live2d */

const LIVE2D_BUCKET = "sekai-live2d-assets";
const LIVE2D_PATH = /^live2d\/(?:model|motion)\/[\w./ -]+\.(?:json|moc3|png|webp)$/;
const live2dFile = (path: string) => `${SEKAI_API_PREFIX}/jp/live2d-file/${path}`;
const live2dJson = async <T>(path: string): Promise<T> => {
  const response = await sourceResponse(`${ASSET_ORIGIN}/${LIVE2D_BUCKET}/${path}`, {
    cf: { cacheTtl: BESTDORI_CACHE_POLICY.upstream.edgeTtlSeconds, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
};
const live2dFolders = async (prefix: string): Promise<string[]> => {
  const response = await sourceResponse(
    `${ASSET_ORIGIN}/${LIVE2D_BUCKET}/?list-type=2&delimiter=/&prefix=${encodeURIComponent(prefix)}`,
    { cf: { cacheTtl: BESTDORI_CACHE_POLICY.upstream.edgeTtlSeconds, cacheEverything: true } },
  );
  if (!response.ok) return [];
  return [...(await response.text()).matchAll(/<Prefix>([^<]+)<\/Prefix>/g)]
    .map((match) => match[1]!)
    .filter((folder) => folder !== prefix);
};

interface Live2dModel {
  modelName: string;
  modelBase: string;
  modelPath: string;
  modelFile: string;
}
interface MotionData {
  motions?: string[];
  expressions?: string[];
}

/** A character's poses and facials are shared by all of their costumes. */
const motionBase = async (model: Live2dModel, models: Live2dModel[]): Promise<string | undefined> => {
  const parent = model.modelPath.slice(0, model.modelPath.lastIndexOf("/") + 1);
  const folders = await live2dFolders(`live2d/motion/${parent}`);
  const own = folders.find((folder) => folder.endsWith(`/${model.modelBase}_motion_base/`));
  if (own) return own;
  if (folders.length === 1 && parent.split("/").length > 3) return folders[0];
  // A side costume ("v2_19ena_school_back") borrows the main character's set.
  const character = /^(?:v2_)?(\d\d)([a-z]+?)(?:_|$)/.exec(model.modelBase);
  if (!character) return undefined;
  const folder = `/main/${character[1]}_${character[2]}/`;
  const version = model.modelPath.split("/")[0];
  const main =
    models.find((entry) => entry.modelPath.startsWith(`${version}${folder}`)) ??
    models.find((entry) => entry.modelPath.includes(folder));
  return main && main !== model ? motionBase(main, models) : undefined;
};

interface Live2dCostume {
  folder: string;
  model: Live2dModel;
  motions: { name: string; file: string }[];
  expressions: { name: string; file: string }[];
}
const live2dCostume = async (id: string): Promise<Live2dCostume | undefined> => {
  const models = await live2dJson<Live2dModel[]>("live2d/model_list.json");
  // Later rows are later revisions of the same costume.
  const model = models.filter((entry) => entry.modelBase === id).at(-1);
  if (!model) return undefined;
  const folder = `live2d/model/${model.modelPath}`;
  const base = await motionBase(model, models);
  const data = (path: string) => live2dJson<MotionData>(path).catch((): MotionData => ({}));
  const [shared, own] = await Promise.all([
    base ? data(`${base}BuildMotionData.json`) : ({} as MotionData),
    data(`${folder}/motions/BuildMotionData.json`),
  ]);
  return {
    folder,
    model,
    motions: [
      ...(own.motions ?? []).map((name) => ({ name, file: live2dFile(`${folder}/motions/${name}.motion3.json`) })),
      ...(shared.motions ?? []).map((name) => ({ name, file: live2dFile(`${base}motion/${name}.motion3.json`) })),
    ],
    // The game stores a facial as a one-pose motion; the player wants an expression.
    expressions: (shared.expressions ?? []).map((name) => ({
      name,
      file: `${SEKAI_API_PREFIX}/jp/live2d-expression/${base}facial/${name}.exp3.json`,
    })),
  };
};

/**
 * The published manifest names only the mesh, textures and physics. The
 * player reads its motion and expression catalogue from the manifest, so the
 * character's shared set is written into it.
 */
const live2dManifest = async (id: string): Promise<Obj> => {
  const costume = await live2dCostume(id);
  if (!costume) throw new Error(`unknown sekai costume: ${id}`);
  const source = await live2dJson<{ FileReferences: Record<string, unknown>; Groups?: Obj[] }>(
    `${costume.folder}/${costume.model.modelFile}`,
  );
  const file = (name: unknown) => live2dFile(`${costume.folder}/${String(name)}`);
  const references = source.FileReferences;
  return {
    ...source,
    FileReferences: {
      Moc: file(references.Moc),
      Textures: (references.Textures as string[]).map(file),
      ...(references.Physics ? { Physics: file(references.Physics) } : {}),
      Motions: { "": costume.motions.map((motion) => ({ File: motion.file })) },
      Expressions: costume.expressions.map((expression) => ({ Name: expression.name, File: expression.file })),
    },
    Groups: (source.Groups ?? []).map((group) =>
      group.Name === "LipSync" && !(group.Ids as string[]).length ? { ...group, Ids: ["ParamMouthOpenY"] } : group,
    ),
  };
};

const live2dEntries = async (ids: string[]): Promise<Obj> => {
  const items: Obj = {};
  const missing: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const costume = await live2dCostume(id);
      if (!costume) {
        missing.push(id);
        return;
      }
      items[id] = {
        live2dKey: id,
        profile: {
          basePosition: { x: 0, y: 0, z: 0 },
          baseScale: 1,
          placement: {
            anchor: "stage",
            referenceWidth: 1280,
            referenceHeight: 720,
            fit: "height",
            scale: LIVE2D_SCALE,
            align: [0.5, 0.5],
            offset: [0, LIVE2D_OFFSET_Y],
          },
          presentationFadeInSeconds: -1,
          playDefaultMotionBeforePresentation: false,
          preservePresentationOnHide: true,
        },
        runtime: {
          model: `${SEKAI_API_PREFIX}/jp/live2d-model/${id}.model3.json`,
          motions: costume.motions.map(({ name, file }) => ({ name, runtime: file })),
          expressions: costume.expressions.map(({ name, file }) => ({ name, runtime: file })),
        },
      };
    }),
  );
  return { items, missing };
};

const facialExpression = async (path: string): Promise<Obj> => {
  const motion = await live2dJson<{ Curves?: { Target: string; Id: string; Segments: number[] }[] }>(
    path.replace(/\.exp3\.json$/, ".motion3.json"),
  );
  return {
    Type: "Live2D Expression",
    Parameters: (motion.Curves ?? [])
      .filter((curve) => curve.Target === "Parameter")
      .map((curve) => ({ Id: curve.Id, Value: curve.Segments[1] ?? 0, Blend: "Overwrite" })),
  };
};

/* ------------------------------------------------------------------ routes */

export async function handleSekaiApi(ctx: ProviderExecutionContext, request: Request, url: URL): Promise<Response | null> {
  const route = /^\/api\/v1\/sekai\/([a-z]+)\/(.+)$/.exec(url.pathname);
  if (!route || !isRegion(route[1]!)) return null;
  const region = route[1];
  const tail = route[2]!;
  if (tail === "songs") return serveJson(request, ctx, songRecords);
  if (tail === "bands") return serveJson(request, ctx, async () => unitRecords());
  // The catalogue asks every provider for these; Sekai has neither a cast index nor score metadata.
  if (tail === "characters" || tail === "song-meta") return serveJson(request, ctx, async () => ({}));
  if (tail === "stories/event") return serveJson(request, ctx, () => storyList(region));
  if (tail === "stories/unit") return serveJson(request, ctx, () => unitStoryList(region));
  const others: Record<string, () => Promise<Obj>> = {
    "stories/character": characterStoryList,
    "stories/card": cardStoryList,
    "stories/area": areaTalkList,
    "stories/special": specialStoryList,
    "stories/mysekai": mysekaiTalkList,
    "stories/live": virtualLiveList,
  };
  if (others[tail]) return serveJson(request, ctx, others[tail]);
  if (tail === "live2d") {
    const ids = [...new Set(url.searchParams.getAll("id"))].filter((id) => /^[\w-]+$/.test(id)).slice(0, 64);
    return serveJson(request, ctx, () => live2dEntries(ids));
  }
  let match: RegExpMatchArray | null;
  if ((match = /^songs\/(\d+)$/.exec(tail))) {
    const id = match[1]!;
    return serveJson(request, ctx, async () => {
      const song = (await songRecords())[id];
      if (!song) throw new Error(`unknown sekai song: ${id}`);
      return song;
    });
  }
  if ((match = /^stories\/((?:event|unit|character|card|area|special|mysekai|live)\.[\w-]+)$/.exec(tail))) {
    const storyId = match[1]!;
    return serveJson(request, ctx, () => storyDetail(region, storyId));
  }
  if ((match = /^live2d-model\/([\w-]+)\.model3\.json$/.exec(tail))) {
    const id = match[1]!;
    return serveJson(request, ctx, () => live2dManifest(id));
  }
  if ((match = /^live2d-(file|expression)\/(.+)$/.exec(tail))) {
    let path: string;
    try {
      path = decodeURIComponent(match[2]!);
    } catch {
      return null;
    }
    if (path.includes("..") || !LIVE2D_PATH.test(path)) return null;
    return match[1] === "file"
      ? proxyMedia(request, LIVE2D_BUCKET, path)
      : serveJson(request, ctx, () => facialExpression(path));
  }
  if ((match = /^media\/(.+)$/.exec(tail))) {
    // A few voice files carry a trailing space in their name, so the path arrives encoded.
    let path: string;
    try {
      path = decodeURIComponent(match[1]!);
    } catch {
      return null;
    }
    if (path.includes("..") || !MEDIA_PATH.test(path)) return null;
    return proxyMedia(request, SOURCES[region].assets, path);
  }
  return null;
}
