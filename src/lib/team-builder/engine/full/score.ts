/** The client's live score: note score from the factor state, and the incremental 40 ms frame log with undo.
 * Undoing a frame subtracts the float sum of each factor field the frame applied, so the state after an undo can differ
 * in the last bits from the state before the frame ran; the score follows that state exactly. */
import { f, floorToI32, floorToI32F64, getFrame, minIgnoringNaN, roundTiesEven, satI32 } from "./num";
import type { ComboCounter } from "./combo";

export const SCORE_JUST = 1;
export const SCORE_PERFECT = 2;
export const SCORE_GREAT = 3;
export const SCORE_GOOD = 4;
const EXTRA_FRAMES = 50;
const NONE: never[] = [];
const LEVEL_STEP = f(0.005);

export interface FactorCommand {
  timeMs: number;
  owner: number;
  note: number;
  combo: number;
  /** Note judgement (6 Just, 5 Perfect, 4 Great, 3 Good) of `judge`. */
  judgement: number;
  judge: number;
  luck: number;
}
export const command = (timeMs: number, owner: number, fields: Partial<FactorCommand>): FactorCommand => ({
  timeMs,
  owner,
  note: 0,
  combo: 0,
  judgement: 0,
  judge: 0,
  luck: 0,
  ...fields,
});
/** `floor(factor * 100000f)` with the floor conversion's saturation. */
export const noteFactorMill = (factor: number) => floorToI32(f(factor * 100000));
/** `round((double)(factor * 100000f))` half to even. */
export function judgementFactorMill(factor: number): number {
  const x = f(factor * 100000);
  return Number.isFinite(x) ? floorToI32F64(roundTiesEven(x)) : floorToI32(x);
}
const mill = (m: number) => (m !== 0 ? f(f(m) / 100000) : 0);

export class FactorState {
  combo = 0;
  note = 1;
  just = 0;
  perfect = 0;
  great = 0;
  good = 0;
  luck = 0;
  judgementFactor(scoreType: number): number {
    switch (scoreType) {
      case SCORE_JUST:
        return this.just;
      case SCORE_PERFECT:
        return this.perfect;
      case SCORE_GREAT:
        return this.great;
      case SCORE_GOOD:
        return this.good;
      default:
        return 0;
    }
  }
  apply(cmd: FactorCommand) {
    const fc = mill(cmd.combo);
    const fn = mill(cmd.note);
    const fj = mill(cmd.judge);
    if (fc !== 0) this.combo = f(this.combo + fc);
    if (fn !== 0) this.note = f(this.note + fn);
    switch (cmd.judgement) {
      case 6:
        this.just = f(this.just + fj);
        break;
      case 5:
        this.perfect = f(this.perfect + fj);
        break;
      case 4:
        this.great = f(this.great + fj);
        break;
      case 3:
        this.good = f(this.good + fj);
        break;
    }
    this.luck = (this.luck + cmd.luck) | 0;
  }
}

class FrameDiff {
  combo = 0;
  note = 0;
  just = 0;
  perfect = 0;
  great = 0;
  good = 0;
  luck = 0;
  add(cmd: FactorCommand) {
    this.luck = (this.luck + cmd.luck) | 0;
    const fc = mill(cmd.combo);
    const fn = mill(cmd.note);
    const fj = mill(cmd.judge);
    if (fc !== 0) this.combo = f(this.combo + fc);
    if (fn !== 0) this.note = f(this.note + fn);
    switch (cmd.judgement) {
      case 6:
        this.just = f(this.just + fj);
        break;
      case 5:
        this.perfect = f(this.perfect + fj);
        break;
      case 4:
        this.great = f(this.great + fj);
        break;
      case 3:
        this.good = f(this.good + fj);
        break;
    }
  }
  undo(s: FactorState) {
    s.just = f(s.just - this.just);
    s.perfect = f(s.perfect - this.perfect);
    s.combo = f(s.combo - this.combo);
    s.note = f(s.note - this.note);
    s.luck = (s.luck - this.luck) | 0;
    s.great = f(s.great - this.great);
    s.good = f(s.good - this.good);
    this.combo = this.note = this.just = this.perfect = this.great = this.good = this.luck = 0;
  }
}

