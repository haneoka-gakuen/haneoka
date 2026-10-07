/** Exact Top-K over leader → four members → snap assignment.
 *
 * Every slot contributes power p, skill weight g and event bonus e additively; an
 * objective maps (P, G, E) monotonically to its key, so optimistic sums give valid
 * bounds. Survivors are ranked by an interval around the key and only those that
 * can still enter the Top-K are evaluated exactly. */
import type { EngineMaster } from "./master";
import {
  leaderPercentBound,
  leaderPercents,
  leaderPoints,
  leaderProfile,
  slotBase,
  snapPoints,
  type LeaderProfile,
  type MemberState,
  type MusicView,
  type PlayerState,
  type SlotBase,
  type SnapState,
} from "./power";

export interface Totals {
  power: number;
  /** Optimistic skill weight (upper end of the key). */
  skill: number;
  /** Pessimistic skill weight (lower end of the key). */
  skillLow: number;
  bonus: number;
}
export interface Team {
  /** Member indices; slot 0 is the leader. */
  members: number[];
  /** Snap index per slot, -1 for an empty slot. */
  snaps: number[];
}
export interface ObjectiveAdapter<Detail> {
  /** [pessimistic, optimistic] skill weight of a member with snap `snap` (-1 empty). */
  skill(member: number, snap: number): readonly [number, number];
  /** Additive event bonus of a member and a snap (BP, 10000 = 100 %). */
  memberBonus(member: number): number;
  snapBonus(snap: number): number;
  /** Upper bound of the key for optimistic totals. */
  bound(totals: Totals): number;
  /** When set, `bound` depends on power and skill only through power × (productBase + skill): the snap assignment
   * then bounds that product directly (much tighter than bounding both sums apart). */
  productBase?: number;
  /** The bounds are loose for this objective (life-draining plays). */
  hard?: boolean;
  /** Joint requirements a team must meet to reach a key of at least `limit`: for at least one entry, bonus ≥ `bonus`
   * and power × (productBase + skill) ≥ `product` together (one entry per score rank of an event payoff). When snaps
   * carry bonus, this lets the snap assignment prove that no completion has both enough bonus and enough score. */
  jointTargets?(limit: number): readonly { bonus: number; product: number }[];
  /** Snap ordering hint: higher first within a slot (e.g. recovery when life drains). */
  preferSnap?(member: number, snap: number): number;
  /** Optional tighter upper bound for a complete team, checked before `interval`. */
  leafBound?(team: Team, totals: Totals): number;
  /** Interval containing the exact key of a complete team with exact power. */
  interval(team: Team, totals: Totals): [number, number];
  exact(team: Team, power: number, slotPowers: readonly number[]): { key: number; detail: Detail };
}
export interface Constraints {
  requiredMembers: readonly number[];
  excludedMembers: readonly number[];
  requiredSnaps: readonly number[];
  excludedSnaps: readonly number[];
  leader: number | null;
  /** member index → snap index (-1 keeps the slot empty). */
  bindings: ReadonlyMap<number, number>;
  noSnaps: boolean;
  /** Minimum event bonus (BP). */
  minBonus: number | null;
  /** Maximum bonus sum (objectives that use the bonus as a non-negative per-member level). */
  maxBonus?: number | null;
}
export const NO_CONSTRAINTS: Constraints = {
  requiredMembers: [],
  excludedMembers: [],
  requiredSnaps: [],
  excludedSnaps: [],
  leader: null,
  bindings: new Map(),
  noSnaps: false,
  minBonus: null,
};
export interface SearchInput<Detail> {
  master: EngineMaster;
  player: PlayerState;
  members: readonly MemberState[];
  snaps: readonly SnapState[];
  music: MusicView | null;
  /** Event parameter effects that raise power (challenge lives only). */
  powerEffects?: readonly import("./master").EventEffectRow[];
  memberPowerPercent?: (member: MemberState) => number;
  snapPowerPercent?: (snap: SnapState) => number;
  objective: ObjectiveAdapter<Detail>;
  constraints?: Constraints;
  k: number;
  /** Stop exploring after this many ms; results stay exact but the ranking is unproven. */
  timeLimitMs?: number;
  /** Teams evaluated first so the threshold starts high (e.g. the best teams of an easier objective). */
  seeds?: readonly Team[];
  /** Parallel search: this worker takes every `count`-th leader from `index`. Each team has one leader, so the
   * union of the shards' top-k lists (deduplicated by member set) is the exact top k. */
  shard?: { index: number; count: number };
  /** Aspiration: teams below this key are pruned. The result is exact when it still holds k teams at or above the
   * floor; otherwise the caller searches again with a lower floor. */
  floor?: number;
  progress?: (done: number, total: number) => void;
}
export interface SearchHit<Detail> {
  team: Team;
  power: number;
  slotPowers: number[];
  totals: Totals;
  key: number;
  detail: Detail;
}
export interface SearchOutput<Detail> {
  hits: SearchHit<Detail>[];
  proven: boolean;
  /** Upper bound of any unexplored team when not proven. */
  bound: number | null;
  stats: { leaders: number; memberNodes: number; snapNodes: number; candidates: number; exact: number; elapsedMs: number };
}

interface Candidate {
  setKey: string;
  team: Team;
  power: number;
  slotPowers: number[];
  totals: Totals;
  low: number;
  high: number;
}

/** Maximum-weight assignment of rows to distinct columns (rows ≤ columns), Hungarian algorithm. `rowColumn`, when
 * given, receives each row's column. */
