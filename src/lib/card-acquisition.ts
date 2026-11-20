// L3 — GEB
// Input: A card's acquisition references and its release-pinned catalogues.
// Output: Compact source rows for the same tiles as the system collections.
// Pos: [Map](L2-2.md)
// Effects/Dependencies: Reads only the catalogues referenced by the card.
import { PUBLIC_RELEASE_SERVERS } from "./temporary-public-routing";
import { loadCrossServerCatalog, type CrossCatalogReader } from "./cross-server/load";
import type { CrossCatalogIdentity } from "./cross-server/catalog";

const CARD_ACQUISITION_COLLECTIONS = ["events", "gacha", "exchange", "passes", "login-campaigns", "shop"] as const;
export type CardAcquisitionCollection = (typeof CARD_ACQUISITION_COLLECTIONS)[number];
type Row = Record<string, unknown>;
type Catalogue = { entries?: Record<string, Row> };

interface AcquisitionNotice {
  title: string;
  startAt?: number;
}

const announcements = new Map<string, AcquisitionNotice>([
  ["https://www.fromtyo.jp/news/20260721", { title: "グローバル事前登録者数80万人突破記念" }],
  ["https://haneoka.org/jp/ja/announcements/53/", {
    title: "【追記 10/16】映画「BanG Dream! Ave Mujica prima aurora」公開記念 キャンペーン開催！",
    startAt: 1792072800,
  }],
]);

export type CardAcquisitionSource =
  | { resource: CardAcquisitionCollection; id: string; row: Row }
  | ({ resource: "announcement"; id: string } & AcquisitionNotice);

export async function readCardAcquisitionCatalogue(
  resource: CardAcquisitionCollection, identity: CrossCatalogIdentity, reader: CrossCatalogReader,
): Promise<Catalogue> {
  const native = reader.readCollection(resource, identity) as Promise<Catalogue>;
  const catalog = await loadCrossServerCatalog(resource, {
    selectedServer: identity.server,
    servers: PUBLIC_RELEASE_SERVERS,
    locale: "ja",
    withDependencies: false,
    reader: {
      readIdentity: server => server === identity.server ? Promise.resolve(identity) : reader.readIdentity(server),
      readCollection: (name, source) => source.server === identity.server ? native : reader.readCollection(name, source),
    },
  });
  const entries = { ...(await native).entries };
  for (const entry of catalog.entries) {
    const id = entry.perServer[identity.server]?.id;
    if (id && entry.nameOverrides.title && entries[id])
      entries[id] = { ...entries[id], title: entry.nameOverrides.title };
  }
  return { entries };
}

export async function loadCardAcquisitionSources(
  item: Row,
  read: (resource: CardAcquisitionCollection) => Promise<unknown>,
): Promise<CardAcquisitionSource[]> {
  if (!Array.isArray(item.acquisitionSources)) return [];
  const references = new Map<string, { resource: string; id: string }>();
  for (const source of item.acquisitionSources) {
    if (typeof source?.resource === "string" && typeof source.id === "string")
      references.set(`${source.resource}/${source.id}`, source);
  }

  const fields = ["title", "image", "logo", "backgroundImage", "startAt", "endAt", "payment"];
  const groups = await Promise.all(CARD_ACQUISITION_COLLECTIONS.map(async (resource) => {
    const ids = [...references.values()]
      .filter(source => source.resource === resource && /^[a-z0-9-]+$/u.test(source.id))
      .map(source => source.id);
    if (!ids.length) return [];
    const document = await read(resource) as Catalogue | undefined;
    return ids.flatMap((id): CardAcquisitionSource[] => {
      const row = document?.entries?.[id];
      if (!row) return [];
      return [{ resource, id, row: Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])) }];
    });
  }));
  return [
    ...groups.flat(),
    ...[...references.values()].flatMap(({ resource, id }): CardAcquisitionSource[] => {
      const notice = resource === "announcement" ? announcements.get(id) : undefined;
      return notice ? [{ resource: "announcement", id, ...notice }] : [];
    }),
  ];
}
