import { canonicalEntityTarget, type CommunityEntityTarget } from "./community-entity-guard";
import { publishedCommunityStory } from "./community-stories";
import { communitySonolusRows } from "./community-charts";
import { publicPlaylistTitle } from "./community-playlists";
import { communityStoryPath } from "../src/lib/community-story-route";
import { communityChartPath } from "../src/lib/community-chart-route";
import { publicationFields } from "../src/lib/content-publication";
import { SKILL_FAMILY_RESOURCES } from "../src/lib/skill-page";
import { announcementPath } from "../src/lib/announcements";
import { providerEntityRoute, type ProviderEntityLocator } from "../src/lib/provider-entity-data";
import { PROVIDER_STORY_SECTIONS } from "../src/lib/provider-page-data";
import { assetPublicDocumentUrl, assetStaticLocation } from "../src/lib/asset-static-routing";

type Server = "jp" | "intl";
type Locale = "ja" | "en" | "zh-TW" | "zh-CN" | "ko";
type Row = Record<string, unknown>;
interface Pin {
  server: Server;
  releaseId: string;
  sourceId: string;
}
export interface CommunityCatalogEntityDescriptor {
  type: string;
  originalId: string;
  titles: Partial<Record<Locale, string>>;
  availability: Record<Server, "present" | "absent" | "unknown">;
  locators: Partial<Record<Server, { routeKind: string; routeId: string; detailPath: string }>>;
}
export type CommunityEntityCatalogReader = (env: Env, request: Request) => Promise<Response | null>;
interface Match {
  status: "present" | "absent" | "unknown";
  row?: Row;
  routeId?: string;
  ambiguous?: boolean;
}
interface PinnedMatchCache {
  entries: Map<string, { match: Match; bytes: number }>;
  bytes: number;
}
function publicationFacts(row: Row): Row {
  const fields = publicationFields(row);
  if (object(fields.catalogMetadata)) fields.catalogMetadata = publicationFacts(fields.catalogMetadata);
  for (const key of ["_publicStartAt", "_publishedAt", "_releaseAt", "_startAt"])
    if (row[key] !== undefined) fields[key] = row[key];
  return fields;
}
const pinnedMatches = new WeakMap<R2Bucket, PinnedMatchCache>();
const TITLE_FIELDS = ["prefix", "musicTitle", "characterName", "title", "name", "live2dName", "skillName"] as const;
function matchCache(env: Env): PinnedMatchCache | undefined {
  if (!env.ASSET_BUCKET || typeof env.ASSET_BUCKET !== "object") return;
  let cache = pinnedMatches.get(env.ASSET_BUCKET);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    pinnedMatches.set(env.ASSET_BUCKET, cache);
  }
  return cache;
}
function rememberMatch(cache: PinnedMatchCache | undefined, key: string, match: Match) {
  if (!cache || match.status === "unknown" || match.ambiguous) return;
  const row = match.row && {
    ...publicationFacts(match.row),
    ...Object.fromEntries(
      TITLE_FIELDS.map((field) => {
        const value = match.row![field];
        return [
          field,
          Array.isArray(value)
            ? value.slice(0, 5).map((label) => (typeof label === "string" ? label : null))
            : typeof value === "string"
              ? value
              : undefined,
        ];
      }),
    ),
  };
  const value: Match = {
    status: match.status,
    ...(match.routeId ? { routeId: match.routeId } : {}),
    ...(row ? { row } : {}),
  };
  const bytes = (key.length + JSON.stringify(value).length) * 2;
  if (bytes > 16384) return;
  const previous = cache.entries.get(key);
  if (previous) cache.bytes -= previous.bytes;
  cache.entries.delete(key);
  cache.entries.set(key, { match: value, bytes });
  cache.bytes += bytes;
  while (cache.entries.size > 256 || cache.bytes > 2 * 1024 * 1024) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    cache.bytes -= cache.entries.get(oldest)!.bytes;
    cache.entries.delete(oldest);
  }
}
interface Rule {
  resource: string;
  routeKind: string;
  field: string;
  kind?: string;
  prefix?: string;
  sourceTable?: string;
  stringId?: boolean;
}
const LOCALES: Locale[] = ["ja", "en", "zh-TW", "zh-CN", "ko"];
const SERVERS: Server[] = ["jp", "intl"];
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_RECORDS = 10000;
const RULES: Record<string, Rule> = {
  cards: { resource: "cards", routeKind: "member-cards", field: "cardId" },
  "support-cards": { resource: "support-cards", routeKind: "support-cards", field: "supportCardId" },
  characters: { resource: "characters", routeKind: "characters", field: "characterId" },
  songs: { resource: "songs", routeKind: "songs", field: "musicId" },
  "band-items": { resource: "band-items", routeKind: "band-items", field: "bandItemId" },
  items: { resource: "items", routeKind: "items", field: "itemId" },
  comics: { resource: "comics", routeKind: "comics", field: "comicId" },
  stamps: { resource: "stamps", routeKind: "stamps", field: "stampId" },
  stickers: { resource: "stickers", routeKind: "stickers", field: "stickerId" },
  backgrounds: { resource: "backgrounds", routeKind: "backgrounds", field: "backgroundId" },
  events: { resource: "events", routeKind: "events", field: "id", kind: "game-event", sourceTable: "MasterEvent" },
  "real-lives": {
    resource: "real-lives",
    routeKind: "real-lives",
    field: "id",
    kind: "real-live",
    prefix: "real-live-",
  },
  gacha: { resource: "gacha", routeKind: "gacha", field: "id", kind: "gacha" },
  "login-campaigns": { resource: "login-campaigns", routeKind: "login-campaigns", field: "id", kind: "login" },
  exchange: { resource: "exchange", routeKind: "exchange", field: "id", kind: "exchange" },
  circle: { resource: "circle", routeKind: "circle", field: "id", kind: "circle" },
  challenge: { resource: "challenge", routeKind: "challenge", field: "id", kind: "challenge" },
  "passes-season": { resource: "passes", routeKind: "passes", field: "id", kind: "season-pass", prefix: "season-" },
  "passes-monthly": { resource: "passes", routeKind: "passes", field: "id", kind: "monthly-pass", prefix: "monthly-" },
  "missions-regular": {
    resource: "missions",
    routeKind: "missions",
    field: "id",
    kind: "regular-mission",
    prefix: "regular-mission-",
  },
  "missions-limited": {
    resource: "missions",
    routeKind: "missions",
    field: "id",
    kind: "limited-mission",
    prefix: "limited-mission-",
  },
  "missions-event": {
    resource: "missions", routeKind: "missions", field: "id", kind: "event-mission", prefix: "event-mission-",
  },
  arena: { resource: "arena", routeKind: "arena", field: "id", kind: "arena-season", stringId: true },
  "chat-customizations": { resource: "chat-customizations", routeKind: "chat-customizations", field: "id", stringId: true },
  "tgw-card": { resource: "tgw-card", routeKind: "tgw-card", field: "rank", sourceTable: "MasterVip" },
  shop: { resource: "shop", routeKind: "shop", field: "id", kind: "shop" },
};
const object = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const decimal = (value: unknown): string | null => {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" && /^[1-9]\d{0,15}$/u.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
};
const routeIdValid = (value: string) =>
  value.length <= 512 && /^[A-Za-z0-9._:~-]+$/u.test(value) && value !== "." && value !== "..";
