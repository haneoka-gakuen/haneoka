/** Skill condition checkers and the factory that builds them from the condition tables. A checker answers
 * `(hit, hit count)` and may carry an override time (the chart time of the note that completed a count). Condition groups
 * are an OR over their sets, each set an AND over its conditions; both stop at the first decisive item. */
import type { EngineMaster, TargetRow } from "../master";
import { type Controller, M_ALL, M_LUCK, S_COMPLETE, S_FINISH, S_PLAYING, S_START } from "./gekisou";
import type { LifeController } from "./life";
import { ceilToI32, f, floorToI32 } from "./num";
import { SKILL, type LiveRandom } from "./random";

export interface GkView {
  ctrl: Controller;
  prevLots: readonly number[];
  prevLotMs: number;
}
export interface CheckCtx {
  prevConfirmedRank: number | null;
  life: LifeController;
  random: LiveRandom;
  frameTime: number;
  currentCombo: number;
  /** The frame's judged notes: note id, converted judgement, chart time. */
  judged: readonly (readonly [number, number, number])[];
  /** The frame's fired skill events: event index, event time. */
  events: readonly (readonly [number, number])[];
  gk: GkView | null;
  /** Luck recording: probabilities pass (their chance is read separately) and no rush is ever playing. */
  record?: boolean;
}
const ctrl = (ctx: CheckCtx, type: number): Controller => {
  if (!ctx.gk) throw new Error(`condition type ${type} reads the Gekisou state of a live without Gekisou`);
  return ctx.gk.ctrl;
};

export abstract class Checker {
  abstract check(ctx: CheckCtx): [boolean, number];
  overrideTime(): number | null {
    return null;
  }
  reset(_ctx: CheckCtx): void {}
  countResettable(): boolean {
    return false;
  }
  resetCount(_ctx: CheckCtx): void {}
  /** For the idle plan: -1 when the checker is the pure `Fixed(false)`, the performer index of a pure same-member live
   * skill check, else undefined. */
  idleMember(): number | undefined {
    return undefined;
  }
}

