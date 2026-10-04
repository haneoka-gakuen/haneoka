import { canonicalEntityTarget, type CommunityEntityTarget } from "./community-entity-guard";

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
interface Rule {
  resource: string;
  routeKind: string;
  field: string;
  kind?: string;
  prefix?: string;
  sourceTable?: string;
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
  "tgw-card": { resource: "tgw-card", routeKind: "tgw-card", field: "rank", sourceTable: "MasterVip" },
  shop: { resource: "shop", routeKind: "shop", field: "id", kind: "shop", sourceTable: "MasterShop" },
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
export function createCommunityEntityResolver(readCatalog: CommunityEntityCatalogReader) {
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
      if (error?.code === "entity_not_found" || error?.code === "resource_not_found") return null;
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
  const locate = (env: Env, pin: Pin, target: CommunityEntityTarget) => {
    const key = `${pin.server}:${pin.releaseId}:${pin.sourceId}:${target.entityType}:${target.originalId}`;
    let pending = matches.get(key);
    if (!pending) {
      pending = (async (): Promise<Match> => {
        try {
          if (["stories", "live2d", "spine"].includes(target.entityType)) return await reverse(env, pin, target);
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
          const ownId = rule.prefix ? value[rule.field] === routeId : decimal(value[rule.field]) === target.originalId;
          const raw = object(value.raw) ? value.raw : null;
          if (!ownId || (raw?._id !== undefined && decimal(raw._id) !== target.originalId))
            return { status: "unknown" };
          return { status: "present", row: value, routeId };
        } catch {
          return { status: "unknown" };
        }
      })();
      matches.set(key, pending);
    }
    return pending;
  };
  return async function resolveCommunityEntity(
    env: Env,
    target: CommunityEntityTarget,
    context: { server?: Server; locale?: Locale } = {},
  ): Promise<CommunityCatalogEntityDescriptor | null> {
    if (requestEnv !== undefined && requestEnv !== env) throw new Error("entity-catalog-request-env-changed");
    requestEnv = env;
    const checked = canonicalEntityTarget(target.entityType, target.originalId);
    const rule = Object.hasOwn(RULES, target.entityType) ? RULES[target.entityType] : undefined;
    const stringTarget = ["live2d", "spine"].includes(target.entityType);
    if (
      !checked ||
      (!rule && !["stories", "live2d", "spine"].includes(target.entityType)) ||
      (!stringTarget && decimal(target.originalId) !== target.originalId) ||
      (target.entityType === "live2d" && !originalModelAddress(target.originalId))
    )
      return null;
    const server = context.server ?? "intl",
      locale = context.locale ?? "en";
    if (!SERVERS.includes(server) || !LOCALES.includes(locale)) return null;
    const values = await Promise.all(
      SERVERS.map(async (name) => {
        const pin = await current(env, name);
        return [name, pin ? await locate(env, pin, target) : ({ status: "unknown" } as Match)] as const;
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
        locators[name] = {
          routeKind,
          routeId: match.routeId,
          detailPath: `/${name}/${locale}/${routeKind}/${encodeURIComponent(match.routeId)}/`,
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
        const label = ["prefix", "musicTitle", "characterName", "title", "name", "live2dName"]
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
