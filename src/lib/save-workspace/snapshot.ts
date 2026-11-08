// L3 — GEB
// Input: Versioned save snapshots and local storage requests.
// Output: Sanitized, lossless progress snapshots and IndexedDB records.
// Pos: [Map](../L2-2.md); shared save workspace.
// Effects/Dependencies: Filters account credentials and persists independent local copies.
import { losslessJson } from "@haneoka/game-data-exporter/save-document";
export interface SaveSnapshot {
  schema: "haneoka-game-save-v1";
  server: "jp" | "intl";
  savedAt: string | null;
  player: Record<string, unknown>;
}
const denied =
  /password|token|secret|certification|accountid|session|credential|friendprofile|friendinvitation|chat|iaptransaction|externalpayment|reportedplayer|world_room|linkedaccount|specialfocus|sendingrequest|pendingapproval/i;
const fields = new Set(
  "_memberCards _supportCards _characters _characterFriendships _bandItems _items _liveMusicResults _topHighScoreRatings _challengeMusicResults _events _challengeLives _gachaRecords _storyEpisodeRecords _decks _normalMissions _limitedMissions _characterMissions _playerSeasonPass _monthlyPass _receivedLoginBonuses _unlockedCostumes _currentCostumes _backgrounds _stamps _degrees _playerProfileCards _liveLaneSkins _liveNoteSkins _liveNoteEffectSkins _liveNoteSeGroups _spots _memory _liveBoost _liveSkip _vip _offlineBonus _arenaLeagues _liveMusics _challengeMusics _characterFriendshipRankRewards _stampFavorites _exchange _shop _exp _playerRankUpData".split(
    " ",
  ),
);
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
  const player = Object.fromEntries(
    Object.entries(value.player)
      .filter(([k]) => fields.has(k))
      .map(([k, v]) => [k, clean(v)]),
  );
  if (!Object.keys(player).length) throw new Error("save_empty");
  if (value.savedAt != null && (typeof value.savedAt !== "string" || !Number.isFinite(Date.parse(value.savedAt))))
    throw new Error("save_invalid");
  return {
    schema: "haneoka-game-save-v1",
    server: value.server as "jp" | "intl",
    savedAt: (value.savedAt as string | null) ?? null,
    player,
  };
}
export interface StoredSave {
  id: string;
  label: string;
  importedAt: string;
  snapshot: SaveSnapshot;
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("haneoka-save-snapshots", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("snapshots", { keyPath: "id" });
    req.onerror = () => reject(new Error("save_storage_failed", { cause: req.error }));
    req.onblocked = () => reject(new Error("save_storage_busy"));
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
  });
}
export async function saveRecords(
  action: "list" | "put" | "delete",
  value?: StoredSave | string,
): Promise<StoredSave[]> {
  const db = await database().catch((error) => {
    throw new Error("save_storage_failed", { cause: error });
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", action === "list" ? "readonly" : "readwrite"),
        store = tx.objectStore("snapshots");
      if (action === "put") {
        const record = value as StoredSave;
        store.put({ ...record, snapshot: parseSnapshot(JSON.stringify(record.snapshot)) });
      }
      if (action === "delete") store.delete(value as string);
      const req = store.getAll();
      tx.oncomplete = () => resolve(req.result as StoredSave[]);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("save_storage_failed"));
    });
  } catch (error) {
    throw new Error("save_storage_failed", { cause: error });
  } finally {
    db.close();
  }
}
