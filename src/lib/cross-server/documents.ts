import { OFFICIAL_CATALOG_SERVERS, type CrossCatalogDTO, type CrossCatalogIdentity, type OfficialCatalogServer } from "./catalog";
import { exclusiveCatalogServer } from "./availability";
import { pinCrossCatalogValue } from "./presentation";
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const id = (row: Row): unknown => row.id ?? row._id ?? (object(row.raw) ? row.raw._id : undefined);
export interface CrossDocumentEntry {
  identity: CrossCatalogIdentity;
  exclusive: OfficialCatalogServer | null;
}

/** Union native tables in a compound catalog; individual records retain one server variant. */
export function crossCatalogDocuments(dto: CrossCatalogDTO) {
  const order = [dto.selectedServer, ...OFFICIAL_CATALOG_SERVERS.filter((server) => server !== dto.selectedServer)];
  const sources = order.filter((server) => dto.documents[server] && dto.identities[server]);
  const complete = !!dto.documents.jp && !!dto.documents.intl;
  const entries = new WeakMap<Row, CrossDocumentEntry>(), byId = new Map<string, CrossDocumentEntry>();
  const copyRow = (row: Row, server: OfficialCatalogServer, available: OfficialCatalogServer[], key: string) => {
    const identity = dto.identities[server]!;
    const copied = pinCrossCatalogValue(row, identity) as Row;
    const entry = { identity, exclusive: complete ? exclusiveCatalogServer(available) ?? null : null };
    entries.set(copied, entry);
    if (!byId.has(key)) byId.set(key, entry);
    return copied;
  };
  function merge(values: Partial<Record<OfficialCatalogServer, unknown>>, path: string): unknown {
    const present = sources.filter((server) => values[server] !== undefined);
    if (!present.length) return undefined;
    const primary = present[0]!, first = values[primary];
    if (Array.isArray(first)) {
      if (!first.every((row) => object(row) && id(row) !== undefined))
        return pinCrossCatalogValue(first, dto.identities[primary]!);
      const maps = new Map(present.map((server) => [server, new Map((Array.isArray(values[server]) ? values[server] as Row[] : [])
        .filter((row) => object(row) && id(row) !== undefined).map((row) => [String(id(row)), row]))]));
      const keys = new Set(present.flatMap((server) => [...maps.get(server)!.keys()]));
      return [...keys].map((key) => {
        const available = present.filter((server) => maps.get(server)!.has(key));
        const owner = available[0]!;
        return copyRow(maps.get(owner)!.get(key)!, owner, available, key);
      });
    }
    if (!object(first)) return first;
    const keys = new Set(present.flatMap((server) => object(values[server]) ? Object.keys(values[server]) : []));
    const rows = [...keys].every((key) => present.every((server) => {
      const row = object(values[server]) ? values[server][key] : undefined;
      return row === undefined || object(row) && id(row) !== undefined;
    }));
    return Object.fromEntries([...keys].map((key) => {
      const members = Object.fromEntries(present.map((server) => [server, object(values[server]) ? values[server][key] : undefined]));
      if (rows) {
        const available = present.filter((server) => members[server] !== undefined), owner = available[0]!;
        return [key, copyRow(members[owner] as Row, owner, available, String(id(members[owner] as Row)))];
      }
      return [key, merge(members, path + "." + key)];
    }));
  }
  return { document: merge(dto.documents, "") as Row, entries, byId };
}
export type CrossCatalogDocuments = ReturnType<typeof crossCatalogDocuments>;