/** Scratch of maxAssignment, grown on demand: the search calls it at hundreds of thousands of nodes. */
let scratchSize = 0;
let scratchU = new Float64Array(0),
  scratchV = new Float64Array(0),
  scratchP = new Int32Array(0),
  scratchWay = new Int32Array(0),
  scratchMinv = new Float64Array(0),
  scratchUsed = new Uint8Array(0);
/** Top candidates of the small assignment: per row, its `rows` best columns (another row can block at most rows−1 of
 * them, so an optimal assignment never needs a column outside its row's list). */
const smallColumns = new Int32Array(16);
const smallValues = new Float64Array(16);
const smallUsed = new Uint8Array(4096);
function smallAssignment(weights: readonly Float64Array[], columns: number): number {
  const n = weights.length;
  for (let r = 0; r < n; r++) {
    const row = weights[r]!;
    const base = r * 4;
    for (let k = 0; k < n; k++) {
      smallColumns[base + k] = -1;
      smallValues[base + k] = -Infinity;
    }
    for (let c = 0; c < columns; c++) {
      const value = row[c]!;
      if (value <= smallValues[base + n - 1]!) continue;
      let k = n - 1;
      while (k > 0 && smallValues[base + k - 1]! < value) {
        smallValues[base + k] = smallValues[base + k - 1]!;
        smallColumns[base + k] = smallColumns[base + k - 1]!;
        k--;
      }
      smallValues[base + k] = value;
      smallColumns[base + k] = c;
    }
  }
  let best = -Infinity;
  const search = (r: number, total: number) => {
    if (r === n) {
      if (total > best) best = total;
      return;
    }
    const base = r * 4;
    for (let k = 0; k < n; k++) {
      const c = smallColumns[base + k]!;
      if (c < 0 || smallUsed[c]) continue;
      smallUsed[c] = 1;
      search(r + 1, total + smallValues[base + k]!);
      smallUsed[c] = 0;
    }
  };
  search(0, 0);
  return best;
}

export function maxAssignment(weights: readonly Float64Array[], columns: number, rowColumn?: Int32Array): number {
  const n = weights.length;
  if (!rowColumn && n <= 4 && columns <= smallUsed.length) return smallAssignment(weights, columns);
  const INF = Number.MAX_VALUE / 4;
  const size = Math.max(n, columns) + 1;
  if (size > scratchSize) {
    scratchSize = size * 2;
    scratchU = new Float64Array(scratchSize);
    scratchV = new Float64Array(scratchSize);
    scratchP = new Int32Array(scratchSize);
    scratchWay = new Int32Array(scratchSize);
    scratchMinv = new Float64Array(scratchSize);
    scratchUsed = new Uint8Array(scratchSize);
  }
  const u = scratchU,
    v = scratchV,
    p = scratchP,
    way = scratchWay,
    minv = scratchMinv,
    used = scratchUsed;
  u.fill(0, 0, n + 1);
  v.fill(0, 0, columns + 1);
  p.fill(0, 0, columns + 1);
  way.fill(0, 0, columns + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(INF, 0, columns + 1);
    used.fill(0, 0, columns + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0]!;
      let delta = INF,
        j1 = 0;
      const row = weights[i0 - 1]!;
      for (let j = 1; j <= columns; j++)
        if (!used[j]) {
          const cur = -row[j - 1]! - u[i0]! - v[j]!;
          if (cur < minv[j]!) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j]! < delta) {
            delta = minv[j]!;
            j1 = j;
          }
        }
      for (let j = 0; j <= columns; j++)
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else minv[j]! -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }
  let total = 0;
  for (let j = 1; j <= columns; j++)
    if (p[j]) {
      total += weights[p[j]! - 1]![j - 1]!;
      if (rowColumn) rowColumn[p[j]! - 1] = j - 1;
    }
  return total;
}

/** Keeps the K best distinct member sets by a lower key. */
class Frontier {
  private readonly best = new Map<string, number>();
  private sorted: number[] = [];
  constructor(private readonly k: number) {}
  offer(setKey: string, value: number) {
    const previous = this.best.get(setKey);
    if (previous !== undefined && previous >= value) return;
    this.best.set(setKey, value);
    if (previous !== undefined) this.sorted.splice(this.sorted.indexOf(previous), 1);
    let index = this.sorted.length;
    while (index > 0 && this.sorted[index - 1]! < value) index--;
    this.sorted.splice(index, 0, value);
    if (this.sorted.length > this.k * 4) this.sorted.length = this.k * 4;
  }
  get threshold() {
    return this.sorted.length >= this.k ? this.sorted[this.k - 1]! : -Infinity;
  }
}

