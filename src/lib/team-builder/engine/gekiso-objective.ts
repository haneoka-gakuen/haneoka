/** Gekisou team search. Given the members' Gekisou context, snap Gekisou support skills add their score-ups
 * independently and live skills add theirs on top, so every slot contributes additively. The members' Gekisou combo
 * bonus is what couples them: it raises the Gekisou combo factor of every combo-range note and the combo-counting
 * supports. The search therefore runs once per combo bonus level L = Σ (each member's largest combo bonus): a synthetic
 * member holding bonus L for every whole combo range bounds every team of that level from above, the context without
 * Gekisou skills bounds every team from below, and survivors are scored by whole-live simulation. Every effect is
 * monotone in the combo count, so the bounds hold and a completed search is proven — except with luck ranges, whose
 * lottery expectation the bounds only estimate. */
import type { EngineMaster, SkillEffectRow } from "./master";
import { teamPower, type MemberState, type MusicView, type PlayerState, type SnapState } from "./power";
import { searchTeams, type Constraints, type ObjectiveAdapter, type SearchHit, type SearchOutput, type Team, type Totals } from "./search";
import { resolveSlotSkill, windowMs, type SlotSkill } from "./skills";
import type { OrderScores } from "./live";
import { performer } from "./full/deck";
import type { Performer } from "./full/conditions";
import { M_ALL, M_COMBO } from "./full/gekisou";
import { gekisoContext, gekisoPerformer, scoreOrdersGekiso, type GekisoChart, type GekisoContext } from "./gekiso";
import type { Criterion } from "./objectives";

export interface GekisoDetail {
  scores: OrderScores;
  skills: SlotSkill[];
  /** Lottery seeds averaged (1: deterministic). */
  seeds: number;
}
export interface GekisoSearchInput {
  master: EngineMaster;
  player: PlayerState;
  members: readonly MemberState[];
  snaps: readonly SnapState[];
  music: MusicView | null;
  chart: GekisoChart;
  /** Lottery seeds shared by every team (luck ranges only). */
  seeds: readonly number[];
  criterion: Criterion;
  constraints: Constraints;
  k: number;
  timeLimitMs?: number;
  progress?: (done: number, total: number) => void;
}

const EMPTY: Performer = {
  liveSkill: null,
  supportSkills: [],
  bandId: 0,
  characterId: 0,
  cardType: 0,
  tagIds: [],
  liveSkillCategories: [],
  gekisouSkillCategories: [],
  gekisouMissionType: 0,
  gekisouSkill: null,
  gekisouSupportSkills: [],
};
const SYNTHETIC_SKILL = -1;
/** Relative slack of the additive estimate (measured: under 4e-5). */
const REFINE_SLACK = 1e-4;

/** The band a support's formation condition favours (0 when it has none). */
function favouredBand(master: EngineMaster, skills: readonly (readonly [number, number])[]): number {
  for (const [id, level] of skills)
    for (const row of master.gekisoSupportSkills.get(id)?.effects ?? []) {
      if (row.level !== level) continue;
      for (const set of master.conditionSets.get(row.conditionGroup) ?? [])
        for (const cid of set) {
          const condition = master.conditions.get(cid);
          if (condition?.type !== 5000 || !condition.positive) continue;
          for (const target of condition.targetIds) {
            const band = master.targets.get(target)?.bandId ?? 0;
            if (band) return band;
          }
        }
    }
  return 0;
}