class Fixed extends Checker {
  constructor(readonly ok: boolean) {
    super();
  }
  check(): [boolean, number] {
    return [this.ok, this.ok ? 1 : 0];
  }
  idleMember() {
    return this.ok ? undefined : -1;
  }
}
class And extends Checker {
  private readonly resettable: boolean[];
  constructor(readonly items: Checker[]) {
    super();
    this.resettable = items.map((item) => item.countResettable());
  }
  check(ctx: CheckCtx): [boolean, number] {
    let hit = 0;
    for (let i = 0; i < this.items.length; i++) {
      const [ok, h] = this.items[i]!.check(ctx);
      hit = Math.max(hit, h);
      if (!ok) {
        if (!this.resettable[i]) this.items.forEach((c, k) => this.resettable[k] && c.resetCount(ctx));
        return [false, 0];
      }
    }
    return [true, hit];
  }
  reset(ctx: CheckCtx) {
    for (const item of this.items) item.reset(ctx);
  }
}
class Or extends Checker {
  constructor(readonly items: Checker[]) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    let hit = 0;
    for (const c of this.items) {
      const [ok, h] = c.check(ctx);
      hit = Math.max(hit, h);
      if (ok) return [true, hit];
    }
    return [false, 0];
  }
  reset(ctx: CheckCtx) {
    for (const item of this.items) item.reset(ctx);
  }
}
class Not extends Checker {
  constructor(readonly inner: Checker) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    const [ok, h] = this.inner.check(ctx);
    return [!ok, h];
  }
  overrideTime() {
    return this.inner.overrideTime();
  }
  reset(ctx: CheckCtx) {
    this.inner.reset(ctx);
  }
  countResettable() {
    return true;
  }
  resetCount(ctx: CheckCtx) {
    if (this.inner.countResettable()) this.inner.resetCount(ctx);
  }
}
class Life extends Checker {
  constructor(
    readonly type: number,
    readonly value: number | undefined,
  ) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    if (this.value === undefined) throw new Error("skill condition without a value");
    const life = ctx.life.lifeAt(ctx.frameTime);
    const ok =
      this.type === 2000 ? this.value < life : this.type === 2001 ? this.value <= life : this.type === 2002 ? life < this.value : life <= this.value;
    return [ok, ok ? 1 : 0];
  }
}
class LifeChanged extends Checker {
  constructor(private previous: number) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    const life = ctx.life.lifeAt(ctx.frameTime);
    const ok = this.previous !== life;
    this.previous = life;
    return [ok, 0];
  }
}
class LifePercent extends Checker {
  private previous = 0;
  constructor(readonly threshold: number) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    const life = ctx.life.lifeAt(ctx.frameTime);
    const ok = this.previous > this.threshold && life <= this.threshold;
    this.previous = life;
    return [ok, ok ? 1 : 0];
  }
}
class LifeDelta extends Checker {
  private count = 0;
  constructor(
    readonly threshold: number,
    readonly increase: boolean,
    private previous: number,
  ) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    const life = ctx.life.lifeAt(ctx.frameTime);
    const change = this.increase ? (life - this.previous) | 0 : (this.previous - life) | 0;
    this.previous = life;
    if (change > 0) this.count = (this.count + change) | 0;
    if (this.threshold <= 0) throw new Error("nonpositive life change threshold");
    const hits = this.count >= this.threshold ? Math.trunc(this.count / this.threshold) : 0;
    if (hits > 0) this.count %= this.threshold;
    return [hits > 0, hits];
  }
  reset(ctx: CheckCtx) {
    this.count = 0;
    this.previous = ctx.life.lifeAt(ctx.frameTime);
  }
  countResettable() {
    return true;
  }
  resetCount(ctx: CheckCtx) {
    this.reset(ctx);
  }
}
class LiveComboMultiple extends Checker {
  private previous = 0;
  constructor(readonly threshold: number) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    const combo = ctx.currentCombo;
    if (combo < 1 || this.threshold < 1) {
      this.previous = 0;
      return [false, 0];
    }
    if (combo <= this.previous) {
      this.previous = combo;
      return [false, 0];
    }
    const hit = Math.trunc(combo / this.threshold) - Math.trunc(this.previous / this.threshold);
    this.previous = combo;
    return [hit > 0, hit];
  }
  reset() {
    this.previous = 0;
  }
}
class LiveComboAtLeast extends Checker {
  constructor(readonly threshold: number) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    const hit = this.threshold > 0 && ctx.currentCombo >= this.threshold;
    return [hit, hit ? 1 : 0];
  }
}
class ElapsedTime extends Checker {
  private elapsed = 0;
  constructor(
    readonly period: number,
    private previous: number,
  ) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    this.elapsed = (this.elapsed + ctx.frameTime - this.previous) | 0;
    this.previous = ctx.frameTime;
    const hit = this.elapsed >= this.period;
    if (hit) this.elapsed = (this.elapsed - this.period) | 0;
    return [hit, hit ? 1 : 0];
  }
  reset(ctx: CheckCtx) {
    this.elapsed = 0;
    this.previous = ctx.frameTime;
  }
  countResettable() {
    return true;
  }
  resetCount(ctx: CheckCtx) {
    this.reset(ctx);
  }
}
class SnapGekisouStart extends Checker {
  private previous = -1;
  check(ctx: CheckCtx): [boolean, number] {
    if (ctx.gk)
      for (const index of ctx.gk.ctrl.stateUpdates)
        if (ctx.gk.ctrl.states[index]!.state === S_START && index !== this.previous) {
          this.previous = index;
          return [true, 1];
        }
    return [false, 0];
  }
  reset() {
    this.previous = -1;
  }
}
class SameMemberLiveSkill extends Checker {
  constructor(readonly member: number) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    const ok = ctx.events.some(([index]) => index === this.member);
    return [ok, ok ? 1 : 0];
  }
  idleMember() {
    return this.member;
  }
}
class Probability extends Checker {
  constructor(readonly rate: number) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    if (ctx.record) return [true, 0];
    return [ctx.random.value(SKILL) < this.rate, 0];
  }
}
class NoteJudgementMatch extends Checker {
  private override: number | null = null;
  constructor(
    readonly kind: number,
    readonly targets: readonly number[],
  ) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    this.override = null;
    let hit = 0;
    for (const [nid, j, tn] of ctx.judged) {
      if (this.kind === 1020 && (j === -1 || j === 7)) continue;
      for (const target of this.targets) {
        let matches: boolean;
        if (this.kind === 1000) matches = target === j;
        else {
          if (target < 1 || target > 6 || j < 1 || j > 6) throw new Error("unknown judgement comparison rank");
          matches = this.kind === 1010 ? j >= target : j <= target;
        }
        if (matches) {
          hit++;
          this.override = nid >= 0 ? tn : null;
          break;
        }
      }
    }
    return [hit > 0, hit];
  }
  overrideTime() {
    return this.override;
  }
  reset() {
    this.override = null;
  }
}
class NoteJudgementCount extends Checker {
  private count = 0;
  private override: number | null = null;
  constructor(
    readonly n: number,
    readonly consecutive: boolean,
    readonly targets: readonly number[],
  ) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    this.override = null;
    let trig = -1;
    let trigMs = 0;
    let ok = false;
    let hit = 0;
    for (const [nid, j, tn] of ctx.judged)
      for (const tj of this.targets) {
        if (tj === j) {
          this.count = (this.count + 1) | 0;
          if (this.count >= this.n) {
            ok = true;
            hit++;
            this.count = 0;
            trig = nid;
            trigMs = tn;
          }
        } else if (this.consecutive) this.count = 0;
      }
    if (ok && trig >= 0) this.override = trigMs;
    return [ok, hit];
  }
  overrideTime() {
    return this.override;
  }
  reset() {
    this.count = 0;
  }
  countResettable() {
    return true;
  }
  resetCount(ctx: CheckCtx) {
    this.reset();
    void ctx;
  }
}
class LuckLotResult extends Checker {
  private override: number | null = null;
  constructor(readonly target: number) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    this.override = null;
    const lots = ctx.gk?.prevLots ?? [];
    const hit = lots.filter((r) => r === this.target).length;
    if (hit > 0) {
      this.override = ctx.gk?.prevLotMs ?? 0;
      return [true, hit];
    }
    return [false, 0];
  }
  overrideTime() {
    return this.override;
  }
  reset() {
    this.override = null;
  }
}
class ComboAtLeast extends Checker {
  private override: number | null = null;
  constructor(readonly threshold: number) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    this.override = null;
    const c = ctrl(ctx, 7005);
    const idx = c.currentPlayingIndex;
    if (idx < 0 || this.threshold <= 0) return [false, 0];
    const rs = c.states[idx]!;
    if (rs.combo < this.threshold) return [false, 0];
    if (rs.lastComboMs >= 0) this.override = rs.lastComboMs;
    return [true, 1];
  }
  overrideTime() {
    return this.override;
  }
  reset() {
    this.override = null;
  }
}
class GkInterval extends Checker {
  private previous = 0;
  private override: number | null = null;
  constructor(
    readonly kind: number,
    readonly n: number,
  ) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    this.override = null;
    const idx = ctx.gk ? ctx.gk.ctrl.currentPlayingIndex : -1;
    const rs = ctx.gk && idx >= 0 ? ctx.gk.ctrl.states[idx]! : null;
    let hits = 0;
    if (this.n > 0 && rs) {
      const current = this.kind === 7001 ? rs.combo : this.kind === 7002 ? rs.just : rs.rawJust;
      if (current <= 0) this.previous = 0;
      else {
        const old = this.previous;
        this.previous = current;
        if (current > old) hits = Math.max(0, Math.trunc(current / this.n) - Math.trunc(old / this.n));
      }
    }
    if (hits > 0 && rs) {
      const t = this.kind === 7001 ? rs.lastComboMs : rs.lastJustMs;
      this.override = t >= 0 ? t : null;
    }
    return [hits > 0, hits];
  }
  overrideTime() {
    return this.override;
  }
  reset() {
    this.previous = 0;
    this.override = null;
  }
}
class JustAtLeast extends Checker {
  private override: number | null = null;
  constructor(readonly threshold: number) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    this.override = null;
    const idx = ctx.gk ? ctx.gk.ctrl.currentPlayingIndex : -1;
    const rs = ctx.gk && idx >= 0 ? ctx.gk.ctrl.states[idx]! : null;
    const hit = this.threshold > 0 && !!rs && rs.just >= this.threshold;
    if (hit && rs!.lastJustMs >= 0) this.override = rs!.lastJustMs;
    return [hit, hit ? 1 : 0];
  }
  overrideTime() {
    return this.override;
  }
  reset() {
    this.override = null;
  }
}
class GkJustEdge extends Checker {
  private previous = 0;
  private lastRange = -1;
  private override: number | null = null;
  constructor(
    readonly raw: boolean,
    readonly threshold: number,
  ) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    this.override = null;
    const idx = ctx.gk ? ctx.gk.ctrl.currentPlayingIndex : -1;
    const rs = ctx.gk && idx >= 0 ? ctx.gk.ctrl.states[idx]! : null;
    if (this.threshold <= 0) return [false, 0];
    if (!rs) {
      this.previous = 0;
      this.lastRange = -1;
      return [false, 0];
    }
    if (idx !== this.lastRange) {
      this.previous = 0;
      this.lastRange = idx;
    }
    const count = this.raw ? rs.rawJust : rs.just;
    const hit = this.previous < this.threshold && count >= this.threshold;
    this.previous = count;
    if (hit && rs.lastJustMs >= 0) this.override = rs.lastJustMs;
    return [hit, hit ? 1 : 0];
  }
  overrideTime() {
    return this.override;
  }
  reset() {
    this.previous = 0;
    this.lastRange = -1;
    this.override = null;
  }
}
class GkOnce extends Checker {
  private triggered = false;
  constructor(readonly eligible: (ctx: CheckCtx) => boolean) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    const hit = !this.triggered && this.eligible(ctx);
    if (hit) this.triggered = true;
    return [hit, hit ? 1 : 0];
  }
  reset() {
    this.triggered = false;
  }
}
const missionOk = (missions: readonly number[], mission: number) => !missions.length || missions.includes(M_ALL) || missions.includes(mission);
class RangeStart extends Checker {
  private triggered: number[] = [];
  private override: number | null = null;
  constructor(readonly missions: readonly number[]) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    this.override = null;
    const c = ctrl(ctx, 7010);
    for (const idx of c.stateUpdates) {
      const s = c.states[idx]!.state;
      if (s === S_FINISH) this.triggered = this.triggered.filter((x) => x !== idx);
      else if (s === S_START) {
        if (!missionOk(this.missions, c.ranges[idx]!.mission)) continue;
        if (!this.triggered.includes(idx)) {
          this.triggered.push(idx);
          this.override = c.ranges[idx]!.startMs;
          return [true, 1];
        }
      }
    }
    return [false, 0];
  }
  overrideTime() {
    return this.override;
  }
  reset() {
    this.triggered = [];
    this.override = null;
  }
}
class RangeComplete extends Checker {
  check(ctx: CheckCtx): [boolean, number] {
    const c = ctrl(ctx, 7013);
    const ok = c.stateUpdates.some((i) => c.states[i]!.state === S_COMPLETE);
    return [ok, ok ? 1 : 0];
  }
}
class RangePlaying extends Checker {
  private active: [number, number][] = [];
  private override: number | null = null;
  constructor(readonly missions: readonly number[]) {
    super();
  }
  check(ctx: CheckCtx): [boolean, number] {
    this.override = null;
    const c = ctrl(ctx, 7020);
    let first = -1;
    for (const idx of c.stateUpdates) {
      const s = c.states[idx]!.state;
      if (s === S_START || s === S_PLAYING) {
        if (!this.active.some((a) => a[0] === idx)) {
          this.active.push([idx, c.ranges[idx]!.mission]);
          if (first < 0) first = c.ranges[idx]!.startMs;
        }
      } else if (s === S_COMPLETE || s === S_FINISH) this.active = this.active.filter((a) => a[0] !== idx);
    }
    if (!this.active.length) return [false, 0];
    if (this.missions.length && !this.missions.includes(M_ALL) && !this.active.some((a) => this.missions.includes(a[1]))) return [false, 0];
    if (first >= 0) this.override = first;
    return [true, 1];
  }
  overrideTime() {
    return this.override;
  }
  reset() {
    this.active = [];
    this.override = null;
  }
}
class LuckRushPlaying extends Checker {
  private rush = false;
  check(ctx: CheckCtx): [boolean, number] {
    if (ctx.record) return [false, 0];
    const c = ctrl(ctx, 7021);
    const idx = c.currentPlayingIndex;
    if (idx >= 0 && c.ranges[idx]!.mission === M_LUCK) this.rush = c.states[idx]!.luck.rushCombo !== 0;
    for (const i of c.stateUpdates) {
      const s = c.states[i]!.state;
      if (c.ranges[i]!.mission === M_LUCK && (s === S_COMPLETE || s === S_FINISH)) this.rush = false;
    }
    return [this.rush, this.rush ? 1 : 0];
  }
  reset() {
    this.rush = false;
  }
}