/** Gekisou combo of the range covering a time, or null outside every combo range. */
export interface GekisouComboInfo {
  gekisouCombo(timeMs: number): number | null;
}

export interface ScoreSettings {
  adjustment: number;
  lifeOnus: number;
  notePercent: ReadonlyMap<number, number>;
  judgePercent: ReadonlyMap<number, number>;
  /** Combo bonus type → ascending `[required count, cumulative factor]`. */
  combo: ReadonlyMap<number, readonly (readonly [number, number])[]>;
}

export class ScoreCalculator {
  readonly state = new FactorState();
  readonly levelFactor: number;
  constructor(
    readonly settings: ScoreSettings,
    readonly power: number,
    level: number,
    readonly convertedCount: number,
    readonly assist = 1,
  ) {
    this.levelFactor = f(f(f((level - 5) | 0) * LEVEL_STEP) + 1);
  }
  table(type: number, combo: number): number {
    const rows = this.settings.combo.get(type);
    if (!rows?.length || rows[0]![0] > combo) return 0;
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      if (rows[mid]![0] > combo) hi = mid - 1;
      else lo = mid;
    }
    return rows[lo]![1];
  }
  gekisouComboFactor(info: GekisouComboInfo | null, timeMs: number): number {
    const c = info?.gekisouCombo(timeMs);
    if (c === null || c === undefined) return 1;
    return f(minIgnoringNaN(this.table(1, c), 1) + 1);
  }
  /** Optional observer of every executed note: the factors its score read (the last execution is final). */
  onNote: ((noteId: number, scoreType: number, note: number, gk: number, luck: number, judge: number) => void) | null = null;
  noteScore(combo: number, life: number, timeMs: number, op: number, scoreType: number, info: GekisouComboInfo | null, noteId = 0): number {
    const cum = this.table(0, combo);
    const gk = this.gekisouComboFactor(info, timeMs);
    const scoreUp = f(this.state.note + this.state.judgementFactor(scoreType));
    const luckPercent = Math.min((this.state.luck + 100) | 0, 200);
    const luck = f(f(luckPercent) / 100);
    const comboFactor = f(gk * f(this.state.combo + f(minIgnoringNaN(cum, 1) + 1)));
    this.onNote?.(noteId, scoreType, this.state.note, gk, luck, this.state.judgementFactor(scoreType));
    return this.noteScoreCore(life, op, scoreType, comboFactor, scoreUp, luck);
  }
  noteScoreCore(life: number, op: number, scoreType: number, comboFactor: number, scoreUp: number, luck: number): number {
    const notePct = this.settings.notePercent.get(op);
    const judgePct = this.settings.judgePercent.get(scoreType);
    if (notePct === undefined || judgePct === undefined) throw new Error(`score percent missing: note ${op} score ${scoreType}`);
    const lifeFactor = life > 0 ? 1 : this.settings.lifeOnus;
    const t = f(f(this.settings.adjustment * f(this.power)) * this.levelFactor);
    const a = f(f(f(notePct) / 100) * t);
    const b = f(f(f(judgePct) / 100) * a);
    const c = f(f(b * comboFactor) * scoreUp);
    const d = f(luck * c);
    const x = f(d / f(this.convertedCount));
    const floored = Math.floor(x);
    const y = floored === Infinity ? -2147483648 : f(satI32(floored));
    const z = f(this.assist * f(lifeFactor * y));
    return floorToI32(z);
  }
}

export interface NoteCommand {
  timeMs: number;
  life: number;
  noteId: number;
  op: number;
  scoreType: number;
  added: number;
}

export class IncrementalScore {
  readonly maxFrame: number;
  private notes: NoteCommand[][];
  private factors: FactorCommand[][];
  private diffs: FrameDiff[];
  private prev = -1;
  private added = -1;
  score = 0;
  private fixed = new Map<number, number>();
  private pendingFixed: [number, number] | null = null;
  rankBonus = 0;

