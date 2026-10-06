/** Whole-live simulation, frame by frame, with live skills, snap skills and, optionally, Gekisou — a port of the
 * native frame order. Each frame: fevers and Gekisou ranges step; due chart skill events fire; judged notes go through
 * conversion, combo, damage and the note score command; the score advances; live skills restart; skills update in
 * phase 1 then 2 (live skills by key, then condition skills) with their appliers; life syncs; the score advances again;
 * Gekisou ranges take the judged notes and a completed range gets its rank bonus. */
import type { EngineMaster, SkillEffectRow } from "../master";
import { type Checker, type CheckCtx, chanceOf, type Cumulative, Factory, type Performer } from "./conditions";
import { ComboCounter } from "./combo";
import { Conversion } from "./convert";
import {
  type CondEffect,
  ConditionSkillUpdater,
  END_FRAME,
  EXECUTE_FRAME,
  EXECUTING,
  type EffectState,
  effectUpdate,
  type FrameInput,
  newEffectState,
  ONE_SHOT,
  STAY,
  SUSTAINED,
  type Trigger,
} from "./effects";
import { Controller, type Env, FeverUpdater, type GkNote, type LuckHandle, MAX_RANGES, missionPattern, rankingFactors, S_COMPLETE } from "./gekisou";
import { LifeController } from "./life";
import { f, floorToI32 } from "./num";
import { LiveRandom } from "./random";
import { command, type FactorCommand, IncrementalScore, judgementFactorMill, noteFactorMill, ScoreCalculator } from "./score";

export type { Performer } from "./conditions";
export interface LiveNote {
  id: number;
  timeMs: number;
  op: number;
  judgementType: number;
}
export interface JudgedNote {
  noteId: number;
  /** Note judgement before conversion: 1 Miss … 6 Just. */
  judgement: number;
  timeMs: number;
}
export interface PlayFrame {
  timeMs: number;
  judged: JudgedNote[];
}
export interface LiveParams {
  skillTargetMusicType: number;
  power: number;
  level: number;
  convertedCount: number;
  musicLengthMs: number;
  assist: number;
}
/** Luck recording: what the luck DP reads from one lottery-free run. */
export interface LuckRecord {
  /** Range-start luck actions as they execute: 11003 gauge add (value) or 11005 guarantee (value, limit). */
  actions: { frame: number; range: number; type: number; value: number; limit: number; chance: number }[];
  /** Per frame: each range's state after the before-update, the ranges that changed, the playing range. */
  frames: { states: number[]; updates: number[]; playing: number }[];
  /** Judged range-target notes of luck ranges: frame, range, note type, converted judgement, time, gauge speed, lot buff. */
  notes: { frame: number; range: number; op: number; judgement: number; timeMs: number; speed: number; buff: number }[];
}
export interface GekisouSetup {
  fevers: readonly (readonly [number, number])[];
  missions: readonly number[];
}

const SKILL_SUPPORT = 3;
const SKILL_GEKISOU = 4;
const SKILL_GEKISOU_SUPPORT = 5;
const OWNER_MEMBER = 1;
const OWNER_SNAP = 2;
const GEKISOU_APPLIER_TYPES = new Set([11000, 11001, 11002, 11003, 11004, 11005, 12000, 12002, 12003, 12004, 13000, 13002, 13003, 13004]);
const convertScoreType = (j: number) => [0, 0, 6, 5, 4, 3, 2, 1, 0][j + 1] ?? 0;
function approximately(a: number, b: number): boolean {
  const tol = Math.max(f(f(1e-6) * Math.max(Math.abs(a), Math.abs(b))), f(1.401298464324817e-45 * 8));
  return Math.abs(f(b - a)) < tol;
}
const NO_TRIGGER: Trigger = { hit: false, timeMs: 0 };
const NO_LOTS: number[] = [];
const minimumResultOf = (v: number) => (v - 2 >= 0 && v - 2 <= 2 ? v - 1 : 0);
function gekisouMissionGroup(mission: number): number {
  if (mission >= 1 && mission <= 3) return mission;
  if (mission === 4) return 1;
  throw new Error(`KeyNotFoundException: Gekisou mission type ${mission}`);
}

interface EffectRow {
  id: number;
  type: number;
  value: number;
  maxValue: number;
  limitCount: number;
  /** Judgements of the targets. */
  targets: number[];
}
interface LiveEffect {
  row: number;
  act: number;
  phase: number;
  state: EffectState;
  condition: Checker | null;
  release: Checker | null;
  cumulative: Cumulative | null;
}
interface LiveSkill {
  key: number;
  member: number;
  index: number;
  parentState: number;
  trigger: Trigger;
  effects: LiveEffect[];
}
interface LivePool {
  key: number;
  member: number;
  available: number[];
}
interface CondSkill {
  member: number;
  skillType: number;
  updater: ConditionSkillUpdater;
}
type Listed = { live: true; skill: number; effect: number } | { live: false; updater: number; u: number };