const originalModelAddress = (value: string) =>
  value.startsWith("Assets/AddressableResources/") &&
  !/[\\%:?\u0000-\u001f\u007f]/u.test(value) &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
const hasTable = (row: Row, table: string) =>
  row.sourceTable === table || (Array.isArray(row.sourceTables) && row.sourceTables.includes(table));

/** Instantiate once per incoming API request. The reader must be the existing
 * trusted catalog dispatcher, not a client URL, client row or remote fetcher.
 */
export function createCommunityEntityResolver(
  readCatalog: CommunityEntityCatalogReader,
  canRead?: (env: Env, pin: Pin, target: CommunityEntityTarget, match: Match) => Promise<boolean>,
  readAnnouncement?: (server: Server, id: string, locale: Locale) => Promise<Row | undefined>,
  readProvider?: (entry: ProviderEntityLocator) => Promise<Row | undefined>,
) {
  const pins = new Map<Server, Promise<Pin | null>>();
  const indexes = new Map<string, Promise<unknown>>();
  const matches = new Map<string, Promise<Match>>();
  let requestEnv: Env | undefined,
    requestBytes = 0;
  const current = (env: Env, server: Server) => {
    let pending = pins.get(server);
    if (!pending) {
      pending = (async () => {
        try {
          const request = new Request(`https://catalog.internal/api/v1/servers/${server}/release?projection=identity`, {
            method: "HEAD",
          });
          const response = await readCatalog(env, request);
          if (!response?.ok) {
            await response?.body?.cancel();
            return null;
          }
          const releaseId = response.headers.get("x-haneoka-release-id") ?? "";
          const sourceId = response.headers.get("x-haneoka-source-id") ?? "";
          await response.body?.cancel();
          return /^r-[a-f0-9]{20}$/u.test(releaseId) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sourceId)
            ? { server, releaseId, sourceId }
            : null;
        } catch {
          return null;
        }
      })();
      pins.set(server, pending);
    }
    return pending;
  };
  const read = async (env: Env, pin: Pin, path: string): Promise<unknown> => {
    const url = new URL(`/api/v1/servers/${pin.server}/${path}`, "https://catalog.internal");
    url.searchParams.set("release", pin.releaseId);
    const response = await readCatalog(env, new Request(url, { headers: { accept: "application/json" } }));
    if (
      !response ||
      response.headers.get("x-haneoka-release-id") !== pin.releaseId ||
      response.headers.get("x-haneoka-source-id") !== pin.sourceId
    ) {
      await response?.body?.cancel();
      throw new Error("entity-catalog-pin-unavailable");
    }
    if ((!response.ok && response.status !== 404) || !response.body) {
      await response.body?.cancel();
      throw new Error("entity-catalog-unavailable");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        requestBytes += part.value.byteLength;
        if (size > MAX_BYTES || requestBytes > MAX_REQUEST_BYTES) throw new Error("entity-catalog-byte-limit");
        chunks.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of chunks) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (response.status === 404) {
      const error = object(document) && object(document.error) ? document.error : null;
      if (error?.code === "entity_not_found" || error?.code === "resource_not_found" || error?.code === "source_not_found") return null;
      throw new Error("entity-catalog-not-authoritative-absence");
    }
    return document;
  };
  const index = (env: Env, pin: Pin, resource: string) => {
    const key = `${pin.server}:${pin.releaseId}:${pin.sourceId}:${resource}`;
    let pending = indexes.get(key);
    if (!pending) {
      pending = read(env, pin, resource);
      indexes.set(key, pending);
    }
    return pending;
  };
  const reverse = async (env: Env, pin: Pin, target: CommunityEntityTarget): Promise<Match> => {
    const document = await index(env, pin, target.entityType);
    if (document === null) return { status: "absent" };
    if (!object(document)) return { status: "unknown" };
    const collection =
      target.entityType === "stories" ? document.episodes : target.entityType === "spine" ? document.models : document;
    if (!object(collection) || Object.keys(collection).length > MAX_RECORDS) return { status: "unknown" };
    const found: { row: Row; routeId: string }[] = [];
    let incomplete = false;
    for (const [key, value] of Object.entries(collection)) {
      if (!object(value)) {
        incomplete = true;
        continue;
      }
      let original: string | null = null;
      if (target.entityType === "stories") {
        original = hasTable(value, "MasterAdv") ? decimal(value.advId) : null;
        if (value.storyId !== key) {
          incomplete = true;
          if (original === target.originalId) return { status: "unknown", ambiguous: true };
          continue;
        }
      } else if (target.entityType === "live2d") {
        original =
          typeof value.sourcePath === "string" && originalModelAddress(value.sourcePath) ? value.sourcePath : null;
        if (value.live2dKey !== key) {
          incomplete = true;
          if (original === target.originalId) return { status: "unknown", ambiguous: true };
          continue;
        }
      } else {
        original = typeof value.resourceKey === "string" && value.resourceKey ? value.resourceKey : null;
        if (
          value.id !== key ||
          (object(value.asset) && value.asset.name !== undefined && value.asset.name !== original)
        ) {
          incomplete = true;
          if (original === target.originalId) return { status: "unknown", ambiguous: true };
          continue;
        }
      }
      if (original === null || !routeIdValid(key)) {
        incomplete = true;
        continue;
      }
      if (original === target.originalId) found.push({ row: value, routeId: key });
    }
    if (found.length > 1) return { status: "unknown", ambiguous: true };
    return found[0] ? { status: "present", ...found[0] } : { status: incomplete ? "unknown" : "absent" };
  };
  const helpTopic = async (env: Env, pin: Pin, id: string): Promise<Match> => {
    const document = await index(env, pin, "help");
    if (!object(document) || !object(document.categories)) return { status: "unknown" };
    for (const category of Object.values(document.categories)) {
      if (!object(category) || !Array.isArray(category.subcategories)) continue;
      const row = category.subcategories.find((topic) =>
        object(topic) && decimal(topic.helpSubcategoryId) === id && hasTable(topic, "MasterHelpSubCategory"));
      if (row) return { status: "present", row, routeId: id };
    }
    return { status: "absent" };
  };
  const locate = (env: Env, pin: Pin, target: CommunityEntityTarget) => {
    const key = `${pin.server}:${pin.releaseId}:${pin.sourceId}:${target.entityType}:${target.originalId}`;
    // Cache immutable facts; each request applies visibility after lookup.
    const cache = matchCache(env);
    const cached = cache?.entries.get(key);
    if (cached) {
      cache!.entries.delete(key);
      cache!.entries.set(key, cached);
      return Promise.resolve(structuredClone(cached.match));
    }
    let pending = matches.get(key);
    if (!pending) {
      pending = (async (): Promise<Match> => {
        try {
          if (target.entityType === "assets") {
            const location = assetStaticLocation(pin.server, "en", target.originalId.match(/.{1,160}/gu)!.join("/"));
            if (!location?.selected || !/^(?:Assets|Packages|CRI)$/u.test(location.path[0] ?? "")) return { status: "absent" };
            const row = await read(env, pin, `sources/${location.path.map(encodeURIComponent).join("/")}`);
            if (!object(row) || !(
              (Array.isArray(row.outputs) && row.outputs.some((entry) => object(entry) && entry.path === location.selected)) ||
              (object(row.objectArchive) && row.objectArchive.path === location.selected)
            )) return { status: "absent" };
            return { status: "present", row: { title: location.selected.split("/").at(-1) }, routeId: target.originalId };
          }
          if ((target.entityType === "live2d" || target.entityType === "spine") && target.originalId.startsWith("model:")) {
            const routeId = target.originalId.slice(6);
            const row = await read(env, pin, `${target.entityType}/${encodeURIComponent(routeId)}`);
            const field = target.entityType === "live2d" ? "live2dKey" : "id";
            return object(row) && row[field] === routeId ? { status: "present", row, routeId } : { status: "absent" };
          }
          if (["stories", "live2d", "spine"].includes(target.entityType)) return await reverse(env, pin, target);
          if (target.entityType === "help") return await helpTopic(env, pin, target.originalId);
          if (target.entityType === "skills") {
            const [family, id] = target.originalId.split("-");
            if (!family || !id || !Object.hasOwn(SKILL_FAMILY_RESOURCES, family) || decimal(id) !== id) return { status: "absent" };
            const resource = SKILL_FAMILY_RESOURCES[family as keyof typeof SKILL_FAMILY_RESOURCES];
            const row = await read(env, pin, `${resource}/${id}`);
            return object(row) && decimal(row.id) === id ? { status: "present", row, routeId: target.originalId } : { status: "absent" };
          }
          const rule = RULES[target.entityType]!;
          const routeId = `${rule.prefix ?? ""}${target.originalId}`;
          const value = await read(env, pin, `${rule.resource}/${encodeURIComponent(routeId)}`);
          if (value === null) return { status: "absent" };
          if (
            !object(value) ||
            (rule.kind && value.kind !== rule.kind) ||
            (rule.sourceTable && !hasTable(value, rule.sourceTable))
          )
            return { status: "unknown" };
          const ownId = rule.prefix || rule.stringId ? value[rule.field] === routeId : decimal(value[rule.field]) === target.originalId;
          const raw = object(value.raw) ? value.raw : null;
          if (!ownId || (!rule.stringId && raw?._id !== undefined && decimal(raw._id) !== target.originalId))
            return { status: "unknown" };
          return { status: "present", row: value, routeId };
        } catch {
          return { status: "unknown" };
        }
      })().then((match) => {
        rememberMatch(cache, key, match);
        return match;
      });
      matches.set(key, pending);
    }
    return pending;
  };
  return async function resolveCommunityEntity(
    env: Env,
    target: CommunityEntityTarget,
    context: { server?: Server; locale?: Locale; discovery?: boolean } = {},
  ): Promise<CommunityCatalogEntityDescriptor | null> {
    if (target.entityType === "community-playlists") {
      if (!/^[0-9a-f-]{36}$/u.test(target.originalId)) return null;
      const title = await publicPlaylistTitle(env, target.originalId);
      if (title === undefined) return null;
      const locale = context.locale ?? "en";
      const locator = {
        routeKind: target.entityType,
        routeId: target.originalId,
        detailPath: `/${locale}/community/playlists/?${new URLSearchParams({ playlist: target.originalId })}`,
      };
      return {
        type: target.entityType, originalId: target.originalId, titles: { [locale]: title },
        availability: { jp: "present", intl: "present" }, locators: { jp: locator, intl: locator },
      };
    }
    if (target.entityType.startsWith("provider-")) {
      const resource = target.entityType.slice(9);
      const match = /^(bestdori|sekai):(?:(?<section>[a-z]+):)?(?<id>[A-Za-z0-9._~-]+)$/u.exec(target.originalId);
      if (!readProvider || !match?.groups || !["songs", "cards", "stories"].includes(resource)) return null;
      const provider = match[1] as ProviderEntityLocator["provider"];
      const { section, id } = match.groups;
      if (!id) return null;
      if (resource === "stories" ? !(PROVIDER_STORY_SECTIONS[provider] as readonly string[]).includes(section ?? "") || !id.startsWith(`${section}.`) :
        !!section || !decimal(id) || (resource === "cards" && provider !== "bestdori")) return null;
      const locale = context.locale ?? "en";
      const entry: ProviderEntityLocator = {
        provider, locale, resource: resource as ProviderEntityLocator["resource"], id, ...(section ? { section } : {}),
      };
      const value = await readProvider(entry);
      if (!value) return null;
      const rawTitle = value.musicTitle ?? value.prefix ?? value.title ?? value.name;
      const title = Array.isArray(rawTitle) ? rawTitle[LOCALES.indexOf(locale)] ?? rawTitle.find((part) => typeof part === "string" && part) : rawTitle;
      const locator = { routeKind: target.entityType, routeId: id, detailPath: providerEntityRoute(entry) };
      return {
        type: target.entityType, originalId: target.originalId, titles: typeof title === "string" ? { [locale]: title } : {},
        availability: { jp: "present", intl: "present" }, locators: { jp: locator, intl: locator },
      };
    }
    if (target.entityType === "community-stories") {
      const row = await publishedCommunityStory(env, target.originalId);
      if (!row || (context.discovery && row.visibility !== "public")) return null;
      const locale = context.locale ?? "en";
      return {
        type: target.entityType,
        originalId: row.id,
        titles: Object.fromEntries(LOCALES.map((locale) => [locale, row.title])),
        availability: { jp: "present", intl: "present" },
        locators: {
          jp: {
            routeKind: "community-stories",
            routeId: row.id,
            detailPath: communityStoryPath("", locale, row.id),
          },
          intl: {
            routeKind: "community-stories",
            routeId: row.id,
            detailPath: communityStoryPath("", locale, row.id),
          },
        },
      };
    }
    if (target.entityType === "community-charts") {
      if (!/^[0-9a-f-]{36}$/u.test(target.originalId)) return null;
      const row = (await communitySonolusRows(env, `haneoka-community-${target.originalId}`))[0];
      if (!row || (context.discovery && row.visibility !== "public")) return null;
      const locale = context.locale ?? "en";
      const detailPath = communityChartPath("", locale, row.id);
      return { type: target.entityType, originalId: row.id, titles: Object.fromEntries(LOCALES.map(locale => [locale, row.title])), availability: { jp: "present", intl: "present" }, locators: { jp: { routeKind: "charts", routeId: row.id, detailPath }, intl: { routeKind: "charts", routeId: row.id, detailPath } } };
    }
    if (target.entityType === "announcements") {
      const match = /^(jp|intl)-([1-9]\d*)$/u.exec(target.originalId);
      if (!match || !readAnnouncement) return null;
      const server = match[1] as Server, id = match[2]!, locale = context.locale ?? "en";
      if (!decimal(id)) return null;
      const row = await readAnnouncement(server, id, locale);
      if (!row || decimal(row.id) !== id || typeof row.title !== "string") return null;
      return {
        type: target.entityType, originalId: target.originalId, titles: { [locale]: row.title },
        availability: { jp: server === "jp" ? "present" : "absent", intl: server === "intl" ? "present" : "absent" },
        locators: { [server]: { routeKind: "announcements", routeId: id, detailPath: announcementPath(server, locale, Number(id)) } },
      };
    }
    if (requestEnv !== undefined && requestEnv !== env) throw new Error("entity-catalog-request-env-changed");
    requestEnv = env;
    const checked = canonicalEntityTarget(target.entityType, target.originalId);
    const rule = Object.hasOwn(RULES, target.entityType) ? RULES[target.entityType] : undefined;
    const stringTarget = rule?.stringId || ["live2d", "spine", "skills", "assets"].includes(target.entityType);
    if (
      !checked ||
      (!rule && !["stories", "live2d", "spine", "help", "skills", "assets"].includes(target.entityType)) ||
      (!stringTarget && decimal(target.originalId) !== target.originalId) ||
      (target.entityType === "assets" && !/^[A-Za-z0-9_-]{1,512}$/u.test(target.originalId)) ||
      ((rule?.stringId || target.entityType === "skills") && !routeIdValid(target.originalId)) ||
      (target.entityType === "skills" && !/^[A-Za-z]+-[1-9]\d*$/u.test(target.originalId)) ||
      ((target.entityType === "live2d" || target.entityType === "spine") && target.originalId.startsWith("model:")
        ? !routeIdValid(target.originalId.slice(6))
        : target.entityType === "live2d" && !originalModelAddress(target.originalId))
    )
      return null;
    const server = context.server ?? "intl",
      locale = context.locale ?? "en";
    if (!SERVERS.includes(server) || !LOCALES.includes(locale)) return null;
    const values = await Promise.all(
      SERVERS.map(async (name) => {
        const pin = await current(env, name);
        const match = pin ? await locate(env, pin, target) : ({ status: "unknown" } as Match);
        if (pin && match.status === "present" && canRead && !await canRead(env, pin, target, match))
          return [name, { status: "absent" } as Match] as const;
        return [name, match] as const;
      }),
    );
    if (values.some(([, value]) => value.ambiguous) || !values.some(([, value]) => value.status === "present"))
      return null;
    const availability: CommunityCatalogEntityDescriptor["availability"] = { jp: "unknown", intl: "unknown" };
    const locators: CommunityCatalogEntityDescriptor["locators"] = {};
    for (const [name, match] of values) {
      availability[name] = match.status;
      if (match.status === "present" && match.routeId) {
        const routeKind = rule?.routeKind ?? target.entityType;
        const assetLocation = routeKind === "assets"
          ? assetStaticLocation(name, locale, match.routeId.match(/.{1,160}/gu)!.join("/"))
          : undefined;
        locators[name] = {
          routeKind,
          routeId: match.routeId,
          detailPath: assetLocation ? assetPublicDocumentUrl(assetLocation)
            : `/${name}/${locale}/${routeKind}/${encodeURIComponent(match.routeId)}/`,
        };
      }
    }
    const preferred = values.find(([name]) => name === server)?.[1];
    const fallback = values.find(([, match]) => match.status === "present")?.[1];
    const row = preferred?.status === "present" ? preferred.row : fallback?.row;
    const peer = values.find(([name]) => name !== server)?.[1].row;
    const titles: CommunityCatalogEntityDescriptor["titles"] = {};
    const text = (value: unknown, slot: number) => {
      const chosen = Array.isArray(value) ? value[slot] : value;
      return typeof chosen === "string" && chosen.trim() ? chosen.trim() : null;
    };
    for (const [slot, name] of LOCALES.entries()) {
      for (const source of [row, peer]) {
        const label = TITLE_FIELDS
          .map((field) => text(source?.[field], slot))
          .find(Boolean);
        if (label) {
          titles[name] = label;
          break;
        }
      }
    }
    return { type: target.entityType, originalId: target.originalId, titles, availability, locators };
  };
}
