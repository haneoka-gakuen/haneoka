/** The skill effect state machine and the condition skill updater (snap, Gekisou and Gekisou support skills). An effect
 * state moves Stay → ExecuteFrame (with the trigger time) → Executing → EndFrame (with the finish time) → Stay. */
import type { CheckCtx, Checker, Cumulative } from "./conditions";
import { M_ALL } from "./gekisou";
import { ceilToI32, f } from "./num";

export const STAY = 0;
export const EXECUTE_FRAME = 2;
export const EXECUTING = 3;
export const END_FRAME = 4;
export const ONE_SHOT = 1;
export const SUSTAINED = 2;
const POOL = 5;
const EMPTY: readonly number[] = [];

export interface EffectState {
  state: number;
  executeMs: number;
  finishMs: number;
  /** Duration added by extensions, ms (binary32). */
  extendedMs: number;
  cumulativeCount: number;
  cumulativeUnit: number;
  cumulativeMax: number;
}
export const newEffectState = (): EffectState => ({
  state: STAY,
  executeMs: -1,
  finishMs: -1,
  extendedMs: 0,
  cumulativeCount: 0,
  cumulativeUnit: 0,
  cumulativeMax: 0,
});
export interface FrameInput {
  timeMs: number;
  musicLengthMs: number;
  finished: boolean;
}
export interface Trigger {
  hit: boolean;
  timeMs: number;
}
const NO_TRIGGER: Trigger = { hit: false, timeMs: 0 };

/** One update of an effect state; returns whether it changed (or started). */
export function effectUpdate(
  st: EffectState,
  act: number,
  inp: FrameInput,
  trigger: Trigger,
  condition: Checker | null,
  release: Checker | null,
  finishFrame: boolean,
  ctx: CheckCtx,
): boolean {
  switch (st.state) {
    case STAY: {
      const ok = condition ? condition.check(ctx)[0] : true;
      if (ok && trigger.hit) {
        st.state = EXECUTE_FRAME;
        st.executeMs = trigger.timeMs;
      }
      return ok && trigger.hit;
    }
    case EXECUTE_FRAME: {
      const t = inp.timeMs;
      if (finishFrame) {
        st.state = END_FRAME;
        st.finishMs = t;
      } else if (release) st.state = EXECUTING;
      else {
        const dur = f(f(act * 1000) + st.extendedMs);
        const elapsed = f((t - st.executeMs) | 0);
        if (dur > elapsed) st.state = EXECUTING;
        else {
          st.state = END_FRAME;
          st.finishMs = t;
        }
      }
      return true;
    }
    case EXECUTING: {
      const released = release ? release.check(ctx)[0] : false;
      const dur = f(f(act * 1000) + st.extendedMs);
      const elapsed = f((inp.timeMs - st.executeMs) | 0);
      const byTime = dur < elapsed && act > 0;
      if (!(released || finishFrame || byTime)) return false;
      st.state = END_FRAME;
      let finish = !released && !finishFrame ? (st.executeMs + ceilToI32(dur)) | 0 : inp.timeMs;
      if (inp.musicLengthMs > 0 && inp.musicLengthMs <= finish) finish = inp.musicLengthMs;
      st.finishMs = finish;
      return true;
    }
    case END_FRAME:
      st.state = STAY;
      return true;
    default:
      throw new Error(`effect state ${st.state} out of range`);
  }
}

/** Whether a sustained effect has an activation time: `act > 0` and not approximately `int.MaxValue`. */
function hasActivationTime(act: number): boolean {
  if (Number.isNaN(act) || act <= 0) return false;
  const big = f(2147483647);
  const m = Math.max(Math.abs(act), big);
  const tol = Math.max(f(m * f(1e-6)), f(1.401298464324817e-45 * 8));
  return tol <= Math.abs(f(big - act));
}

/** One effect of a condition skill. */
export interface CondEffect {
  effectId: number;
  triggerType: number;
  act: number;
  phase: number;
  trigger: Checker | null;
  condition: Checker | null;
  executeLimit: number;
  reset: Checker | null;
  /** Index of the effect's row in the live model. */
  row: number;
  cumulative: (() => Cumulative | null) | null;
}

export class EffectUpdater {
  readonly state: EffectState = newEffectState();
  constructor(
    readonly effect: number,
    readonly index: number,
    readonly release: Checker | null,
    readonly phase: number,
    readonly cumulative: Cumulative | null,
  ) {
    if (cumulative) {
      this.state.cumulativeCount = cumulative.initCount();
      this.state.cumulativeUnit = cumulative.unit();
      this.state.cumulativeMax = cumulative.max();
    }
  }
  update(act: number, inp: FrameInput, trigger: Trigger, finishFrame: boolean, ctx: CheckCtx): boolean {
    const s0 = this.state.state;
    const r = effectUpdate(this.state, act, inp, trigger, null, this.release, finishFrame, ctx);
    if (this.cumulative) {
      const s1 = this.state.state;
      if ((s0 === STAY && s1 === EXECUTE_FRAME) || s0 === EXECUTE_FRAME || (s0 === EXECUTING && s1 === EXECUTING))
        this.state.cumulativeCount = this.cumulative.updateCount(ctx);
      else if (s0 === END_FRAME) this.cumulative.reset();
    }
    return r;
  }
}