class ScoreCtl implements LuckHandle {
  private counter = 0;
  private cmds = new Map<number, FactorCommand>();
  constructor(private readonly score: IncrementalScore) {}
  put(cmd: FactorCommand): number {
    this.counter = (this.counter + 1) | 0;
    this.cmds.set(this.counter, cmd);
    this.score.addFactor(cmd);
    return this.counter;
  }
  private take(id: number): FactorCommand {
    const c = this.cmds.get(id);
    if (!c) throw new Error(`score factor ${id} not found`);
    this.cmds.delete(id);
    return c;
  }
  addNoteScoreUp(owner: number, t: number, factor: number) {
    return this.put(command(t, owner, { note: noteFactorMill(factor) }));
  }
  disableNoteScoreUp(t: number, id: number) {
    const c = this.take(id);
    this.score.addFactor(command(t, c.owner, { note: -c.note | 0 }));
  }
  addComboBonus(owner: number, t: number, factor: number) {
    return this.put(command(t, owner, { combo: judgementFactorMill(factor) }));
  }
  disableComboBonus(t: number, id: number) {
    const c = this.take(id);
    this.score.addFactor(command(t, c.owner, { combo: -c.combo | 0 }));
  }
  comboBonusFactor(id: number) {
    const c = this.cmds.get(id);
    return c && c.combo !== 0 ? f(f(c.combo) / 100000) : 0;
  }
  scoreUpFactor(id: number) {
    const c = this.cmds.get(id);
    return c && c.note !== 0 ? f(f(c.note) / 100000) : 0;
  }
  add(t: number, percent: number): number {
    return this.put(command(t, -1, { luck: percent }));
  }
  disable(t: number, id: number) {
    const c = this.take(id);
    this.score.addFactor(command(t, -1, { luck: -c.luck | 0 }));
  }
}

class GkAppliers {
  ids = new Map<string, number>();
  exhausted = new Set<string>();
  limitFinished = new Map<string, number>();
  add(key: string, id: number) {
    if (this.ids.has(key)) throw new Error("effect state registered twice");
    this.ids.set(key, id);
  }
  pop(key: string): number {
    const id = this.ids.get(key);
    if (id === undefined) throw new Error("effect state not registered");
    this.ids.delete(key);
    return id;
  }
  limit(key: string, st: EffectState) {
    const t = this.limitFinished.get(key);
    if (t !== undefined) {
      this.limitFinished.delete(key);
      st.state = END_FRAME;
      st.finishMs = t;
    }
  }
}

interface GekisouLive {
  ctrl: Controller;
  fever: FeverUpdater;
  factors: number[][];
  feverUpdates: [number, number][];
  prevLots: number[];
  prevLotMs: number;
  rankBonus: { range: number; rank: number; bonus: number; percent: number }[];
}

export class LiveModel {
  private readonly notes = new Map<number, LiveNote>();
  private readonly fired: boolean[];
  private readonly random: LiveRandom;
  readonly life: LifeController;
  private readonly combo: ComboCounter;
  readonly score: IncrementalScore;
  private readonly conversion: Conversion;
  private readonly rows: EffectRow[] = [];
  private readonly live: LiveSkill[] = [];
  private readonly livePools: LivePool[] = [];
  private enabledLive: number[] = [];
  private readonly cond: CondSkill[] = [];
  private readonly guards = new Map<string, number>();
  private readonly reductions = new Map<string, number>();
  private readonly limits = new Map<string, number>();
  private frameEvents: [number, number][] = [];
  private judged: [number, number, number][] = [];
  private readonly results: [LiveNote, number][] = [];
  private firedCount = 0;
  private readonly ctx: CheckCtx;
  readonly trace: [number, number][] = [];
  private frameTime = 0;
  private prevConfirmedRank: number | null = null;
  private simulatorPreviousCombo = 0;
  private currentCombo = 0;
  private readonly scorectl: ScoreCtl;
  readonly gk: GekisouLive | null;
  private readonly ga = new GkAppliers();
  private finished = false;

