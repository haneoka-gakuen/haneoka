import { objectRow } from "./team-builder/data";

/** The catalogue's presentation records, read under the caller's existing pin. */
export async function fetchCatalogVisuals(
  identity: { server: string; releaseId: string; sourceId?: string },
  signal: AbortSignal,
  cardMetadata = false,
  bandItemMetadata = false,
) {
  const read = async (resource: string) => {
    const response = await fetch(
      `/api/v1/servers/${encodeURIComponent(identity.server)}/${resource}?release=${encodeURIComponent(identity.releaseId)}`,
      { signal },
    );
    if (
      !response.ok ||
      response.headers.get("x-haneoka-release-id") !== identity.releaseId ||
      response.headers.get("x-haneoka-source-id") !== identity.sourceId
    )
      throw new Error("catalog-visuals-unavailable");
    const value = objectRow(await response.json());
    return objectRow(value.entries ?? value.items ?? value[resource] ?? value);
  };
  const [marks, characters, songs, cards, supportCards, bandItems] = await Promise.all([
    read("ui-marks"),
    read("characters"),
    read("songs"),
    cardMetadata ? read("cards") : Promise.resolve({} as Record<string, unknown>),
    cardMetadata ? read("support-cards") : Promise.resolve({} as Record<string, unknown>),
    bandItemMetadata ? read("band-items") : Promise.resolve({} as Record<string, unknown>),
  ]);
  return {
    cards, supportCards,
    bandItems: Object.fromEntries(
      Object.entries(bandItems)
        .filter(([, row]) => row && typeof row === "object")
        .map(([id, row]) => [id, objectRow(row)]),
    ),
    marks: new Map(
      Object.entries(marks)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, path]) => [name, `/runtime/${identity.server}/${path.replace(/^runtime\//u, "")}`]),
    ),
    characters: Object.fromEntries(
      Object.entries(characters)
        .filter(([, row]) => row && typeof row === "object")
        .map(([id, row]) => [id, objectRow(row)]),
    ),
    songs: Object.fromEntries(
      Object.entries(songs)
        .filter(([, row]) => row && typeof row === "object")
        .map(([id, row]) => [id, objectRow(row)]),
    ),
  };
}
