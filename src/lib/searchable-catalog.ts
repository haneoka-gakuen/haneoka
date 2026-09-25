import { LOCALES, type Locale } from "../i18n/locales";
import { t } from "../i18n/messages";
import { resolveLocalizedText } from "./localized-text";
import { disambiguateTitles } from "./title-disambiguation";
import { asRecord, fetchStaticCatalog, type RecordValue } from "./static-catalog-source";

export interface SearchableCatalogFact {
  key: string;
  value: string;
}

export interface SearchableCatalogPage {
  collection: string;
  resource: string;
  route: string;
  selectionParam: string;
  kind:
    | "song"
    | "character"
    | "member"
    | "support"
    | "comic"
    | "stamp"
    | "background"
    | "band-item"
    | "item"
    | "system";
  id: string;
  title: string;
  titles: Record<Locale, string>;
  descriptions: Record<Locale, string>;
  subtitles: Record<Locale, string>;
  bodies: Record<Locale, string>;
  facts: Record<Locale, SearchableCatalogFact[]>;
  image: string;
  accent: string;
}

interface CollectionDefinition {
  collection: string;
  resource: string;
  route: string;
  selectionParam: string;
  kind: SearchableCatalogPage["kind"];
  /** Key holding the entity map when the release wraps it ("entries", "items"). */
  document?: string;
  titleField: string;
  /** Secondary line under the title, per presentation. */
  subtitle: "band" | "characters" | "description" | "field" | "kind" | "category" | "";
  subtitleField?: string;
}

/**
 * One entry per catalogue screen resource, mirroring the profiles in
 * lit/catalog-screen.ts so every entity that the interactive detail pane can
 * open also gets a static, crawlable page. Resources that the current release
 * does not publish yet are skipped at build time and picked up by the next
 * rebuild after the resource pipeline releases them.
 */
const COLLECTIONS: CollectionDefinition[] = [
  {
    collection: "songs",
    resource: "songs",
    route: "/catalog/songs",
    selectionParam: "song",
    kind: "song",
    titleField: "musicTitle",
    subtitle: "band",
  },
  {
    collection: "characters",
    resource: "characters",
    route: "/catalog/characters",
    selectionParam: "character",
    kind: "character",
    titleField: "characterName",
    subtitle: "band",
  },
  {
    collection: "member-cards",
    resource: "cards",
    route: "/catalog/member-cards",
    selectionParam: "card",
    kind: "member",
    titleField: "prefix",
    subtitle: "characters",
  },
  {
    collection: "support-cards",
    resource: "support-cards",
    route: "/catalog/support-cards",
    selectionParam: "snap",
    kind: "support",
    titleField: "prefix",
    subtitle: "characters",
  },
  {
    collection: "comics",
    resource: "comics",
    route: "/catalog/comics",
    selectionParam: "comic",
    kind: "comic",
    titleField: "title",
    subtitle: "characters",
  },
  {
    collection: "stamps",
    resource: "stamps",
    route: "/catalog/stamps",
    selectionParam: "stamp",
    kind: "stamp",
    titleField: "name",
    subtitle: "characters",
  },
  {
    collection: "stickers",
    resource: "stickers",
    route: "/catalog/stickers",
    selectionParam: "sticker",
    kind: "stamp",
    document: "entries",
    titleField: "name",
    subtitle: "description",
  },
  {
    collection: "backgrounds",
    resource: "backgrounds",
    route: "/catalog/backgrounds",
    selectionParam: "background",
    kind: "background",
    document: "entries",
    titleField: "name",
    subtitle: "description",
  },
  {
    collection: "band-items",
    resource: "band-items",
    route: "/catalog/band-items",
    selectionParam: "item",
    kind: "band-item",
    document: "items",
    titleField: "name",
    subtitle: "band",
  },
  {
    collection: "items",
    resource: "items",
    route: "/catalog/items",
    selectionParam: "item",
    kind: "item",
    document: "items",
    titleField: "name",
    subtitle: "field",
    subtitleField: "itemTypeName",
  },
  {
    collection: "events",
    resource: "events",
    route: "/catalog/events",
    selectionParam: "entry",
    kind: "system",
    document: "entries",
    titleField: "title",
    subtitle: "kind",
  },
  {
    collection: "real-lives",
    resource: "real-lives",
    route: "/catalog/real-lives",
    selectionParam: "entry",
    kind: "system",
    document: "entries",
    titleField: "title",
    subtitle: "kind",
  },
  {
    collection: "gacha",
    resource: "gacha",
    route: "/catalog/gacha",
    selectionParam: "entry",
    kind: "system",
    document: "entries",
    titleField: "title",
    subtitle: "category",
  },
  {
    collection: "login-campaigns",
    resource: "login-campaigns",
    route: "/catalog/login-campaigns",
    selectionParam: "entry",
    kind: "system",
    document: "entries",
    titleField: "title",
    subtitle: "kind",
  },
  {
    collection: "shop",
    resource: "shop",
    route: "/catalog/shop",
    selectionParam: "entry",
    kind: "system",
    document: "entries",
    titleField: "title",
    subtitle: "",
  },
  {
    collection: "exchange",
    resource: "exchange",
    route: "/catalog/exchange",
    selectionParam: "entry",
    kind: "system",
    document: "entries",
    titleField: "title",
    subtitle: "category",
  },
  {
    collection: "circle",
    resource: "circle",
    route: "/catalog/circle",
    selectionParam: "entry",
    kind: "system",
    document: "entries",
    titleField: "title",
    subtitle: "field",
    subtitleField: "rank",
  },
  {
    collection: "challenge",
    resource: "challenge",
    route: "/catalog/challenge",
    selectionParam: "entry",
    kind: "system",
    document: "entries",
    titleField: "title",
    subtitle: "",
  },
  {
    collection: "passes",
    resource: "passes",
    route: "/catalog/passes",
    selectionParam: "entry",
    kind: "system",
    document: "entries",
    titleField: "title",
    subtitle: "kind",
  },
];