  constructor(
    master: EngineMaster,
    deck: readonly Performer[],
    notes: readonly LiveNote[],
    private readonly events: readonly (readonly [number, number])[],
    private readonly params: LiveParams,
    setup: GekisouSetup | null,
    seed = 0,
    private readonly record: LuckRecord | null = null,
  ) {
    for (const n of notes) this.notes.set(n.id, n);
    this.fired = events.map(() => false);
    this.random = new LiveRandom(seed);
    const live = master.live;
    if (setup) {
      const n = Math.min(setup.fevers.length, MAX_RANGES);
      const ranges = setup.fevers.slice(0, n).map(([s, e], i) => {
        const m = setup.missions[i];
        if (m === undefined) throw new Error("fewer missions than fevers");
        return [s, e, m] as const;
      });
      if (setup.missions.length < 3) throw new Error("a Gekisou song has three missions");
      this.gk = {
        ctrl: new Controller(
          ranges,
          notes.map((note) => [note.id, note.timeMs] as const),
          live.gekiso,
          live.gekiso.rushPercent,
          live.afterMs,
        ),
        fever: new FeverUpdater(setup.fevers),
        factors: rankingFactors(live.gekiso, missionPattern(setup.missions[0]!, setup.missions[1]!, setup.missions[2]!)),
        feverUpdates: [],
        prevLots: [],
        prevLotMs: 0,
        rankBonus: [],
      };
    } else this.gk = null;
    const calc = new ScoreCalculator(live, params.power, params.level, params.convertedCount, params.assist);
    const lifeLength = notes.length ? Math.max(...notes.map((n) => n.timeMs)) + 1000 : 1000;
    this.life = new LifeController(live.lifeBase, live.damage, lifeLength);
    this.combo = new ComboCounter();
    this.score = new IncrementalScore(calc, params.musicLengthMs);
    this.scorectl = new ScoreCtl(this.score);
    const noJust = new Set([...live.timingTypes].filter((t) => !live.justTypes.has(t)));
    this.conversion = new Conversion(noJust);
    if (record && this.gk) this.gk.ctrl.weighted = true;
    this.ctx = {
      record: !!record,
      life: this.life,
      random: this.random,
      frameTime: 0,
      currentCombo: 0,
      judged: this.judged,
      events: this.frameEvents,
      gk: this.gk ? { ctrl: this.gk.ctrl, prevLots: [], prevLotMs: 0 } : null,
      prevConfirmedRank: null,
    };
    const phase = (type: number) => live.phases.get(type) ?? 1;
    const factory = new Factory(master, deck, live.lifeBase, params.skillTargetMusicType);
    const effectRow = (r: SkillEffectRow): number => {
      this.rows.push({
        id: r.id,
        type: r.type,
        value: r.value,
        maxValue: r.maxValue,
        limitCount: r.limitCount,
        targets: r.targetIds.map((t) => {
          const row = master.targets.get(t);
          if (!row) throw new Error(`unknown skill target ${t}`);
          return row.judgement;
        }),
      });
      return this.rows.length - 1;
    };

    deck.forEach((p, k) => {
      if (!p.liveSkill) return;
      const [sid, lv] = p.liveSkill;
      const rs = (master.liveSkills.get(sid) ?? []).filter((r) => r.level === lv).sort((a, b) => a.id - b.id);
      const rowIndexes = rs.map(effectRow);
      const key = sid * 1000 + 100 + k;
      const pool: number[] = [];
      for (let index = 0; index < 5; index++) {
        pool.push(this.live.length);
        const effects = rs.map((r, i): LiveEffect => {
          const cumulative = factory.cumulative(r.cumulativeId, k);
          const state = newEffectState();
          if (cumulative) {
            state.cumulativeCount = cumulative.initCount();
            state.cumulativeUnit = cumulative.unit();
            state.cumulativeMax = cumulative.max();
          }
          return {
            row: rowIndexes[i]!,
            act: f(r.seconds),
            phase: phase(r.type),
            state,
            condition: factory.group(r.conditionGroup, k),
            release: factory.group(r.releaseGroup, k),
            cumulative,
          };
        });
        this.live.push({ key, member: k, index, parentState: STAY, trigger: { hit: false, timeMs: 0 }, effects });
      }
      this.livePools.push({ key, member: k, available: pool });
    });
    this.livePools.sort((a, b) => a.key - b.key);

    const conditionSkill = (rows: readonly SkillEffectRow[], k: number, skillType: number, gate: number | null) => {
      const rs = [...rows].sort((a, b) => a.id - b.id);
      const effects: CondEffect[] = [];
      const releases: number[] = [];
      for (const r of rs) {
        if (r.triggerType !== ONE_SHOT && r.triggerType !== SUSTAINED)
          throw new Error(`ArgumentOutOfRangeException: skill trigger type ${r.triggerType}`);
        effects.push({
          effectId: r.id * 100 + skillType * 10 + k,
          triggerType: r.triggerType,
          act: f(r.seconds),
          phase: phase(r.type),
          trigger: factory.group(r.triggerGroup, k),
          condition: factory.group(r.conditionGroup, k),
          executeLimit: r.executeLimit,
          reset: r.executeLimit > 0 ? factory.group(r.resetGroup, k) : null,
          row: effectRow(r),
          cumulative: r.cumulativeId ? () => factory.cumulative(r.cumulativeId, k) : null,
        });
        releases.push(r.releaseGroup);
      }
      const updater = new ConditionSkillUpdater(effects, (e) => factory.group(releases[e]!, k), gate);
      this.cond.push({ member: k, skillType, updater });
    };
    deck.forEach((p, k) => {
      for (const [sid, lv] of p.supportSkills)
        conditionSkill((master.supportSkills.get(sid) ?? []).filter((r) => r.level === lv), k, SKILL_SUPPORT, null);
    });
    if (this.gk) {
      const mission = deck.map((p) => {
        if (p.missionOnly) return p.missionOnly;
        if (!p.gekisouSkill) return null;
        const row = master.gekisoSkills.get(p.gekisouSkill[0]);
        if (!row) throw new Error(`unknown Gekisou skill ${p.gekisouSkill[0]}`);
        gekisouMissionGroup(row.missionType);
        return row.missionType;
      });
      for (let m = 1; m <= 3; m++)
        deck.forEach((p, k) => {
          const mk = mission[k];
          if (!p.gekisouSkill || mk === null || mk === undefined || gekisouMissionGroup(mk) !== m) return;
          const [sid, lv] = p.gekisouSkill;
          conditionSkill(master.gekisoSkills.get(sid)!.effects.filter((r) => r.level === lv), k, SKILL_GEKISOU, mk);
        });
      deck.forEach((p, k) => {
        if (mission[k] === null || mission[k] === undefined) return;
        for (const [sid, lv] of p.gekisouSupportSkills) {
          const row = master.gekisoSupportSkills.get(sid);
          if (!row) throw new Error(`unknown Gekisou support skill ${sid}`);
          conditionSkill(row.effects.filter((r) => r.level === lv), k, SKILL_GEKISOU_SUPPORT, row.missionType);
        }
      });
    }
  }

