// L3 — GEB
// Input: Published event settlement tables, a fixed PT bonus and current/target PT.
// Output: Exact grouped play plans or the nearest reachable totals and native score-rank intervals.
// Pos: [Map](L2-2.md); event parking arithmetic, independent of team search and chart replay.
// Effects/Dependencies: Pure; reuses native integer settlement and local event rule projection.
import type { EngineMaster } from "./engine/master";
import { plannerMaster } from "./planner-data";
import { settleEventPoints } from "./event-settlement";
import { liveBoostRow } from "./engine/boosts";

export interface ParkingPlay {
  teamKey?: string;
  teamName?: string;
  rankLabel?: string;
  rank: number;
  points: number;
  scoreMin: number;
  scoreMax: number;
  boosts: number;
  cpCost: number;
  cpGain: number;
  cpGainMax?: number;
}
export interface ParkingPlan {
  points: number;
  plays: number;
  steps: { play: ParkingPlay; count: number }[];
}
export interface ParkingResult {
  exact: ParkingPlan | null;
  below: ParkingPlan;
  above: ParkingPlan | null;
}

export function parkingPlays(master: EngineMaster, eventId: number, songId: number, challenge: boolean, consumption: number, bonusBP: number, scoreMin: number, scoreMax: number): ParkingPlay[] {
  const rules = plannerMaster(master, eventId, challenge);
  const event = rules.events.get(eventId), song = rules.songs.get(songId);
  if (!event || !song) return [];
  if (challenge && consumption <= 0) return [];
  const boost = challenge ? rules.challengeBoosts.find(row => row.consumed === consumption) : liveBoostRow(rules.boosts, consumption);
  const rate = boost?.eventPointRate;
  if (rate === undefined) return [];
  const thresholds = new Map<number, number>([[2, 0]]);
  for (const row of rules.scoreRanks.get(song.rankGroup) ?? []) {
    if (row.rank > 2) thresholds.set(row.rank, Math.min(thresholds.get(row.rank) ?? Infinity, row.required));
  }
  const ranks = [...thresholds].sort((a, b) => a[0] - b[0]);
  const points = challenge ? event.challengePoints : event.livePoints;
  return ranks.flatMap(([rank, required], index) => {
    const minimum = Math.max(scoreMin, required);
    const maximum = Math.min(scoreMax, Math.min(0x80000000, ...ranks.slice(index + 1).map(row => row[1])) - 1);
    const amount = settleEventPoints(points.get(rank) ?? 0, bonusBP, rate);
    return minimum <= maximum && amount > 0 ? [{ rank, points: amount, scoreMin: minimum, scoreMax: maximum,
      boosts: challenge ? 0 : consumption, cpCost: challenge ? consumption : 0,
      cpGain: challenge ? 0 : Math.imul(rules.liveChallengePoints.get(rank) ?? 0, rate) }] : [];
  });
}

const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
function pairCounts(target: number, coins: readonly number[]): number[] | null {
  let best: number[] | null = null, count = Infinity;
  for (let i = 0; i < coins.length; i++) {
    if (target % coins[i]! === 0 && target / coins[i]! < count) {
      best = coins.map((_, at) => at === i ? target / coins[i]! : 0); count = target / coins[i]!;
    }
    for (let j = i + 1; j < coins.length; j++) {
      const a = coins[i]!, b = coins[j]!, g = gcd(a, b);
      if (target % g) continue;
      let [oldR, r, oldS, s] = [a / g, b / g, 1, 0];
      while (r) { const q = Math.floor(oldR / r); [oldR, r, oldS, s] = [r, oldR - q * r, s, oldS - q * s]; }
      const modulus = BigInt(b / g);
      const x = Number(((BigInt(target / g) * BigInt(oldS)) % modulus + modulus) % modulus);
      const y = (target - a * x) / b;
      if (y >= 0 && x + y < count) {
        best = coins.map((_, at) => at === i ? x : at === j ? y : 0); count = x + y;
      }
    }
  }
  return best;
}

