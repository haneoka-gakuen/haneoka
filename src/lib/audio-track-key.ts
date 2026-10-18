export interface AudioTrackIdentity {
  id: string;
  url: string;
  songKey?: string;
}

/** Native and GBP song IDs are stable across their respective server regions. */
export function audioTrackKey(track: AudioTrackIdentity): string {
  if (track.songKey) {
    const song = /^(gbp|our-notes):(?:[^:]+:)?(\d+)$/u.exec(track.songKey);
    return song ? `${song[1]}:${song[2]}` : track.songKey;
  }
  let url: URL;
  try {
    url = new URL(track.url, "https://haneoka.invalid");
  } catch {
    return `${track.id}\u0000${track.url}`;
  }
  const gbp = url.pathname.startsWith("/api/v1/garupa/bestdori/") || url.hostname === "bestdori.com";
  const native = /^\/(?:runtime|assets)\/(?:jp|intl)(?:-cbt)?\//u.test(url.pathname);
  const id = track.id
    .split(":")
    .at(-1)
    ?.match(/^(\d+)(?:-\d+)?$/u)?.[1];
  return id && (gbp || native) ? `${gbp ? "gbp" : "our-notes"}:${id}` : `${track.id}\u0000${track.url}`;
}