/** Performer attributes any Gekisou skill condition reads: contexts differing only elsewhere are equal. */
function readAttributes(master: EngineMaster, which: "members" | "all"): (keyof Performer)[] {
  const out = new Set<keyof Performer>();
  const groups = new Set<number>();
  const cumulative = new Set<number>();
  for (const table of which === "members" ? [master.gekisoSkills] : [master.gekisoSkills, master.gekisoSupportSkills])
    for (const skill of table.values())
      for (const row of skill.effects) {
        for (const group of [row.triggerGroup, row.conditionGroup, row.releaseGroup, row.resetGroup]) if (group) groups.add(group);
        if (row.cumulativeId) cumulative.add(row.cumulativeId);
      }
  const note = (targetIds: readonly number[]) => {
    for (const id of targetIds) {
      const t = master.targets.get(id);
      if (!t) continue;
      if (t.bandId) out.add("bandId");
      if (t.cardType) out.add("cardType");
      if (t.characterId) out.add("characterId");
      if (t.tagId) out.add("tagIds");
      if (t.liveSkillCategories.length) out.add("liveSkillCategories");
      if (t.gekisouSkillCategories.length) out.add("gekisouSkillCategories");
      if (t.gekisouMissionType) out.add("gekisouMissionType");
    }
  };
  for (const group of groups)
    for (const set of master.conditionSets.get(group) ?? [])
      for (const id of set) {
        const c = master.conditions.get(id);
        if (c && (c.type === 5000 || c.type === 3000 || c.type === 3001)) note(c.targetIds);
      }
  for (const id of cumulative) {
    const c = master.cumulative.get(id);
    if (!c) continue;
    if (c.type === 3000 || c.type === 3001) note(c.targetIds);
    if (c.type === 3002 || c.type === 3003 || c.type === 3004) out.add("bandId");
    if (c.type === 3005) out.add("cardType");
  }
  return [...out].sort();
}

/** A sustained Gekisou combo bonus row that runs for whole combo ranges (the template of the synthetic member). */
function comboTemplate(master: EngineMaster): SkillEffectRow | null {
  for (const skill of master.gekisoSkills.values()) {
    if (skill.missionType !== M_COMBO) continue;
    for (const row of skill.effects) {
      if (row.type !== 12000 || row.triggerType !== 2 || row.conditionGroup) continue;
      const sets = master.conditionSets.get(row.triggerGroup) ?? [];
      const playing = sets.length === 1 && sets[0]!.length === 1 && master.conditions.get(sets[0]![0]!)?.type === 7020;
      if (playing) return row;
    }
  }
  return null;
}
/** The master with a synthetic member Gekisou skill holding combo bonus `level` for every whole combo range. */
function levelMaster(master: EngineMaster, template: SkillEffectRow, level: number): EngineMaster {
  const skills = new Map(master.gekisoSkills);
  skills.set(SYNTHETIC_SKILL, { missionType: M_COMBO, effects: [{ ...template, id: 2_000_000_000 + level, level: 1, value: level }] });
  return { ...master, gekisoSkills: skills };
}

