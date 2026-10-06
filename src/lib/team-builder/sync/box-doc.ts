/** Conflict-free team box document shared by the browser and the Worker.
 *
 * Every card field, account bonus and saved team is its own key. A write is an
 * op (key, value, clock, client); the newest clock wins and ties break on the
 * client id, so any two replicas that saw the same ops agree without a merge
 * dialog. Each stored entry also records the server revision that last changed
 * it, so readers fetch only what changed since their revision. */

export type BoxValue = number | boolean | string | null | { readonly [key: string]: unknown } | readonly unknown[];
export interface BoxEntry {
  v: BoxValue;
  /** Hybrid logical clock: milliseconds since the epoch, bumped past any seen clock. */
  t: number;
  /** Writer id, the tie break for equal clocks. */
  c: string;
  /** Server revision of the last change; 0 for an entry not yet stored. */
  r: number;
}
export interface BoxOp {
  k: string;
  v: BoxValue;
  t: number;
  c: string;
}
export const BOX_SCHEMA = "haneoka-team-box-v1";
export const MAX_BOX_KEYS = 8000;
export const MAX_OPS_PER_REQUEST = 4000;
export const MAX_BOX_BYTES = 1024 * 1024;
const MAX_STRUCTURED_BYTES = 16 * 1024;

const NUMERIC_FIELDS = new Set(["lvl", "awk", "rnk", "sk", "gsk"]);
const FLAG_FIELDS = new Set(["own", "use", "lock"]);
/** Card fields: m.<card>.<field> (members) and s.<card>.<field> (snaps). */
const CARD_KEY = /^(m|s)\.([1-9]\d{0,9})\.([a-z]{2,4})$/u;
const ACCOUNT_KEY = /^(cr|bi|br|cm|mm)\.([1-9]\d{0,9})$/u;
const PLAYER_KEY = /^p\.(total|vip)$/u;
const STRUCTURED_KEY = /^(team|plan|pref)\.([a-z0-9][a-z0-9-]{0,47})$/u;

const integer = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

/** Key grammar and value shape; null deletes (a tombstone that still carries its clock). */
export function validEntry(key: string, value: unknown): boolean {
  if (typeof key !== "string" || key.length > 64) return false;
  const card = CARD_KEY.exec(key);
  if (card) {
    const field = card[3]!;
    if (FLAG_FIELDS.has(field)) return value === null || typeof value === "boolean";
    if (NUMERIC_FIELDS.has(field)) return value === null || integer(value, 1_000_000);
    return false;
  }
  if (ACCOUNT_KEY.test(key)) return value === null || integer(value, 2_147_483_647);
  if (PLAYER_KEY.test(key)) return value === null || integer(value, 2_147_483_647);
  if (STRUCTURED_KEY.test(key)) {
    if (value === null) return true;
    if (typeof value !== "object") return false;
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_STRUCTURED_BYTES;
    } catch {
      return false;
    }
  }
  return false;
}
export function validOp(op: unknown): op is BoxOp {
  if (!op || typeof op !== "object" || Array.isArray(op)) return false;
  const row = op as Record<string, unknown>;
  return (
    Object.keys(row).length === 4 &&
    typeof row.k === "string" &&
    integer(row.t, Number.MAX_SAFE_INTEGER) &&
    typeof row.c === "string" &&
    /^[A-Za-z0-9_-]{6,40}$/u.test(row.c) &&
    "v" in row &&
    validEntry(row.k, row.v)
  );
}
export const newer = (a: { t: number; c: string }, b: { t: number; c: string } | undefined) =>
  !b || a.t > b.t || (a.t === b.t && a.c > b.c);

/** Applies ops in place; returns the keys whose stored value changed. */
export function applyOps(entries: Record<string, BoxEntry>, ops: readonly BoxOp[], revision: number): string[] {
  const changed: string[] = [];
  for (const op of ops) {
    const current = entries[op.k];
    if (!newer(op, current)) continue;
    entries[op.k] = { v: op.v, t: op.t, c: op.c, r: revision };
    changed.push(op.k);
  }
  return changed;
}
/** Stored entries changed after `since`. */
export function changesSince(entries: Record<string, BoxEntry>, since: number): Record<string, BoxEntry> {
  const out: Record<string, BoxEntry> = {};
  for (const [key, entry] of Object.entries(entries)) if (entry.r > since) out[key] = entry;
  return out;
}
/** Merges server entries into a replica; local entries keep their unsent clocks when newer. */
export function mergeEntries(target: Record<string, BoxEntry>, incoming: Record<string, BoxEntry>): string[] {
  const changed: string[] = [];
  for (const [key, entry] of Object.entries(incoming)) {
    const current = target[key];
    if (current && !newer(entry, current)) {
      if (current.t === entry.t && current.c === entry.c && current.r < entry.r) current.r = entry.r;
      continue;
    }
    target[key] = { ...entry };
    changed.push(key);
  }
  return changed;
}

/** Hybrid logical clock for one writer. */
export class BoxClock {
  private last = 0;
  observe(time: number) {
    if (time > this.last) this.last = time;
  }
  next(): number {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }
}
