// L3 — GEB
// Input: Browser/App game snapshot documents.
// Output: Bounded credential-free save data.
// Pos: [Map](../L2-2.md); common browser and Worker snapshot validation.
// Effects/Dependencies: Lossless JSON parsing and key filtering.
import { losslessJson } from "@haneoka/game-data-exporter/save-document";
import { hashGameToolKey } from "../game-tool-accounts";
import { profileRegion } from "../game-records";
export interface SaveSnapshot {
  schema: "haneoka-game-save-v1";
  server: "jp" | "intl";
  savedAt: string | null;
  player: Record<string, unknown>;
  settings?: Record<string, unknown> | null;
  persist?: Record<string, unknown> | null;
  permanent?: Record<string, unknown> | null;
}
export async function gameSaveSlot(snapshot: SaveSnapshot) {
  const uid = String(snapshot.player._profileId ?? "");
  const region = profileRegion(uid);
  return (await hashGameToolKey(region && (region === "jp") === (snapshot.server === "jp")
    ? `private-save:${snapshot.server}:${uid}`
    : JSON.stringify(snapshot))).slice(0, 32);
}
const denied =
  /password|token|secret|certification|account_?id|session|credential|authorization|auth_?(?:key|code)|cookie|api_?key|device_?id|friendprofile|friendinvitation|friend_?id|friend_?player|chat|iaptransaction|payment|purchase_?(?:history|record)|reportedplayer|world_room|linkedaccount|specialfocus|sendingrequest|pendingapproval/i;
function clean(value: unknown, depth = 0): unknown {
  if (depth > 24) throw new Error("save_invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)))
    return value;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !denied.test(k) && !["__proto__", "constructor", "prototype"].includes(k))
        .map(([k, v]) => [k, clean(v, depth + 1)]),
    );
  throw new Error("save_invalid");
}
export function parseSnapshot(text: string): SaveSnapshot {
  if (new TextEncoder().encode(text).length > 16 * 1024 * 1024) throw new Error("save_too_large");
  const value = losslessJson(text) as Record<string, unknown>;
  if (
    !value ||
    value.schema !== "haneoka-game-save-v1" ||
    !["jp", "intl"].includes(String(value.server)) ||
    !value.player ||
    typeof value.player !== "object" ||
    Array.isArray(value.player)
  )
    throw new Error("save_invalid");
  for (const key of ["_memberCards", "_supportCards", "_characters", "_bandItems", "_items", "_liveMusicResults"]) {
    const rows = (value.player as Record<string, unknown>)[key];
    if (
      rows !== undefined &&
      (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row)))
    )
      throw new Error("save_invalid");
  }
  if (value.savedAt != null && (typeof value.savedAt !== "string" || !Number.isFinite(Date.parse(value.savedAt))))
    throw new Error("save_invalid");
  const snapshot: SaveSnapshot = {
    schema: "haneoka-game-save-v1",
    server: value.server as "jp" | "intl",
    savedAt: (value.savedAt as string | null) ?? null,
    player: clean(value.player) as Record<string, unknown>,
  };
  if (!Object.keys(snapshot.player).length) throw new Error("save_empty");
  for (const field of ["settings", "persist", "permanent"] as const) {
    const document = value[field];
    if (document === undefined) continue;
    if (document !== null && (typeof document !== "object" || Array.isArray(document))) throw new Error("save_invalid");
    snapshot[field] = clean(document) as Record<string, unknown> | null;
  }
  return snapshot;
}
