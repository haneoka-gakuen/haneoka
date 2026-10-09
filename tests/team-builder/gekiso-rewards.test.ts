import assert from "node:assert/strict";
import { fixture } from "./pt-recommendation.test";
import { eventRoute, ChartCache, runEngine, playerState, musicView } from "../../src/lib/team-builder/engine/api";
import { battleRank, type ChartSource } from "../../src/lib/team-builder/engine/chart";
import { resolveBox } from "../../src/lib/team-builder/engine/box";
import { memberEventPercent, snapEventPercent, teamPower } from "../../src/lib/team-builder/engine/power";
import { performer } from "../../src/lib/team-builder/engine/full/deck";
import { gekisoContext, scoreOrdersGekiso } from "../../src/lib/team-builder/engine/gekiso";
import { resolveSlotSkill } from "../../src/lib/team-builder/engine/skills";
import { validatePtRequest } from "../../src/lib/team-builder/engine/pt-eligibility";
import { DEFAULT_GEKISO_REWARDS, settleGekisoRewards } from "../../src/lib/team-builder/engine/gekiso-rewards";
import { gekisoJustSummary } from "../../src/lib/team-builder/engine/gekiso-just";
import { Conversion } from "../../src/lib/team-builder/engine/full/convert";
import { EXECUTE_FRAME } from "../../src/lib/team-builder/engine/full/effects";
import { judgementStream, type FullChart } from "../../src/lib/team-builder/engine/full/play";

