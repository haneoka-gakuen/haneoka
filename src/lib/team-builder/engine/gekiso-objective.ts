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
import { gekisoContext, gekisoPerformer, rushOnlyFactor, scoreOrdersGekiso, settleSlack, type GekisoChart, type GekisoContext } from "./gekiso";
import { bestOrder5, type Criterion } from "./objectives";

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
  initialTeams?: Team[];
  onCandidate?: (hits: readonly SearchHit<GekisoDetail>[]) => void;
  shard?: { index: number; count: number };
  /** Known lower bound on the k-th key (teams other shards found). */
  floor?: number;
  /** Stops after seeding: one Worker seeds, and every shard starts from its teams (`seeded`). */
  seedOnly?: boolean;
  /** `initialTeams` already hold the seeding's teams. */
  seeded?: boolean;
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

/** Whether the favoured band's variant of support skills has every effect the other variants have, at least as
 * strong: rows outside the favoured band only differ from a favoured row by a smaller value. */
function favouredDominates(master: EngineMaster, skills: readonly (readonly [number, number])[]): boolean {
  const band = (cid: number) => {
    const c = master.conditions.get(cid);
    return c?.type === 5000 ? c : null;
  };
  const shape = (group: number, flip: boolean) =>
    JSON.stringify(
      (master.conditionSets.get(group) ?? []).map((set) =>
        set.map((cid) => {
          const c = band(cid);
          return c ? [5000, flip || c.positive, c.targetIds] : cid;
        }),
      ),
    );
  for (const [id, level] of skills) {
    const rows = (master.gekisoSupportSkills.get(id)?.effects ?? []).filter((row) => row.level === level);
    for (const row of rows) {
      if ([row.triggerGroup, row.releaseGroup, row.resetGroup].some((group) => (master.conditionSets.get(group) ?? []).flat().some(band))) return false;
      const negative = (master.conditionSets.get(row.conditionGroup) ?? []).flat().some((cid) => band(cid) && !band(cid)!.positive);
      if (!negative) continue;
      const wanted = shape(row.conditionGroup, true);
      const twin = rows.find(
        (other) =>
          other !== row &&
          other.type === row.type &&
          other.triggerType === row.triggerType &&
          other.executeLimit === row.executeLimit &&
          other.seconds === row.seconds &&
          other.limitCount === row.limitCount &&
          other.maxValue === row.maxValue &&
          JSON.stringify(other.targetIds) === JSON.stringify(row.targetIds) &&
          other.triggerGroup === row.triggerGroup &&
          other.releaseGroup === row.releaseGroup &&
          other.resetGroup === row.resetGroup &&
          other.value >= row.value &&
          shape(other.conditionGroup, false) === wanted,
      );
      if (!twin) return false;
    }
  }
  return true;
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

/** Per-Worker Gekisou contexts of the chart being searched, by level tag and lottery seeds, then deck. A context
 * holds four note-sized arrays and a search simulates thousands of decks, so only the current chart's are kept and
 * the oldest are dropped past a fixed budget; a dropped context is simulated again when asked for. */
const CONTEXT_BYTES = 16 * 1024 * 1024;
const BASES = 2048;
const contexts = { chart: null as GekisoChart | null, byTag: new Map<string, Map<string, GekisoContext>>(), bytes: 0 };
const contextBytes = (key: string, value: GekisoContext) =>
  key.length * 2 + 128 + value.judgement.byteLength + value.gk.byteLength + value.up.byteLength + value.luck.byteLength;
const levelTags = new WeakMap<EngineMaster, string>();
/** Per-Worker memo of the seeding phase (shard-independent), keyed by chart and request. */
const seededByChart = new WeakMap<GekisoChart, Map<string, SearchHit<GekisoDetail>[]>>();

export function gekisoSearch(input: GekisoSearchInput): SearchOutput<GekisoDetail> & { levels: number } {
  const started = performance.now();
  const { master, members, snaps, chart, criterion } = input;
  const deadline = input.timeLimitMs == null ? Infinity : started + input.timeLimitMs;
  const n = chart.notes.length;
  const count = chart.full.convertedCount;
  const unit = master.live.adjustment * chart.difficultyFactor;
  const rangeFactor = Float64Array.from(chart.rangeOf, (r) => (r >= 0 ? 1 + chart.rangePercent[r]! / 100 : 1));
  const missions = chart.setup.missions.slice(0, chart.full.fevers.length);
  const comboRanges = missions.some((m) => m === M_COMBO || m === M_ALL);

  // Contexts are kept per chart across calls: the shards of one request (and later requests on the same chart) share
  // every deck already simulated. Level masters are tagged by level, since each call builds them afresh.
  if (contexts.chart !== chart) {
    contexts.chart = chart;
    contexts.byTag = new Map();
    contexts.bytes = 0;
  }
  const chartCache = contexts.byTag;
  const seedTag = input.seeds.join(",");
  const readAll = readAttributes(master, "all");
  const readMembers = readAttributes(master, "members");
  const timing = { contexts: 0, contextMs: 0, orders: 0, ordersMs: 0 };
  /** A performer's context key (the fields its simulation reads), computed once per performer object. */
  const performerKeys = new WeakMap<Performer, number>();
  const performerIds = new Map<string, number>();
  const performerJson: string[] = [];
  const performerKey = (p: Performer) => {
    let id = performerKeys.get(p);
    if (id === undefined) {
      // A mission without skills only gates the performer's own supports: without them it simulates as nothing.
      const mission = p.gekisouSkill || p.gekisouSupportSkills.length ? (p.missionOnly ?? 0) : 0;
      const key = JSON.stringify([p.gekisouSkill, mission, p.gekisouSupportSkills, ...(p.gekisouSupportSkills.length ? readAll : readMembers).map((field) => p[field])]);
      id = performerIds.get(key);
      if (id === undefined) {
        performerIds.set(key, (id = performerJson.length));
        performerJson.push(key);
      }
      performerKeys.set(p, id);
    }
    return id;
  };
  /** Luck charts shard by member set: a set's lottery contexts dominate its cost, and sets that simulate alike (the
   * same fields, whichever members) go to one shard, so no two Workers build the same contexts. */
  const luckSets = (() => {
    if (!chart.luck || !input.shard || input.shard.count < 2) return null;
    const { index, count } = input.shard;
    return (team: readonly number[]) => {
      const key = team.map((i) => performerJson[performerKey(gkMember[i]!)]!).sort().join("|");
      let hash = 0x811c9dc5;
      for (let c = 0; c < key.length; c++) hash = Math.imul(hash ^ key.charCodeAt(c), 0x01000193);
      return (hash >>> 0) % count === index;
    };
  })();
  // Simulated decks are ordered by the performers' fields, whichever order the search met them in.
  const byFields = (a: number, b: number) => (performerJson[a]! < performerJson[b]! ? -1 : performerJson[a]! > performerJson[b]! ? 1 : 0);
  /** Decks with the same key simulate alike. */
  const contextKey = (deck: readonly Performer[]) => deck.map(performerKey).sort(byFields).join(",");
  const contextOf = (deck: Performer[], within = master) => {
    const tag = `${within === master ? "base" : (levelTags.get(within) ?? "?")}|${seedTag}`;
    let cache = chartCache.get(tag);
    if (!cache) chartCache.set(tag, (cache = new Map()));
    const keyed = deck.map((p) => ({ p, key: performerKey(p) }));
    keyed.sort((a, b) => byFields(a.key, b.key));
    const key = keyed.map((item) => item.key).join(",");
    let value = cache.get(key);
    if (!value) {
      const t0 = performance.now();
      cache.set(key, (value = gekisoContext(within, chart, keyed.map((item) => item.p), input.seeds)));
      contexts.bytes += contextBytes(key, value);
      if (contexts.bytes > CONTEXT_BYTES)
        evict: for (const old of chartCache.values())
          for (const [oldKey, oldValue] of old) {
            if (oldValue === value) continue;
            old.delete(oldKey);
            contexts.bytes -= contextBytes(oldKey, oldValue);
            if (contexts.bytes <= CONTEXT_BYTES * 0.75) break evict;
          }
      timing.contexts++;
      timing.contextMs += performance.now() - t0;
    }
    return value;
  };
  /** `rush`: per unit rush factor, the expected weight of notes read while rush is on (Luck charts). */
  type Weights = { base: number; general: Float64Array; byJudgement: Float64Array[]; rush: number };
  const weightCache = new WeakMap<GekisoContext, Weights>();
  /** Linear weight of a context per unit power: `base` without live skills, prefix sums of live-factor weights. */
  const weights = (ctx: GekisoContext): Weights => {
    let value = weightCache.get(ctx);
    if (value) return value;
    const general = new Float64Array(n + 1);
    const byJudgement = [4, 5, 6].map(() => new Float64Array(n + 1));
    let base = 0, rush = 0;
    const probabilities = ctx.nominal?.probabilities;
    const bonus = ctx.nominal ? ctx.nominal.rushFactor - 1 : 0;
    for (let i = 0; i < n; i++) {
      const beta = rangeFactor[i]! * unit * chart.noteFrac[i]! * chart.judgeFrac[ctx.judgement[i]!]! * chart.comboFactor[i]! * ctx.gk[i]!;
      base += beta * ctx.up[i]!;
      if (probabilities) rush += beta * (probabilities[2]![i]! + probabilities[3]![i]! + bonus * probabilities[3]![i]!);
      const live = beta * ctx.luck[i]!;
      general[i + 1] = general[i]! + live;
      for (let k = 0; k < 3; k++) byJudgement[k]![i + 1] = byJudgement[k]![i]! + (ctx.judgement[i] === k + 4 ? live : 0);
    }
    weightCache.set(ctx, (value = { base, general, byJudgement, rush }));
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
  const supportBySlot: (Performer | null | undefined)[] = [];
  const supportPerformer = (member: number, snap: number): Performer | null => {
    if (snap < 0 || !hasGekiso[member]) return null;
    const index = member * snaps.length + snap;
    const known = supportBySlot[index];
    if (known !== undefined) return known;
    return (supportBySlot[index] = supportPerformerOf(member, snap));
  };
  const supportPerformerOf = (member: number, snap: number): Performer | null => {
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
  const calibrateLuck = () => {
    if (!chart.luck) return true;
    const baseDeck: Performer[] = [];
    const memberLuck: { i: number; value: number }[] = [];
    for (let i = 0; i < members.length; i++) {
      if (performance.now() >= deadline) return false;
      memberLuck.push({ i, value: gkMember[i]!.gekisouSkill && bonusOf[i] === 0 ? gain([gkMember[i]!], baseDeck) : 0 });
    }
    const ranked = memberLuck
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
    const characters = new Set<number>();
    for (const { i } of ranked) {
      if (characters.has(members[i]!.card.characterId) || characters.size === 5) continue;
      characters.add(members[i]!.card.characterId);
      luckDeck.push(gkMember[i]!);
    }
    const seen = new Set<string>();
    const supports: { p: Performer; value: number }[] = [];
    for (const snap of snaps) {
      if (performance.now() >= deadline) return false;
      const skills = snap.card.gekisoSupportSkillIds.map((id, k) => [id, snap.gekisoSkillLevels[k] ?? 1] as const).filter(([id]) => id);
      const key = JSON.stringify(skills);
      if (!skills.length || seen.has(key)) continue;
      seen.add(key);
      const p: Performer = { ...EMPTY, bandId: favouredBand(master, skills), missionOnly: 1, gekisouSupportSkills: skills };
      supports.push({ p, value: gain([p], baseDeck) });
    }
    for (const { p } of supports.sort((a, b) => b.value - a.value).slice(0, 5)) luckDeck.push(p);
    luckMembers.push(...ranked.map(({ i }) => gkMember[i]!));
    // Every lottery-changing support, in each band variant a slot can give it unless the favoured one dominates.
    for (const { p } of supports) {
      if (!luckChain(p)) continue;
      luckSupports.push(p);
      if (p.bandId && !favouredDominates(master, p.gekisouSupportSkills)) luckSupports.push({ ...p, bandId: p.bandId === 1 ? 2 : 1 });
    }
    return true;
  };

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
  const eventWeights = (skill: SlotSkill, w: Weights) => {
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
    return perEvent;
  };
  const liveWeight = (skill: SlotSkill, w: Weights, pick: "mean" | "best" | "worst") => {
    const perEvent = eventWeights(skill, w);
    if (pick === "best") return Math.max(...perEvent);
    if (pick === "worst") return Math.min(...perEvent);
    return perEvent.reduce((a, b) => a + b, 0) / 5;
  };

  // Lower bounds: no Gekisou member skills, each support alone.
  let base: Weights | undefined;
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
    return liveWeight(slotSkill(member, snap), base ??= weights(contextOf([])), criterion === "min" ? "worst" : "mean") + support;
  };

  const relative = 3e-6;
  const absolute = n + 4;
  /** Luck charts: per Gekisou deck (by performer shape, so member sets with the same Luck skills share it) and set
   * of lottery-changing supports, its weights and each other support's gain given that lottery. */
  const shapeKeys = new WeakMap<Performer, string>();
  const shapeOf = (p: Performer) => {
    let key = shapeKeys.get(p);
    if (key === undefined) shapeKeys.set(p, (key = JSON.stringify(p)));
    return key;
  };
  const rushFactors = new Map<Performer, number | null>();
  const rushFactorOf = (p: Performer) => {
    if (!rushFactors.has(p)) rushFactors.set(p, rushOnlyFactor(master, p));
    return rushFactors.get(p)!;
  };
  const memberBases = new Map<string, number>();
  /** A support's variants across slots, reduced to the favoured band's when that one has every effect stronger. */
  const dominance = new Map<string, boolean>();
  const strongest = (variants: Set<Performer>): Performer[] => {
    const list = [...variants];
    if (list.length < 2) return list;
    const skills = JSON.stringify(list[0]!.gekisouSupportSkills);
    if (list.some((p) => JSON.stringify(p.gekisouSupportSkills) !== skills)) return list;
    const favoured = list.find((p) => p.bandId === favouredBand(master, p.gekisouSupportSkills));
    if (!favoured) return list;
    let dominates = dominance.get(skills);
    if (dominates === undefined) dominance.set(skills, (dominates = favouredDominates(master, favoured.gekisouSupportSkills)));
    return dominates ? [favoured] : list;
  };
  /** The pool's Luck member skills strongest first, and its lottery-changing supports (set by `calibrateLuck`). */
  const luckMembers: Performer[] = [];
  const luckSupports: Performer[] = [];
  const luckBases = new Map<string, { w: Weights; deck: Performer[]; gains: Map<Performer, number>; lives: Map<number, number> }>();
  const luckBase = (memberDeck: readonly Performer[], chained: readonly Performer[]) => {
    const key = contextKey([...memberDeck, ...chained]);
    let value = luckBases.get(key);
    if (!value) {
      const deck = [...memberDeck, ...chained];
      // Each holds a deck's note weights: a Worker on a phone keeps at most a few thousand.
      if (luckBases.size >= BASES) luckBases.clear();
      luckBases.set(key, (value = { w: weights(contextOf(deck)), deck, gains: new Map(), lives: new Map() }));
    }
    return value;
  };
  /** The lottery-fixed value of one slot: a non-chain support's gain and the slot's live weight. */
  const luckSlot = (base: NonNullable<ReturnType<typeof luckBase>>, member: number, snap: number, pick: "mean" | "best" | "worst") => {
    const index = (member * (snaps.length + 1) + snap + 1) * 3 + (pick === "mean" ? 0 : pick === "best" ? 1 : 2);
    let value = base.lives.get(index);
    if (value === undefined) {
      value = liveWeight(slotSkill(member, snap), base.w, pick);
      const p = snap >= 0 ? supportPerformer(member, snap) : null;
      if (p && !luckChain(p)) {
        let support = base.gains.get(p);
        if (support === undefined) {
          const factor = rushFactorOf(p);
          base.gains.set(p, (support = factor === null ? gain([p], base.deck) : factor * base.w.rush));
        }
        value += support;
      }
      base.lives.set(index, value);
    }
    return value;
  };
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
  /** Per member set (and lottery-changing supports): its weights, each support's gain and each slot's live weight. */
  const refineBases = new Map<string, { w: Weights; deck: Performer[]; gains: Map<Performer, number>; lives: Map<number, number> }>();
  const supportIds = new Map<Performer, number>();
  const refinePick = criterion === "min" ? "worst" : criterion === "max" ? "best" : "mean";
  const refine = (team: Team, power: number) => {
    const supports = team.members.map((member, slot) => supportPerformer(member, team.snaps[slot]!));
    // With luck ranges the lottery-changing supports join the base: the rest add their gains given its lottery.
    const chained = chart.luck ? supports.filter((p): p is Performer => !!p && luckChain(p)) : [];
    let key = team.members.slice().sort((a, b) => a - b).join(",");
    if (chained.length) {
      const ids = chained.map((p) => {
        let id = supportIds.get(p);
        if (id === undefined) supportIds.set(p, (id = supportIds.size));
        return id;
      });
      key += "|" + ids.sort((a, b) => a - b).join(",");
    }
    let base = refineBases.get(key);
    if (!base) {
      const deck = [...team.members.map((i) => gkMember[i]!), ...chained];
      if (refineBases.size >= BASES) refineBases.clear();
      refineBases.set(key, (base = { w: weights(contextOf(deck)), deck, gains: new Map(), lives: new Map() }));
    }
    let total = base.w.base;
    team.members.forEach((member, slot) => {
      const snap = team.snaps[slot]!;
      const p = supports[slot];
      if (p && !(chart.luck && luckChain(p))) {
        let value = base.gains.get(p);
        if (value === undefined) {
          const factor = chart.luck ? rushFactorOf(p) : null;
          base.gains.set(p, (value = factor === null ? gain([p], base.deck) : factor * base.w.rush));
        }
        total += value;
      }
      const index = member * (snaps.length + 1) + snap + 1;
      let live = base.lives.get(index);
      if (live === undefined) base.lives.set(index, (live = liveWeight(slotSkill(member, snap), base.w, refinePick)));
      total += live;
    });
    return (power * total) / count;
  };
  const exact = (team: Team, power: number, settle = true) => {
    const ctx = contextOf(deckOf(team));
    const skills = team.members.map((member, slot) => slotSkill(member, team.snaps[slot]!));
    const t0 = performance.now();
    const scores = scoreOrdersGekiso(master, chart, ctx, power, skills, undefined, settle);
    timing.orders++;
    timing.ordersMs += performance.now() - t0;
    const key = criterion === "min" ? scores.min : criterion === "max" ? scores.max : scores.mean;
    return { key, detail: { scores, skills, seeds: ctx.seeds } };
  };

  /** Exact power of a complete team (leader first). */
  const teamPowerOf = (team: Team) =>
    teamPower(master, input.player, team.members.map((i) => members[i]!), team.snaps.map((j) => (j < 0 ? null : snaps[j]!)), 0, input.music, []);
  const teamSkill = (objective: ObjectiveAdapter<unknown>, team: Team) =>
    team.members.reduce((sum, member, slot) => sum + objective.skill(member, team.snaps[slot]!)[1], 0);
  const levels = maxLevel > 0 ? [...Array(maxLevel + 1).keys()].reverse() : [0];
  const hits = new Map<string, SearchHit<GekisoDetail>>();
  const setKey = (team: Team) => team.members.map((i) => members[i]!.key).sort().join("|");
  const stats = { leaders: 0, memberNodes: 0, snapNodes: 0, candidates: 0, exact: 0, elapsedMs: 0 };
  let proven = true;
  let bound: number | null = null;
  const finish = () => ({
    hits: [...hits.values()].sort((a, b) => b.key - a.key).slice(0, input.k),
    proven, bound, stats: { ...stats, elapsedMs: performance.now() - started }, levels: levels.length,
  });
  // Support gains on a coarse level grid: a gain at a higher level bounds every lower one.
  const grid = maxLevel > 0 ? [...new Set([0, Math.ceil(maxLevel / 4), Math.ceil(maxLevel / 2), Math.ceil((3 * maxLevel) / 4), maxLevel])].sort((a, b) => a - b) : [0];
  const levelData = new Map<number, { within: EngineMaster; deck: Performer[]; weights: Weights }>();
  const levelOf = (level: number) => {
    let value = levelData.get(level);
    if (!value) {
      const within = level > 0 && template ? levelMaster(master, template, level) : master;
      if (within !== master) levelTags.set(within, `L${level}`);
      const deck: Performer[] = [...luckDeck];
      if (level > 0 && template) deck.push({ ...EMPTY, gekisouSkill: [SYNTHETIC_SKILL, 1], gekisouMissionType: M_COMBO });
      levelData.set(level, (value = { within, deck, weights: weights(contextOf(deck, within)) }));
    }
    return value;
  };
  const supportHigh = new Map<string, number>();
  const supportHighBySlot = new Map<number, number>();
  const supportHighOf = (member: number, snap: number, level: number) => {
    const p = supportPerformer(member, snap);
    if (!p) return 0;
    const at = grid.find((g) => g >= level) ?? maxLevel;
    const index = (member * snaps.length + snap) * (maxLevel + 1) + at;
    let known = supportHighBySlot.get(index);
    if (known === undefined) supportHighBySlot.set(index, (known = supportHighAt(p, at)));
    return known;
  };
  const supportHighAt = (p: Performer, at: number) => {
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
    for (let i = 0; i < members.length; i++) {
      if (performance.now() >= deadline) return false;
      if (input.constraints.excludedMembers.includes(i)) continue;
      objective.skill(i, -1);
      if (!input.constraints.noSnaps) for (let j = 0; j < snaps.length; j++) {
        if (performance.now() >= deadline) return false;
        if (!excluded.has(j)) objective.skill(i, j);
      }
    }
    return true;
  };
  const levelConstraints = (level: number): Constraints => ({
    ...input.constraints,
    minBonus: maxLevel > 0 ? level : input.constraints.minBonus,
    maxBonus: maxLevel > 0 ? level : null,
  });
  const objectiveFor = (level: number, surrogate: boolean): ObjectiveAdapter<GekisoDetail | null> => {
    const data = levelOf(level);
    const ranges = new Map<string, [number, number]>();
    const orders = new Map<string, { perEvent: Float64Array; best: number }>();
    const orderOf = (member: number, snap: number) => {
      const key = `${member}:${snap}`;
      let value = orders.get(key);
      if (!value) {
        const perEvent = eventWeights(slotSkill(member, snap), data.weights);
        orders.set(key, (value = { perEvent, best: Math.max(...perEvent) }));
      }
      return value;
    };
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
      // Best order: the five live skills take distinct events, so each slot's own best event overstates the team.
      ...(criterion === "max" && !surrogate
        ? {
            leafBound: (team: Team, totals: Totals) => {
              const rows = team.members.map((member, slot) => orderOf(member, team.snaps[slot]!));
              const separate = rows.reduce((sum, row) => sum + row.best, 0);
              return high({ ...totals, skill: totals.skill - separate + bestOrder5(rows.map((row) => row.perEvent)) });
            },
          }
        : {}),
      productBase: data.weights.base,
      // Luck charts: the lottery depends only on the members' Luck skills and the lottery-changing supports. For each
      // such set the other supports and live skills add given its lottery, so a member set's completions are bounded
      // by the best set its assigned snaps still allow, not by the luckiest deck of the whole pool.
      ...(chart.luck && !surrogate
        ? {
            // The lottery of a partial set: its members' Luck skills, the strongest Luck skills for the open slots
            // and every lottery-changing support. More or stronger Luck skills never lower a rush's odds.
            memberBound: (chosen: readonly number[], totals: Totals, left: number) => {
              if (!readAll.every((field) => field === "bandId")) return Infinity;
              const deck = chosen.map((i) => gkMember[i]!);
              const key = deck.map(shapeOf).sort().join("+") + "|" + left;
              let base = memberBases.get(key);
              if (base === undefined) {
                // Every Luck skill an open slot could bring, as many times as the open slots allow.
                const copies = new Map<string, Performer[]>();
                for (const p of luckMembers) {
                  const list = copies.get(shapeOf(p)) ?? [];
                  if (list.length < left) list.push(p);
                  copies.set(shapeOf(p), list);
                }
                const extra = [...copies.values()].flat();
                memberBases.set(key, (base = weights(contextOf([...deck, ...extra, ...luckSupports])).base));
              }
              return ((totals.power * (base + totals.skill)) / count) * (1 + relative) + absolute;
            },
            assignmentBound: (team: readonly number[], options: readonly (readonly number[])[]) => {
              const memberDeck = team.map((i) => gkMember[i]!);
              const chainOf = (slot: number, snap: number) => {
                const p = snap >= 0 ? supportPerformer(team[slot]!, snap) : null;
                return p && luckChain(p) ? p : null;
              };
              const chainSnaps = [...new Set(options.flatMap((row, slot) => row.filter((snap) => chainOf(slot, snap))))];
              const pick = criterion === "max" ? "best" : "mean";
              const value = (chained: readonly Performer[], totals: Totals, assigned: readonly number[], from: number) => {
                const taken = assigned.slice(0, from);
                const base = luckBase(memberDeck, chained);
                let value = base.w.base;
                for (let slot = 0; slot < from; slot++) value += luckSlot(base, team[slot]!, assigned[slot]!, pick);
                for (let slot = from; slot < 5; slot++) {
                  let top = -Infinity;
                  for (const snap of options[slot]!) {
                    if (snap >= 0 && taken.includes(snap)) continue;
                    top = Math.max(top, chainOf(slot, snap) ? luckSlot(base, team[slot]!, -1, pick) : luckSlot(base, team[slot]!, snap, pick));
                  }
                  value += top;
                }
                return ((totals.power * value) / count) * (1 + REFINE_SLACK) + absolute;
              };
              return (totals: Totals, assigned: readonly number[], from: number) => {
                const taken = assigned.slice(0, from);
                // A taken support joins with its own slot's variant; an open one with every variant the open slots
                // offer (a support's band-dependent rows make the slots differ).
                const chained: Performer[] = [];
                for (const snap of chainSnaps) {
                  const at = taken.indexOf(snap);
                  if (at >= 0) {
                    const p = chainOf(at, snap);
                    if (p) chained.push(p);
                    continue;
                  }
                  const variants = new Set<Performer>();
                  for (let slot = from; slot < 5; slot++) if (options[slot]!.includes(snap)) variants.add(chainOf(slot, snap)!);
                  chained.push(...strongest(variants));
                }
                return value(chained, totals, assigned, from);
              };
            },
          }
        : {}),
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
  // threshold near the optimum. It covers every leader (a shard's own leaders would seed it far lower) and a Worker
  // keeps it for the request's other shards.
  const seedKey = JSON.stringify([members.map((m) => m.key), snaps.map((x) => x.key), criterion, input.k, input.constraints, input.seeds]);
  let seedCache = seededByChart.get(chart);
  if (!seedCache) seededByChart.set(chart, (seedCache = new Map()));
  const publish = () => input.onCandidate?.([...hits.values()].sort((a, b) => b.key - a.key).slice(0, input.k));
  for (const team of input.initialTeams ?? []) {
    if (performance.now() > deadline) break;
    const power = teamPowerOf(team);
    const { key, detail } = exact(team, power.total);
    stats.exact++;
    hits.set(setKey(team), { team, key, detail, power: power.total, slotPowers: power.slots, totals: { power: power.total, skill: 0, skillLow: 0, bonus: 0 } });
    publish();
  }
  if (chart.luck && !hits.size && performance.now() < deadline) {
    // A feasibility seed is settled before calibration. Empty optional slots avoid making the most complex
    // support combination block the first result; the score search still includes every usable snapshot.
    const seed = searchTeams({
      master, player: input.player, members, snaps, music: input.music,
      objective: {
        skill: () => [0, 0], memberBonus: (member) => bonusOf[member]!, snapBonus: () => 0,
        bound: () => 0, interval: () => [0, 0], exact: () => ({ key: 0, detail: null }),
        preferSnap: (_member, snap) => snap < 0 ? 1 : 0,
        preferMember: (member) => {
          const skill = gkMember[member]!.gekisouSkill;
          return skill ? -(master.gekisoSkills.get(skill[0])?.effects ?? []).filter(row =>
            row.level === skill[1] && row.type >= 11000 && row.type <= 11005).length : 0;
        },
      },
      constraints: input.constraints, k: 1,
      timeLimitMs: Math.min(100, deadline - performance.now()),
    });
    const candidate = seed.hits[0];
    if (candidate && performance.now() < deadline) {
      const { team, power, slotPowers } = candidate;
      const evaluated = exact(team, power);
      stats.exact++;
      hits.set(setKey(team), { ...candidate, ...evaluated, team, power, slotPowers });
      publish();
    }
  }
  if (performance.now() >= deadline || !calibrateLuck()) {
    proven = false;
    return finish();
  }
  const seeded = input.seeded ? [] : seedCache.get(seedKey);
  if (seeded) for (const hit of seeded) {
    const key = setKey(hit.team);
    if (!hits.has(key) || hits.get(key)!.key < hit.key) hits.set(key, hit);
  }
  else {
    const pool = new Map<string, { team: Team; value: number }>();
    // A few levels are enough to seed: the per-level passes below still visit every level.
    const seedLevels = [...new Set(grid.slice().reverse())];
    for (const level of seedLevels) {
      if (performance.now() > deadline) break;
      const surrogate = objectiveFor(level, true);
      if (!warm(surrogate)) break;
      const out = searchTeams({
        master,
        player: input.player,
        members,
        snaps,
        music: input.music,
        objective: { ...surrogate, exact: (team, power) => ({ key: surrogate.bound({ power, skill: teamSkill(surrogate, team), skillLow: 0, bonus: 0 }), detail: null }) },
        constraints: levelConstraints(level),
        // Luck charts rank on this estimate (their lottery has no proven bound), so it runs to completion and
        // keeps a deeper pool for the exact rescoring below.
        k: chart.luck ? Math.max(input.k * 12, 120) : Math.max(input.k * 3, 16),
        timeLimitMs: chart.luck
          ? (Number.isFinite(deadline) ? Math.max(1, deadline - performance.now()) : undefined)
          : Math.min(400, Number.isFinite(deadline) ? Math.max(1, deadline - performance.now()) : 400),
      });
      for (const hit of out.hits) pool.set(setKey(hit.team) + "#" + hit.team.snaps.join(","), { team: hit.team, value: hit.key });
    }
    // The optimistic values overrate some teams by a few percent: score the most promising ones exactly.
    let ranked: { team: Team; value: number }[] = [...pool.values()].sort((a, b) => b.value - a.value).slice(0, chart.luck ? Math.max(120, input.k * 12) : Math.max(60, input.k * 12));
    // Settling a Luck range's rank remainder runs the lottery once per order, and the remainder only takes off less
    // than a point per range. The unsettled scores bound the settled ones from above, so teams are settled best
    // bound first, and the rest can no longer reach the top k once their bound falls to its k-th settled score.
    const slack = chart.luck ? settleSlack(chart) : 0;
    const upper = new Map<Team, number>();
    if (slack > 0) {
      for (const candidate of ranked) {
        if (performance.now() > deadline) break;
        upper.set(candidate.team, exact(candidate.team, teamPowerOf(candidate.team).total, false).key);
      }
      ranked = ranked.filter((candidate) => upper.has(candidate.team)).sort((a, b) => upper.get(b.team)! - upper.get(a.team)!);
    }
    const kth = () => {
      const keys = [...hits.values()].map((hit) => hit.key).sort((a, b) => b - a);
      return keys.length >= input.k ? keys[input.k - 1]! : -Infinity;
    };
    for (const { team } of ranked) {
      if (performance.now() > deadline) break;
      if (slack > 0 && upper.get(team)! <= kth()) break;
      const power = teamPowerOf(team);
      const { key, detail } = exact(team, power.total);
      stats.exact++;
      const hitKey = setKey(team);
      const previous = hits.get(hitKey);
      if (!previous || previous.key < key) hits.set(hitKey, { team, power: power.total, slotPowers: power.slots, totals: { power: power.total, skill: 0, skillLow: 0, bonus: 0 }, key, detail });
      publish();
    }
    if (performance.now() <= deadline) {
      if (seedCache.size > 8) seedCache.clear();
      seedCache.set(seedKey, [...hits.values()]);
    }
  }
  if (input.seedOnly) {
    proven = false;
    return finish();
  }

  // Luck ranges: the lottery expectation has no bound the snap search could prune on (optimistic support gains
  // against the strongest luck deck never meet the chained-lottery leaves), so the exact rescoring of the
  // estimate's best teams above is the result.
  for (const [index, level] of levels.entries()) {
    input.progress?.(index, levels.length);
    if (performance.now() > deadline) {
      proven = false;
      break;
    }
    const objective = objectiveFor(level, false) as ObjectiveAdapter<GekisoDetail>;
    if (!warm(objective)) { proven = false; break; }
    const best = [...hits.values()].sort((a, b) => b.key - a.key).slice(0, input.k);
    const seeds = best.map((hit) => hit.team);
    // Seeds rarely hold this level's bonus: the k-th best of every level so far is the floor any team must beat.
    const floor = Math.max(input.floor ?? -Infinity, best.length >= input.k ? best[input.k - 1]!.key : -Infinity);
    const out = searchTeams({
      ...(luckSets ? { owns: luckSets } : { shard: input.shard }),
      master,
      player: input.player,
      members,
      snaps,
      music: input.music,
      objective,
      constraints: levelConstraints(level),
      k: input.k,
      seeds,
      onCandidate: candidates => {
        for (const hit of candidates) { const key = setKey(hit.team); if (!hits.has(key) || hits.get(key)!.key < hit.key) hits.set(key, hit); }
        publish();
      },
      floor: Number.isFinite(floor) ? floor : undefined,
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
  return finish();
}
