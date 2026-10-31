import fs from "node:fs";
import { arenaCatalog } from "./arena-catalog";
import { arenaPeriods, arenaRuleMarkNames } from "../lib/arena";
import { characterProfiles } from "../data/characterProfiles";
import { castProfiles } from "../data/castProfiles";
import {
  calendarGarupaCharacters,
  calendarGarupaCast,
  calendarGarupaProfileLinks,
} from "../data/calendar-garupa-birthdays";
import {
  asRecord,
  fetchOptionalStaticCatalog,
  fetchStaticCatalogBatch,
  staticCatalogRelease,
  type StaticCatalogRelease,
} from "../lib/static-catalog-source";
import { resourcePath, type ReleaseServer } from "../lib/resource-route";
import type { Locale } from "../i18n/locales";
import { prepareCalendarLives } from "./calendar-live-build";
import {
  calendarDayAt,
  parseCalendarDate,
  type CalendarArena,
  type CalendarArenaRule,
  type CalendarBirthday,
  type CalendarLiveSource,
  type CalendarData,
  type CalendarActivity,
  type CalendarVoiceRole,
} from "../lib/calendar-model";

const resources = ["events", "gacha", "login-campaigns", "passes", "real-lives"] as const;
const kinds = {
  events: "event",
  gacha: "gacha",
  "login-campaigns": "login",
  passes: "pass",
  "real-lives": "game-live",
} as const;
/** A rotation starts at the small hours, so its civil day is read a little after. */
const ARENA_DAY_OFFSET_MS = 6 * 3_600_000;
const cache = new Map<string, Promise<CalendarData>>();
const rows = (value: unknown): Array<Record<string, unknown> & { id: string }> => {
  const doc = asRecord(value),
    entries = doc?.entries ?? value;
  if (Array.isArray(entries))
    return entries.flatMap((row) => {
      const value = asRecord(row);
      return value && (value.id ?? value.eventId) !== undefined
        ? [{ ...value, id: String(value.id ?? value.eventId) }]
        : [];
    });
  return Object.entries(asRecord(entries) || {}).flatMap(([id, row]) => {
    const value = asRecord(row);
    return value ? [{ ...value, id: String(value.id ?? id) }] : [];
  });
};
const names = (value: unknown): string | readonly string[] =>
  Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : "")) : typeof value === "string" ? value : "";
