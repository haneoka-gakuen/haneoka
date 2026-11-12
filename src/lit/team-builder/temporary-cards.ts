// L3 — GEB
// Input: Page-local card drafts, field edits and the permanent Box entries.
// Output: A temporary working-card overlay and its change version.
// Pos: [Map](../L2-2.md); ephemeral cards for the team-builder workspace.
// Effects/Dependencies: Memory only; uses the shared Box clock and never writes storage or sync queues.
import { BoxClock, type BoxEntry, type BoxValue } from "../../lib/team-builder/sync/box-doc";

export type TemporaryCardKind = "members" | "snaps";
export type CardWrite = { key: string; value: BoxValue };
const prefix = (kind: TemporaryCardKind, id: number) => `${kind === "members" ? "m" : "s"}.${id}`;
const fieldOwner = (key: string) => key.slice(0, key.lastIndexOf("."));

export class TemporaryCards {
  private cards = new Map<string, Record<string, BoxEntry>>();
  private clock = new BoxClock();
  version = 0;
  get size() { return this.cards.size; }
  has(kind: TemporaryCardKind, id: number) { return this.cards.has(prefix(kind, id)); }
  ownsKey(key: string) { return this.cards.has(fieldOwner(key)); }
  value(key: string) { return this.cards.get(fieldOwner(key))?.[key]?.v; }
  private entry(value: BoxValue): BoxEntry { return { v: value, t: this.clock.next(), c: "temporary", r: 0 }; }
  ids(kind: TemporaryCardKind) {
    const head = kind === "members" ? "m." : "s.";
    return [...this.cards.keys()].filter(key => key.startsWith(head)).map(key => Number(key.slice(2)));
  }
  add(kind: TemporaryCardKind, id: number, changes: readonly CardWrite[]) {
    const key = prefix(kind, id), record: Record<string, BoxEntry> = {};
    for (const change of [{ key: `${key}.own`, value: true }, ...changes]) record[change.key] = this.entry(change.value);
    this.cards.set(key, record);
    this.version++;
  }
  apply(changes: readonly CardWrite[]) {
    let changed = false;
    for (const change of changes) {
      const key = fieldOwner(change.key), card = this.cards.get(key);
      if (!card) continue;
      if (change.key === `${key}.own` && change.value === false) {
        this.cards.delete(key);
        changed = true;
      } else if (!card[change.key] || !Object.is(card[change.key]!.v, change.value)) {
        card[change.key] = this.entry(change.value);
        changed = true;
      }
    }
    if (changed) this.version++;
    return changed;
  }
  remove(kind: TemporaryCardKind, id: number) {
    const changed = this.cards.delete(prefix(kind, id));
    if (changed) this.version++;
    return changed;
  }
  clear() {
    if (!this.cards.size) return false;
    this.cards.clear();
    this.version++;
    return true;
  }
  changes(kind: TemporaryCardKind, id: number): CardWrite[] {
    return Object.entries(this.cards.get(prefix(kind, id))!).map(([key, entry]) => ({ key, value: entry.v }));
  }
  merge(entries: Readonly<Record<string, BoxEntry>>) {
    if (!this.cards.size) return entries;
    const merged = { ...entries };
    for (const card of this.cards.values()) Object.assign(merged, card);
    return merged;
  }
}