export function searchTeams<Detail>(input: SearchInput<Detail>): SearchOutput<Detail> {
  const started = performance.now();
  const { master, player, members, snaps, music, objective } = input;
  const constraints = input.constraints ?? NO_CONSTRAINTS;
  const k = Math.max(1, input.k);
  const n = members.length,
    s = snaps.length;
  const stats = { leaders: 0, memberNodes: 0, snapNodes: 0, candidates: 0, exact: 0, elapsedMs: 0 };
  const excludedMember = new Set(constraints.excludedMembers);
  const excludedSnap = new Set(constraints.excludedSnaps);
  const bases: SlotBase[] = members.map((member) =>
    slotBase(master, player, member, music, input.memberPowerPercent?.(member) ?? 0),
  );
  const snapEvent = snaps.map((snap) => input.snapPowerPercent?.(snap) ?? 0);
  // Snap power per (member, snap); column s is the empty slot.
  const width = s + 1;
  const width0 = width;
  const snapPower = new Float64Array(n * width);
  const skill = new Float64Array(n * width);
  const skillLow = new Float64Array(n * width);
  const allowedSnaps: number[] = [];
  for (let j = 0; j < s; j++) if (!excludedSnap.has(j) && !constraints.noSnaps) allowedSnaps.push(j);
  for (let i = 0; i < n; i++) {
    for (const j of allowedSnaps) {
      snapPower[i * width + j] = snapPoints(master, bases[i]!, members[i]!, snaps[j]!, snapEvent[j]!);
      [skillLow[i * width + j], skill[i * width + j]] = objective.skill(i, j);
    }
    snapPower[i * width + s] = 0;
    [skillLow[i * width + s], skill[i * width + s]] = objective.skill(i, -1);
  }
  const memberBonus = members.map((_, i) => objective.memberBonus(i));
  const snapBonus = snaps.map((_, j) => objective.snapBonus(j));
  const anySnapBonus = snapBonus.some((value) => value !== 0);
  /** The five largest bonuses of distinct usable snaps: no team's snaps can bring more. */
  /** Usable snaps with a bonus, largest first. */
  const bonusOrder = allowedSnaps.filter((j) => snapBonus[j]! > 0).sort((a, b) => snapBonus[b]! - snapBonus[a]!);
  const snapBonusTop5 = allowedSnaps
    .map((j) => snapBonus[j]!)
    .filter((value) => value > 0)
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((sum, value) => sum + value, 0);
  // Per member: the best snap contribution ignoring snap distinctness.
  const bestSnap = (i: number) => {
    const bound = constraints.bindings.get(i);
    const options = bound !== undefined ? [bound] : [...allowedSnaps, -1];
    let power = 0,
      weight = 0,
      bonus = 0;
    for (const j of options) {
      const column = j < 0 ? s : j;
      power = Math.max(power, snapPower[i * width + column]!);
      weight = Math.max(weight, skill[i * width + column]!);
      bonus = Math.max(bonus, j < 0 ? 0 : snapBonus[j]!);
    }
    return { power, weight, bonus };
  };
  const required = new Set(constraints.requiredMembers);
  const boundMembers = [...constraints.bindings.keys()];
  for (const member of boundMembers) required.add(member);
  const requiredSnaps = new Set(constraints.requiredSnaps);
  for (const snap of constraints.bindings.values()) if (snap >= 0) requiredSnaps.delete(snap);
  const best = members.map((_, i) => bestSnap(i));
  // A slot never needs a snap that five other usable snaps dominate for its member: one of them
  // is always free, and swapping it in raises no objective input less. Ties keep the lower index.
  const boundElsewhere = new Set([...constraints.bindings.values()].filter((j) => j >= 0));
  const snapOptions = members.map((_, i) => {
    const bound = constraints.bindings.get(i);
    if (bound !== undefined) return [bound];
    const list = [...allowedSnaps.filter((j) => !boundElsewhere.has(j)), -1];
    const value = (j: number) => {
      const column = j < 0 ? s : j;
      return [snapPower[i * width + column]!, skill[i * width + column]!, skillLow[i * width + column]!, j < 0 ? 0 : snapBonus[j]!];
    };
    const values = list.map(value);
    const kept = list.filter((j, a) => {
      if (j < 0 || requiredSnaps.has(j)) return true;
      let dominated = 0;
      for (let b = 0; b < list.length && dominated < 5; b++) {
        if (b === a || list[b]! < 0) continue;
        const x = values[a]!,
          y = values[b]!;
        if (y[0]! >= x[0]! && y[1]! >= x[1]! && y[2]! >= x[2]! && y[3]! >= x[3]!) {
          const equal = y[0] === x[0] && y[1] === x[1] && y[2] === x[2] && y[3] === x[3];
          if (!equal || b < a) dominated++;
        }
      }
      return dominated < 5;
    });
    const prefer = objective.preferSnap;
    return kept.sort(
      (a, b) =>
        (prefer ? prefer(i, b) - prefer(i, a) : 0) || snapPower[i * width + (b < 0 ? s : b)]! - snapPower[i * width + (a < 0 ? s : a)]!,
    );
  });
  const profiles = new Map<number, LeaderProfile>();
  const profile = (leader: number) => {
    let value = profiles.get(leader);
    if (!value) profiles.set(leader, (value = leaderProfile(master, members[leader]!)));
    return value;
  };

  const frontier = new Frontier(k);
  const candidates: Candidate[] = [];
  /** Compact when the pool doubles past what survived the last compaction, keeping the work amortized linear. */
  let compactAt = 4096;
  const leaders = [...Array(n).keys()].filter(
    (i) => !excludedMember.has(i) && (constraints.leader === null || constraints.leader === i),
  );
  // Leader order: strongest optimistic slot first, so the threshold rises early.
  const memberScore = (i: number) => bases[i]!.fixedPoints + best[i]!.power;
  leaders.sort((a, b) => memberScore(b) - memberScore(a));
  // Interleaved over the strength order, so every shard holds a balanced mix of strong and weak leaders.
  if (input.shard && input.shard.count > 1) {
    const { index, count } = input.shard;
    const mine = leaders.filter((_, position) => position % count === index);
    leaders.length = 0;
    leaders.push(...mine);
  }
  const floor = input.floor ?? -Infinity;
  let timedOut = false;
  let unexploredBound = -Infinity;
  const deadline = input.timeLimitMs ? started + input.timeLimitMs : Infinity;

  const seedValid = (seed: Team) => {
    const team = seed.members;
    if (team.length !== 5 || new Set(team).size !== 5) return false;
    if (team.some((i) => excludedMember.has(i))) return false;
    if (constraints.leader !== null && team[0] !== constraints.leader) return false;
    if (new Set(team.map((i) => members[i]!.card.characterId)).size !== 5) return false;
    for (const i of required) if (!team.includes(i)) return false;
    const used = seed.snaps.filter((j) => j >= 0);
    if (new Set(used).size !== used.length) return false;
    if (constraints.noSnaps && used.length) return false;
    for (const j of used) if (excludedSnap.has(j)) return false;
    for (const j of requiredSnaps) if (!used.includes(j)) return false;
    for (let slot = 0; slot < 5; slot++) {
      const bound = constraints.bindings.get(team[slot]!);
      if (bound !== undefined && seed.snaps[slot] !== bound) return false;
      if (bound === undefined && seed.snaps[slot]! >= 0 && boundElsewhere.has(seed.snaps[slot]!)) return false;
    }
    return true;
  };
  const seedKeys: { seed: Team; key: number }[] = [];
  const seen = new Set<string>();
  const evaluateSeed = (seed: Team) => {
    const id = seed.members.join(",") + "|" + seed.snaps.join(",");
    if (seen.has(id)) return;
    seen.add(id);
    const team = seed.members;
    const setKey = team.map((i) => members[i]!.key).sort().join("|");
    const lead = profile(team[0]!);
    const percents = leaderPercents(master, lead, team.map((i) => members[i]!), 0, music);
    const slotPowers = team.map((i, slot) => {
      const snap = seed.snaps[slot]!;
      return bases[i]!.fixedPoints + leaderPoints(bases[i]!, percents[slot]!) + snapPower[i * width + (snap < 0 ? s : snap)]!;
    });
    const power = slotPowers.reduce((sum, value) => sum + value, 0);
    let weight = 0,
      weightLow = 0,
      bonus = 0;
    team.forEach((i, slot) => {
      const snap = seed.snaps[slot]!;
      weight += skill[i * width + (snap < 0 ? s : snap)]!;
      weightLow += skillLow[i * width + (snap < 0 ? s : snap)]!;
      bonus += memberBonus[i]! + (snap < 0 ? 0 : snapBonus[snap]!);
    });
    if (constraints.minBonus !== null && bonus < constraints.minBonus) return;
    if (constraints.maxBonus != null && bonus > constraints.maxBonus) return;
    const { key } = objective.exact(seed, power, slotPowers);
    stats.exact++;
    frontier.offer(setKey, key);
    seedKeys.push({ seed, key });
    candidates.push({ setKey, team: { members: [...team], snaps: [...seed.snaps] }, power, slotPowers, totals: { power, skill: weight, skillLow: weightLow, bonus }, low: key, high: key });
  };
  for (const seed of input.seeds ?? []) if (seedValid(seed)) evaluateSeed(seed);
  for (const [leaderIndex, leader] of leaders.entries()) {
    input.progress?.(leaderIndex, leaders.length);
    if (performance.now() > deadline) timedOut = true;
    stats.leaders++;
    const leaderSkill = profile(leader);
    const leaderCharacter = members[leader]!.card.characterId;
    if ([...required].some((i) => i !== leader && members[i]!.card.characterId === leaderCharacter)) continue;
    // Leader points per member: exact when the profile is simple, else an upper bound.
    const leadPoints = new Float64Array(n);
    for (let i = 0; i < n; i++)
      leadPoints[i] = leaderPoints(bases[i]!, leaderPercentBound(master, leaderSkill, members[i]!));
    const slotPower = (i: number) => bases[i]!.fixedPoints + leadPoints[i]!;
    // Characters other than the leader's, each with its eligible members.
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      if (i === leader || excludedMember.has(i)) continue;
      const character = members[i]!.card.characterId;
      if (character === leaderCharacter) continue;
      const list = groups.get(character) ?? [];
      list.push(i);
      groups.set(character, list);
    }
    const forced: number[][] = [];
    const free: number[][] = [];
    for (const list of groups.values()) {
      const must = list.filter((i) => required.has(i));
      if (must.length > 1) {
        forced.length = 0;
        free.length = 0;
        groups.clear();
        break;
      }
      const ordered = (must.length ? must : list).sort(
        (a, b) => slotPower(b) + best[b]!.power - (slotPower(a) + best[a]!.power),
      );
      (must.length ? forced : free).push(ordered);
    }
    if (!groups.size || forced.length > 4) continue;
    free.sort((a, b) => slotPower(b[0]!) + best[b[0]!]!.power - (slotPower(a[0]!) + best[a[0]!]!.power));
    const characters = [...forced, ...free];
    const forcedCount = forced.length;
    // Per character, the optimistic slot values of its best member.
    const charPower = characters.map((list) => Math.max(...list.map((i) => slotPower(i) + best[i]!.power)));
    const charSkill = characters.map((list) => Math.max(...list.map((i) => best[i]!.weight)));
    const charBonus = characters.map((list) => Math.max(...list.map((i) => memberBonus[i]! + best[i]!.bonus)));
    // charBonus may count one strong snap for every member; five distinct snaps bring at most the five largest.
    const charMemberBonus = characters.map((list) => Math.max(...list.map((i) => memberBonus[i]!)));
    const memberOnlyBound = (memberPart: number, index: number, left: number) => memberPart + topSum(charMemberBonus, index, left) + snapBonusTop5;
    const leaderTotals = {
      power: slotPower(leader) + best[leader]!.power,
      skill: best[leader]!.weight,
      bonus: memberBonus[leader]! + best[leader]!.bonus,
    };
    // Suffix top-4 sums: tops[from][c] is the sum of the c largest values from index `from` on.
    const suffixTops = (values: number[]) => {
      const tops: Float64Array[] = new Array(values.length + 1);
      tops[values.length] = new Float64Array(5);
      let best = [-Infinity, -Infinity, -Infinity, -Infinity];
      for (let index = values.length - 1; index >= 0; index--) {
        const v = values[index]!;
        best = [...best, v].sort((a, b) => b - a).slice(0, 4);
        const row = new Float64Array(5);
        for (let c = 1; c <= 4; c++) row[c] = row[c - 1]! + (best[c - 1]! === -Infinity ? 0 : best[c - 1]!);
        tops[index] = row;
      }
      return tops;
    };
    const tops = new Map<number[], Float64Array[]>();
    const topSum = (values: number[], from: number, count: number) => {
      if (count <= 0) return 0;
      let table = tops.get(values);
      if (!table) tops.set(values, (table = suffixTops(values)));
      return table[Math.min(from, values.length)]![Math.min(count, 4)]!;
    };
    if (characters.length < 4) continue;
    const leaderBound = objective.bound({
      power: leaderTotals.power + topSum(charPower, 0, 4),
      skill: leaderTotals.skill + topSum(charSkill, 0, 4),
      skillLow: 0,
      bonus: Math.min(leaderTotals.bonus + topSum(charBonus, 0, 4), memberOnlyBound(memberBonus[leader]!, 0, 4)),
    });
    if (leaderBound < Math.max(frontier.threshold, floor)) continue;
    if (timedOut) {
      // Unexplored: its optimistic bound limits every team it leads.
      unexploredBound = Math.max(unexploredBound, leaderBound);
      continue;
    }
    if (constraints.minBonus !== null && leaderTotals.bonus + topSum(charBonus, 0, 4) < constraints.minBonus) continue;

    const chosen: number[] = [];
    // The member part of the running bonus (it only grows): visit adds each member's best snap bonus too.
    const memberOptimisticSnapBonus = (list: readonly number[]) => best[leader]!.bonus + list.reduce((sum, i) => sum + best[i]!.bonus, 0);
    const visit = (index: number, power: number, weight: number, bonus: number, memberPart = memberBonus[leader]!) => {
      if (timedOut) {
        const left = 4 - chosen.length;
        unexploredBound = Math.max(unexploredBound, objective.bound({ power: power + topSum(charPower, index, left), skill: weight + topSum(charSkill, index, left), skillLow: 0, bonus: bonus + topSum(charBonus, index, left) }));
        return;
      }
      stats.memberNodes++;
      const left = 4 - chosen.length;
      if (left === 0) {
        assignSnaps(leader, [...chosen]);
        return;
      }
      if (characters.length - index < left) return;
      if (index < forcedCount) {
        // Required characters are always taken.
        for (const i of characters[index]!) {
          chosen.push(i);
          visit(index + 1, power + slotPower(i) + best[i]!.power, weight + best[i]!.weight, bonus + memberBonus[i]! + best[i]!.bonus, memberPart + memberBonus[i]!);
          chosen.pop();
        }
        return;
      }
      const bound = objective.bound({
        power: power + topSum(charPower, index, left),
        skill: weight + topSum(charSkill, index, left),
        skillLow: 0,
        bonus: Math.min(bonus + topSum(charBonus, index, left), memberOnlyBound(memberPart, index, left)),
      });
      if (bound < Math.max(frontier.threshold, floor)) return;
      if (constraints.minBonus !== null && bonus + topSum(charBonus, index, left) < constraints.minBonus) return;
      if (constraints.maxBonus != null && bonus - memberOptimisticSnapBonus(chosen) > constraints.maxBonus) return;
      if (performance.now() > deadline) {
        timedOut = true;
        unexploredBound = Math.max(unexploredBound, bound);
        return;
      }
      for (const i of characters[index]!) {
        chosen.push(i);
        visit(index + 1, power + slotPower(i) + best[i]!.power, weight + best[i]!.weight, bonus + memberBonus[i]! + best[i]!.bonus, memberPart + memberBonus[i]!);
        chosen.pop();
      }
      visit(index + 1, power, weight, bonus, memberPart);
    };
    visit(0, leaderTotals.power, leaderTotals.skill, leaderTotals.bonus);
  }

  /** Snap assignment for one member set; records every assignment that can still rank. */
  function assignSnaps(leader: number, others: number[]) {
    const team = [leader, ...others];
    const setKey = team
      .map((i) => members[i]!.key)
      .sort()
      .join("|");
    const lead = profile(leader);
    let exactLead: number[] | null = null;
    if (!lead.simple) {
      const percents = leaderPercents(master, lead, team.map((i) => members[i]!), 0, music);
      exactLead = team.map((i, slot) => leaderPoints(bases[i]!, percents[slot]!));
    }
    const basePower = team.map((i, slot) => bases[i]!.fixedPoints + (exactLead ? exactLead[slot]! : leaderPoints(bases[i]!, leaderPercentBound(master, lead, members[i]!))));
    const options = team.map((i) => snapOptions[i]!);
    const used = new Uint8Array(s);
    for (const [member, snap] of constraints.bindings) if (snap >= 0 && !team.includes(member)) used[snap] = 1;
    const assignment = new Array<number>(5).fill(-1);
    const maxPower = team.map((i) => best[i]!.power);
    const maxWeight = team.map((i) => best[i]!.weight);
    const maxBonus = team.map((i) => best[i]!.bonus);
    const suffix = (values: number[], from: number) => values.slice(from).reduce((sum, value) => sum + value, 0);
    const memberTotalBonus = team.reduce((sum, i) => sum + memberBonus[i]!, 0);
    const requiredLeft = () => (requiredSnaps.size ? [...requiredSnaps].filter((j) => !used[j]).length : 0);
    // Only assignments that can beat this set's own best lower key matter for distinct-set results.
    let setLow = -Infinity;
    const limit = () => Math.max(frontier.threshold, setLow, floor);
    // Distinct snaps: matchings of the remaining slots to unused snaps bound the optimistic totals. For a product
    // key P·(W + S), any λ > 0 gives P·(W+S) ≤ (λP₀ + (W+S₀)/λ + max Σ(λp + s/λ))²/4.
    const NONE = -1e15;
    /** Remaining slots × (unused snaps + one empty column per slot): power, skill and bonus matrices. */
    // Assignment matrices are rebuilt at every node of the snap walk: per-depth pools keep that allocation-free (a depth's
    // buffers are reused only after its subtree is done).
    const maxColumns = s + 5;
    interface Tables {
      count: number;
      columns: number;
      columnSnap: Int32Array;
      power: Float64Array[];
      weight: Float64Array[];
      bonus: Float64Array[];
      blended: Float64Array[];
      joint: Float64Array[];
    }
    const pools: Tables[] = Array.from({ length: 5 }, (_, from) => {
      const rows = () => Array.from({ length: 5 - from }, () => new Float64Array(maxColumns));
      return { count: 0, columns: 0, columnSnap: new Int32Array(maxColumns), power: rows(), weight: rows(), bonus: rows(), blended: rows(), joint: rows() };
    });
    const columnOf = new Int32Array(s);
    const columnStamp = new Int32Array(s);
    let stamp = 0;
    const tables = (from: number): Tables => {
      const t = pools[from]!;
      stamp++;
      let count = 0;
      for (let slot = from; slot < 5; slot++)
        for (const j of options[slot]!)
          if (j >= 0 && !used[j] && columnStamp[j] !== stamp) {
            columnStamp[j] = stamp;
            columnOf[j] = count;
            t.columnSnap[count++] = j;
          }
      const rows = 5 - from;
      const columns = count + rows;
      t.count = count;
      t.columns = columns;
      for (let r = 0; r < rows; r++) {
        const slot = from + r;
        const i = team[slot]!;
        const p = t.power[r]!,
          w = t.weight[r]!,
          b = t.bonus[r]!;
        p.fill(NONE, 0, columns);
        w.fill(NONE, 0, columns);
        b.fill(NONE, 0, columns);
        for (const j of options[slot]!) {
          if (j >= 0 && used[j]) continue;
          const column = j < 0 ? s : j;
          const vp = snapPower[i * width0 + column]!,
            vw = skill[i * width0 + column]!,
            vb = j < 0 ? 0 : snapBonus[j]!;
          if (j < 0)
            for (let empty = count; empty < columns; empty++) {
              p[empty] = vp;
              w[empty] = vw;
              b[empty] = vb;
            }
          else {
            const at = columnOf[j]!;
            p[at] = vp;
            w[at] = vw;
            b[at] = vb;
          }
        }
      }
      return t;
    };
    const blend = (t: Tables, l: number) => {
      const rows = t.power.length;
      for (let r = 0; r < rows; r++) {
        const out = t.blended[r]!,
          row = t.power[r]!,
          w = t.weight[r]!;
        for (let c = 0; c < t.columns; c++) out[c] = row[c]! <= NONE / 2 ? NONE : l * row[c]! + w[c]! / l;
      }
      return t.blended;
    };
    /** Whether some completion meets bonus ≥ need and power × (base + skill) ≥ product together: a Lagrangian
     * relaxation over the tangent-linearized product (any feasible completion keeps l·P + S/l + μ·B above
     * K + μ·need, so a maximum below it proves infeasibility). */
    const jointFeasible = (t: Tables, x: number, y: number, bonus: number, P: number, S: number, B: number, need: number, product: number) => {
      if (bonus + B < need) return false;
      if ((x + P) * (y + S) < product) return false;
      if (bonus >= need) return true;
      const lambda0 = Math.sqrt((y + S) / Math.max(1e-9, x + P));
      for (const scale of [1]) {
      const lambda = lambda0 * scale;
      const K = 2 * Math.sqrt(product) - lambda * x - y / lambda;
      const linear = blend(t, lambda);
      let spread = 0;
      for (const row of linear) for (const value of row) if (value > NONE / 2) spread = Math.max(spread, value);
      let pruned = false;
      for (const factor of [0.25, 1, 4]) {
        const mu = (factor * spread) / Math.max(1, need - bonus);
        const rows = t.joint;
        for (let r = 0; r < linear.length; r++) {
          const out = rows[r]!,
            row = linear[r]!,
            b = t.bonus[r]!;
          for (let c = 0; c < t.columns; c++) out[c] = row[c]! <= NONE / 2 ? NONE : row[c]! + mu * b[c]!;
        }
        if (maxAssignment(rows, t.columns) < K + mu * (need - bonus)) {
          pruned = true;
          break;
        }
      }
      if (pruned) return false;
      }
      return true;
    };
    const remainingBound = (from: number, power: number, weight: number, bonus: number) => {
      const t = tables(from);
      const P = maxAssignment(t.power, t.columns);
      const S = maxAssignment(t.weight, t.columns);
      if (P <= NONE / 2 || S <= NONE / 2) return -Infinity;
      const B = anySnapBonus ? maxAssignment(t.bonus, t.columns) : 0;
      const base = objective.productBase;
      if (anySnapBonus && objective.jointTargets && base !== undefined) {
        const targets = objective.jointTargets(limit());
        if (!targets.some((target) => jointFeasible(t, power, base + weight, bonus, P, S, B, target.bonus, target.product))) return -Infinity;
      }
      if (base === undefined) return objective.bound({ power: power + P, skill: weight + S, skillLow: 0, bonus: bonus + B });
      const x = power,
        y = base + weight;
      let product = (x + P) * (y + S);
      // Separate maxima first; the λ-tangents only when that does not already prune.
      if (objective.bound({ power: product / (y + S), skill: weight + S, skillLow: 0, bonus: bonus + B }) < limit()) return -Infinity;
      const lambda = Math.sqrt((y + S) / Math.max(1e-9, x + P));
      for (const scale of [1, 1.02, 1 / 1.02]) {
        const l = lambda * scale;
        const M = maxAssignment(blend(t, l), t.columns);
        product = Math.min(product, (l * x + y / l + M) ** 2 / 4);
      }
      return objective.bound({ power: product / (y + S), skill: weight + S, skillLow: 0, bonus: bonus + B });
    };
    const baseTotal = basePower.reduce((sum, value) => sum + value, 0);
    // Cheap first: every member's own best snap, distinctness ignored.
    if (objective.bound({ power: baseTotal + suffix(maxPower, 0), skill: suffix(maxWeight, 0), skillLow: 0, bonus: memberTotalBonus + suffix(maxBonus, 0) }) < limit()) return;
    // Bonus constraints: the set's members fix their part; the snaps can add at most a matching's worth.
    if (constraints.maxBonus != null && memberTotalBonus > constraints.maxBonus) return;
    if (constraints.minBonus !== null && memberTotalBonus + (anySnapBonus ? maxAssignment(tables(0).bonus, tables(0).columns) : 0) < constraints.minBonus) return;
    if (remainingBound(0, baseTotal, 0, memberTotalBonus) < limit()) return;
    // Incumbent: the assignment maximizing the linearized key (λ·power + skill/λ) is feasible and usually optimal or
    // close, so the walk below starts with a high bar for this set.
    if (objective.productBase !== undefined && !requiredSnaps.size) {
      const picks = new Array<number>(5).fill(-1);
      const t = tables(0);
      const P = maxAssignment(t.power, t.columns);
      const S = maxAssignment(t.weight, t.columns);
      const x = baseTotal;
      const l = Math.sqrt((objective.productBase + S) / Math.max(1e-9, x + P));
      const rowColumn = new Int32Array(5);
      if (maxAssignment(blend(t, l), t.columns, rowColumn) > NONE / 2) {
        const snapOf = Array.from(t.columnSnap.subarray(0, t.count));
        rowColumn.forEach((column, row) => (picks[row] = column < snapOf.length ? snapOf[column]! : -1));
        let power = x,
          weight = 0,
          weightLow = 0,
          bonus = memberTotalBonus;
        team.forEach((i, slot) => {
          const j = picks[slot]!;
          const column = j < 0 ? s : j;
          power += snapPower[i * width0 + column]!;
          weight += skill[i * width0 + column]!;
          weightLow += skillLow[i * width0 + column]!;
          bonus += j < 0 ? 0 : snapBonus[j]!;
        });
        const totals = { power, skill: weight, skillLow: weightLow, bonus };
        const fits = (constraints.minBonus === null || bonus >= constraints.minBonus) && (constraints.maxBonus == null || bonus <= constraints.maxBonus);
        if (fits) {
          const [low, high] = objective.interval({ members: team, snaps: picks }, totals);
          if (high >= limit()) {
            frontier.offer(setKey, low);
            setLow = Math.max(setLow, low);
            stats.candidates++;
            candidates.push({
              setKey,
              team: { members: [...team], snaps: [...picks] },
              power,
              slotPowers: team.map((i, index) => basePower[index]! + snapPower[i * width0 + (picks[index]! < 0 ? s : picks[index]!)]!),
              totals,
              low,
              high,
            });
          }
        }
      }
    }
    /** The `count` largest bonuses of snaps still unused: distinct snaps, unlike the per-slot maxima. */
    const unusedBonusTop = (count: number) => {
      let total = 0;
      for (let k = 0; k < bonusOrder.length && count > 0; k++) {
        const j = bonusOrder[k]!;
        if (used[j]) continue;
        total += snapBonus[j]!;
        count--;
      }
      return total;
    };
    const walk = (slot: number, power: number, weight: number, weightLow: number, bonus: number) => {
      if (!timedOut && (++stats.snapNodes & 1023) === 0 && performance.now() > deadline) timedOut = true;
      if (timedOut) {
        unexploredBound = Math.max(
          unexploredBound,
          objective.bound({ power: power + suffix(maxPower, slot), skill: weight + suffix(maxWeight, slot), skillLow: 0, bonus: bonus + suffix(maxBonus, slot) }),
        );
        return;
      }
      if (slot === 5) {
        if (requiredLeft()) return;
        const totals = { power, skill: weight, skillLow: weightLow, bonus };
        if (constraints.minBonus !== null && bonus < constraints.minBonus) return;
        if (constraints.maxBonus != null && bonus > constraints.maxBonus) return;
        if (objective.bound(totals) < limit()) return;
        if (objective.leafBound && objective.leafBound({ members: team, snaps: assignment }, totals) < limit()) return;
        const [low, high] = objective.interval({ members: team, snaps: assignment }, totals);
        if (high < limit()) return;
        frontier.offer(setKey, low);
        setLow = Math.max(setLow, low);
        stats.candidates++;
        if (candidates.length > compactAt) compact();
        candidates.push({
          setKey,
          team: { members: [...team], snaps: [...assignment] },
          power,
          slotPowers: team.map((i, index) => basePower[index]! + snapPower[i * width + (assignment[index]! < 0 ? s : assignment[index]!)]!),
          totals,
          low,
          high,
        });
        return;
      }
      const optimistic = objective.bound({
        power: power + suffix(maxPower, slot),
        skill: weight + suffix(maxWeight, slot),
        skillLow: 0,
        bonus: bonus + Math.min(suffix(maxBonus, slot), unusedBonusTop(5 - slot)),
      });
      if (optimistic < limit()) return;
      if (slot > 0 && slot < 4 && remainingBound(slot, power, weight, bonus) < limit()) return;
      // One slot left: each option's own bound (its power, skill and bonus together), and only options that can still
      // reach the limit are walked.
      let lastOptions: readonly number[] | null = null;
      if (slot === 4 && objective.productBase !== undefined) {
        const i = team[4]!;
        const bar = limit();
        const keep: number[] = [];
        for (const j of options[4]!) {
          if (j >= 0 && used[j]) continue;
          const column = j < 0 ? s : j;
          const value = objective.bound({
            power: power + snapPower[i * width + column]!,
            skill: weight + skill[i * width + column]!,
            skillLow: 0,
            bonus: bonus + (j < 0 ? 0 : snapBonus[j]!),
          });
          if (value >= bar) keep.push(j);
        }
        if (!keep.length) return;
        lastOptions = keep;
      }
      if (5 - slot < requiredLeft()) return;
      const i = team[slot]!;
      for (const j of lastOptions ?? options[slot]!) {
        if (j >= 0 && used[j]) continue;
        const column = j < 0 ? s : j;
        if (j >= 0) used[j] = 1;
        assignment[slot] = j;
        walk(
          slot + 1,
          power + snapPower[i * width + column]!,
          weight + skill[i * width + column]!,
          weightLow + skillLow[i * width + column]!,
          bonus + (j < 0 ? 0 : snapBonus[j]!),
        );
        if (j >= 0) used[j] = 0;
      }
      assignment[slot] = -1;
    };
    walk(0, basePower.reduce((sum, value) => sum + value, 0), 0, 0, memberTotalBonus);
  }

  function compact() {
    const threshold = Math.max(frontier.threshold, floor);
    const bestLow = new Map<string, number>();
    for (const candidate of candidates) bestLow.set(candidate.setKey, Math.max(bestLow.get(candidate.setKey) ?? -Infinity, candidate.low));
    let write = 0;
    for (const candidate of candidates)
      if (candidate.high >= threshold && candidate.high >= bestLow.get(candidate.setKey)!) candidates[write++] = candidate;
    candidates.length = write;
    compactAt = Math.max(4096, candidates.length * 2);
  }
  // Exact phase: highest optimistic first, until nothing left can enter the Top-K.
  const threshold = Math.max(frontier.threshold, floor);
  const pool = candidates.filter((candidate) => candidate.high >= threshold).sort((a, b) => b.high - a.high);
  const hits: SearchHit<Detail>[] = [];
  const exactBySet = new Map<string, number>();
  const kth = () => {
    if (hits.length < k) return -Infinity;
    return hits[k - 1]!.key;
  };
  for (const candidate of pool) {
    if (candidate.high < kth()) break;
    if (performance.now() > deadline && hits.length >= k) {
      // Out of time: what is left could still rank.
      timedOut = true;
      unexploredBound = Math.max(unexploredBound, candidate.high);
      break;
    }
    const known = exactBySet.get(candidate.setKey);
    if (known !== undefined && known >= candidate.high) continue;
    stats.exact++;
    const { key, detail } = objective.exact(candidate.team, candidate.power, candidate.slotPowers);
    if (known !== undefined && known >= key) continue;
    exactBySet.set(candidate.setKey, key);
    const existing = hits.findIndex((hit) => setKeyOf(hit.team) === candidate.setKey);
    if (existing >= 0) hits.splice(existing, 1);
    const hit: SearchHit<Detail> = { team: candidate.team, power: candidate.power, slotPowers: candidate.slotPowers, totals: candidate.totals, key, detail };
    let index = hits.length;
    while (index > 0 && hits[index - 1]!.key < key) index--;
    hits.splice(index, 0, hit);
  }
  function setKeyOf(team: Team) {
    return team.members
      .map((i) => members[i]!.key)
      .sort()
      .join("|");
  }
  stats.elapsedMs = performance.now() - started;
  return { hits: hits.slice(0, k), proven: !timedOut, bound: timedOut ? unexploredBound : null, stats };
}