/** Zero/missing means no date. Locale tuple fallback follows the catalog's Japanese source slot. */
function instant(value: unknown, locale: Locale): number | undefined {
  const index = ["ja", "en", "zh-TW", "zh-CN", "ko"].indexOf(locale);
  const selected = Array.isArray(value) ? (value[index] ?? value[0]) : value;
  return typeof selected === "number" && Number.isFinite(selected) && selected > 0 ? selected : undefined;
}
/** Same-current snapshots only: neither the path nor a source identity comes from a research fixture. */
async function bandoriLiveSnapshot(
  release: StaticCatalogRelease,
  realLives: unknown,
): Promise<{ lives: CalendarLiveSource[]; unavailable: boolean; buildId?: string }> {
  const selected = await prepareCalendarLives(release.server, release, realLives ?? { entries: {} });
  const value = selected
    ? JSON.parse(fs.readFileSync(selected, "utf8"))
    : (await fetchOptionalStaticCatalog("calendar-lives", release.server, release)).value;
  if (!value) return { lives: [], unavailable: false };
  const doc = asRecord(value),
    pin = asRecord(doc?.pin);
  if (
    doc?.schema !== "haneoka-calendar-lives-v1" ||
    pin?.server !== release.server ||
    pin.sourceId !== release.sourceId ||
    (pin.releaseId !== undefined && pin.releaseId !== release.releaseId)
  )
    throw new TypeError("Calendar Live snapshot differs from the current catalog pin");
  if (doc.available !== true) return { lives: [], unavailable: true };
  if (!Array.isArray(doc.events)) throw new TypeError("Invalid calendar Live snapshot");
  const lives: CalendarLiveSource[] = [];
  for (const value of doc.events) {
    const row = asRecord(value),
      match = asRecord(row?.match),
      venue = asRecord(row?.venue);
    if (
      !row ||
      typeof row.id !== "string" ||
      typeof row.startDate !== "string" ||
      typeof row.endDateExclusive !== "string" ||
      !parseCalendarDate(row.startDate) ||
      !parseCalendarDate(row.endDateExclusive) ||
      row.endDateExclusive <= row.startDate ||
      typeof row.sourceUrl !== "string"
    )
      continue;
    lives.push({
      id: row.id,
      title: names(row.title),
      date: row.startDate as CalendarLiveSource["date"],
      startAtMs:
        row.allDay === false && typeof row.startAtMs === "number" && Number.isFinite(row.startAtMs)
          ? row.startAtMs
          : undefined,
      endAtMs: typeof row.endAtMs === "number" && Number.isFinite(row.endAtMs) ? row.endAtMs : undefined,
      endDate: row.endDateExclusive as CalendarLiveSource["endDate"],
      endExclusive: true,
      allDay: row.allDay !== false,
      timeZone: typeof row.timeZone === "string" ? row.timeZone : undefined,
      venue: typeof venue?.name === "string" ? venue.name : undefined,
      sourceUrl: row.sourceUrl,
      image: typeof row.image === "string" ? row.image : undefined,
      startLocal: typeof row.startLocal === "string" ? row.startLocal : undefined,
      realLiveIds:
        match?.status === "matched" && typeof match.realLiveId === "string"
          ? { [release.server]: [match.realLiveId] }
          : {},
    });
  }
  return {
    lives,
    unavailable: doc.status === "unavailable",
    buildId: typeof pin.buildId === "string" ? pin.buildId : undefined,
  };
}
function bestdoriHref(entry: unknown): string | undefined {
  const row = asRecord(entry),
    facts = asRecord(row?.bestdori);
  const id = Number(row?.bestdoriCharacterId ?? facts?.characterId ?? facts?.bestdoriCharacterId);
  return Number.isSafeInteger(id) && id > 0 ? `https://bestdori.com/info/characters/${id}` : undefined;
}
export interface CalendarSources {
  readonly birthdays?: readonly CalendarBirthday[];
  readonly lives?: readonly CalendarLiveSource[];
}
/** Existing Our Notes profiles plus the calendar-only GBP dataset, with stable person identities. */
export function calendarProfileBirthdays(
  characters: unknown,
  server: ReleaseServer,
  locale: Locale,
): CalendarBirthday[] {
  const catalog = Object.values(asRecord(characters) || {}).flatMap((v) => (asRecord(v) ? [asRecord(v)!] : []));
  const find = (slug: string, profileNames: readonly string[]) =>
    catalog.find(
      (c) =>
        c.slug === slug ||
        (Array.isArray(c.characterName) &&
          c.characterName.some((n) =>
            profileNames.some((p) => p.replace(/[\s・]/gu, "") === String(n).replace(/[\s・]/gu, "")),
          )),
    );
  const ownById = new Map(characterProfiles.map((profile) => [profile.id as string, profile]));
  const sharedCast = new Set(calendarGarupaProfileLinks.map((link) => link.castProfileId as string));
  const roleIndex = new Map<string, CalendarVoiceRole>();
  for (const profile of characterProfiles) {
    const target = find(profile.slug, profile.name);
    roleIndex.set(profile.id, {
      id: profile.id,
      name: profile.name,
      href: target?.characterId
        ? resourcePath({ server, locale, kind: "characters", id: String(target.characterId) })
        : undefined,
    });
  }
  for (const character of calendarGarupaCharacters)
    roleIndex.set(character.id, { id: character.id, name: character.name, href: bestdoriHref(character) });
  for (const link of calendarGarupaProfileLinks) {
    const own = ownById.get(link.characterProfileId);
    if (own)
      roleIndex.set(link.garupaCharacterId, {
        id: own.id,
        name: own.name,
        href: roleIndex.get(own.id)?.href,
      });
  }
  const rolesFor = (id: string, ownRoles: readonly string[] = []): CalendarVoiceRole[] => {
    const roles = new Map<string, CalendarVoiceRole>();
    const cast = calendarGarupaCast.find((person) => String(person.id) === id);
    for (const roleId of [...ownRoles, ...(cast?.roles.map((role) => role.characterId) ?? [])]) {
      const role = roleIndex.get(roleId);
      if (role) roles.set(role.id, role);
    }
    return [...roles.values()];
  };
  const profiles: CalendarBirthday[] = characterProfiles.flatMap((p) => {
    const birthday = p.birthday[0]?.match(/^(\d{1,2})月(\d{1,2})日$/u);
    if (!birthday) return [];
    const c = find(p.slug, p.name),
      id = c?.characterId;
    return [
      {
        id: `our-notes:character:${p.id}`,
        game: "our-notes",
        games: calendarGarupaProfileLinks.some((link) => link.characterProfileId === p.id)
          ? ["our-notes", "garupa"]
          : ["our-notes"],
        kind: "character",
        name: p.name,
        month: Number(birthday[1]),
        day: Number(birthday[2]),
        image: id ? `/images/avatars/characters/${id}.png` : undefined,
        characterIds: id ? [String(id)] : [],
        href: id ? resourcePath({ server, locale, kind: "characters", id: String(id) }) : undefined,
        sourceUrls: [p.sources.ja, p.sources.global],
      },
    ];
  });
  for (const person of castProfiles) {
    const birthday = person.birthday.value;
    if (!birthday) continue;
    const ids = characterProfiles
      .filter((p) => person.characterSlugs.some((slug) => slug === p.id))
      .map((p) => find(p.slug, p.name)?.characterId)
      .filter(Boolean)
      .map(String);
    profiles.push({
      id: `cast:${person.id}`,
      game: "our-notes",
      games: sharedCast.has(person.id) ? ["our-notes", "garupa"] : ["our-notes"],
      voices: rolesFor(person.id, person.characterSlugs),
      kind: "cast",
      name: person.name,
      ...birthday,
      image: `/images/avatars/cast/${person.id}.jpg?v=official-20261002`,
      characterIds: ids,
      href: rolesFor(person.id, person.characterSlugs).find((role) => role.href)?.href,
      sourceUrls: person.birthday.sourceUrls,
    });
  }
  const linkedCharacters = new Set<string>(calendarGarupaProfileLinks.map((link) => link.garupaCharacterId));
  const linkedCast = new Set<string>(calendarGarupaProfileLinks.map((link) => link.castProfileId));
  const existingCast = new Set<string>(castProfiles.map((person) => person.id));
  for (const character of calendarGarupaCharacters) {
    if (!character.birthday.value || linkedCharacters.has(character.id)) continue;
    profiles.push({
      id: character.id,
      game: "garupa",
      kind: "character",
      name: character.name,
      ...character.birthday.value,
      image: character.image || undefined,
      href: bestdoriHref(character),
      sourceUrls: character.birthday.sourceUrls,
    });
  }
  for (const person of calendarGarupaCast) {
    if (!person.birthday.value || linkedCast.has(person.id) || existingCast.has(person.id)) continue;
    profiles.push({
      id: `cast:${person.id}`,
      game: "garupa",
      voices: rolesFor(person.id),
      kind: "cast",
      name: person.name,
      ...person.birthday.value,
      image: person.image || undefined,
      href: rolesFor(person.id).find((role) => role.href)?.href,
      sourceUrls: person.birthday.sourceUrls,
    });
  }
  return profiles;
}
export async function loadCalendarData(
  server: ReleaseServer,
  locale: Locale,
  sources: CalendarSources = {},
): Promise<CalendarData> {
  const useCache = !sources.birthdays && !sources.lives;
  const release = await staticCatalogRelease(server);
  const key = `${server}:${release.releaseId}:${locale}`;
  if (useCache && cache.has(key)) return cache.get(key)!;
  const load = async (): Promise<CalendarData> => {
    const unavailable: string[] = [];
    const documents: Record<string, unknown> = {};
    // Bounded reads reuse the same pin, including when current changes during the build.
    for (let i = 0; i < resources.length; i += 2)
      await Promise.all(
        resources.slice(i, i + 2).map(async (resource) => {
          const result = await fetchOptionalStaticCatalog(resource, server, release);
          documents[resource] = result.value;
          if (!result.value) unavailable.push(resource);
        }),
      );
    const eventIds = rows(documents.events).map((row) => row.id);
    if (eventIds.length) {
      const detail = await fetchStaticCatalogBatch("events", eventIds, server, release);
      documents.events = { entries: rows(documents.events).map((row) => ({ ...row, ...detail.get(row.id) })) };
    }
    const characters = await fetchOptionalStaticCatalog("characters", server, release);
    const supplied = sources.birthdays;
    const birthdays = new Map<string, CalendarBirthday>();
    for (const person of supplied ?? calendarProfileBirthdays(characters.value, server, locale)) {
      if (
        !person.id ||
        !["character", "cast"].includes(person.kind) ||
        !["our-notes", "garupa"].includes(person.game) ||
        !parseCalendarDate(`2000-${String(person.month).padStart(2, "0")}-${String(person.day).padStart(2, "0")}`)
      )
        continue;
      const prior = birthdays.get(person.id);
      birthdays.set(
        person.id,
        prior
          ? {
              ...prior,
              characterIds: [...new Set([...(prior.characterIds ?? []), ...(person.characterIds ?? [])])],
              sourceUrls: [...new Set([...(prior.sourceUrls ?? []), ...(person.sourceUrls ?? [])])],
              games: [...new Set([...(prior.games ?? [prior.game]), ...(person.games ?? [person.game])])],
              voices: [
                ...new Map([...(prior.voices ?? []), ...(person.voices ?? [])].map((role) => [role.id, role])).values(),
              ],
            }
          : person,
      );
    }
    const activities = new Map<string, CalendarActivity>();
    for (const resource of resources)
      for (const row of rows(documents[resource])) {
        const id = String(row.id),
          startAtMs = instant(row.startAt, locale),
          endAtMs = instant(row.endAt, locale);
        if (!startAtMs || (endAtMs && endAtMs < startAtMs)) continue;
        activities.set(`${resource}:${id}`, {
          id: `${resource}:${id}`,
          kind: kinds[resource],
          title: names(row.title || row.name),
          startAtMs,
          endAtMs,
          endExclusive: false,
          href: resourcePath({ server, locale, kind: resource, id }),
          image: typeof row.image === "string" ? row.image : undefined,
        });
      }
    const arena = await arenaCatalog(server, release);
    const arenaDays: Record<string, (CalendarArenaRule | null)[]> = {};
    for (const season of Object.values(arena.entries)) {
      const href = resourcePath({ server, locale, kind: "arena" });
      activities.set(`arena:${season.id}`, { id: `arena:${season.id}`, kind: "arena", title: season.title,
        startAtMs: season.startAt, endAtMs: season.endAt, href: `${href}#${season.id}`, timeZone: season.timeZone });
      for (const period of arenaPeriods(season))
        for (let at = period.startAt + ARENA_DAY_OFFSET_MS; at < period.endAt; at += 86_400_000)
          arenaDays[calendarDayAt(at, season.timeZone)] = period.rules.map((rule) =>
            rule ? { musicType: rule.musicType, missions: rule.missions } : null);
    }
    const arenaLeagues = Object.values(arena.entries)[0]?.leagues ?? [];
    const calendarArena: CalendarArena | undefined = Object.keys(arenaDays).length ? {
      releaseId: arena.identity.releaseId,
      href: resourcePath({ server, locale, kind: "arena" }),
      leagues: arenaLeagues.map(({ id, name, image }) => ({ id, name, image })),
      missions: arena.images?.missions ?? {},
      marks: arenaRuleMarkNames(((await fetchOptionalStaticCatalog("ui-marks", server, release)).value as Record<string, string>) || {}),
      days: arenaDays,
    } : undefined;
    const liveSnapshot = sources.lives
      ? { lives: sources.lives, unavailable: false, buildId: undefined }
      : await bandoriLiveSnapshot(release, documents["real-lives"]);
    if (liveSnapshot.unavailable) unavailable.push("live-information");
    const lives = sources.lives ?? liveSnapshot.lives;
    for (const live of lives) {
      const ids = live.realLiveIds?.[server] ?? [];
      const matches = ids.map((id) => activities.get(`real-lives:${id}`)).filter((a): a is CalendarActivity => !!a);
      if (matches.length)
        for (const entry of matches)
          activities.set(entry.id, {
            ...entry,
            kind: "live",
            title: live.title,
            // The concert is the calendar occurrence; game availability is a separate linked fact.
            facets: ["game-live", "external-live"],
            date: live.date,
            endDate: live.endDate,
            startAtMs: live.startAtMs,
            endAtMs: live.endAtMs,
            allDay: live.allDay,
            endExclusive: live.endExclusive,
            href: live.sourceUrl,
            gameWindow: { startAtMs: entry.startAtMs, endAtMs: entry.endAtMs, href: entry.href },
            liveStartLocal: live.startLocal,
            timeZone: live.timeZone,
            image: live.image,
            venue: live.venue,
            sourceUrl: live.sourceUrl,
          });
      else if (live.date || live.startAtMs) {
        const id = live.id.startsWith("bandori-fans:") ? live.id : `bandori-fans:${live.id}`;
        activities.set(id, {
          ...live,
          id,
          kind: "live",
          href: live.sourceUrl,
          facets: ["external-live"],
          liveStartLocal: live.startLocal,
        });
      }
    }
    return {
      schema: "haneoka-calendar-v1",
      server,
      releaseId: release.releaseId,
      sourceId: release.sourceId,
      snapshotBuildId: liveSnapshot.buildId,
      birthdays: [...birthdays.values()],
      activities: [...activities.values()],
      unavailable,
      ...(calendarArena ? { arena: calendarArena } : {}),
    };
  };
  const promise = load();
  if (useCache) cache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

export async function renderCalendar(data: CalendarData, locale: Locale, labels: Record<string, string>) {
  await import("@lit-labs/ssr/lib/install-global-dom-shim.js");
  const [{ render }, { collectResultSync }, { CalendarPage }] = await Promise.all([
    import("@lit-labs/ssr"),
    import("@lit-labs/ssr/lib/render-result.js"),
    import("../lit/calendar-page"),
  ]);
  const page = new CalendarPage();
  page.locale = locale;
  page.data = data;
  page.labels = labels;
  return collectResultSync(render(page.render()));
}
