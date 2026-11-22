// L3 — GEB
// Input: Explicit same-server source, destination and selected data kind.
// Output: A conflict preview, confirmed copy, and device-local undo.
// Pos: [Map](L2-2.md); manual assignment of legacy game-tool data.
// Effects/Dependencies: Reads Box replicas and preserves source data.
import { BoxStore } from "./team-builder/sync/box-store";
import { MAX_BOX_KEYS, type BoxValue } from "./team-builder/sync/box-doc";
import { gameToolCopyBackupKey, isGameToolAccountId, type GameToolAccount } from "./game-tool-accounts";
import { gameToolOwner } from "./game-tool-account-store";

type DataKind = "team" | "songs";
type Changes = { key: string; value: BoxValue }[];
export interface GameToolCopyPreview {
  target: GameToolAccount;
  owner: string | null;
  missing: Changes;
  conflicts: Changes;
  base: Record<string, BoxValue>;
}

const openBox = (profile: GameToolAccount, owner: string | null) => new BoxStore({
  server: profile.server, accountOwner: owner, accountId: isGameToolAccountId(profile.id) ? profile.id : undefined,
});
const isSongKey = (key: string) => key.startsWith("l.") || key.startsWith("pref.pc-");
const equal = (a: BoxValue, b: BoxValue) => JSON.stringify(a) === JSON.stringify(b);

export async function previewGameToolCopy(source: GameToolAccount, target: GameToolAccount, kind: DataKind): Promise<GameToolCopyPreview> {
  if (source.id === target.id || source.server !== target.server || source.tool !== kind || target.tool !== kind || !isGameToolAccountId(target.id))
    throw new Error("game_tool_scope");
  const owner = gameToolOwner(), from = openBox(source, owner), to = openBox(target, owner);
  try {
    await Promise.all([from.start(), to.start()]);
    if (from.snapshot.owner !== owner || to.snapshot.owner !== owner || gameToolOwner() !== owner)
      throw new Error("game_tool_account_changed");
    const missing: Changes = [], conflicts: Changes = [];
    const base: Record<string, BoxValue> = {};
    for (const [key, entry] of Object.entries(from.snapshot.entries)) {
      if (entry.v === null || key.startsWith("pref.save-") || isSongKey(key) !== (kind === "songs")) continue;
      const existing = to.value(key) ?? null;
      if (equal(existing, entry.v)) continue;
      base[key] = existing;
      (existing === null ? missing : conflicts).push({ key, value: entry.v });
    }
    return { target, owner, missing, conflicts, base };
  } finally {
    from.dispose(); to.dispose();
  }
}

export async function applyGameToolCopy(preview: GameToolCopyPreview, replace: boolean) {
  const { target, owner, missing, conflicts, base } = preview;
  const to = openBox(target, owner);
  try {
    await to.start();
    const changes = replace ? [...missing, ...conflicts] : missing;
    if (to.snapshot.owner !== owner || gameToolOwner() !== owner ||
      changes.some(({ key }) => !equal(to.value(key) ?? null, base[key] ?? null)))
      throw new Error("game_tool_account_changed");
    if (Object.keys(to.snapshot.entries).length + changes.filter(({ key }) => !Object.hasOwn(to.snapshot.entries, key)).length > MAX_BOX_KEYS)
      throw new Error("game_tool_box_limit");
    if (!changes.length) return;
    localStorage.setItem(gameToolCopyBackupKey(owner, target.id), JSON.stringify({
      before: changes.map(({ key }) => ({ key, value: base[key] ?? null })), after: changes,
    }));
    to.set(changes);
    await to.flushPending();
  } finally {
    to.dispose();
  }
}

export function hasGameToolCopyBackup(account: GameToolAccount) {
  try { return localStorage.getItem(gameToolCopyBackupKey(gameToolOwner(), account.id)) !== null; }
  catch { return false; }
}
export async function undoGameToolCopy(account: GameToolAccount) {
  const owner = gameToolOwner(), key = gameToolCopyBackupKey(owner, account.id), to = openBox(account, owner);
  try {
    const snapshot = JSON.parse(localStorage.getItem(key) ?? "null") as { before: Changes; after: Changes } | null;
    if (!snapshot) return;
    await to.start();
    if (to.snapshot.owner !== owner || gameToolOwner() !== owner ||
      snapshot.after.some(change => !equal(to.value(change.key) ?? null, change.value)))
      throw new Error("game_tool_account_changed");
    to.set(snapshot.before);
    localStorage.removeItem(key);
    await to.flushPending();
  } finally {
    to.dispose();
  }
}
