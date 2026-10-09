import assert from "node:assert/strict";
import { fixture } from "./pt-recommendation.test";
import { performanceFixture } from "./performance-fixtures";
import { ChartCache, eventRoute, runEngine, type EngineResponse } from "../../src/lib/team-builder/engine/api";
import { mergeShardResponses, aspirationHeld } from "../../src/lib/team-builder/engine/merge";
import { settleGekisoRewards, settleGekisoRewardsProgressive } from "../../src/lib/team-builder/engine/gekiso-rewards";
import { GekisoScoreCache, type GekisoScoreDraw } from "../../src/lib/team-builder/engine/gekiso-score-cache";
import type { GekisoChart } from "../../src/lib/team-builder/engine/gekiso";
import { gekisoContext, scoreOrdersGekiso } from "../../src/lib/team-builder/engine/gekiso";
import { gekisoScoreBound } from "../../src/lib/team-builder/engine/gekiso-score-bound";
import { resolveBox } from "../../src/lib/team-builder/engine/box";
import { performer } from "../../src/lib/team-builder/engine/full/deck";
import { resolveSlotSkill } from "../../src/lib/team-builder/engine/skills";
import { teamPower } from "../../src/lib/team-builder/engine/power";
import { playerState, musicView } from "../../src/lib/team-builder/engine/api";
import { gekisoJustSummary } from "../../src/lib/team-builder/engine/gekiso-just";

