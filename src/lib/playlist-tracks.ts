type RecordValue = Record<string, unknown>;
const catalogs = new Map<string, Promise<Record<string, RecordValue>>>();

async function songs(url: string) {
  let request = catalogs.get(url);
  if (!request) {
    request = fetch(url, { headers: { accept: "application/json" } }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as RecordValue;
      return Object.fromEntries(
        Object.values(payload.items || payload)
          .filter((value): value is RecordValue => Boolean(value && typeof value === "object"))
          .map((song) => [String(song.musicId || song.id), song]),
      );
    });
    catalogs.set(url, request);
    request.catch(() => catalogs.delete(url));
  }
  return request;
}

export async function resolvePlaylistTracks(tracks: RecordValue[], defaultServer: string): Promise<RecordValue[]> {
  return Promise.all(
    tracks.map(async (track) => {
      const ref = track.assetRef as RecordValue | undefined;
      if (ref?.kind !== "song") return track;
      const bestdori = ref.provider === "bestdori";
      const server = String(ref.server || defaultServer);
      const id = String(ref.musicId || track.musicId || "");
      const base = bestdori
        ? `/api/v1/garupa/bestdori/${encodeURIComponent(server)}/songs`
        : `/api/v1/servers/${encodeURIComponent(server)}/songs`;
      const catalog = await songs(base);
      const song = catalog[id];
      return {
        ...track,
        ...song,
        assetRef: ref,
        id: `${String(ref.provider)}:${server}:${id}`,
        musicId: id,
        title: song?.musicTitle || song?.title || track.title,
        musicUrl: song?.musicUrl || track.musicUrl || "",
        detailPath: `${bestdori ? "/community/songs-bestdori" : "/catalog/songs"}?song=${encodeURIComponent(id)}`,
      };
    }),
  );
}