/** Probability that a pure condition holds: probabilities multiply through AND, OR and NOT; every other checker is
 * asked once (the luck chain's conditions read only life, formation and probabilities). */
export function chanceOf(checker: Checker | null, ctx: CheckCtx): number {
  if (!checker) return 1;
  if (checker instanceof Probability) return checker.rate;
  if (checker instanceof And) return checker.items.reduce((p, item) => p * chanceOf(item, ctx), 1);
  if (checker instanceof Or) return 1 - checker.items.reduce((p, item) => p * (1 - chanceOf(item, ctx)), 1);
  if (checker instanceof Not) return 1 - chanceOf(checker.inner, ctx);
  return checker.check(ctx)[0] ? 1 : 0;
}

/** The count an effect state carries while it runs (read by cumulative appliers). */
export abstract class Cumulative {
  initCount() {
    return 0;
  }
  unit() {
    return 0;
  }
  max() {
    return 0;
  }
  abstract updateCount(ctx: CheckCtx): number;
  reset() {}
}
class CumulativeFixed extends Cumulative {
  constructor(readonly value: number) {
    super();
  }
  initCount() {
    return this.value;
  }
  updateCount() {
    return this.value;
  }
}
class ComboPerN extends Cumulative {
  constructor(
    readonly n: number,
    readonly valuesEmpty: boolean,
    readonly maximum: number,
    readonly just: boolean,
  ) {
    super();
  }
  unit() {
    return this.n;
  }
  max() {
    return this.maximum;
  }
  updateCount(ctx: CheckCtx) {
    if (!ctx.gk) return 0;
    const idx = ctx.gk.ctrl.currentPlayingIndex;
    let v = 0;
    if (idx >= 0) {
      if (this.valuesEmpty) throw new Error("skill condition without a value");
      const st = ctx.gk.ctrl.states[idx]!;
      v = floorToI32(f(f(this.just ? st.just : st.combo) / f(this.n)));
    }
    return v >= this.maximum ? this.maximum : v;
  }
}
class LifePerN extends Cumulative {
  constructor(
    readonly init: number,
    readonly n: number,
    readonly valuesEmpty: boolean,
    readonly maximum: number,
    readonly limit: boolean,
  ) {
    super();
  }
  initCount() {
    return this.init;
  }
  updateCount(ctx: CheckCtx) {
    if (this.valuesEmpty) throw new Error("skill condition without a value");
    const life = this.limit ? ctx.life.maximum : ctx.life.lifeAt(ctx.frameTime);
    return Math.min(floorToI32(f(f(life) / f(this.n))), this.maximum);
  }
}
class JudgementPerN extends Cumulative {
  private count = 0;
  constructor(
    readonly n: number,
    readonly valuesEmpty: boolean,
    readonly targets: readonly number[],
    readonly maximum: number,
    readonly kind: number,
  ) {
    super();
  }
  unit() {
    return this.n;
  }
  max() {
    return this.maximum;
  }
  updateCount(ctx: CheckCtx) {
    for (const [, j] of ctx.judged)
      if (this.targets.some((t) => (this.kind === 1001 ? j >= t : this.kind === 1002 ? j <= t : j === t))) this.count = (this.count + 1) | 0;
    if (this.valuesEmpty) throw new Error("skill condition without a value");
    return Math.min(floorToI32(f(f(this.count) / f(this.n))), this.maximum);
  }
  reset() {
    this.count = 0;
  }
}
class ElapsedCount extends Cumulative {
  private elapsed = 0;
  private count = 0;
  constructor(
    readonly period: number,
    private previous: number,
    readonly maximum: number,
  ) {
    super();
  }
  updateCount(ctx: CheckCtx) {
    this.elapsed = (this.elapsed + ctx.frameTime - this.previous) | 0;
    this.previous = ctx.frameTime;
    if (this.elapsed >= this.period) {
      this.elapsed = (this.elapsed - this.period) | 0;
      this.count = (this.count + 1) | 0;
    }
    return Math.min(this.count, this.maximum);
  }
  reset() {
    this.elapsed = 0;
    this.count = 0;
  }
}