  private env(): Env {
    return { random: this.random, handle: this.scorectl };
  }
  private info() {
    return this.gk ? this.gk.ctrl : null;
  }

  /** Plays one frame at music time `t` with delta time `dt` in seconds. */
  frame(t: number, judged: readonly JudgedNote[], dt: number) {
    this.frameTime = t;
    const frameRank = this.prevConfirmedRank;
    this.prevConfirmedRank = null;
    if (this.gk) {
      this.gk.feverUpdates = this.gk.fever.update(t);
      this.gk.ctrl.beforeUpdate(dt, t, this.gk.feverUpdates, this.score.score, this.env());
      if (this.record)
        this.record.frames.push({
          states: this.gk.ctrl.states.map((s) => s.state),
          updates: [...this.gk.ctrl.stateUpdates],
          playing: this.gk.ctrl.currentPlayingIndex,
        });
    }
    this.frameEvents.length = 0;
    if (this.firedCount < this.events.length)
      for (let i = 0; i < this.events.length; i++) {
        const [index, evT] = this.events[i]!;
        if (!this.fired[i] && evT <= t) {
          this.fired[i] = true;
          this.firedCount++;
          this.frameEvents.push([index, evT]);
        }
      }
    this.judged.length = 0;
    const results = this.results;
    results.length = 0;
    let broken = false;
    for (const j of judged) {
      const n = this.notes.get(j.noteId);
      if (!n) throw new Error(`unknown note ${j.noteId}`);
      const conv = this.conversion.convert(j.judgement, n.judgementType, j.timeMs);
      this.combo.addJudgement(n.timeMs, conv);
      results.push([n, conv]);
      this.judged.push([n.id, conv, n.timeMs]);
      if (conv === 1 || conv === 2) broken = true;
    }
    const simulatorCombo = this.combo.timingCombo(t);
    const addedCombo = Math.max(0, simulatorCombo - this.simulatorPreviousCombo);
    this.simulatorPreviousCombo = simulatorCombo;
    if (broken) this.currentCombo = 0;
    this.currentCombo = (this.currentCombo + addedCombo) | 0;
    const notePercent = this.score.calc.settings.notePercent;
    for (const [n, conv] of results) {
      this.life.noteDamage(n.timeMs, conv);
      const life = this.life.lifeAt(n.timeMs);
      if (notePercent.has(n.op)) this.score.addNote(n.timeMs, life, n.id, n.op, convertScoreType(conv));
    }
    this.score.calculate(t, this.combo, this.info());
    const inp: FrameInput = { timeMs: t, musicLengthMs: this.params.musicLengthMs, finished: this.finished };
    for (const si of this.enabledLive) this.live[si]!.trigger = NO_TRIGGER;
    let started = false;
    if (this.frameEvents.length) for (const pool of this.livePools) {
      let ev: [number, number] | undefined;
      for (let i = this.frameEvents.length - 1; i >= 0; i--)
        if (this.frameEvents[i]![0] === pool.member) {
          ev = this.frameEvents[i];
          break;
        }
      if (!ev) continue;
      const si = pool.available.shift();
      if (si === undefined) throw new Error("live skill pool is empty");
      const s = this.live[si]!;
      s.trigger = { hit: true, timeMs: ev[1] };
      for (const e of s.effects) e.state.state = STAY;
      this.enabledLive.push(si);
      started = true;
    }
    if (started && this.enabledLive.length > 1)
      this.enabledLive.sort((a, b) => this.live[a]!.key * 10 + this.live[a]!.index - (this.live[b]!.key * 10 + this.live[b]!.index));
    for (const c of this.cond) c.updater.beginFrame();
    const ctx = this.ctx;
    ctx.frameTime = t;
    ctx.currentCombo = this.currentCombo;
    ctx.prevConfirmedRank = frameRank;
    if (ctx.gk) {
      ctx.gk.prevLots = this.gk!.prevLots;
      ctx.gk.prevLotMs = this.gk!.prevLotMs;
    }
    for (let ph = 1; ph <= 2; ph++) {
      const listed: Listed[] = [];
      for (const si of this.enabledLive) {
        const s = this.live[si]!;
        if (s.parentState === END_FRAME) {
          s.parentState = STAY;
          for (const e of s.effects) e.state.state = STAY;
          continue;
        }
        let changed = false;
        for (const e of s.effects) if (e.phase === ph) changed = this.updateLiveEffect(e, inp, s.trigger, ctx) || changed;
        if (changed) s.parentState = aggregateLiveState(s.effects);
        s.effects.forEach((e, ei) => {
          if (e.state.state !== STAY && e.phase === ph) listed.push({ live: true, skill: si, effect: ei });
        });
      }
      for (let ui = 0; ui < this.cond.length; ui++) {
        const updater = this.cond[ui]!.updater;
        for (const x of updater.update(ph, inp, ctx)) if (updater.updaters[x]!.state.state !== STAY) listed.push({ live: false, updater: ui, u: x });
      }
      for (const item of listed) this.apply(item);
    }
    if (this.enabledLive.length) {
      let stayed = false;
      for (const si of this.enabledLive) {
        const s = this.live[si]!;
        if (s.parentState === STAY) {
          const pool = this.livePools.find((p) => p.key === s.key && p.member === s.member);
          if (!pool) throw new Error("missing live skill pool");
          pool.available.push(si);
          stayed = true;
        }
      }
      if (stayed) this.enabledLive = this.enabledLive.filter((si) => this.live[si]!.parentState !== STAY);
    }
    this.life.syncCurrent(t);
    this.score.calculate(t, this.combo, this.info());
    if (this.gk) this.gekisouAfter(t, results);
    if (this.recordTrace) this.trace.push([t, this.score.score]);
  }
  recordTrace = false;