interface LoadedCollection {
  definition: CollectionDefinition;
  records: Array<[string, RecordValue]>;
}

function text(value: unknown, locale: Locale): string {
  return resolveLocalizedText(value, locale).text.trim();
}

function recordId(value: RecordValue, key: string, resource: string): string {
  const field =
    resource === "songs"
      ? "musicId"
      : resource === "characters"
        ? "characterId"
        : resource === "cards"
          ? "cardId"
          : resource === "support-cards"
            ? "supportCardId"
            : resource === "comics"
              ? "comicId"
              : resource === "stamps"
                ? "stampId"
                : resource === "stickers"
                  ? "stickerId"
                  : resource === "backgrounds"
                    ? "backgroundId"
                    : resource === "band-items"
                      ? "bandItemId"
                      : resource === "items"
                        ? "itemId"
                        : "id";
  return String(value[field] ?? key).trim();
}

/** Game timestamps arrive as a plain number or a per-locale array of numbers. */
function timestamp(value: unknown): number {
  const raw = Array.isArray(value) ? value.find((entry) => Number(entry) > 0) : value;
  return Number(raw || 0);
}

function formatDate(value: unknown, locale: Locale): string {
  const time = timestamp(value);
  return time
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(time))
    : "";
}

function collectSkillNames(value: unknown, locale: Locale, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSkillNames(item, locale, output));
    return output;
  }
  const record = asRecord(value);
  if (!record) return output;
  if (record.skillName) {
    const name = text(record.skillName, locale);
    if (name) output.push(name);
  }
  Object.entries(record).forEach(([key, item]) => {
    if (key !== "skillName" && key !== "raw") collectSkillNames(item, locale, output);
  });
  return output;
}