export async function verify() {
  const cases: string[] = [];
  const { master } = fixture();
  const event = [...master.events.keys()][0]!;
  const route = eventRoute(master, event, "live", 3);
  const ranks = {
    ranks: [
      { rank: 2, required: 0, battleRequired: 0 },
      { rank: 3, required: 50, battleRequired: 100 },
    ],
  };
  const payout = {
    ...route,
    points: new Map([
      [2, 100],
      [3, 1000],
    ]),
    challengePoints: new Map([
      [2, 2],
      [3, 7],
    ]),
  };
  assert.equal(battleRank(ranks, 80), 2);
  const result = settleGekisoRewards(ranks, payout, "points", 2500, [[80], [110]], { numerator: 3, denominator: 2 });
  const oracle = (n: number) => Number((BigInt(n) * BigInt(payout.rate) * 12500n) / 10000n);
  const low = oracle(100),
    high = oracle(1000);
  assert.equal(result.rewardSum, low + high);
  assert.equal(result.comparisonSum, (low + high) * 2 + 9 * payout.rate * 3);
  assert.equal(result.mean, result.comparisonSum / 2);
  assert.equal(result.directMin, low);
  assert.equal(result.directMax, high);
  assert.notEqual(
    result.mean,
    settleGekisoRewards(ranks, payout, "points", 2500, [[95]], { numerator: 3, denominator: 2 }).mean,
  );
  cases.push(
    "battle thresholds and each lottery outcome are settled before averaging; independent BigInt PT and CP oracle",
  );

  const rewards = [
    { scoreRank: 2, resourceType: 1, resourceId: 77, count: 3, probability: 10000 },
    { scoreRank: 2, resourceType: 1, resourceId: 77, count: 7, probability: 10000 },
  ];
  const medals = settleGekisoRewards(ranks, { ...route, itemId: 77, rewardRate: 1, rewards }, "items", 5000, [[0]]);
  assert.equal(medals.rewardSum, 4 + 10);
  assert.throws(() => settleGekisoRewards(ranks, { ...payout, points: new Map() }, "points", 0, [[0]]), /reward-rank/);
  assert.throws(
    () =>
      settleGekisoRewards(ranks, { ...payout, challengePoints: new Map() }, "points", 0, [[0]], {
        numerator: 1,
        denominator: 1,
      }),
    /reward-cp/,
  );
  assert.throws(() => settleGekisoRewards(ranks, payout, "points", 0, []), /empty/);
  cases.push("medals round each reward row separately; missing payout/CP and empty samples are not zero rewards");

  master.live.justTypes = new Set([1]);
  const notes = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, timeMs: 1000 + i * 100, op: 1, judgementType: 1 }));
  const chart: FullChart = {
    notes,
    events: [],
    fevers: [[500, 2000]],
    convertedCount: 8,
    lastTimingMs: 1700,
    level: 1,
  };
  const play = judgementStream(
    master,
    chart,
    { fevers: chart.fevers, missions: [3, 1, 1] },
    { great: 0, just: DEFAULT_GEKISO_REWARDS.just },
  );
  const before = Int8Array.from(play.frames.flatMap((f) => f.judged.map((n) => n.judgement)));
  assert.equal([...before].filter((j) => j === 6).length, 2);
  const conversion = new Conversion(new Set([2]));
  conversion.update("skill", EXECUTE_FRAME, { type: 13005, value: 0, limitCount: 3, targets: [5], effectId: 1 });
  const after = Int8Array.from(before, (j, i) => conversion.convert(j, 1, notes[i]!.timeMs));
  const summary = gekisoJustSummary({ notes, play, judgements: before }, { judgement: after });
  assert.deepEqual(summary, {
    eligible: 8,
    baselineHits: 2,
    effectiveHits: 5,
    convertedHits: 3,
    baselineRate: 0.25,
    effectiveRate: 0.625,
  });
  const unchanged = gekisoJustSummary({ notes, play, judgements: before }, { judgement: before });
  assert.equal(unchanged.effectiveRate, 0.25); // A bonus counter cannot change actual note judgements.
  assert.equal(
    gekisoJustSummary({ notes, play: { ...play, justEligibleIds: [] }, judgements: before }, { judgement: after })
      .effectiveRate,
    null,
  );
  cases.push(
    "25% baseline becomes 62.5% after three bounded JUST conversions; count bonuses do not inflate hit rate; no-JUST charts report null",
  );
  const g = fixture();
  g.master.live.justTypes = new Set([1]);
  g.master.live.judgePercent = new Map([
    [1, 110],
    [2, 100],
  ]);
  g.master.live.gekiso = {
    gaugeMax: 100,
    gaugeMaxRush: 50,
    rushPercent: 100,
    rankingBonuses: [1, 2, 3].flatMap((pattern) =>
      [1, 2, 3].map((count) => ({ pattern, count, rank: 1, percent: 10 * count })),
    ),
    luckBasePoints: [{ category: 0, judgement: 5, weight: 1, point: 50 }],
    luckBonusLots: [0, 1, 2, 3, 4].flatMap((lotType) => [1, 2, 3].map((result) => ({ lotType, result, weight: 1 }))),
  };
  g.master.scoreRanks = new Map([
    [
      1,
      [
        { rank: 2, required: 0, battleRequired: 0 },
        { rank: 3, required: 1000, battleRequired: 50000 },
        { rank: 4, required: 2000, battleRequired: 85000 },
      ],
    ],
  ]);
  const ev = g.master.events.get(1)!;
  g.master.events = new Map([
    [
      1,
      {
        ...ev,
        itemId: 9,
        liveRewards: [2, 3, 4].map((scoreRank) => ({
          scoreRank,
          resourceType: 1,
          resourceId: 9,
          count: scoreRank * 5,
          probability: 10000,
        })),
      },
    ],
  ]);
  g.master.liveChallengePoints = new Map([
    [2, 2],
    [3, 5],
    [4, 8],
  ]);
  const raw = g.charts({ songId: 1, difficulty: 0 });
  const source: ChartSource = {
    ...raw,
    feverMs: [
      [500, 1600],
      [2500, 3600],
      [4500, 5600],
    ],
    enumeration: raw.notes.map((n) => ({ op: n.operateType, timeMs: n.timeMs, judgementType: n.judgementType })),
  };
  g.request.snaps = [];
  g.request.constraints.noSnaps = true;
  if (g.request.goal.kind !== "event") throw new Error("fixture");
  g.request.goal.gekiso = { just: 0.25, luckSamples: 3, rank: 1 };
  g.request.goal.cpExchange = { numerator: 3, denominator: 2 };
  for (const missions of [
    [1, 3, 1],
    [2, 3, 1],
  ]) {
    g.master.songs = new Map([...g.master.songs].map(([id, song]) => [id, { ...song, gekisoMissions: missions }]));
    const cache = new ChartCache(g.master, async () => source);
    const { members, snaps } = resolveBox(g.master, g.request.members, g.request.snaps, "min");
    const compiled = await cache.chart({ songId: 1, difficulty: 0 });
    const chart = await cache.gekiso({ songId: 1, difficulty: 0 }, { just: 0.25, great: 0 }, 1);
    const samples = chart.luck ? 3 : 1;
    for (const measure of ["points", "items"] as const) {
      g.request.goal.measure = measure;
      assert.deepEqual(validatePtRequest(g.master, g.request), []);
      let best = -Infinity;
      // Independently enumerate every legal member set and leader (six choose five × five).
      for (let omitted = 0; omitted < 6; omitted++) {
        const chosen = members.filter((_, i) => i !== omitted);
        for (let leader = 0; leader < 5; leader++) {
          const order = [chosen[leader]!, ...chosen.filter((_, i) => i !== leader)];
          const power = teamPower(
            g.master,
            playerState(g.master, g.request.player),
            order,
            [null, null, null, null, null],
            0,
            musicView(g.master, 1, null),
            [],
          );
          const bonus =
            order.reduce((sum, m) => sum + memberEventPercent(ev.effects, m, measure === "points" ? 0 : 1), 0) +
            snaps.reduce((sum, s) => sum + snapEventPercent(ev.effects, s), 0);
          let sum = 0n;
          for (let seed = 0; seed < samples; seed++) {
            const ctx = gekisoContext(
              g.master,
              chart,
              order.map((m) => performer(g.master, m, null)),
              [seed],
            );
            const scored = scoreOrdersGekiso(
              g.master,
              chart,
              ctx,
              power.total,
              order.map((m) => resolveSlotSkill(g.master, m, null)),
            );
            for (const score of scored.scores) {
              let rank = 2;
              for (const row of compiled.ranks)
                if (row.battleRequired > 0 && score >= row.battleRequired) rank = Math.max(rank, row.rank);
              const base = measure === "points" ? ev.livePoints.get(rank)! : rank * 5;
              const direct = (BigInt(base) * 3n * BigInt(10000 + bonus)) / 10000n;
              sum += direct * 2n + BigInt(g.master.liveChallengePoints.get(rank)!) * 3n * 3n;
            }
          }
          best = Math.max(best, Number(sum) / (samples * 120));
        }
      }
      const out = await runEngine(g.master, cache, g.request);
      assert(out.results[0]!.proven);
      assert.equal(out.overall[0]!.key, best);
      assert.equal(out.overall[0]!.event!.orders, samples * 120);
      assert.equal(out.overall[0]!.gekiso!.sampled, chart.luck);
      assert(out.overall[0]!.gekiso!.just.eligible > 0);
      cases.push(
        `${missions.join("/")}/${measure}: all 30 legal teams and leaders match independent reward enumeration`,
      );
    }
  }
  const invalid = structuredClone(g.request);
  if (invalid.goal.kind !== "event") throw new Error("fixture");
  invalid.goal.gekiso!.just = 1.01;
  assert(validatePtRequest(g.master, invalid).some((i) => i.target === "gekiso-input"));
  invalid.goal.gekiso!.just = 0.25;
  invalid.goal.gekiso!.luckSamples = 1.5;
  assert(validatePtRequest(g.master, invalid).some((i) => i.target === "gekiso-input"));
  invalid.goal.gekiso!.luckSamples = 3;
  invalid.goal.route = "challenge";
  assert(validatePtRequest(g.master, invalid).some((i) => i.target === "gekiso-input"));
  cases.push("invalid JUST, fractional sample counts and Gekisou on a challenge request are rejected");
  const card = g.master.members.get(1)!;
  g.master.members = new Map(g.master.members).set(1, { ...card, gekisoSkillId: 991 });
  const effect = { ...g.master.liveSkills.get(1)![0]!, triggerType: 1, triggerGroup: 991, level: 1 };
  g.master.gekisoSkills = new Map([[991, { missionType: 3, effects: [effect] }]]);
  g.request.members[0]!.gekisoSkillLevel = 1;
  assert(validatePtRequest(g.master, g.request).some((i) => i.target.includes("condition:991")));
  delete g.request.members[0]!.gekisoSkillLevel;
  assert(validatePtRequest(g.master, g.request).some((i) => i.target.endsWith("gekisoSkillLevel")));
  cases.push("missing Gekisou condition data and unfilled skill practice cannot silently use defaults");
  return { passed: true, cases };
}