  constructor(
    readonly calc: ScoreCalculator,
    musicLengthMs: number,
  ) {
    this.maxFrame = getFrame(musicLengthMs) + EXTRA_FRAMES;
    this.notes = new Array(this.maxFrame);
    this.factors = new Array(this.maxFrame);
    this.diffs = new Array(this.maxFrame);
  }
  private file(t: number): number {
    let frame = getFrame(t);
    if (this.maxFrame <= frame) frame = this.maxFrame - 1;
    this.added = this.added < 0 ? frame : Math.min(this.added, frame);
    return frame;
  }
  addNote(timeMs: number, life: number, noteId: number, op: number, scoreType: number) {
    const frame = this.file(timeMs);
    (this.notes[frame] ??= []).push({ timeMs, life, noteId, op, scoreType, added: 0 });
  }
  addFactor(cmd: FactorCommand) {
    const frame = this.file(cmd.timeMs);
    (this.factors[frame] ??= []).push(cmd);
  }
  /** Every filed note with the score of its last execution. */
  filedNotes(): readonly NoteCommand[] {
    return this.notes.filter(Boolean).flat();
  }
  /** Sets the fixed score filed by the next calculation (only the last one set counts). */
  addFixed(timeMs: number, score: number) {
    this.pendingFixed = [timeMs, score];
  }
  /** Brings the score to the frame of `t`, undoing first down to the earliest frame that received a command. */
  calculate(t: number, combo: ComboCounter, info: GekisouComboInfo | null): number {
    const g = getFrame(t);
    let to = g < 0 ? 0 : g;
    if (this.maxFrame <= g) to = this.maxFrame - 1;
    const u = this.added < 0 ? to : Math.min(to, this.added - 1);
    let start: number;
    if (u < this.prev) {
      for (let frame = this.prev; frame > u; frame--) this.undo(frame);
      start = u + 1;
    } else start = this.prev + 1;
    for (let frame = start; frame <= to; frame++) this.execute(frame, combo, info);
    if (this.pendingFixed) {
      const [ft, fs] = this.pendingFixed;
      this.pendingFixed = null;
      const ff = getFrame(ft);
      if (this.fixed.has(ff)) throw new Error("two fixed scores in one frame");
      this.fixed.set(ff, fs);
      this.score = (this.score + fs) | 0;
    }
    this.prev = to;
    this.added = -1;
    return this.score;
  }
  private undo(frame: number) {
    const notes = this.notes[frame];
    if (notes) for (const n of notes) this.score = (this.score - n.added) | 0;
    const v = this.fixed.get(frame);
    if (v !== undefined) this.score = (this.score - v) | 0;
    this.diffs[frame]?.undo(this.calc.state);
  }
  private execute(frame: number, combo: ComboCounter, info: GekisouComboInfo | null) {
    const fl = this.factors[frame] ?? NONE;
    const nl = this.notes[frame] ?? NONE;
    if (!fl.length && !nl.length) {
      const v = this.fixed.get(frame);
      if (v !== undefined) {
        this.score = (this.score + v) | 0;
        this.rankBonus = (this.rankBonus + v) | 0;
      }
      return;
    }
    const of = fl.length > 1 ? fl.map((_, i) => i).sort((a, b) => fl[a]!.timeMs - fl[b]!.timeMs || fl[a]!.owner - fl[b]!.owner || a - b) : [0];
    const on = nl.length > 1 ? nl.map((_, i) => i).sort((a, b) => nl[a]!.timeMs - nl[b]!.timeMs || nl[a]!.noteId - nl[b]!.noteId || a - b) : [0];
    let a = 0;
    let b = 0;
    while (a < fl.length || b < nl.length) {
      if (a < fl.length && (b >= nl.length || nl[on[b]!]!.timeMs >= fl[of[a]!]!.timeMs)) {
        const c = fl[of[a]!]!;
        this.calc.state.apply(c);
        (this.diffs[frame] ??= new FrameDiff()).add(c);
        a++;
      } else {
        const n = nl[on[b]!]!;
        const s = this.calc.noteScore(combo.timingCombo(n.timeMs), n.life, n.timeMs, n.op, n.scoreType, info, n.noteId);
        n.added = s;
        this.score = (this.score + s) | 0;
        b++;
      }
    }
    const v = this.fixed.get(frame);
    if (v !== undefined) {
      this.score = (this.score + v) | 0;
      this.rankBonus = (this.rankBonus + v) | 0;
    }
  }
}