  private updateLiveEffect(e: LiveEffect, inp: FrameInput, trigger: Trigger, ctx: CheckCtx): boolean {
    const before = e.state.state;
    const changed = effectUpdate(e.state, e.act, inp, trigger, e.condition, e.release, false, ctx);
    if (e.cumulative) {
      const after = e.state.state;
      if ((before === STAY && after === EXECUTE_FRAME) || before === EXECUTE_FRAME || (before === EXECUTING && after === EXECUTING))
        e.state.cumulativeCount = e.cumulative.updateCount(ctx);
      else if (before === END_FRAME) e.cumulative.reset();
    }
    return changed;
  }

  private gekisouAfter(t: number, results: readonly [LiveNote, number][]) {
    const gk = this.gk!;
    const judged: GkNote[] = results.map(([n, j]) => [n.id, n.op, n.timeMs, j] as const);
    if (this.record) {
      const frame = this.record.frames.length - 1;
      gk.ctrl.ranges.forEach((range, r) => {
        if (range.mission !== 2) return;
        for (const [id, op, timeMs, judgement] of judged)
          if (range.targets.has(id) && judgement !== 0 && judgement !== 7)
            this.record!.notes.push({ frame, range: r, op, judgement, timeMs, speed: gk.ctrl.gaugeSpeedAt(timeMs), buff: gk.ctrl.lotBuffAt(timeMs) });
      });
    }
    gk.ctrl.update(t, judged, gk.feverUpdates, this.score.score, this.env());
    gk.prevLots = gk.ctrl.lotResults.length ? [...gk.ctrl.lotResults] : NO_LOTS;
    gk.prevLotMs = gk.prevLots.length ? t : 0;
    const idx = gk.ctrl.stateUpdates.find((i) => gk.ctrl.states[i]!.state === S_COMPLETE);
    if (idx === undefined) return;
    const range = gk.ctrl.ranges[idx]!;
    const s0 = this.score.calculate(range.startMs, this.combo, gk.ctrl);
    const s1 = this.score.calculate(range.endMs, this.combo, gk.ctrl);
    gk.ctrl.states[idx]!.startScore = s0;
    gk.ctrl.states[idx]!.endScore = s1;
    if (idx < gk.factors.length) {
      const percent = gk.factors[idx]![0]!;
      const p = gk.ctrl.states[idx]!.score * percent;
      const bonus = (p >= 0 ? Math.floor(p / 100) : -Math.floor(-p / 100)) | 0;
      this.score.addFixed(range.endMs, bonus);
      gk.rankBonus.push({ range: idx, rank: 1, bonus, percent });
      this.prevConfirmedRank = 1;
    }
  }

