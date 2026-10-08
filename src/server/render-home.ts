import "@lit-labs/ssr/lib/install-global-dom-shim.js";
import { render } from "@lit-labs/ssr";
import { collectResultSync } from "@lit-labs/ssr/lib/render-result.js";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { characterProfiles } from "../data/characterProfiles";
import { castProfiles } from "../data/castProfiles";
import { HomeDashboard, type HomeSeed } from "../lit/home-dashboard";
import { localizedAssetUrl } from "../lit/ui/lazy-images";
import { createServerI18nContext } from "../i18n/server";
import { initializeI18nClient } from "../i18n/client";
import { fetchOptionalStaticCatalog, staticCatalogRelease } from "../lib/static-catalog-source";
import type { Locale } from "../i18n/locales";
import type { ReleaseServer } from "../lib/release-server";
import type { JsonRecord } from "../lit/shared/catalog";
import fs from "node:fs/promises";
import { prepareCalendarLives } from "./calendar-live-build";
import { compactHomeGacha, homeFanInfo } from "./home-display-slices";
import { loadStaticCrossServerHome } from "../lib/cross-server/home";

const snapshots = new Map<string, Promise<HomeSeed>>();
let publicPosts: Promise<JsonRecord | undefined> | undefined;
const origin = (process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org").replace(/\/$/u, "");
const pick = (entry: JsonRecord, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]));
const rows = (value: unknown) => Object.values((value || {}) as Record<string, JsonRecord>);
async function snapshot(server: ReleaseServer, locale: Locale): Promise<HomeSeed> {
  const release = await staticCatalogRelease(server);
  const homeUnion = server === "intl" || server === "jp" || server === "intl-test" ? await loadStaticCrossServerHome(server, locale) : {};
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
      pick(entry, ["characterId", "characterName", "englishName", "slug", "bandId", "colorCode", "faceImage", "thumbnailImage"]),
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
    birthdayStories: (documents.stories.birthdayStories && typeof documents.stories.birthdayStories === "object" &&
      !Array.isArray(documents.stories.birthdayStories)) ? documents.stories.birthdayStories : {},
  };
  const entries = rows(documents.events.entries);
  documents.events = {
    ...documents.events,
    entries: await Promise.all(
      entries.map(async (entry) => {
        const detail = await fetchOptionalStaticCatalog(`events/${entry.id}`, server, release);
        const value = { ...entry, ...((detail.value as JsonRecord) || {}) };
        return {
          ...pick(value, ["id", "title", "image", "backgroundImage", "logo", "startAt", "endAt", "eventType"]),
          homeStoryId: String(((value.story as JsonRecord)?.episodes as JsonRecord[] | undefined)?.[0]?.storyKey || ""),
          effects: rows(value.effects).map((effect) => ({
            targets: Object.fromEntries(
              Object.entries((effect.targets || {}) as Record<string, JsonRecord>).map(([kind, target]) => [
                kind,
                {
                  ...pick(target, ["kind", "resourceId", "bandId", "cardType", "name", "image", "icon"]),
                  homeTargetKind: kind,
                  bandId: kind === "band" ? Number((effect.raw as JsonRecord)?._bandId || 0) : target.bandId,
                  cardType:
                    kind === "attribute"
                      ? Number(effect.cardType || (effect.raw as JsonRecord)?._cardType || 0)
                      : target.cardType,
                },
              ]),
            ),
          })),
        };
      }),
    ),
  };
  let announcements: HomeSeed["announcements"] = [];
  try {
    const response = await fetch(`${origin}/api/v1/announcements?${new URLSearchParams({ server, locale })}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      const value = await response.json();
      if (value.server === server && value.requestedLocale === locale && Array.isArray(value.announcements))
        announcements = value.announcements.slice(0, 5);
    }
  } catch {
    /* Live panel retries separately; catalog snapshot remains usable. */
  }
  publicPosts ??= fetch(`${origin}/api/v1/community/posts?limit=5&scope=recommended`, {
    signal: AbortSignal.timeout(10000),
  })
    .then(async (response) => (response.ok ? ((await response.json()) as JsonRecord) : undefined))
    .catch(() => undefined);
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
export async function renderHome(server: ReleaseServer, locale: Locale) {
  const key = `${server}:${locale}`;
  let pending = snapshots.get(key);
  if (!pending) {
    pending = snapshot(server, locale);
    snapshots.set(key, pending);
  }
  let seed: HomeSeed | undefined;
  try {
    seed = await pending;
  } catch (error) {
    console.warn(`Home snapshot unavailable for ${server}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const i18nSeed = createServerI18nContext(locale, "/").seed();
  initializeI18nClient({ seed: i18nSeed }).adoptSeed(i18nSeed);
  const dashboard = new HomeDashboard();
  dashboard.locale = locale;
  dashboard.server = server;
  if (seed) dashboard.prepareHome(seed, locale);
  const fragment = parseFragment(collectResultSync(render(dashboard.render())));
  const promote = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node && node.tagName === "img") {
      const source = node.attrs.find((attribute) => attribute.name === "data-src");
      if (source && !node.attrs.some((attribute) => attribute.name === "src")) {
        // The client's lazy loader asks for the locale-tagged variant first;
        // prerender the same URL so hydration reuses the request.
        node.attrs.push({ name: "src", value: localizedAssetUrl(source.value, locale) });
        if (!node.attrs.some((attribute) => attribute.name === "loading"))
          node.attrs.push({ name: "loading", value: "lazy" });
      }
      // SSR has a real source: deferred-media CSS must not wait for client load hooks.
      if (node.attrs.some((attribute) => attribute.name === "src" && attribute.value))
        node.attrs = node.attrs.filter((attribute) => !["data-src", "data-loading"].includes(attribute.name));
    }
    if ("childNodes" in node) for (const child of node.childNodes) promote(child);
  };
  promote(fragment);
  return {
    html: serialize(fragment),
    seed: seed ? JSON.stringify(seed).replace(/</gu, "\\u003c") : "",
  };
}