/** A performer's skill-target view. */
export interface Performer {
  liveSkill: readonly [number, number] | null;
  supportSkills: readonly (readonly [number, number])[];
  bandId: number;
  characterId: number;
  cardType: number;
  tagIds: readonly number[];
  liveSkillCategories: readonly number[];
  gekisouSkillCategories: readonly number[];
  gekisouMissionType: number;
  gekisouSkill: readonly [number, number] | null;
  gekisouSupportSkills: readonly (readonly [number, number])[];
  /** Analysis only: a Gekisou mission without Gekisou skill rows (lets the snap's support skills run). */
  missionOnly?: number;
}
/** The live member-target predicate (it ignores the target's discriminator). */
export function performerMatches(p: Performer, t: TargetRow): boolean {
  const categories = (targets: readonly number[], member: readonly number[]) => targets.some((c) => c !== 0 && member.includes(c));
  return (
    (t.bandId > 0 && t.bandId === p.bandId) ||
    (t.cardType !== 0 && t.cardType === p.cardType) ||
    (t.characterId > 0 && t.characterId === p.characterId) ||
    (t.tagId > 0 && p.tagIds.includes(t.tagId)) ||
    categories(t.liveSkillCategories, p.liveSkillCategories) ||
    categories(t.gekisouSkillCategories, p.gekisouSkillCategories) ||
    (t.gekisouMissionType !== 0 && t.gekisouMissionType === p.gekisouMissionType)
  );
}