interface Sustained {
  queue: number[];
  current: number | null;
  enabled: boolean;
  timed: boolean;
  executing: number[];
}

/** The gate of a Gekisou (support) skill: a range of its mission changed state this frame, or one is playing. */
export function missionGateOpen(gate: number | null, ctx: CheckCtx): boolean {
  if (gate === null || gate === M_ALL) return true;
  if (!ctx.gk) throw new Error("Gekisou skill in a live without Gekisou");
  const c = ctx.gk.ctrl;
  if (c.stateUpdates.some((i) => c.ranges[i]!.mission === gate)) return true;
  const i = c.currentPlayingIndex;
  return i >= 0 && c.ranges[i]!.mission === gate;
}

export class ConditionSkillUpdater {
  readonly updaters: EffectUpdater[] = [];
  private readonly sorted: number[];
  private readonly stacks: number[][];
  private readonly sustained: (Sustained | null)[];
  private executing: number[] = [];
  private executeCount = new Map<number, number>();
  private triggerChecked = false;
  private cache: (Trigger | null)[];
  /** One-shot effects whose only possible triggers are these performers' live events (or never): a frame without such
   * an event and without running instances checks nothing observable. */
  private readonly idleMembers: number[] | null;
  private quietFrame = false;

  constructor(
    readonly effects: CondEffect[],
    release: (e: number) => Checker | null,
    readonly gate: number | null,
  ) {
    const ids = effects.map((e) => e.effectId).sort((a, b) => a - b);
    if (ids.some((id, i) => i > 0 && ids[i - 1] === id)) throw new Error("condition skill with a duplicate effect id");
    this.sorted = effects.map((_, i) => i).sort((a, b) => effects[a]!.effectId - effects[b]!.effectId);
    this.stacks = effects.map(() => []);
    this.sustained = effects.map(() => null);
    effects.forEach((ef, e) => {
      if (ef.triggerType !== ONE_SHOT && ef.triggerType !== SUSTAINED) return;
      const pool: number[] = [];
      for (let index = 0; index < POOL; index++) {
        pool.push(this.updaters.length);
        this.updaters.push(new EffectUpdater(e, index, release(e), ef.phase, ef.cumulative?.() ?? null));
      }
      if (ef.triggerType === ONE_SHOT) this.stacks[e] = pool;
      else this.sustained[e] = { queue: pool, current: null, enabled: false, timed: hasActivationTime(ef.act), executing: [] };
    });
    this.cache = effects.map(() => null);
    let idle: number[] | null = effects.length ? [] : null;
    for (const ef of effects) {
      const member = ef.trigger?.idleMember();
      if (!idle || ef.triggerType !== ONE_SHOT || ef.reset || member === undefined) {
        idle = null;
        break;
      }
      if (member >= 0 && !idle.includes(member)) idle.push(member);
    }
    this.idleMembers = idle;
  }
  beginFrame() {
    this.triggerChecked = false;
    this.quietFrame = false;
  }
  private updateOne(u: number, inp: FrameInput, trigger: Trigger, finishFrame: boolean, ctx: CheckCtx): boolean {
    const upd = this.updaters[u]!;
    return upd.update(this.effects[upd.effect]!.act, inp, trigger, finishFrame, ctx);
  }
  /** Updates the skill for one phase; returns the updaters whose states the appliers see, in order. */
  update(phase: number, inp: FrameInput, ctx: CheckCtx): readonly number[] {
    if (!this.triggerChecked && !this.executing.length) {
      const idle = this.idleMembers;
      if ((idle && !ctx.events.some(([m]) => idle.includes(m))) || inp.finished || !missionGateOpen(this.gate, ctx)) {
        // Nothing runs and no trigger can hit: every phase of this frame only clears the trigger cache.
        this.triggerChecked = true;
        this.quietFrame = true;
      }
    }
    if (this.quietFrame) return EMPTY;
    const updated: number[] = [];
    const done: number[] = [];
    for (const u of this.executing.length > 1 ? [...this.executing] : this.executing) {
      if (phase < 1 || this.updaters[u]!.phase === phase) {
        this.updateOne(u, inp, NO_TRIGGER, false, ctx);
        if (this.updaters[u]!.state.state === STAY) done.push(u);
        else updated.push(u);
      }
    }
    if (!this.triggerChecked) {
      this.triggerChecked = true;
      this.cache.fill(null);
      if (inp.finished || !missionGateOpen(this.gate, ctx)) {
        this.finish(done);
        return updated;
      }
      for (const ef of this.effects) if (ef.reset && ef.reset.check(ctx)[0]) this.executeCount.delete(ef.effectId);
      for (const e of this.sorted) {
        const c = this.effects[e]!.trigger;
        if (!c) this.cache[e] = NO_TRIGGER;
        else {
          const [hit] = c.check(ctx);
          this.cache[e] = { hit, timeMs: c.overrideTime() ?? inp.timeMs };
        }
      }
    }
    for (const e of this.sorted) {
      const tr = this.cache[e];
      if (!tr) continue;
      const ef = this.effects[e]!;
      if (ef.triggerType === SUSTAINED) {
        if (phase < 1 || ef.phase === phase) this.updateSustained(e, inp, tr, ctx, updated);
        continue;
      }
      if (ef.triggerType !== ONE_SHOT) throw new Error(`ArgumentOutOfRangeException: skill trigger type ${ef.triggerType}`);
      if (!tr.hit) continue;
      const stack = this.stacks[e]!;
      const top = stack[stack.length - 1];
      if (top === undefined) continue;
      if (phase >= 1 && this.updaters[top]!.phase !== phase) continue;
      const executed = this.executeCount.get(ef.effectId);
      if (ef.executeLimit > 0 && executed !== undefined && ef.executeLimit <= executed) continue;
      if (ef.condition && !ef.condition.check(ctx)[0]) continue;
      const u = stack.pop()!;
      this.updateOne(u, inp, { hit: true, timeMs: tr.timeMs }, false, ctx);
      this.executing.push(u);
      updated.push(u);
      if (ef.executeLimit > 0) this.executeCount.set(ef.effectId, (this.executeCount.get(ef.effectId) ?? 0) + 1);
    }
    this.finish(done);
    return updated;
  }
  private finish(done: readonly number[]) {
    for (const u of done) {
      this.stacks[this.updaters[u]!.effect]!.push(u);
      const p = this.executing.indexOf(u);
      if (p >= 0) this.executing.splice(p, 1);
    }
  }
  private updateSustained(e: number, inp: FrameInput, tr: Trigger, ctx: CheckCtx, updated: number[]) {
    const s = this.sustained[e]!;
    if (s.timed) this.timedStep(s, e, inp, tr, ctx, updated);
    else {
      const u = this.step(s, e, tr.hit ? tr.timeMs : inp.timeMs, inp, tr, ctx);
      if (u !== null) updated.push(u);
    }
  }
  private timedStep(s: Sustained, e: number, inp: FrameInput, tr: Trigger, ctx: CheckCtx, updated: number[]) {
    if (tr.hit) {
      const condition = this.effects[e]!.condition;
      if (!condition) throw new Error("timed sustained effect has no condition checker");
      if (!s.enabled) {
        condition.reset(ctx);
        s.enabled = true;
      }
      let fresh: number | null = null;
      if (condition.check(ctx)[0]) {
        condition.reset(ctx);
        const u = s.queue.shift();
        if (u === undefined) throw new Error("sustained effect queue is empty");
        s.executing.push(u);
        fresh = u;
      }
      const done: number[] = [];
      for (const u of s.executing) {
        const trigger = { hit: fresh === u, timeMs: fresh === u ? tr.timeMs : inp.timeMs };
        if (this.updateOne(u, inp, trigger, false, ctx)) {
          updated.push(u);
          if (this.updaters[u]!.state.state === STAY) done.push(u);
        }
      }
      for (const u of done) {
        s.queue.push(u);
        s.executing = s.executing.filter((x) => x !== u);
      }
    } else {
      for (const u of s.executing) {
        this.updateOne(u, inp, NO_TRIGGER, true, ctx);
        updated.push(u);
        s.queue.push(u);
      }
      s.executing = [];
      s.enabled = false;
    }
  }
  private step(s: Sustained, e: number, executeMs: number, inp: FrameInput, tr: Trigger, ctx: CheckCtx): number | null {
    let cur = s.current;
    if (cur !== null && this.updaters[cur]!.state.state === END_FRAME) {
      this.updateOne(cur, inp, NO_TRIGGER, false, ctx);
      s.queue.push(cur);
      s.current = null;
      cur = null;
    }
    if (cur !== null && this.updaters[cur]!.state.state === EXECUTE_FRAME) this.updaters[cur]!.state.state = EXECUTING;
    const condition = this.effects[e]!.condition;
    if (tr.hit) {
      if (!s.enabled) {
        condition?.reset(ctx);
        s.enabled = true;
      }
      if (condition && !condition.check(ctx)[0]) return null;
      if (cur === null) {
        const c = s.queue.shift();
        if (c === undefined) throw new Error("sustained effect queue is empty");
        s.current = c;
        if (this.updateOne(c, inp, { hit: true, timeMs: executeMs }, false, ctx)) return c;
      }
    } else {
      if (cur !== null) {
        this.updateOne(cur, inp, NO_TRIGGER, true, ctx);
        s.enabled = false;
        return cur;
      }
      s.enabled = false;
    }
    return null;
  }
}