/** Exact reachability over the integer reward lattice; large totals stay compressed. */
export function parkingPlan(target: number, plays: readonly ParkingPlay[]): ParkingResult {
  const options = [...plays].sort((a, b) => a.points - b.points || a.rank - b.rank)
    .filter((play, i, rows) => !i || play.points !== rows[i - 1]!.points);
  const plan = (counts: readonly number[]): ParkingPlan => ({
    points: counts.reduce((sum, count, i) => sum + count * options[i]!.points, 0),
    plays: counts.reduce((sum, count) => sum + count, 0),
    steps: counts.flatMap((count, i) => count ? [{ play: options[i]!, count }] : []).sort((a, b) => b.play.points - a.play.points),
  });
  const empty = plan(options.map(() => 0));
  if (target === 0) return { exact: empty, below: empty, above: empty };
  if (!options.length) return { exact: null, below: empty, above: null };
  const unit = options.map(row => row.points).reduce(gcd);
  const coins = options.map(row => row.points / unit);
  const floor = Math.floor(target / unit), ceil = Math.ceil(target / unit), minimum = coins[0]!;
  if (floor < minimum) return { exact: null, below: empty, above: plan(coins.map((_, i) => i === 0 ? 1 : 0)) };
  if (ceil <= 200_000) {
    const limit = ceil + minimum;
    const counts = new Int32Array(limit + 1).fill(0x3fffffff), previous = new Int16Array(limit + 1).fill(-1);
    counts[0] = 0;
    for (let amount = minimum; amount <= limit; amount++) for (let i = 0; i < coins.length && coins[i]! <= amount; i++) {
      const value = counts[amount - coins[i]!]! + 1;
      if (value < counts[amount]!) { counts[amount] = value; previous[amount] = i; }
    }
    const build = (amount: number) => {
      const result = coins.map(() => 0);
      while (amount > 0) { const i = previous[amount]!; result[i]!++; amount -= coins[i]!; }
      return plan(result);
    };
    let below = floor, above = ceil;
    while (below && previous[below] === -1) below--;
    while (previous[above] === -1) above++;
    const exact = floor === ceil && below === floor ? build(floor) : null;
    return { exact, below: exact ?? build(below), above: exact ?? build(above) };
  }
  const lower = pairCounts(floor, coins), upper = ceil === floor ? lower : pairCounts(ceil, coins);
  if (lower && upper) {
    const below = plan(lower), above = plan(upper);
    return { exact: floor === ceil ? below : null, below, above };
  }
  type Node = { residue: number; amount: number; count: number; previous: Node | null; coin: number };
  const root: Node = { residue: 0, amount: 0, count: 0, previous: null, coin: -1 };
  const known = new Map<number, Node>([[0, root]]), heap: Node[] = [root];
  const push = (node: Node) => {
    let at = heap.length; heap.push(node);
    while (at) { const parent = (at - 1) >> 1; if (heap[parent]!.amount <= node.amount) break; heap[at] = heap[parent]!; at = parent; }
    heap[at] = node;
  };
  while (heap.length) {
    const node = heap[0]!, tail = heap.pop()!;
    if (heap.length) {
      let at = 0;
      while (at * 2 + 1 < heap.length) {
        let child = at * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1]!.amount < heap[child]!.amount) child++;
        if (heap[child]!.amount >= tail.amount) break; heap[at] = heap[child]!; at = child;
      }
      heap[at] = tail;
    }
    if (known.get(node.residue) !== node) continue;
    for (let i = 1; i < coins.length; i++) {
      const amount = node.amount + coins[i]!, residue = amount % minimum, old = known.get(residue);
      if (amount > ceil + minimum || old && (old.amount < amount || old.amount === amount && old.count <= node.count + 1)) continue;
      const next = { residue, amount, count: node.count + 1, previous: node, coin: i }; known.set(residue, next); push(next);
    }
  }
  let belowNode = root, belowAmount = 0, aboveNode = root, aboveAmount = Math.ceil(ceil / minimum) * minimum;
  for (const node of known.values()) {
    if (node.amount <= floor) {
      const amount = node.amount + Math.floor((floor - node.amount) / minimum) * minimum;
      if (amount > belowAmount) { belowAmount = amount; belowNode = node; }
    }
    const amount = node.amount + Math.max(0, Math.ceil((ceil - node.amount) / minimum)) * minimum;
    if (amount < aboveAmount) { aboveAmount = amount; aboveNode = node; }
  }
  const build = (node: Node, amount: number) => {
    const counts = coins.map(() => 0); counts[0] = (amount - node.amount) / minimum;
    while (node.previous) { counts[node.coin]!++; node = node.previous; }
    for (let i = coins.length - 1; i > 0; i--) {
      const common = gcd(minimum, coins[i]!), batch = coins[i]! / common;
      const repeats = Math.floor(counts[0]! / batch); counts[0]! -= repeats * batch; counts[i]! += repeats * minimum / common;
    }
    return plan(counts);
  };
  const below = build(belowNode, belowAmount), above = build(aboveNode, aboveAmount);
  return { exact: below.points === target ? below : null, below, above };
}