  private state(item: Listed): EffectState {
    if (item.live) return this.live[item.skill]!.effects[item.effect]!.state;
    const c = this.cond[item.updater]!;
    return c.updater.updaters[item.u]!.state;
  }

  private apply(item: Listed) {
    let ri: number, k: number, ownerType: number, skillType: number, key: string;
    if (item.live) {
      const s = this.live[item.skill]!;
      ri = s.effects[item.effect]!.row;
      k = s.member;
      ownerType = OWNER_MEMBER;
      skillType = 1;
      key = `L${this.rows[ri]!.id}:${s.member}:${s.index}`;
    } else {
      const c = this.cond[item.updater]!;
      const upd = c.updater.updaters[item.u]!;
      const ef = c.updater.effects[upd.effect]!;
      ri = ef.row;
      k = c.member;
      ownerType = c.skillType === SKILL_GEKISOU ? OWNER_MEMBER : OWNER_SNAP;
      skillType = c.skillType;
      key = `C${ef.effectId}:${upd.index}`;
    }
    const st = this.state(item);
    const owner = (Math.imul(k, 100) + ownerType) | 0;
    const gkSkill = skillType === SKILL_GEKISOU || skillType === SKILL_GEKISOU_SUPPORT;
    const row = this.rows[ri]!;
    const type = row.type;
    const gkType = GEKISOU_APPLIER_TYPES.has(type);
    if ((gkType || type === 13001) && !gkSkill && !this.gk) return;
    if (this.record && (type === 11003 || type === 11005)) {
      // The luck DP applies these with their chance; record the executions only.
      if (st.state === EXECUTE_FRAME && !item.live) {
        const c = this.cond[item.updater]!;
        const ef = c.updater.effects[c.updater.updaters[item.u]!.effect]!;
        this.record.actions.push({
          frame: this.record.frames.length - 1,
          range: this.gk!.ctrl.playingRangeIndex(),
          type,
          value: row.value,
          limit: row.limitCount,
          chance: chanceOf(ef.condition, this.ctx),
        });
      }
      return;
    }
    if ((gkSkill || gkType) && this.applyGekisou(row, st, owner, key)) return;
    const value = row.value;
    switch (type) {
      case 0:
      case 1000:
      case 1001:
      case 1002:
      case 1003:
      case 1500:
      case 1501:
      case 1502:
      case 1503:
        return;
      case 2000:
      case 2005: {
        const m = noteFactorMill(f(f(value) / (type === 2005 ? -10000 : 10000)));
        if (st.state === EXECUTE_FRAME) this.score.addFactor(command(st.executeMs, owner, { note: m }));
        else if (st.state === END_FRAME) this.score.addFactor(command(st.finishMs, owner, { note: -m | 0 }));
        return;
      }
      case 2001:
      case 2003:
        this.applyCumulativeScore(row, st, owner, key);
        return;
      case 2002: {
        const m = judgementFactorMill(f(f(value) / 10000));
        if (st.state === EXECUTE_FRAME) this.score.addFactor(command(st.executeMs, owner, { combo: m }));
        else if (st.state === END_FRAME) this.score.addFactor(command(st.finishMs, owner, { combo: -m | 0 }));
        return;
      }
      case 2004: {
        const m = judgementFactorMill(f(f(value) / 10000));
        for (const j of row.targets) {
          if (st.state === EXECUTE_FRAME) this.score.addFactor(command(st.executeMs, owner, { judgement: j, judge: m }));
          else if (st.state === END_FRAME) this.score.addFactor(command(st.finishMs, owner, { judgement: j, judge: -m | 0 }));
        }
        return;
      }
      case 15000:
        if (st.state === EXECUTE_FRAME) this.extend(k, f(value));
        return;
      case 3000:
        if (st.state === EXECUTE_FRAME) {
          if (this.limits.has(key)) throw new Error("duplicate life limit effect state");
          this.limits.set(key, this.life.addLimit(value));
        } else if (st.state === END_FRAME) {
          const id = this.limits.get(key);
          if (id === undefined) throw new Error("missing life limit effect state");
          this.limits.delete(key);
          this.life.subtractLimit(id);
        }
        return;
      case 3002:
        if (st.state === EXECUTE_FRAME) this.life.skillDamage(st.executeMs, value, true);
        return;
      case 3004:
        if (st.state === EXECUTE_FRAME) {
          if (this.reductions.has(key)) throw new Error("duplicate damage reduction effect state");
          this.reductions.set(key, this.life.enableReduction(st.executeMs, value));
        } else if (st.state === END_FRAME) {
          const id = this.reductions.get(key);
          if (id !== undefined) {
            this.reductions.delete(key);
            this.life.disableReduction(st.finishMs, id);
          }
        }
        return;
      case 3001:
        if (st.state === EXECUTE_FRAME) this.life.recovery(st.executeMs, value, true);
        return;
      case 3003:
        if (st.state === EXECUTE_FRAME) {
          if (this.guards.has(key)) throw new Error("duplicate guard effect state");
          this.guards.set(key, this.life.enableGuard(st.executeMs));
        } else if (st.state === END_FRAME) {
          const id = this.guards.get(key);
          if (id === undefined) throw new Error("missing guard effect state");
          this.life.disableGuard(st.finishMs, id);
          this.guards.delete(key);
        }
        return;
      case 12006:
      case 13005: {
        if (type === 13005 && !this.gk) return;
        const t = this.conversion.update(key, st.state, { type, value, limitCount: row.limitCount, targets: row.targets, effectId: row.id });
        if (t !== null) {
          st.state = END_FRAME;
          st.finishMs = t;
        }
        return;
      }
      default:
        throw new Error(`unsupported skill effect type ${type}`);
    }
  }