export async function verify() {
  const cases: string[] = [];
  const base = fixture();
  const route = {
    ...eventRoute(base.master, 1, "live", 3),
    rate: 1,
    points: new Map([
      [2, 0],
      [3, 10],
    ]),
  };
  const ranks = {
    ranks: [
      { rank: 2, required: 0, battleRequired: 0 },
      { rank: 3, required: 1, battleRequired: 1 },
    ],
  };
  let stopped = 0;
  for (let bits = 0; bits < 16; bits++) {
    const draws = Array.from({ length: 4 }, (_, i) => [bits & (1 << i) ? 1 : 0]);
    const exact = settleGekisoRewards(ranks, route, "points", 0, draws);
    for (const key of [0, 2.5, 5, 7.5, 10, 10.01])
      for (const pruneEqual of [false, true]) {
        let consumed = 0;
        function* samples() {
          for (const draw of draws) {
            consumed++;
            yield draw;
          }
        }
        const result = settleGekisoRewardsProgressive(ranks, route, "points", 0, samples(), undefined, {
          observations: 4,
          ceiling: 10,
          cutoff: { key, pruneEqual },
        });
        if ("pruned" in result) {
          stopped++;
          assert(consumed < 4);
          assert(exact.mean <= result.upperBound);
          assert(pruneEqual ? exact.mean <= key : exact.mean < key);
          assert(!("mean" in result));
        } else {
          assert.equal(consumed, 4);
          assert.deepEqual(result, exact);
        }
      }
  }
  assert(stopped > 0);
  cases.push(
    "all 16 four-draw outcome sequences × 12 cutoffs: progressive bounds never discard a winner or emit partial means",
  );

  const cache = new GekisoScoreCache(3600);
  const chart = {} as GekisoChart;
  const draw: GekisoScoreDraw = {
    scores: { power: 100, scores: new Float64Array(120), mean: 0, min: 0, max: 0, minOrder: 0, maxOrder: 0 },
    just: { eligible: 4, baselineHits: 1, effectiveHits: 1, convertedHits: 0, baselineRate: 0.25, effectiveRate: 0.25 },
  };
  const prefix = cache.prefix(chart, [{ liveSkill: [1, 1] }], [{ effects: [] }], 100);
  cache.put(prefix, 0, draw);
  assert.equal(cache.get(prefix, 0), draw);
  for (const other of [
    cache.prefix({} as GekisoChart, [{ liveSkill: [1, 1] }], [{ effects: [] }], 100),
    cache.prefix(chart, [{ liveSkill: [1, 2] }], [{ effects: [] }], 100),
    cache.prefix(chart, [{ liveSkill: [1, 1] }], [{ effects: [1] }], 100),
    cache.prefix(chart, [{ liveSkill: [1, 1] }], [{ effects: [] }], 101),
  ])
    assert.equal(cache.get(other, 0), undefined);
  for (let seed = 1; seed <= 20; seed++) cache.put(prefix, seed, draw);
  assert(cache.bytes <= cache.maxBytes);
  assert(cache.size < 20);
  assert.equal(cache.get(prefix, 0), undefined);
  assert.equal(cache.get(prefix, 20), draw);
  cases.push(
    "score cache distinguishes chart, ordered performer, resolved skills, power and seed; eviction stays within its explicit byte budget",
  );

  const g = performanceFixture(fixture(), "gekiso-photos");
  g.request.snaps = [];
  g.request.constraints.noSnaps = true;
  if (g.request.goal.kind !== "event") throw new Error("fixture");
  g.request.goal.gekiso!.luckSamples = 4;
  const createCache = () => new ChartCache(g.master, async (_, song) => g.charts(song));
  const shared = createCache();
  const points = await runEngine(g.master, shared, g.request);
  const optimum = points.overall[0]!.key;
  const itemsRequest = structuredClone(g.request);
  if (itemsRequest.goal.kind !== "event") throw new Error("fixture");
  itemsRequest.goal.measure = "items";
  itemsRequest.goal.cpExchange = { numerator: 7, denominator: 3 };
  const items = await runEngine(g.master, shared, itemsRequest);
  const uncachedItems = await runEngine(g.master, createCache(), itemsRequest);
  assert.equal(items.overall[0]!.key, uncachedItems.overall[0]!.key);
  assert.equal(items.overall[0]!.score!.mean, uncachedItems.overall[0]!.score!.mean);
  assert((items.results[0]!.stats.sampleCacheHits ?? 0) > 0);
  assert((items.results[0]!.stats.sampleComputations ?? 0) < (uncachedItems.results[0]!.stats.sampleComputations ?? 0));
  const accuracy = structuredClone(itemsRequest);
  if (accuracy.goal.kind !== "event") throw new Error("fixture");
  accuracy.goal.gekiso!.just = 0.5;
  const changed = await runEngine(g.master, shared, accuracy);
  const changedFresh = await runEngine(g.master, createCache(), accuracy);
  assert.equal(changed.overall[0]!.key, changedFresh.overall[0]!.key);
  assert((changed.results[0]!.stats.sampleComputations ?? 0) > 0);
  cases.push(
    "activity PT and medals with different CP prices reuse exact native draws; changed JUST recompiles and matches a fresh cache",
  );

  for (const rewardCutoff of [optimum - 1, optimum, optimum + 0.01]) {
    const single = await runEngine(g.master, shared, { ...g.request, rewardCutoff });
    const responses: EngineResponse[] = [];
    for (let index = 7; index >= 0; index--)
      responses.push(
        await runEngine(g.master, shared, {
          ...g.request,
          rewardCutoff,
          floors: { "1:0": optimum },
          shard: { index, count: 8 },
        }),
      );
    const merged = mergeShardResponses(responses, 1, 0);
    if (rewardCutoff <= optimum) {
      assert.equal(single.overall[0]!.key, optimum);
      assert.equal(merged.overall[0]!.key, optimum);
      assert(single.results[0]!.proven && merged.results[0]!.proven);
      assert.equal(merged.results[0]!.excludedBelow, undefined);
    } else {
      for (const response of [single, merged]) {
        assert.equal(response.overall.length, 0);
        assert.equal(response.results[0]!.excludedBelow, rewardCutoff);
        assert.equal(response.results[0]!.proven, false);
        assert(aspirationHeld(response, 1));
      }
    }
    for (const response of responses.slice(0, 3)) assert.equal(response.results[0]!.stats.exact, 0);
  }
  cases.push(
    "single vs reversed eight leader shards: external floor, empty shards, below/equal/above song cutoffs retain ties and separate exclusion from exact optima",
  );

  const excluded = structuredClone(points);
  excluded.overall = [];
  excluded.results[0]!.hits = [];
  excluded.results[0]!.proven = false;
  excluded.results[0]!.excludedBelow = optimum;
  excluded.results[0]!.bound = optimum;
  const timedOut = structuredClone(excluded);
  delete timedOut.results[0]!.excludedBelow;
  assert(mergeShardResponses([points, excluded], 1, 0).results[0]!.proven);
  assert(!mergeShardResponses([points, timedOut], 1, 0).results[0]!.proven);
  assert.equal(mergeShardResponses([excluded, timedOut], 1, 0).results[0]!.excludedBelow, undefined);
  assert.equal(mergeShardResponses([excluded, excluded], 1, 0).results[0]!.excludedBelow, optimum);
  cases.push(
    "merge never converts unfinished shards to exclusion proof; exact winners discharge only compatible exclusion bounds",
  );

  const solo = fixture();
  const soloCache = new ChartCache(solo.master, async (_, song) => solo.charts(song));
  const normal = await runEngine(solo.master, soloCache, solo.request);
  const soloTop = normal.overall[0]!.key;
  const tie = await runEngine(solo.master, soloCache, { ...solo.request, rewardCutoff: soloTop });
  assert.equal(tie.overall[0]!.key, soloTop);
  const above = await runEngine(solo.master, soloCache, { ...solo.request, rewardCutoff: soloTop + 1 });
  assert.equal(above.overall.length, 0);
  assert(above.results.every((result) => result.excludedBelow === soloTop + 1 && !result.proven));
  cases.push(
    "solo reward cutoff retains the exact tie and returns explicit exclusion above the best, without aspiration fallback",
  );
  let boundedOrders = 0;
  for (const baseline of [0, 0.25, 1]) {
    const b = performanceFixture(fixture(), "gekiso-small");
    if (baseline > 0)
      b.master.songs = new Map([...b.master.songs].map(([id, song]) => [id, { ...song, gekisoMissions: [2, 3, 1] }]));
    const chartCache = new ChartCache(b.master, async (_, song) => b.charts(song));
    const chart = await chartCache.gekiso({ songId: 1, difficulty: 0 }, { great: 0, just: baseline }, 1);
    const box = resolveBox(b.master, b.request.members, b.request.snaps, "min");
    const bound = gekisoScoreBound(b.master, chart, box.members, box.snaps);
    assert(bound.supported);
    for (let omit = 0; omit < 6; omit++) {
      const chosen = box.members.filter((_, i) => i !== omit);
      for (let lead = 0; lead < 5; lead++) {
        const ordered = [chosen[lead]!, ...chosen.filter((_, i) => i !== lead)];
        for (let photo = -1; photo < 5; photo++) {
          const equipped = ordered.map((_, slot) => (slot === photo ? box.snaps[0]! : null));
          const power = teamPower(
            b.master,
            playerState(b.master, b.request.player),
            ordered,
            equipped,
            0,
            musicView(b.master, 1, null),
            [],
          );
          const upper = bound.score(power.total);
          for (let seed = 0; seed < (chart.luck ? 2 : 1); seed++) {
            const context = gekisoContext(
              b.master,
              chart,
              ordered.map((m, i) => performer(b.master, m, equipped[i]!)),
              [seed],
            );
            const scores = scoreOrdersGekiso(
              b.master,
              chart,
              context,
              power.total,
              ordered.map((m, i) => resolveSlotSkill(b.master, m, equipped[i]!)),
            );
            for (const score of scores.scores) {
              assert(score <= upper, `${score} > ${upper}`);
              boundedOrders++;
            }
          }
        }
      }
    }
    const first = box.members[0]!;
    const changed = { ...first, card: { ...first.card, gekisoSkillId: 901 } };
    const effect = b.master.liveSkills.get(first.card.liveSkillId)![0]!;
    for (const type of [12000, 13000, 13005, 11005]) {
      b.master.gekisoSkills = new Map([
        [901, { missionType: 3, effects: [{ ...effect, type, level: changed.growth.gekisoSkillLevel }] }],
      ]);
      assert(gekisoScoreBound(b.master, chart, [changed, ...box.members.slice(1)], box.snaps).supported);
    }
    for (const type of [2000, 2001, 2002, 15000, 99999]) {
      b.master.gekisoSkills = new Map([
        [901, { missionType: 3, effects: [{ ...effect, type, level: changed.growth.gekisoSkillLevel }] }],
      ]);
      const fallback = gekisoScoreBound(b.master, chart, [changed, ...box.members.slice(1)], box.snaps);
      assert(!fallback.supported);
      assert.equal(fallback.score(100000), Infinity);
    }
    const oldRush = b.master.live.gekiso.rushPercent;
    b.master.live.gekiso.rushPercent = -1;
    assert(!gekisoScoreBound(b.master, chart, box.members, box.snaps).supported);
    b.master.live.gekiso.rushPercent = oldRush;
    const oldCombo = b.master.live.combo;
    b.master.live.combo = new Map(oldCombo).set(1, [[0, -1]]);
    assert(!gekisoScoreBound(b.master, chart, box.members, box.snaps).supported);
    b.master.live.combo = oldCombo;
    const oldJudge = chart.judgeFrac[0]!;
    chart.judgeFrac[0] = -1;
    assert(!gekisoScoreBound(b.master, chart, box.members, box.snaps).supported);
    chart.judgeFrac[0] = oldJudge;
  }
  cases.push(
    "108000 independent per-order scores across all 30 legal member/leader choices, photo slots, JUST levels and native draws stay below the analytic Gekisou ceiling; score-changing or unknown effects fall back to Infinity",
  );
  const active = performanceFixture(fixture(), "gekiso-small");
  active.master.songs = new Map(
    [...active.master.songs].map(([id, song]) => [id, { ...song, gekisoMissions: [2, 3, 1] }]),
  );
  active.master.live.combo = new Map(active.master.live.combo).set(1, [
    [0, 0],
    [10, 0.1],
    [50, 1],
  ]);
  active.master.conditions = new Map(active.master.conditions).set(9000, {
    id: 9000,
    type: 7010,
    values: [],
    targetIds: [],
    positive: true,
  });
  active.master.conditionSets = new Map(active.master.conditionSets).set(9000, [[9000]]);
  active.master.targets = new Map(active.master.targets).set(9000, {
    id: 9000,
    judgement: 5,
    bandId: 0,
    cardType: 0,
    characterId: 0,
    tagId: 0,
    liveSkillCategories: [],
    gekisouSkillCategories: [],
    gekisouMissionType: 0,
    liveMusicType: 0,
    skillTargetType: 0,
  });
  const row = active.master.liveSkills.get(1)![0]!;
  const effect = (id: number, type: number, value: number) => ({
    ...row,
    id,
    type,
    value,
    level: 1,
    seconds: 20,
    triggerType: 1,
    triggerGroup: 9000,
    conditionGroup: 0,
    releaseGroup: 0,
    cumulativeId: 0,
    executeLimit: 0,
    resetGroup: 0,
    maxValue: 0,
    limitCount: 5,
    targetIds: type === 13005 ? [9000] : [],
  });
  active.master.gekisoSkills = new Map([
    [901, { missionType: 3, effects: [effect(901, 13000, 3)] }],
    [902, { missionType: 2, effects: [effect(902, 11001, 10000), effect(903, 11005, 4), effect(904, 11003, 10000)] }],
    [903, { missionType: 1, effects: [effect(905, 12000, 100), effect(906, 12002, 100)] }],
  ]);
  active.master.gekisoSupportSkills = new Map([[904, { missionType: 3, effects: [effect(907, 13005, 0)] }]]);
  active.master.members = new Map(
    [...active.master.members].map(([id, card]) => [id, { ...card, gekisoSkillId: id <= 3 ? 900 + id : 0 }]),
  );
  active.master.snaps = new Map(
    [...active.master.snaps].map(([id, card]) => [id, { ...card, gekisoSupportSkillIds: [904, 0] as const }]),
  );
  const activeCache = new ChartCache(active.master, async (_, song) => active.charts(song));
  const activeChart = await activeCache.gekiso({ songId: 1, difficulty: 0 }, { great: 0, just: 0.25 }, 1);
  const activeBox = resolveBox(active.master, active.request.members, active.request.snaps, "min");
  const activeMembers = activeBox.members.slice(0, 5);
  const activePhotos = [activeBox.snaps[0]!, null, null, null, null];
  const activePower = teamPower(
    active.master,
    playerState(active.master, active.request.player),
    activeMembers,
    activePhotos,
    0,
    musicView(active.master, 1, null),
    [],
  );
  const activeBound = gekisoScoreBound(active.master, activeChart, activeBox.members, activeBox.snaps);
  assert(activeBound.supported);
  const activeDeck = activeMembers.map((member, slot) => performer(active.master, member, activePhotos[slot]!));
  let activeOrders = 0;
  for (let seed = 0; seed < 128; seed++) {
    const context = gekisoContext(active.master, activeChart, activeDeck, [seed]);
    assert(gekisoJustSummary(activeChart, context).convertedHits > 0);
    assert([...context.gk].some((value) => value === 2));
    assert([...context.luck].some((value) => value === 2));
    const scores = scoreOrdersGekiso(
      active.master,
      activeChart,
      context,
      activePower.total,
      activeMembers.map((member, slot) => resolveSlotSkill(active.master, member, activePhotos[slot]!)),
    );
    for (const score of scores.scores) {
      assert(score <= activeBound.score(activePower.total));
      activeOrders++;
    }
  }
  const activeRow = active.master.gekisoSkills.get(901)!;
  for (const value of [-1, Infinity, 1e20]) {
    active.master.gekisoSkills = new Map(active.master.gekisoSkills).set(901, {
      ...activeRow,
      effects: [{ ...activeRow.effects[0]!, value }],
    });
    assert(!gekisoScoreBound(active.master, activeChart, activeBox.members, activeBox.snaps).supported);
  }
  cases.push(
    "128 native draws × 120 orders with active member Combo/Luck effects and photo JUST conversion remain within the bound; negative/non-finite/excessive effect values use Infinity",
  );
  return {
    passed: true,
    boundedOrders,
    activeOrders,
    cases,
    progressiveStops: stopped,
    reuse: {
      cached: items.results[0]!.stats,
      fresh: uncachedItems.results[0]!.stats,
    },
  };
}
