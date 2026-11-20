// L3 — GEB
// Input: Credential-free saves from browser imports and the App bridge.
// Output: Versioned private cloud saves and device-local copies.
// Pos: [Map](../L2-2.md); shared account save sync.
// Effects/Dependencies: Uses explicit owner expectations and retains local saves on network failure.
import { gameToolOwner } from "../game-tool-account-store";
import { parseSnapshot, saveRecords, type StoredSave } from "./snapshot";
import { gameSaveSlot } from "./schema";

const API = "/api/v1/account/private-game-saves";
export interface CloudGameSave {
  id: string;
  server: "jp" | "intl";
  label: string;
  savedAt: string | null;
  profile?: StoredSave["profile"];
}
const headers = (owner: string) => ({ "x-haneoka-expected-user": owner });

export async function listCloudGameSaves(owner: string): Promise<CloudGameSave[]> {
  const response = await fetch(API, { credentials: "same-origin", headers: headers(owner), cache: "no-store" });
  if (!response.ok || gameToolOwner() !== owner) return [];
  const { saves } = await response.json() as { saves?: CloudGameSave[] };
  return Array.isArray(saves) ? saves : [];
}

export async function uploadCloudGameSave(record: Pick<StoredSave, "snapshot" | "profile" | "label">, owner: string) {
  const id = await gameSaveSlot(record.snapshot);
  if (gameToolOwner() !== owner) return false;
  try {
    const response = await fetch(`${API}/${id}`, {
      method: "PUT", credentials: "same-origin", cache: "no-store",
      headers: { ...headers(owner), "content-type": "application/json" },
      body: JSON.stringify({ label: record.label, profile: record.profile, snapshot: record.snapshot }),
    });
    return response.ok;
  } catch { return false; }
}

export async function storeImportedGameSave(record: Omit<StoredSave, "id" | "importedAt">): Promise<StoredSave> {
  const saved: StoredSave = { ...record, id: await gameSaveSlot(record.snapshot), importedAt: new Date().toISOString() };
  const known = (await saveRecords("list")).find(row => row.id === saved.id);
  if (known?.snapshot.savedAt && Date.parse(known.snapshot.savedAt) > Date.parse(saved.snapshot.savedAt ?? "1970-01-01")) return known;
  await saveRecords("put", saved);
  return saved;
}

export async function openCloudGameSave(id: string, owner: string): Promise<StoredSave> {
  const result = await fetch(`${API}/${id}`, { credentials: "same-origin", headers: headers(owner), cache: "no-store" });
  if (!result.ok || owner !== gameToolOwner()) throw new Error("save_scope_changed");
  const body = await result.json() as Pick<StoredSave, "snapshot" | "profile" | "label">;
  if (owner !== gameToolOwner()) throw new Error("save_scope_changed");
  return storeImportedGameSave({ ...body, snapshot: parseSnapshot(JSON.stringify(body.snapshot)) });
}
