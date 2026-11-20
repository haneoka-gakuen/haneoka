// L3 — GEB
// Input: Local raw saves, archives or versioned snapshots.
// Output: Sanitized snapshots with source labels.
// Pos: [Map](../L2-2.md); shared save workspace.
// Effects/Dependencies: Decodes in the Worker; Public profile fields travel separately from the sanitized snapshot.
import { readSaveDocuments } from "@haneoka/game-data-exporter/save-document";
import { parseSnapshot, type StoredSave } from "./snapshot";
import { songProgressProfile } from "../song-progress-profile";
import { object } from "./catalog";

function rawPlayer(value: Record<string, unknown>) {
  const player = object(value._player ?? value.player ?? value);
  return Array.isArray(player._memberCards) || Array.isArray(player._supportCards) ? player : undefined;
}

function companion(documents: readonly Record<string, unknown>[], fields: readonly string[]) {
  const matches = documents.filter(value => !value.schema && !rawPlayer(value) && fields.some(key => Object.hasOwn(value, key)));
  return matches.length === 1 ? matches[0] : undefined;
}

self.onmessage = async (event: MessageEvent<{ files: File[]; server: "jp" | "intl" }>) => {
  try {
    const documents = await readSaveDocuments(event.data.files);
    const snapshots: Omit<StoredSave, "id" | "importedAt">[] = [];
    const values = documents.map(document => object(document.value));
    const singlePlayer = values.filter(value => value.schema === "haneoka-game-save-v1" || rawPlayer(value)).length === 1;
    const persist = singlePlayer ? companion(values, ["_tutorialPhase", "_latestLiveResult", "_advResumePoints"]) : undefined;
    const permanent = singlePlayer ? companion(values, ["_isTutorialCompleted", "_bulkDownloadLastCompletedAtTicks"]) : undefined;
    for (const document of documents) {
      const value = object(document.value);
      if (value.schema === "haneoka-game-save-v1") {
        const snapshot = parseSnapshot(JSON.stringify(value));
        const profile = songProgressProfile({
          name: snapshot.player._name, uid: snapshot.player._profileId,
          rank: (snapshot.player._playerRankUpData as Record<string, unknown> | undefined)?._afterRank,
          server: snapshot.server,
        });
        snapshots.push({ label: profile.name || document.name, snapshot, profile });
        continue;
      }
      if (value.schema) continue;
      const player = rawPlayer(value);
      if (!player) continue;
      const id = String(player._profileId ?? "");
      const inferred = /^[2-5]\d{10}$/.test(id) ? (id[0] === "5" ? "jp" : "intl") : undefined;
      const settings = player === value ? undefined
        : Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== player));
      const root = { schema: "haneoka-game-save-v1", server: inferred ?? event.data.server, savedAt: null,
        player, settings, persist, permanent };
      const profile = songProgressProfile({
        name: player._name, uid: player._profileId,
        rank: (player._playerRankUpData as Record<string, unknown> | undefined)?._afterRank,
        server: root.server,
      });
      snapshots.push({ label: profile.name || document.name, snapshot: parseSnapshot(JSON.stringify(root)), profile });
    }
    if (!snapshots.length) throw new Error("box_no_player");
    self.postMessage({ snapshots });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error && ["NotReadableError", "NotFoundError"].includes(error.name)
          ? "save_file_unreadable"
          : error instanceof Error
            ? error.message
            : "save_invalid",
    });
  } finally {
    self.close();
  }
};
