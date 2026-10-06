/** One-time conversion of the previous inventory and workspace documents into box ops. */
import type { BoxOp, BoxValue } from "./box-doc";
import type { StorageLike } from "./box-store";

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** Cloud copies beat clean local copies; dirty local drafts beat both. */
const CLOCK = { localClean: 1, cloud: 2, localDirty: 3 } as const;

export function inventoryChanges(inventory: unknown): { key: string; value: BoxValue }[] {
  if (!object(inventory)) return [];
  const out: { key: string; value: BoxValue }[] = [];
  const put = (key: string, value: BoxValue) => out.push({ key, value });
  for (const row of Array.isArray(inventory.members) ? inventory.members : []) {
    if (!object(row) || !count(row.cardId)) continue;
    const id = row.cardId as number;
    put(`m.${id}.own`, true);
    put(`m.${id}.use`, row.excluded !== true);
    if (row.locked === true) put(`m.${id}.lock`, true);
    for (const [field, key] of [["level", "lvl"], ["training", "awk"], ["awakening", "rnk"], ["liveSkillLevel", "sk"], ["gekisoSkillLevel", "gsk"]] as const)
      if (count(row[field]) !== null) put(`m.${id}.${key}`, count(row[field]));
  }
  for (const row of Array.isArray(inventory.snapshots) ? inventory.snapshots : []) {
    if (!object(row) || !count(row.cardId)) continue;
    const id = row.cardId as number;
    put(`s.${id}.own`, true);
    put(`s.${id}.use`, row.excluded !== true);
    if (row.locked === true) put(`s.${id}.lock`, true);
    if (count(row.level) !== null) put(`s.${id}.lvl`, count(row.level));
    if (count(row.awakening) !== null) put(`s.${id}.rnk`, count(row.awakening));
  }
  for (const [field, prefix] of [["bandItems", "bi"], ["characterRanks", "cr"], ["bandRanks", "br"]] as const)
    if (object(inventory[field]))
      for (const [id, value] of Object.entries(inventory[field] as Row))
        if (/^[1-9]\d{0,9}$/u.test(id) && count(value) !== null) put(`${prefix}.${id}`, count(value));
  const modifiers = inventory.playerModifiers;
  if (object(modifiers)) {
    if (count(modifiers.characterTotalRank) !== null) put("p.total", count(modifiers.characterTotalRank));
    if (count(modifiers.vipRank) !== null) put("p.vip", count(modifiers.vipRank));
    for (const [field, prefix] of [["musicMemoryPoints", "mm"], ["characterMemoryPoints", "cm"]] as const)
      if (object(modifiers[field]))
        for (const [id, value] of Object.entries(modifiers[field] as Row))
          if (/^[1-9]\d{0,9}$/u.test(id) && count(value) !== null) put(`${prefix}.${id}`, count(value));
  }
  return out;
}
function workspaceChanges(workspace: unknown): { key: string; value: BoxValue }[] {
  if (!object(workspace)) return [];
  const out: { key: string; value: BoxValue }[] = [];
  for (const team of Array.isArray(workspace.teams) ? workspace.teams : []) {
    if (!object(team) || typeof team.id !== "string" || !object(team.formation)) continue;
    const id = team.id.toLowerCase().replace(/[^a-z0-9-]/gu, "").slice(0, 48);
    if (!id) continue;
    const formation = team.formation;
    out.push({
      key: `team.${id}`,
      value: {
        name: String(team.name ?? "").slice(0, 80),
        members: Array.isArray(formation.memberCardIds) ? formation.memberCardIds : [],
        snaps: Array.isArray(formation.snapshotCardIds) ? formation.snapshotCardIds : [],
        leader: formation.leaderCardId ?? null,
        createdAt: Date.now(),
      },
    });
  }
  return out;
}
const ops = (changes: { key: string; value: BoxValue }[], t: number, c: string): BoxOp[] =>
  changes.map((change) => ({ k: change.key, v: change.value, t, c: `legacy${c}`.slice(0, 40) }));

/** Every previous local draft of this owner and server, across game-data releases. */
export function legacyOps(storage: StorageLike, server: string, owner: string | null, client: string): BoxOp[] {
  const ownerPart = owner === null ? "anonymous" : `account:${encodeURIComponent(owner)}`;
  const inventoryPrefix = `haneoka:team-inventory:v1:${ownerPart}:${encodeURIComponent(server)}:`;
  const workspaceKey = `haneoka:team-workspace:v1:${ownerPart}:${encodeURIComponent(server)}`;
  const out: BoxOp[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key) continue;
    try {
      if (key.startsWith(inventoryPrefix)) {
        const stored = JSON.parse(storage.getItem(key) ?? "null") as Row | null;
        if (object(stored)) out.push(...ops(inventoryChanges(stored.inventory), stored.dirty ? CLOCK.localDirty : CLOCK.localClean, client));
      } else if (key === workspaceKey) {
        const stored = JSON.parse(storage.getItem(key) ?? "null") as Row | null;
        if (object(stored)) out.push(...ops(workspaceChanges(stored.workspace), CLOCK.localClean, client));
      }
    } catch {
      // An unreadable legacy draft is skipped; the original key is left untouched.
    }
  }
  return out;
}
export function cloudLegacyOps(inventory: unknown, workspace: unknown, client: string): BoxOp[] {
  return [...ops(inventoryChanges(inventory), CLOCK.cloud, client), ...ops(workspaceChanges(workspace), CLOCK.cloud, client)];
}