  private applyCumulativeScore(row: EffectRow, st: EffectState, owner: number, key: string) {
    const combo = row.type === 2003;
    let value = Math.imul(row.value, st.cumulativeCount);
    if (row.maxValue > 0) value = Math.min(value, row.maxValue);
    const factor = f(f(value) / 10000);
    const sc = this.scorectl;
    const add = (t: number) => (combo ? sc.addComboBonus(owner, t, factor) : sc.addNoteScoreUp(owner, t, factor));
    const disable = (t: number, id: number) => (combo ? sc.disableComboBonus(t, id) : sc.disableNoteScoreUp(t, id));
    if (st.state === EXECUTE_FRAME) this.ga.add(key, add(st.executeMs));
    else if (st.state === EXECUTING) {
      const id = this.ga.ids.get(key);
      if (id === undefined) throw new Error("effect state not registered");
      const old = combo ? sc.comboBonusFactor(id) : sc.scoreUpFactor(id);
      if (!approximately(old, factor)) {
        disable(this.frameTime, id);
        this.ga.ids.set(key, add(this.frameTime));
      }
    } else if (st.state === END_FRAME) disable(st.finishMs, this.ga.pop(key));
  }

  /** The Gekisou appliers; false when the effect type is not one of them. */
  private applyGekisou(row: EffectRow, st: EffectState, owner: number, key: string): boolean {
    const et = row.type;
    const v = row.value;
    const frameT = this.frameTime;
    const ga = this.ga;
    if (!this.gk) throw new Error("Gekisou effect without Gekisou");
    const c = this.gk.ctrl;
    const s = st.state;
    switch (et) {
      case 12000:
      case 13000:
        if (s === EXECUTE_FRAME) ga.add(key, et === 12000 ? c.addComboBonus(st.executeMs, f(v)) : c.addJustBonus(st.executeMs, f(v)));
        else if (s === END_FRAME) {
          const id = ga.pop(key);
          if (et === 12000) c.subtractComboBonus(st.finishMs, id);
          else c.subtractJustBonus(st.finishMs, id);
        }
        return true;
      case 13002:
        if (s === END_FRAME) {
          const id = ga.ids.get(key);
          if (id !== undefined) {
            ga.ids.delete(key);
            c.removeCumulativeRule(id);
          }
        } else if (s === EXECUTE_FRAME && !ga.ids.has(key))
          ga.ids.set(key, c.addCumulativeRule(st.cumulativeUnit, v, st.cumulativeMax, row.maxValue));
        return true;
      case 11000:
      case 11001:
        if (s === EXECUTE_FRAME) {
          const value = f(f(v) / 10000);
          ga.add(key, et === 11000 ? c.addLotProbabilityUp(st.executeMs, value) : c.addGaugeUp(st.executeMs, value));
        } else if (s === END_FRAME) {
          const id = ga.pop(key);
          if (et === 11000) c.subtractLotProbabilityUp(st.finishMs, id);
          else c.subtractGaugeUp(st.finishMs, id);
        }
        return true;
      case 11002:
      case 11004:
      case 12002:
      case 12003:
      case 13003:
      case 13004:
        if (s === EXECUTE_FRAME) {
          let count = v | 0;
          if (et === 11004 || et === 12003 || et === 13004) {
            count = Math.imul(count, st.cumulativeCount);
            if (row.maxValue > 0) count = Math.min(count, row.maxValue);
          }
          if (et === 11002 || et === 11004) c.addLuckPoint(count);
          else if (et === 12002 || et === 12003) c.addGekisouCombo(frameT, count);
          else c.addJustCount(frameT, count);
        }
        return true;
      case 11003:
        if (s === EXECUTE_FRAME) {
          const g = (c.currentGaugeMax() * v) | 0;
          c.addLuckGaugePercent(floorToI32(f(f(g) / 10000)));
        }
        return true;
      case 12004:
        ga.limit(key, st);
        if (st.state === EXECUTE_FRAME) {
          let mask = 0;
          for (const j of row.targets) if (j !== 0 && j !== -1) mask |= 1 << (j & 31);
          ga.add(key, c.enableComboProtect(st.executeMs, row.limitCount, mask & 0xff));
        } else if (st.state === END_FRAME && !ga.exhausted.delete(key)) {
          const id = ga.ids.get(key);
          if (id !== undefined) {
            ga.ids.delete(key);
            c.disableComboProtect(st.finishMs, id);
          }
        }
        return true;
      case 11005:
        ga.limit(key, st);
        if (st.state === EXECUTE_FRAME) ga.add(key, c.machine.enableMinimum(minimumResultOf(v), row.limitCount));
        else if (st.state === EXECUTING) {
          const id = ga.ids.get(key);
          if (id !== undefined && !c.machine.isMinimumActive(id)) {
            let t = c.machine.takeLastConsumed(id);
            if (t < 0) t = frameT;
            c.machine.disableMinimum(id);
            ga.ids.delete(key);
            ga.exhausted.add(key);
            ga.limitFinished.set(key, t);
          }
        } else if (st.state === END_FRAME && !ga.exhausted.delete(key)) {
          const id = ga.ids.get(key);
          if (id !== undefined) {
            ga.ids.delete(key);
            c.machine.disableMinimum(id);
          }
        }
        return true;
      case 2001: {
        let n = (v * st.cumulativeCount) | 0;
        if (row.maxValue > 0 && row.maxValue < n) n = row.maxValue;
        const factor = f(f(n) / 10000);
        const sc = this.scorectl;
        if (s === EXECUTE_FRAME) ga.add(key, sc.addNoteScoreUp(owner, st.executeMs, factor));
        else if (s === EXECUTING) {
          const id = ga.ids.get(key);
          if (id === undefined) throw new Error("effect state not registered");
          if (!approximately(sc.scoreUpFactor(id), factor)) {
            sc.disableNoteScoreUp(frameT, id);
            ga.ids.set(key, sc.addNoteScoreUp(owner, frameT, factor));
          }
        } else if (s === END_FRAME) sc.disableNoteScoreUp(st.finishMs, ga.pop(key));
        return true;
      }
      case 4004:
        return true;
      default:
        return false;
    }
  }

  private extend(member: number, ms: number) {
    for (const s of this.live) {
      if (s.member !== member) continue;
      for (const e of s.effects) if (e.state.state === EXECUTE_FRAME || e.state.state === EXECUTING) e.state.extendedMs = f(e.state.extendedMs + ms);
    }
  }
}

function aggregateLiveState(effects: readonly LiveEffect[]): number {
  for (const state of [EXECUTING, EXECUTE_FRAME, END_FRAME]) if (effects.some((e) => e.state.state === state)) return state;
  return STAY;
}