export function gekisoSearch(input: GekisoSearchInput): SearchOutput<GekisoDetail> & { levels: number } {
  const started = performance.now();
  const { master, members, snaps, chart, criterion } = input;
  const n = chart.notes.length;
  const count = chart.full.convertedCount;
  const unit = master.live.adjustment * chart.difficultyFactor;
  const rangeFactor = Float64Array.from(chart.rangeOf, (r) => (r >= 0 ? 1 + chart.rangePercent[r]! / 100 : 1));
  const missions = chart.setup.missions.slice(0, chart.full.fevers.length);
  const comboRanges = missions.some((m) => m === M_COMBO || m === M_ALL);

  const caches = new WeakMap<EngineMaster, Map<string, GekisoContext>>();
  const readAll = readAttributes(master, "all");
  const readMembers = readAttributes(master, "members");
  const timing = { contexts: 0, contextMs: 0, orders: 0, ordersMs: 0 };
  const contextOf = (deck: Performer[], within = master) => {
    let cache = caches.get(within);
    if (!cache) caches.set(within, (cache = new Map()));
    const keyed = deck.map((p) => ({
      p,
      key: JSON.stringify([p.gekisouSkill, p.missionOnly ?? 0, p.gekisouSupportSkills, ...(p.gekisouSupportSkills.length ? readAll : readMembers).map((field) => p[field])]),
    }));
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const key = keyed.map((item) => item.key).join("|");
    let value = cache.get(key);
    if (!value) {
      const t0 = performance.now();
      cache.set(key, (value = gekisoContext(within, chart, keyed.map((item) => item.p), input.seeds)));
      timing.contexts++;
      timing.contextMs += performance.now() - t0;
    }
    return value;
  };
  type Weights = { base: number; general: Float64Array; byJudgement: Float64Array[] };
  const weightCache = new WeakMap<GekisoContext, Weights>();
  /** Linear weight of a context per unit power: `base` without live skills, prefix sums of live-factor weights. */
  const weights = (ctx: GekisoContext): Weights => {
    let value = weightCache.get(ctx);
    if (value) return value;
    const general = new Float64Array(n + 1);
    const byJudgement = [4, 5, 6].map(() => new Float64Array(n + 1));
    let base = 0;
    for (let i = 0; i < n; i++) {
      const beta = rangeFactor[i]! * unit * chart.noteFrac[i]! * chart.judgeFrac[ctx.judgement[i]!]! * chart.comboFactor[i]! * ctx.gk[i]!;
      base += beta * ctx.up[i]!;
      const live = beta * ctx.luck[i]!;
      general[i + 1] = general[i]! + live;
      for (let k = 0; k < 3; k++) byJudgement[k]![i + 1] = byJudgement[k]![i]! + (ctx.judgement[i] === k + 4 ? live : 0);
    }
    weightCache.set(ctx, (value = { base, general, byJudgement }));
    return value;
  };
  const gain = (deck: Performer[], ref: Performer[], within = master) => weights(contextOf([...ref, ...deck], within)).base - weights(contextOf(ref, within)).base;

  // A Gekisou skill runs only in ranges of its mission: one of another mission still lets the member's snap support
  // skills run, and does nothing else.
  const songMissionSet = new Set(missions);
  const hasGekiso = members.map((m) => !!performer(master, m, null).gekisouSkill);
  const gkMember = members.map((m) => {
    const p = gekisoPerformer(performer(master, m, null));
    if (!p.gekisouSkill) return p;
    const mission = master.gekisoSkills.get(p.gekisouSkill[0])?.missionType ?? 0;
    if (mission === M_ALL || songMissionSet.has(mission)) return p;
    return { ...EMPTY, missionOnly: mission || 1 };
  });
  // A support runs only in ranges of its own mission; its formation condition reads the member's band (in every
  // current master), so the band reduces to "favoured or not".
  const songMissions = new Set(missions);
  const supportPerformers = new Map<string, Performer | null>();
  const supportPerformer = (member: number, snap: number): Performer | null => {
    if (snap < 0 || !hasGekiso[member]) return null;
    const p = performer(master, members[member]!, snaps[snap]!);
    if (!p.gekisouSupportSkills.length) return null;
    const runs = p.gekisouSupportSkills.some(([id]) => {
      const mission = master.gekisoSupportSkills.get(id)?.missionType ?? 0;
      return mission === M_ALL || songMissions.has(mission) || songMissions.has(M_ALL);
    });
    if (!runs) return null;
    const bandOnly = readAll.length === 1 && readAll[0] === "bandId";
    const favoured = favouredBand(master, p.gekisouSupportSkills);
    const bandId = bandOnly && favoured ? (p.bandId === favoured ? favoured : favoured === 1 ? 2 : 1) : p.bandId;
    const key = JSON.stringify([p.gekisouSupportSkills, bandOnly ? bandId : [p.bandId, p.cardType, p.characterId]]);
    let value = supportPerformers.get(key);
    if (value === undefined) {
      value = bandOnly ? { ...EMPTY, bandId, missionOnly: 1, gekisouSupportSkills: p.gekisouSupportSkills } : { ...gekisoPerformer(p), gekisouSkill: null, missionOnly: 1 };
      supportPerformers.set(key, value);
    }
    return value;
  };
  /** Each member's largest Gekisou combo bonus (0 without combo ranges). */
  const bonusOf = members.map((m, i) => {
    if (!comboRanges || !gkMember[i]!.gekisouSkill) return 0;
    void hasGekiso;
    const [id, level] = gkMember[i]!.gekisouSkill!;
    const skill = master.gekisoSkills.get(id);
    if (!skill || (skill.missionType !== M_COMBO && skill.missionType !== M_ALL)) return 0;
    void m;
    return Math.max(0, ...skill.effects.filter((row) => row.level === level && row.type === 12000).map((row) => row.value));
  });
  const template = comboRanges ? comboTemplate(master) : null;
  // Highest reachable level: the best bonus per character, five characters.
  const bestPerCharacter = new Map<number, number>();
  members.forEach((m, i) => bestPerCharacter.set(m.card.characterId, Math.max(bestPerCharacter.get(m.card.characterId) ?? 0, bonusOf[i]!)));
  const maxLevel = template ? [...bestPerCharacter.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0) : 0;

  // Luck: the strongest luck members and supports at once raise every rush skill's odds; the estimate uses them.
  const luckDeck: Performer[] = [];
  if (chart.luck) {
    const baseDeck: Performer[] = [];
    const memberLuck = members
      .map((_, i) => ({ i, value: gkMember[i]!.gekisouSkill && bonusOf[i] === 0 ? gain([gkMember[i]!], baseDeck) : 0 }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
    const characters = new Set<number>();
    for (const { i } of memberLuck) {
      if (characters.has(members[i]!.card.characterId) || characters.size === 5) continue;
      characters.add(members[i]!.card.characterId);
      luckDeck.push(gkMember[i]!);
    }
    const seen = new Set<string>();
    const supports: { p: Performer; value: number }[] = [];
    for (const snap of snaps) {
      const skills = snap.card.gekisoSupportSkillIds.map((id, k) => [id, snap.gekisoSkillLevels[k] ?? 1] as const).filter(([id]) => id);
      const key = JSON.stringify(skills);
      if (!skills.length || seen.has(key)) continue;
      seen.add(key);
      const p: Performer = { ...EMPTY, bandId: favouredBand(master, skills), missionOnly: 1, gekisouSupportSkills: skills };
      supports.push({ p, value: gain([p], baseDeck) });
    }
    for (const { p } of supports.sort((a, b) => b.value - a.value).slice(0, 5)) luckDeck.push(p);
  }

  const slotSkills = new Map<string, SlotSkill>();
  const slotSkill = (member: number, snap: number) => {
    const key = `${member}:${snap}`;
    let value = slotSkills.get(key);
    if (!value) slotSkills.set(key, (value = resolveSlotSkill(master, members[member]!, snap < 0 ? null : snaps[snap]!)));
    return value;
  };
  const eventTimes = chart.full.events.map(([, time]) => time);
  const lower = (time: number) => {
    let lo = 0,
      hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (chart.times[mid]! < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const liveWeight = (skill: SlotSkill, w: Weights, pick: "mean" | "best" | "worst") => {
    const perEvent = new Float64Array(5);
    for (let event = 0; event < Math.min(5, eventTimes.length); event++)
      for (const effect of skill.effects) {
        if (effect.gate.kind === "life-at-least" && (master.live.lifeBase >= effect.gate.value) !== effect.gate.positive) continue;
        const start = lower(eventTimes[event]!);
        const end = lower(eventTimes[event]! + windowMs(effect.seconds, skill.extensionMs));
        const factor = effect.delta / 100000;
        if (effect.type === 2000) perEvent[event]! += factor * (w.general[end]! - w.general[start]!);
        else
          for (const j of effect.judgements)
            if (j >= 4 && j <= 6) perEvent[event]! += factor * (w.byJudgement[j - 4]![end]! - w.byJudgement[j - 4]![start]!);
      }
    if (pick === "best") return Math.max(...perEvent);
    if (pick === "worst") return Math.min(...perEvent);
    return perEvent.reduce((a, b) => a + b, 0) / 5;
  };

  // Lower bounds: no Gekisou member skills, each support alone.
  const base = weights(contextOf([]));
  const supportLow = new Map<string, number>();
  const lowOf = (member: number, snap: number) => {
    const p = supportPerformer(member, snap);
    let support = 0;
    if (p) {
      const key = JSON.stringify([p.gekisouSupportSkills, p.bandId]);
      let value = supportLow.get(key);
      if (value === undefined) supportLow.set(key, (value = Math.max(0, gain([p], []))));
      support = value;
    }
    return liveWeight(slotSkill(member, snap), base, criterion === "min" ? "worst" : "mean") + support;
  };

  const relative = 3e-6;
  const absolute = n + 4;
  const deckOf = (team: Team) =>
    team.members.map((member, slot) => {
      const support = supportPerformer(member, team.snaps[slot]!);
      return support ? { ...gkMember[member]!, bandId: support.bandId, gekisouSupportSkills: support.gekisouSupportSkills } : gkMember[member]!;
    });
  /** Members' Gekisou context plus each support's gain within it, plus live skills on its note weights: additive and
   * within a few 1e-5 of the whole-live mean (floors and binary32 order aside). */
  /** Supports that change the lottery itself (gauge, guarantees): every rush reader's gain depends on them. */
  const chainCache = new Map<Performer, boolean>();
  const luckChain = (p: Performer) => {
    let value = chainCache.get(p);
    if (value === undefined) {
      value = p.gekisouSupportSkills.some(([id, level]) =>
        (master.gekisoSupportSkills.get(id)?.effects ?? []).some((row) => row.level === level && row.type >= 11000 && row.type <= 11005),
      );
      chainCache.set(p, value);
    }
    return value;
  };
  const refine = (team: Team, power: number) => {
    const deck = team.members.map((i) => gkMember[i]!);
    // With luck ranges the lottery-changing supports join the base: the rest add their gains given its lottery.
    const supports = team.members.map((member, slot) => supportPerformer(member, team.snaps[slot]!));
    if (chart.luck) for (const p of supports) if (p && luckChain(p)) deck.push(p);
    const w = weights(contextOf(deck));
    let total = w.base;
    team.members.forEach((member, slot) => {
      const snap = team.snaps[slot]!;
      const p = supports[slot];
      if (p && !(chart.luck && luckChain(p))) total += gain([p], deck);
      total += liveWeight(slotSkill(member, snap), w, criterion === "min" ? "worst" : criterion === "max" ? "best" : "mean");
    });
    return (power * total) / count;
  };
  const exact = (team: Team, power: number) => {
    const ctx = contextOf(deckOf(team));
    const skills = team.members.map((member, slot) => slotSkill(member, team.snaps[slot]!));
    const t0 = performance.now();
    const scores = scoreOrdersGekiso(master, chart, ctx, power, skills);
    timing.orders++;
    timing.ordersMs += performance.now() - t0;
    const key = criterion === "min" ? scores.min : criterion === "max" ? scores.max : scores.mean;
    return { key, detail: { scores, skills, seeds: ctx.seeds } };
  };

  const deadline = input.timeLimitMs ? started + input.timeLimitMs : Infinity;
  /** Exact power of a complete team (leader first). */
  const teamPowerOf = (team: Team) =>
    teamPower(master, input.player, team.members.map((i) => members[i]!), team.snaps.map((j) => (j < 0 ? null : snaps[j]!)), 0, input.music, []);
  const teamSkill = (objective: ObjectiveAdapter<unknown>, team: Team) =>
    team.members.reduce((sum, member, slot) => sum + objective.skill(member, team.snaps[slot]!)[1], 0);
  const levels = maxLevel > 0 ? [...Array(maxLevel + 1).keys()].reverse() : [0];
  const hits = new Map<string, SearchHit<GekisoDetail>>();
  const setKey = (team: Team) => team.members.map((i) => members[i]!.key).sort().join("|");
  const stats = { leaders: 0, memberNodes: 0, snapNodes: 0, candidates: 0, exact: 0, elapsedMs: 0 };
  let proven = !chart.luck;
  let bound: number | null = null;
  // Support gains on a coarse level grid: a gain at a higher level bounds every lower one.
  const grid = maxLevel > 0 ? [...new Set([0, Math.ceil(maxLevel / 4), Math.ceil(maxLevel / 2), Math.ceil((3 * maxLevel) / 4), maxLevel])].sort((a, b) => a - b) : [0];
  const levelData = new Map<number, { within: EngineMaster; deck: Performer[]; weights: Weights }>();
  const levelOf = (level: number) => {
    let value = levelData.get(level);
    if (!value) {
      const within = level > 0 && template ? levelMaster(master, template, level) : master;
      const deck: Performer[] = [...luckDeck];
      if (level > 0 && template) deck.push({ ...EMPTY, gekisouSkill: [SYNTHETIC_SKILL, 1], gekisouMissionType: M_COMBO });
      levelData.set(level, (value = { within, deck, weights: weights(contextOf(deck, within)) }));
    }
    return value;
  };
  const supportHigh = new Map<string, number>();
  const supportHighOf = (member: number, snap: number, level: number) => {
    const p = supportPerformer(member, snap);
    if (!p) return 0;
    const at = grid.find((g) => g >= level) ?? maxLevel;
    const key = JSON.stringify([p.gekisouSupportSkills, p.bandId, at]);
    let value = supportHigh.get(key);
    if (value === undefined) {
      const data = levelOf(at);
      supportHigh.set(key, (value = Math.max(0, gain([p], data.deck, data.within))));
    }
    return value;
  };

  /** Fills an objective's per-slot caches (support gains need simulations) before a timed search starts. */
  const warm = (objective: ObjectiveAdapter<unknown>) => {
    const excluded = new Set(input.constraints.excludedSnaps);
    members.forEach((_, i) => {
      if (input.constraints.excludedMembers.includes(i)) return;
      objective.skill(i, -1);
      if (!input.constraints.noSnaps) snaps.forEach((_, j) => excluded.has(j) || objective.skill(i, j));
    });
  };
  const levelConstraints = (level: number): Constraints => ({
    ...input.constraints,
    minBonus: maxLevel > 0 ? level : input.constraints.minBonus,
    maxBonus: maxLevel > 0 ? level : null,
  });
  const objectiveFor = (level: number, surrogate: boolean): ObjectiveAdapter<GekisoDetail | null> => {
    const data = levelOf(level);
    const ranges = new Map<string, [number, number]>();
    const high = (totals: Totals) => ((totals.power * (data.weights.base + totals.skill)) / count) * (1 + relative) + absolute;
    return {
      skill(member, snap) {
        const key = `${member}:${snap}`;
        let value = ranges.get(key);
        if (!value) {
          const top = liveWeight(slotSkill(member, snap), data.weights, criterion === "max" ? "best" : "mean") + supportHighOf(member, snap, level);
          ranges.set(key, (value = [surrogate ? top : lowOf(member, snap), top]));
        }
        return value;
      },
      memberBonus: (member) => bonusOf[member]!,
      snapBonus: () => 0,
      bound: high,
      productBase: data.weights.base,
      interval: (team, totals) => {
        if (surrogate) return [high(totals), high(totals)];
        // The additive estimate is within a few 1e-5 of the whole-live mean; conversions of Great notes add a little.
        const slack = chart.accuracy.great > 0 ? 10 * REFINE_SLACK : REFINE_SLACK;
        const value = refine(team, totals.power);
        return [Math.max(0, value * (1 - slack) - absolute), Math.max(Math.min(high(totals), value * (1 + slack) + absolute), value * (1 + slack))];
      },
      exact: (team, power, slotPowers) => {
        if (surrogate) return { key: high({ power, skill: 0, skillLow: 0, bonus: 0 }) + 0 * slotPowers.length, detail: null };
        stats.exact++;
        return exact(team, power);
      },
    };
  };
  // Seeding: the best teams of each level by its optimistic values, scored exactly, so the proving pass starts from a
  // threshold near the optimum.
  {
    const pool = new Map<string, { team: Team; value: number }>();
    // A few levels are enough to seed: the per-level passes below still visit every level.
    const seedLevels = [...new Set(grid.slice().reverse())];
    for (const level of seedLevels) {
      if (performance.now() > deadline) break;
      const surrogate = objectiveFor(level, true);
      warm(surrogate);
      const out = searchTeams({
        master,
        player: input.player,
        members,
        snaps,
        music: input.music,
        objective: { ...surrogate, exact: (team, power) => ({ key: surrogate.bound({ power, skill: teamSkill(surrogate, team), skillLow: 0, bonus: 0 }), detail: null }) },
        constraints: levelConstraints(level),
        k: Math.max(input.k * 3, 16),
        timeLimitMs: Math.min(400, Number.isFinite(deadline) ? Math.max(1, deadline - performance.now()) : 400),
      });
      for (const hit of out.hits) pool.set(setKey(hit.team) + "#" + hit.team.snaps.join(","), { team: hit.team, value: hit.key });
    }
    // The optimistic values overrate some teams by a few percent: score the most promising ones exactly.
    const ranked = [...pool.values()].sort((a, b) => b.value - a.value).slice(0, Math.max(60, input.k * 12));
    for (const { team } of ranked) {
      if (performance.now() > deadline) break;
      const power = teamPowerOf(team);
      const { key, detail } = exact(team, power.total);
      stats.exact++;
      const hitKey = setKey(team);
      const previous = hits.get(hitKey);
      if (!previous || previous.key < key) hits.set(hitKey, { team, power: power.total, slotPowers: power.slots, totals: { power: power.total, skill: 0, skillLow: 0, bonus: 0 }, key, detail });
    }
  }

  for (const [index, level] of levels.entries()) {
    input.progress?.(index, levels.length);
    if (performance.now() > deadline) {
      proven = false;
      break;
    }
    const objective = objectiveFor(level, false) as ObjectiveAdapter<GekisoDetail>;
    warm(objective);
    const seeds = [...hits.values()].sort((a, b) => b.key - a.key).slice(0, input.k).map((hit) => hit.team);
    const out = searchTeams({
      master,
      player: input.player,
      members,
      snaps,
      music: input.music,
      objective,
      constraints: levelConstraints(level),
      k: input.k,
      seeds,
      timeLimitMs: Number.isFinite(deadline) ? Math.max(1, deadline - performance.now()) : undefined,
    });
    stats.leaders += out.stats.leaders;
    stats.memberNodes += out.stats.memberNodes;
    stats.snapNodes += out.stats.snapNodes;
    stats.candidates += out.stats.candidates;
    if (!out.proven) {
      proven = false;
      bound = Math.max(bound ?? -Infinity, out.bound ?? -Infinity);
    }
    for (const hit of out.hits) {
      const key = setKey(hit.team);
      const previous = hits.get(key);
      if (!previous || previous.key < hit.key) hits.set(key, hit);
    }
  }
  stats.elapsedMs = performance.now() - started;
  return {
    hits: [...hits.values()].sort((a, b) => b.key - a.key).slice(0, input.k),
    proven,
    bound,
    stats,
    levels: levels.length,
  };
}
