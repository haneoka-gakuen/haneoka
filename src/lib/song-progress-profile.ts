// L3 — GEB
// Input: A game save's public profile fields and the current Box owner.
// Output: A device-local, source-linked account identity for song-progress exports.
// Pos: [Map](L2-2.md); verified-by-source export profile, separate from manually entered fields.
// Effects/Dependencies: Stores only display identity, never original save credentials.
import { GAME_REGION_NAMES, profileRegion } from "./game-records";

export interface SongProgressProfile {
  name: string;
  uid: string;
  rank: string;
  region: string;
}

export function songProgressProfile(input: {
  name?: unknown;
  uid?: unknown;
  rank?: unknown;
  region?: unknown;
  server?: unknown;
}): SongProgressProfile {
  const uid = typeof input.uid === "string" || typeof input.uid === "number" && Number.isSafeInteger(input.uid)
    ? String(input.uid).trim().slice(0, 24) : "";
  const regions = Object.entries(GAME_REGION_NAMES);
  let region = (input.region ?? "").toString().toLowerCase();
  if (region === "global-hmt") region = "tw";
  if (region === "global-en") region = "en";
  if (region === "global-kr") region = "kr";
  const known = profileRegion(uid);
  return {
    name: typeof input.name === "string" ? input.name.trim().slice(0, 64) : "",
    uid,
    rank: /^\d{1,8}$/u.test(String(input.rank ?? "")) ? String(input.rank) : "",
    region: known ? GAME_REGION_NAMES[known]
      : regions.find(([key, label]) => key === region || label.toLowerCase() === region)?.[1]
        ?? (input.server === "jp" ? GAME_REGION_NAMES.jp : ""),
  };
}

const keyFor = (server: string, owner: string | null) => `haneoka.song-progress-identity.v1.${server}.${owner ?? "local"}`;

export function saveSongProgressProfile(server: string, owner: string | null, profile?: SongProgressProfile) {
  try {
    if (profile && Object.values(profile).some(Boolean)) localStorage.setItem(keyFor(server, owner), JSON.stringify(profile));
    else localStorage.removeItem(keyFor(server, owner));
  } catch { /* The account can also be resolved on export. */ }
}

export function readSongProgressProfile(server: string, owner: string | null): SongProgressProfile {
  try {
    return songProgressProfile(JSON.parse(localStorage.getItem(keyFor(server, owner)) || "{}") ?? {});
  } catch { return songProgressProfile({}); }
}