function characterIds(value: RecordValue): number[] {
  const ids = Array.isArray(value.characterIds)
    ? value.characterIds
    : Array.isArray(value.characters)
      ? value.characters
      : [value.characterId];
  return [...new Set(ids.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
}

function localizedNamesForIds(ids: number[], characters: Map<number, RecordValue>, locale: Locale): string[] {
  return ids.map((id) => text(characters.get(id)?.characterName, locale)).filter(Boolean);
}

function bandNameForId(id: number, bands: Map<number, RecordValue>, locale: Locale): string {
  return text(bands.get(id)?.bandName, locale);
}

/** Strips the game's inline colour/style markup so descriptions read as plain text. */
function plainGameText(value: unknown, locale: Locale): string {
  return text(value, locale)
    .replace(/<[^>]+>/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .trim();
}

function catalogImage(kind: SearchableCatalogPage["kind"], value: RecordValue): string {
  const images = asRecord(value.images);
  const image =
    kind === "song"
      ? value.jacketUrl || value.jacketThumbUrl
      : kind === "character"
        ? value.profileImage || value.thumbnailImage || value.faceImage
        : kind === "comic"
          ? value.thumbnail || value.image
          : images?.full || images?.thumbnail || value.image || value.thumbnail;
  return typeof image === "string" ? image : "";
}

const RARITY_LABELS: Record<number, string> = { 2: "R", 3: "SR", 4: "SSR", 10: "EX", 20: "BD" };
const KIND_LABEL_KEYS: Record<string, string> = {
  gameEvent: "game-event",
  realLive: "real-live",
  regularMission: "regular-mission",
  limitedMission: "limited-mission",
  seasonPass: "season-pass",
  monthlyPass: "monthly-pass",
};

/** Localises a system entity's kind/category slug the way the screen does. */
function systemLabel(value: string, locale: Locale): string {
  if (!value) return "";
  const kindKey = KIND_LABEL_KEYS[value];
  if (kindKey) return t(locale, `system.${kindKey}`, value);
  const type = t(locale, `gachaType.${value}`, "");
  return type || value.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function factsFor(
  definition: CollectionDefinition,
  value: RecordValue,
  locale: Locale,
  characters: Map<number, RecordValue>,
  bands: Map<number, RecordValue>,
): SearchableCatalogFact[] {
  const facts: SearchableCatalogFact[] = [];
  const push = (key: string, raw: unknown) => {
    const resolved = text(raw, locale);
    if (resolved) facts.push({ key, value: resolved });
  };

  if (definition.kind === "song") {
    push("composer", value.composer);
    push("lyrics", value.lyricist);
    push("arrangement", value.arranger);
    const difficulties = Array.isArray(value.difficulty) ? value.difficulty : [];
    difficulties.forEach((raw) => {
      const row = asRecord(raw);
      if (!row) return;
      const rawName = text(row.difficultyName, locale);
      const name = rawName.toLocaleUpperCase(locale);
      const level = row.displayLevel ?? row.playLevel ?? row.sortLevel;
      const notes = row.noteCount;
      const parts = [level == null ? "" : String(level), notes == null ? "" : String(notes)].filter(Boolean);
      if (name && parts.length) facts.push({ key: name, value: parts.join(" · ") });
    });
    return facts;
  }

  if (definition.kind === "character") {
    ["birthday", "height", "school", "schoolClass", "constellation", "favoriteFood", "hobby", "hatedFood"].forEach(
      (key) => {
        const raw = value[key];
        if (key === "birthday") {
          const birthday = asRecord(raw);
          if (birthday?.month && birthday.day) facts.push({ key, value: `${birthday.month}/${birthday.day}` });
        } else push(key, raw);
      },
    );
    const bandName = bandNameForId(Number(value.bandId || 0), bands, locale);
    if (bandName) facts.unshift({ key: "band", value: bandName });
    return facts;
  }

  if (definition.kind === "member" || definition.kind === "support") {
    const names = localizedNamesForIds(characterIds(value), characters, locale);
    if (names.length) facts.push({ key: "character", value: names.join("、") });
    if (value.rarity != null) {
      const rarity = RARITY_LABELS[Number(value.rarity)];
      if (rarity) facts.push({ key: "rarity", value: rarity });
    }
    const stats = asRecord(value.stat);
    if (stats) ["performance", "technique", "visual"].forEach((key) => push(key, stats[key]));
    const skills = asRecord(value.resolvedSkills);
    if (skills) {
      Object.entries(skills).forEach(([group, skill]) => {
        const labelKey =
          group === "leader"
            ? "leaderSkill"
            : group === "live"
              ? "liveSkill"
              : group === "support"
                ? "supportSkill"
                : "gekisouSkill";
        collectSkillNames(skill, locale)
          .filter((name, index, all) => all.indexOf(name) === index)
          .forEach((name) => facts.push({ key: labelKey, value: name }));
      });
    }
    return facts;
  }

  if (definition.kind === "comic" || definition.kind === "stamp") {
    const names = localizedNamesForIds(characterIds(value), characters, locale);
    if (names.length) facts.push({ key: "character", value: names.join("、") });
    const released = formatDate(value.publicStartAt ?? value.releasedAt, locale);
    if (released) facts.push({ key: "release", value: released });
    return facts;
  }

  if (definition.kind === "background") {
    // The description is the page body; repeating it as a fact adds nothing.
    return facts;
  }

  if (definition.kind === "band-item") {
    const bandName = bandNameForId(Number(value.bandId || 0), bands, locale);
    if (bandName) facts.push({ key: "band", value: bandName });
    const description = plainGameText(value.description, locale);
    if (description) facts.push({ key: "content", value: description });
    const effects = Array.isArray(value.effects) ? value.effects : [];
    const levels = [
      ...new Set(
        effects.map((row) => Number(asRecord(row)?.level ?? 0)).filter((level) => Number.isFinite(level) && level > 0),
      ),
    ].sort((left, right) => left - right);
    if (levels.length) {
      const low = levels[0];
      const high = levels[levels.length - 1];
      facts.push({ key: "level", value: low === high ? String(low) : `${low}–${high}` });
    }
    return facts;
  }

  if (definition.kind === "item") {
    push("type", value.itemTypeName);
    const max = Number(value.max);
    if (Number.isFinite(max) && max > 0 && max < 1_000_000)
      facts.push({ key: "system.limit", value: max.toLocaleString(locale) });
    const description = plainGameText(value.description, locale);
    if (description) facts.push({ key: "content", value: description });
    return facts;
  }

  // The rotating game systems share one shape: optional kind/category, and a
  // start/end window that may stay open-ended.
  const kind = text(value.kind, locale);
  if (kind) facts.push({ key: "type", value: systemLabel(kind, locale) });
  const category = text(value.category, locale);
  if (category) facts.push({ key: "type", value: systemLabel(category, locale) });
  if (value.rank != null) facts.push({ key: "rank", value: String(value.rank) });
  const starts = formatDate(value.startAt, locale);
  if (starts) facts.push({ key: "system.starts", value: starts });
  const ends = formatDate(value.endAt, locale);
  if (ends) facts.push({ key: "system.ends", value: ends });
  else facts.push({ key: "system.ends", value: t(locale, "noEndDate", "Open-ended") });
  return facts;
}

let pagesPromise: Promise<SearchableCatalogPage[]> | undefined;

export function searchableCatalogPages(): Promise<SearchableCatalogPage[]> {
  pagesPromise ??= buildSearchableCatalogPages();
  return pagesPromise;
}

async function fetchCollection(definition: CollectionDefinition): Promise<LoadedCollection> {
  // Resources the current release does not publish yet (or that the edge
  // blocks from build runners): skip them and let the next post-release
  // rebuild pick them up instead of failing the whole build.
  const document = asRecord(
    await fetchStaticCatalog(definition.resource === "songs" ? "songs?projection=4" : definition.resource),
  );
  if (!document) return { definition, records: [] };
  const entries = definition.document ? asRecord(document[definition.document]) ?? {} : document;
  return {
    definition,
    records: Object.entries(entries).flatMap(([key, value]) => {
      const record = asRecord(value);
      return record ? [[key, record] as [string, RecordValue]] : [];
    }),
  };
}

async function buildSearchableCatalogPages(): Promise<SearchableCatalogPage[]> {
  const [collections, bandsDocument] = await Promise.all([
    Promise.all(COLLECTIONS.map(fetchCollection)),
    fetchStaticCatalog("bands"),
  ]);
  if (!bandsDocument) throw new Error("Invalid bands catalog response");

  const records = new Map(collections.map(({ definition, records: entries }) => [definition.collection, entries]));
  const characters = new Map(
    (records.get("characters") || []).map(([key, value]) => [Number(recordId(value, key, "characters")), value]),
  );
  const bands = new Map(
    Object.entries(asRecord(bandsDocument) ?? {}).flatMap(([key, raw]) => {
      const value = asRecord(raw);
      return value ? [[Number(value.bandId ?? key), value] as [number, RecordValue]] : [];
    }),
  );

  const skipped = collections
    .filter(({ definition, records: entries }) => definition.document && !entries.length)
    .map(({ definition }) => definition.resource);
  if (skipped.length) console.warn(`Static catalog: release does not publish ${skipped.join(", ")} yet`);

  const built = collections.flatMap(({ definition, records: entries }) =>
    entries.flatMap(([key, value]) => {
      const id = recordId(value, key, definition.resource);
      if (!/^\d+$/u.test(id)) return [];
      const ids = characterIds(value);
      const titles = Object.fromEntries(
        LOCALES.map((locale) => [locale, text(value[definition.titleField], locale) || id]),
      ) as Record<Locale, string>;
      const subtitles = Object.fromEntries(
        LOCALES.map((locale) => {
          if (definition.subtitle === "band")
            return [
              locale,
              definition.kind === "song"
                ? text(value.bandName, locale) || bandNameForId(Number(value.bandId || 0), bands, locale)
                : bandNameForId(Number(value.bandId || 0), bands, locale),
            ];
          if (definition.subtitle === "characters")
            return [locale, localizedNamesForIds(ids, characters, locale).join("、")];
          if (definition.subtitle === "description")
            return [locale, plainGameText(value.description, locale)];
          if (definition.subtitle === "field") return [locale, text(value[definition.subtitleField || ""], locale)];
          return [locale, ""];
        }),
      ) as Record<Locale, string>;
      const bodies = Object.fromEntries(
        LOCALES.map((locale) => {
          const body =
            definition.kind === "character"
              ? text(value.description, locale)
              : plainGameText(value.description, locale);
          return [locale, body];
        }),
      ) as Record<Locale, string>;
      const facts = Object.fromEntries(
        LOCALES.map((locale) => [locale, factsFor(definition, value, locale, characters, bands)]),
      ) as Record<Locale, SearchableCatalogFact[]>;
      const descriptions = Object.fromEntries(
        LOCALES.map((locale) => {
          const uniqueFacts = facts[locale]
            .filter(({ value: fact }) => fact && fact !== titles[locale] && fact !== subtitles[locale])
            .map((fact) => `${t(locale, fact.key, fact.key)}: ${fact.value}`);
          const description =
            bodies[locale] || [titles[locale], subtitles[locale], ...uniqueFacts].filter(Boolean).join(" · ");
          return [locale, description];
        }),
      ) as Record<Locale, string>;
      return [
        {
          collection: definition.collection,
          resource: definition.resource,
          route: definition.route,
          selectionParam: definition.selectionParam,
          kind: definition.kind,
          id,
          title: titles.ja,
          titles,
          descriptions,
          subtitles,
          bodies,
          facts,
          image: catalogImage(definition.kind, value),
          accent: definition.kind === "character" ? String(value.colorCode || "") : "",
        },
      ];
    }),
  );

  // Shop packs and rotated systems repeat the same title across entities;
  // suffix the colliding groups with their ids so every page stays distinct.
  disambiguateTitles(
    built,
    (page, locale) => page.titles[locale],
    (page, locale, title) => {
      page.titles[locale] = title;
    },
    [],
    (page) => `#${page.id}`,
  );
  return built;
}

export async function searchableCatalogUrls(): Promise<string[]> {
  return (await searchableCatalogPages()).map(({ route, id }) => `${route}/${encodeURIComponent(id)}/`);
}
