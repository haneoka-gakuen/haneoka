// L3 — GEB
// Input: Local raw saves, archives or versioned snapshots.
// Output: Sanitized snapshots with source labels.
// Pos: [Map](../L2-2.md); shared save workspace.
// Effects/Dependencies: Decodes in the Worker; profile identity is used for server detection then discarded.
import { readSaveDocuments } from "@haneoka/game-data-exporter/save-document";
import { parseSnapshot, type SaveSnapshot } from "./snapshot";
self.onmessage = async (event: MessageEvent<{ files: File[]; server: "jp" | "intl" }>) => {
  try {
    const documents = await readSaveDocuments(event.data.files);
    const snapshots: { label: string; snapshot: SaveSnapshot }[] = [];
    for (const document of documents) {
      const value = document.value as Record<string, unknown>;
      if (!value || typeof value !== "object") continue;
      let root = value;
      if (value.schema === "haneoka-game-save-v1") {
        snapshots.push({ label: document.name, snapshot: parseSnapshot(JSON.stringify(value)) });
        continue;
      }
      if (value.schema) continue;
      const player = (value._player ?? value.player ?? value) as Record<string, unknown>;
      if (
        !player ||
        typeof player !== "object" ||
        (!Array.isArray(player._memberCards) && !Array.isArray(player._supportCards))
      )
        continue;
      const id = String(player._profileId ?? "");
      const inferred = /^[2-5]\d{10}$/.test(id) ? (id[0] === "5" ? "jp" : "intl") : undefined;
      root = { schema: "haneoka-game-save-v1", server: inferred ?? event.data.server, savedAt: null, player };
      snapshots.push({ label: document.name, snapshot: parseSnapshot(JSON.stringify(root)) });
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
