import type { GekisoResolved } from "./gekiso-mission-luck.ts";

export interface GekisoPerfectHistoryNote {
  timeMs: number;
  sequence: number;
  /** Native history after judgement conversion and range admission. */
  judgement: 5;
}
export interface GekisoComboCountCommand {
  timeMs: number;
  sequence: number;
  /** Resolved float32 increment, rather than its original BP field. */
  diff: number | null;
}
export interface GekisoAddCountCommand {
  timeMs: number;
  /** -1 targets every range. */
  rangeIndex: -1 | 0 | 1 | 2;
  amount: number | null;
}
export interface GekisoPerfectCounterInput {
  rangeIndex: 0 | 1 | 2;
  /** Already admitted native histories/command stacks at the current update. */
  notes: readonly GekisoPerfectHistoryNote[];
  comboBonuses: readonly GekisoComboCountCommand[] | null;
  addCombo: readonly GekisoAddCountCommand[] | null;
  addJust: readonly GekisoAddCountCommand[] | null;
}
export interface GekisoPerfectCounters {
  currentCombo: number;
  maximumCombo: number;
  naturalJustCount: 0;
  bonusJustCount: number;
  totalJustCount: number;
  /** A trailing AddCombo changes currentCombo without changing old snapshots. */
  comboSnapshots: readonly { timeMs: number; sequence: number; combo: number }[];
}
const f = Math.fround;
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
const float = (value: unknown): value is number => typeof value === "number" && Number.isFinite(f(value));
// RecalculateBonusDependentCounts uses ARM fcvtms/fcvtzs, then explicitly
// substitutes INT_MIN for positive infinity. Finite out-of-range casts saturate.
function countCast(value: number, floor: boolean): number {
  if (value === Infinity || value === -Infinity) return -0x80000000;
  if (Number.isNaN(value)) return 0;
  return Math.max(-0x80000000, Math.min(0x7fffffff, floor ? Math.floor(value) : Math.trunc(value)));
}
const fail = (source: string): GekisoResolved<GekisoPerfectCounters> => ({
  value: null,
  gaps: [{ code: "gekiso-perfect-counter-tape-unresolved", source }],
});

/** Full replay of the PERFECT-only branch of original
 * GekisouController.RecalculateBonusDependentCounts (0x55d66b8).
 * Actual JUST/conversion and MISS/BAD protection require their own histories.
 * Skill activation and note admission stay in the upstream native phase driver.
 */
export function replayGekisoPerfectCounters(input: GekisoPerfectCounterInput): GekisoResolved<GekisoPerfectCounters> {
  if (
    ![0, 1, 2].includes(input.rangeIndex) ||
    !Array.isArray(input.notes) ||
    !Array.isArray(input.comboBonuses) ||
    !Array.isArray(input.addCombo) ||
    !Array.isArray(input.addJust) ||
    input.notes.length > 25000 ||
    input.comboBonuses.length + input.addCombo.length + input.addJust.length > 20000
  )
    return fail("native admitted range/history/command arrays");
  const chronological = <T extends { timeMs: number }>(items: readonly T[], compare: (a: T, b: T) => number) =>
    items.every((item, index) => int(item.timeMs) && (!index || compare(items[index - 1]!, item) <= 0));
  const order = (a: { timeMs: number; sequence: number }, b: { timeMs: number; sequence: number }) =>
    a.timeMs - b.timeMs || a.sequence - b.sequence;
  if (
    !input.notes.every((note) => note.judgement === 5 && int(note.sequence) && note.sequence >= 0) ||
    !chronological(input.notes, order) ||
    !input.comboBonuses.every((command) => int(command.sequence) && command.sequence >= -1 && float(command.diff)) ||
    !chronological(input.comboBonuses, order) ||
    ![input.addCombo, input.addJust].every(
      (commands) =>
        commands.every((command) => [-1, 0, 1, 2].includes(command.rangeIndex) && float(command.amount)) &&
        chronological(commands, (a, b) => a.timeMs - b.timeMs),
    )
  )
    return fail("PERFECT-only native chronological inputs and resolved factors");
  let combo = 0,
    maximum = 0,
    totalJust = 0,
    bonusJust = 0;
  let factor = f(1),
    bonusCursor = 0,
    comboCursor = 0,
    justCursor = 0;
  const snapshots: { timeMs: number; sequence: number; combo: number }[] = [];
  const target = (command: GekisoAddCountCommand) =>
    command.rangeIndex === -1 || command.rangeIndex === input.rangeIndex;
  const add = (command: GekisoAddCountCommand, kind: "combo" | "just") => {
    if (!target(command)) return;
    const value = countCast(f(command.amount!), false);
    if (kind === "combo") {
      combo = (combo + value) | 0;
      maximum = Math.max(maximum, combo);
    } else {
      totalJust = (totalJust + value) | 0;
      bonusJust = (bonusJust + value) | 0;
    }
  };
  for (const note of input.notes) {
    while (bonusCursor < input.comboBonuses.length && order(input.comboBonuses[bonusCursor]!, note) <= 0)
      factor = f(factor + f(input.comboBonuses[bonusCursor++]!.diff!));
    while (justCursor < input.addJust.length && input.addJust[justCursor]!.timeMs <= note.timeMs)
      add(input.addJust[justCursor++]!, "just");
    while (comboCursor < input.addCombo.length && input.addCombo[comboCursor]!.timeMs <= note.timeMs)
      add(input.addCombo[comboCursor++]!, "combo");
    combo = (combo + countCast(factor, true)) | 0;
    maximum = Math.max(maximum, combo);
    snapshots.push({ timeMs: note.timeMs, sequence: note.sequence, combo });
  }
  // The original function skips a range with no judgement history entirely.
  if (input.notes.length) {
    for (; justCursor < input.addJust.length; justCursor++) add(input.addJust[justCursor]!, "just");
    for (; comboCursor < input.addCombo.length; comboCursor++) add(input.addCombo[comboCursor]!, "combo");
  }
  return {
    value: {
      currentCombo: combo,
      maximumCombo: maximum,
      naturalJustCount: 0,
      bonusJustCount: bonusJust,
      totalJustCount: totalJust,
      comboSnapshots: snapshots,
    },
    gaps: [],
  };
}
