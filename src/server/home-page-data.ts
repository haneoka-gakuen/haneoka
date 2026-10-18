import { characterProfiles } from "../data/characterProfiles";
import { castProfiles } from "../data/castProfiles";
import type { HomeSeed } from "../lit/home-dashboard";
import { fetchOptionalStaticCatalog, staticCatalogRelease } from "../lib/static-catalog-source";
import type { Locale } from "../i18n/locales";
import type { ReleaseServer } from "../lib/release-server";
import type { JsonRecord } from "../lit/shared/catalog";
import fs from "node:fs/promises";
import { prepareCalendarLives } from "./calendar-live-build";
import { compactHomeGacha, homeFanInfo } from "./home-display-slices";
import { loadStaticCrossServerHome } from "../lib/cross-server/home";
import { homeEventDisplay } from "../lib/home-event-display";
import { staticBuildJson } from "./static-input-store";

let publicPosts: Promise<JsonRecord | undefined> | undefined;
const origin = (process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org").replace(/\/$/u, "");
const pick = (entry: JsonRecord, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]));
const rows = (value: unknown) => Object.values((value || {}) as Record<string, JsonRecord>);
export async function homePageData(server: ReleaseServer, locale: Locale): Promise<HomeSeed> {
  const release = await staticCatalogRelease(server);
  const homeUnion =
    server === "intl" || server === "jp" || server === "intl-test"
      ? await loadStaticCrossServerHome(server, locale)
      : {};
  const keys = [
    "catalog/summary",
    "songs",
    "characters",
    "bands",
    "home-banners",
    "events",
    "ui-marks",
    "cards",
    "support-cards",
    "gacha",
    "real-lives",
    "stories",
  ];
  const results = await Promise.all(keys.map((key) => fetchOptionalStaticCatalog(key, server, release)));
  const documents = Object.fromEntries(
    keys.map((key, index) => [key === "catalog/summary" ? "summary" : key, (results[index].value || {}) as JsonRecord]),
  );
  documents.songs = Object.fromEntries(
    rows(documents.songs).map((entry) => [
      String(entry.musicId),
      pick(entry, [
        "musicId",
        "musicTitle",
        "bandId",
        "bandName",
        "bandIds",
        "artistName",
        "vocalCharacterIds",
        "jacketUrl",
        "jacketThumbUrl",
        "musicType",
        "publishedAt",
      ]),
    ]),
  );
  documents.characters = Object.fromEntries(
    rows(documents.characters).map((entry) => [
      String(entry.characterId),
      pick(entry, [
        "characterId",
        "characterName",
        "englishName",
        "slug",
        "bandId",
        "colorCode",
        "faceImage",
        "thumbnailImage",
      ]),
    ]),
  );
  documents.bands = Object.fromEntries(
    rows(documents.bands).map((entry) => [
      String(entry.bandId),
      pick(entry, ["bandId", "bandName", "icon", "colorCode"]),
    ]),
  );
  for (const key of ["cards", "support-cards"])
    documents[key] = Object.fromEntries(
      rows(documents[key]).map((entry) => [
        String(entry.cardId || entry.supportCardId),
        {
          ...pick(entry, [
            "cardId",
            "supportCardId",
            "cardName",
            "prefix",
            "characterId",
            "characterIds",
            "cardType",
            "releasedAt",
            "rarity",
            "characterDetails",
          ]),
          images: pick((entry.images || {}) as JsonRecord, ["thumbnail", "full", "background", "character"]),
        },
      ]),
    );
  documents.gacha = compactHomeGacha(documents.gacha, documents.cards);
  documents.stories = {
    birthdayStories:
      documents.stories.birthdayStories &&
      typeof documents.stories.birthdayStories === "object" &&
      !Array.isArray(documents.stories.birthdayStories)
        ? documents.stories.birthdayStories
        : {},
  };
  const entries = rows(documents.events.entries);
  documents.events = {
    ...documents.events,
    entries: await Promise.all(
      entries.map(async (entry) => {
        const detail = await fetchOptionalStaticCatalog(`events/${entry.id}`, server, release);
        const value = { ...entry, ...((detail.value as JsonRecord) || {}) };
        return homeEventDisplay(value);
      }),
    ),
  };
  const announcements = await staticBuildJson(`home-announcements:${server}:${locale}`, "public-data", async () => {
    try {
      const response = await fetch(`${origin}/api/v1/announcements?${new URLSearchParams({ server, locale })}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const value = await response.json();
        if (value.server === server && value.requestedLocale === locale && Array.isArray(value.announcements))
          return value.announcements.slice(0, 5) as HomeSeed["announcements"];
      }
    } catch {
      /* The live panel refreshes independently. */
    }
    return [];
  });
  publicPosts ??= staticBuildJson("home:public-posts", "public-data", () =>
    fetch(`${origin}/api/v1/community/posts?limit=5&scope=recommended`, {
      signal: AbortSignal.timeout(10000),
    })
      .then(async (response) => (response.ok ? ((await response.json()) as JsonRecord) : undefined))
      .catch(() => undefined),
  );
  const posts = await publicPosts;
  if (posts && Array.isArray(posts.posts)) documents.posts = { posts: posts.posts.slice(0, 5) };
  const calendarFile = await prepareCalendarLives(server, release, documents["real-lives"]);
  const fanInfo = homeFanInfo(calendarFile ? JSON.parse(await fs.readFile(calendarFile, "utf8")) : undefined);
  delete documents["real-lives"];
  return {
    server,
    releaseId: release.releaseId,
    documents,
    announcements,
    fanInfo,
    ...homeUnion,
    profiles: {
      characters: characterProfiles.map((profile) =>
        pick(profile as unknown as JsonRecord, ["id", "slug", "band", "bandName", "name", "birthday"]),
      ),
      cast: castProfiles.map((person) => ({
        id: person.id,
        name: person.name,
        characterSlugs: person.characterSlugs,
        birthday: { value: person.birthday.value },
      })),
    },
  };
}