const TARGET_MISSION = 5;
const NO_JUDGEMENT = -1;

/** Builds checkers for the performer at index `k` of `deck`. */
export class Factory {
  constructor(
    readonly master: EngineMaster,
    readonly deck: readonly Performer[],
    readonly initialLife: number,
    readonly skillTargetMusicType: number,
    readonly initialTimeMs = 0,
  ) {}
  private target(id: number): TargetRow {
    const t = this.master.targets.get(id);
    if (!t) throw new Error(`unknown skill target ${id}`);
    return t;
  }
  private one(cid: number, k: number): Checker | null {
    const c = this.master.conditions.get(cid);
    if (!c) throw new Error(`unknown skill condition ${cid}`);
    const v0 = c.values[0];
    const need = () => {
      if (v0 === undefined) throw new Error("skill condition without a value");
      return v0;
    };
    const targets = () => c.targetIds.map((id) => this.target(id));
    const missions = () => targets().filter((t) => t.skillTargetType === TARGET_MISSION && t.gekisouMissionType !== 0).map((t) => t.gekisouMissionType);
    let ch: Checker;
    switch (c.type) {
      case 0:
        return null;
      case 2000:
      case 2001:
      case 2002:
      case 2003:
        ch = new Life(c.type, v0);
        break;
      case 2004:
        ch = new LifeChanged(this.initialLife);
        break;
      case 4007:
        ch = new LifePercent(ceilToI32(f(f(f(need()) / 10) * f(this.initialLife))));
        break;
      case 4008:
      case 4009:
        ch = new LifeDelta(need() | 0, c.type === 4008, this.initialLife);
        break;
      case 3000:
      case 3001: {
        const ts = targets();
        const count = this.deck.filter((member) => ts.some((t) => performerMatches(member, t))).length;
        ch = new Fixed(c.type === 3000 ? count > 0 : count === this.deck.length);
        break;
      }
      case 4001:
        ch = new LiveComboMultiple(need() | 0);
        break;
      case 4002:
        ch = new LiveComboAtLeast(need() | 0);
        break;
      case 4000:
        ch = new ElapsedTime(Math.imul(need() | 0, 1000), this.initialTimeMs);
        break;
      case 4010:
      case 5020:
        ch = new SameMemberLiveSkill(k);
        break;
      case 5021:
        ch = new SnapGekisouStart();
        break;
      case 4012:
        ch = new Fixed(targets().some((t) => t.liveMusicType === this.skillTargetMusicType));
        break;
      case 4011:
        ch = new Probability(f(f(need()) / 100));
        break;
      case 5000: {
        const p = this.deck[k];
        ch = new Fixed(!!p && targets().some((t) => performerMatches(p, t)));
        break;
      }
      case 8000:
        ch = new Fixed(false);
        break;
      case 1000:
      case 1010:
      case 1020:
      case 1030:
      case 1040: {
        const judgements = targets()
          .map((t) => t.judgement)
          .filter((j) => j !== NO_JUDGEMENT);
        ch = c.type === 1030 || c.type === 1040 ? new NoteJudgementCount(need(), c.type === 1040, judgements) : new NoteJudgementMatch(c.type, judgements);
        break;
      }
      case 7000:
        ch = new LuckLotResult(need());
        break;
      case 7001:
      case 7002:
      case 7004:
        ch = new GkInterval(c.type, need() | 0);
        break;
      case 7003:
        ch = new JustAtLeast(need() | 0);
        break;
      case 7006:
      case 7007:
        ch = new GkJustEdge(c.type === 7007, need() | 0);
        break;
      case 7011:
        ch = new GkOnce((ctx) => !!ctx.gk);
        break;
      case 7012: {
        const threshold = v0 ?? 1;
        ch = new GkOnce((ctx) => ctx.prevConfirmedRank !== null && ctx.prevConfirmedRank > 0 && ctx.prevConfirmedRank <= threshold);
        break;
      }
      case 7005:
        ch = new ComboAtLeast(need());
        break;
      case 7010:
        ch = new RangeStart(missions());
        break;
      case 7013:
        ch = new RangeComplete();
        break;
      case 7020:
        ch = new RangePlaying(missions());
        break;
      case 7021:
        ch = new LuckRushPlaying();
        break;
      default:
        throw new Error(`unsupported skill condition type ${c.type}`);
    }
    return c.positive ? ch : new Not(ch);
  }
  /** The checker of a condition group (null for group 0 or a group without a non-empty set). */
  group(gid: number, k: number): Checker | null {
    if (!gid) return null;
    const ors: Checker[] = [];
    for (const set of this.master.conditionSets.get(gid) ?? []) {
      const items = set.map((cid) => this.one(cid, k)).filter((c): c is Checker => !!c);
      if (items.length === 1) ors.push(items[0]!);
      else if (items.length > 1) ors.push(new And(items));
    }
    return ors.length === 0 ? null : ors.length === 1 ? ors[0]! : new Or(ors);
  }
  /** The cumulative condition of an effect (id 0: none). */
  cumulative(cid: number, k: number): Cumulative | null {
    if (!cid) return null;
    const c = this.master.cumulative.get(cid);
    if (!c) throw new Error(`unknown cumulative condition ${cid}`);
    const max = c.cap < 1 ? 2147483647 : c.cap;
    const n = c.values[0] ?? 0;
    const empty = !c.values.length;
    switch (c.type) {
      case 7000:
      case 7001:
        return new ComboPerN(n, empty, max, c.type === 7000);
      case 2000:
      case 2001: {
        if (c.type === 2000 && empty) throw new Error("skill condition without a value");
        const init = c.type === 2000 ? floorToI32(f(f(this.initialLife) / f(n))) : 0;
        return new LifePerN(init, n, empty, max, c.type === 2001);
      }
      case 1000:
      case 1001:
      case 1002: {
        const targets = c.targetIds.map((id) => this.target(id).judgement).filter((j) => j !== NO_JUDGEMENT);
        return new JudgementPerN(n, empty, targets, max, c.type);
      }
      case 3000:
      case 3001:
      case 3002:
      case 3003:
      case 3004:
      case 3005: {
        let count: number;
        if (c.type <= 3001) {
          const ts = c.targetIds.map((id) => this.target(id));
          count = this.deck.filter((member, index) => (c.type !== 3001 || index !== k) && ts.some((t) => performerMatches(member, t))).length;
        } else if (c.type <= 3003) {
          const band = this.deck[k]?.bandId;
          if (band === undefined) throw new Error("cumulative self member index out of range");
          count = c.type === 3002 ? this.deck.filter((p) => p.bandId === band).length : new Set(this.deck.map((p) => p.bandId).filter((b) => b !== band)).size;
        } else count = new Set(this.deck.map((p) => (c.type === 3004 ? p.bandId : p.cardType))).size;
        return new CumulativeFixed(Math.min(count, max));
      }
      case 6000: {
        if (empty) throw new Error("skill condition without a value");
        return new ElapsedCount(Math.imul(n | 0, 1000), this.initialTimeMs, max);
      }
      default:
        throw new Error(`ArgumentOutOfRangeException: cumulative condition type ${c.type}`);
    }
  }
}
