import assert from "node:assert/strict";
import { fixture } from "./pt-recommendation.test";
import { ChartCache, eventRoute } from "../../src/lib/team-builder/engine/api";
import { resolveBox } from "../../src/lib/team-builder/engine/box";
import { AP, scoreOrdersAP, type OrderScores } from "../../src/lib/team-builder/engine/live";
import { LiveScoreCache, liveScoreCache } from "../../src/lib/team-builder/engine/live-score-cache";
import { eventObjective, liveScoreObjective } from "../../src/lib/team-builder/engine/objectives";
import { resolveSlotSkill } from "../../src/lib/team-builder/engine/skills";

export async function verify() {
  const cases: string[] = [];
  const { master, request, charts } = fixture();
  const cache = new ChartCache(master, async (_, ref) => charts(ref));
  const chart = await cache.chart({ songId: 1, difficulty: 0 });
  const live = cache.live(chart);
  const box = resolveBox(master, request.members, request.snaps, "min");
  const team = { members: [0, 1, 2, 3, 4], snaps: [-1, -1, -1, -1, -1] };
  const skills = team.members.map((i) => resolveSlotSkill(master, box.members[i]!, null));
  const direct = scoreOrdersAP(live, 20000, skills);
  const own = new LiveScoreCache(10_000);
  let calls = 0;
  const compute = (): OrderScores => {
    calls++;
    return direct;
  };
  assert.deepEqual(own.score(live, AP, undefined, 20000, skills, compute), direct);
  own.score(live, structuredClone(AP), undefined, 20000, structuredClone(skills), compute);
  assert.equal(calls, 1);
  own.score(live, AP, undefined, 20001, skills, compute);
  own.score(live, { ...AP, great: 1 }, undefined, 20000, skills, compute);
  own.score(live, AP, { assist: 0.9, luckPercent: 100 }, 20000, skills, compute);
  own.score(live, AP, undefined, 20000, [...skills].reverse(), compute);
  const changed = structuredClone(skills);
  changed[0]!.extensionMs += 100;
  own.score(live, AP, undefined, 20000, changed, compute);
  const otherChart = cache.live(await cache.chart({ songId: 2, difficulty: 0 }));
  own.score(otherChart, AP, undefined, 20000, skills, compute);
  assert.equal(calls, 7);
  cases.push(
    "exact live scores reuse equal inputs; power, play, settings, ordered skills, skill extension and chart identity isolate keys",
  );

  const small = new LiveScoreCache(2500);
  for (let power = 1; power < 100; power++) small.score(live, AP, undefined, power, skills, compute);
  assert(small.bytes <= small.maxBytes);
  assert(small.size < 99);
  const before = calls;
  small.score(live, AP, undefined, 1, skills, compute);
  assert.equal(calls, before + 1);
  cases.push("bounded cache evicts values and recomputes instead of dropping candidates");

  const context = { master, ...box, live, chart, play: AP };
  const route = eventRoute(master, 1, "live", 3);
  route.itemId = 7;
  route.rewards = [2, 3, 4].map((scoreRank) => ({
    scoreRank,
    resourceType: 1,
    resourceId: 7,
    count: scoreRank * 7,
    probability: 10000,
  }));
  const computations = liveScoreCache.computations;
  const hits = liveScoreCache.hits;
  const points = eventObjective(context, route, "points", 2, 0, Infinity, "pt-only").exact(team, 20000, []);
  const items = eventObjective(context, route, "items", 2, 0, Infinity, "pt-only", {
    numerator: 11,
    denominator: 7,
  }).exact(team, 20000, []);
  const score = liveScoreObjective(context, "mean").exact(team, 20000, []);
  assert.deepEqual(points.detail.scores, direct);
  assert.deepEqual(items.detail.scores, direct);
  assert.equal(score.key, direct.mean);
  assert.notEqual(points.key, items.key);
  assert.equal(liveScoreCache.computations - computations, 1);
  assert.equal(liveScoreCache.hits - hits, 2);
  cases.push(
    "PT, medals with a different CP price, and score goals reuse scores while settling distinct objective values",
  );
  return { passed: true, cases };
}
