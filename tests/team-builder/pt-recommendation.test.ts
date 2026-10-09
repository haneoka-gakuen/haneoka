/** Algorithm tests are bundled by scripts/test-pt-recommendation.mjs, separate from production tools. */
import assert from "node:assert/strict";
import {
  compileFromMasterTables,
  skillEffect,
  type EngineMaster,
  type MemberCard,
  type SnapCard,
} from "../../src/lib/team-builder/engine/master";
import {
  ChartCache,
  runEngine,
  eventRoute,
  musicView,
  playerState,
  type EngineRequest,
  type EngineResponse,
  type SongRef,
} from "../../src/lib/team-builder/engine/api";
import { resolveBox } from "../../src/lib/team-builder/engine/box";
import { teamPower, memberEventPercent, snapEventPercent } from "../../src/lib/team-builder/engine/power";
import { AP, prepareLive, scoreOrdersAP } from "../../src/lib/team-builder/engine/live";
import { compileChart, type ChartSource } from "../../src/lib/team-builder/engine/chart";
import { resolveSlotSkill } from "../../src/lib/team-builder/engine/skills";
import { eventObjective } from "../../src/lib/team-builder/engine/objectives";
import type { Team } from "../../src/lib/team-builder/engine/search";
import { validatePtChart, validatePtRequest } from "../../src/lib/team-builder/engine/pt-eligibility";
import { mergeShardResponses } from "../../src/lib/team-builder/engine/merge";
import {
  canonical,
  createPtJob,
  ptComplete,
  ptFingerprint,
  ptSongRanking,
  PtRunner,
  type PtJob,
} from "../../src/lib/team-builder/pt-recommendation";

export function fixture() {
  const master = compileFromMasterTables({ server: "test", releaseId: "synthetic-pt-v1" }, () => []);
  master.characters = new Map(Array.from({ length: 6 }, (_, i) => [i + 1, { id: i + 1, bandId: 1 }]));
  master.members = new Map(
    Array.from({ length: 6 }, (_, i) => {
      const id = i + 1;
      const card: MemberCard = {
        id,
        characterId: id,
        bandId: 1,
        rarity: 1,
        cardType: (i % 2) + 1,
        bestTags: [],
        statMax: [1200 + i * 170, 1100, 1000],
        levelGroup: 1,
        awakeGroup: 1,
        rankGroup: 1,
        liveSkillId: id,
        leaderSkillId: 0,
        gekisoSkillId: 0,
        releasedAt: null,
      };
      return [id, card];
    }),
  );
  master.snaps = new Map(
    Array.from({ length: 2 }, (_, i) => {
      const id = i + 1;
      const card: SnapCard = {
        id,
        characterIds: [id],
        bandIds: [1],
        rarity: 1,
        cardType: id,
        statMax: [500 + i * 200, 600, 700],
        levelGroup: 1,
        rankGroup: 1,
        supportSkillIds: [id, 0],
        gekisoSupportSkillIds: [0, 0],
      };
      return [id, card];
    }),
  );
  master.memberLevels = new Map([[1, new Map([[1, [10000, 10000, 10000] as const]])]]);
  master.memberAwake = new Map([[1, new Map([[1, [0, 0, 0] as const]])]]);
  master.memberRanks = new Map([
    [1, new Map([[1, { rates: [0, 0, 0] as const, leaderSkillLevel: 1, musicTypeRate: 500, musicTagRate: 0 }]])],
  ]);
  master.memberLevelLimits = new Map([["1:1", 1]]);
  master.snapLevels = new Map([[1, new Map([[1, [10000, 10000, 10000] as const]])]]);
  master.snapRanks = new Map([
    [
      1,
      new Map([
        [1, { typeLinkRate: 500, limitLevel: 1, skillLevels: [1, 1] as const, gekisoSkillLevels: [1, 1] as const }],
      ]),
    ],
  ]);
  master.maxCharacterRank = 10;
  master.vipBonus = new Map([[1, 0]]);
  master.live.notePercent = new Map([[1, 100]]);
  master.live.judgePercent = new Map([[2, 100]]);
  master.live.timingTypes = new Set([1]);
  master.liveSkills = new Map(
    [...master.members.keys()].map((id) => [
      id,
      [skillEffect({ id, level: 1, skillEffectType: 2000, effectValue: 0 })],
    ]),
  );
  // Use the public normalized effect shape, with unequal windows and strengths.
  master.liveSkills = new Map(
    [...master.members.keys()].map((id) => [
      id,
      [{ ...skillEffect({}), id, level: 1, type: 2000, value: 1200 + id * 330, seconds: id % 2 ? 1 : 2 }],
    ]),
  );
  master.supportSkills = new Map([
    [1, [{ ...skillEffect({}), id: 1, level: 1, type: 15000, value: 500 }]],
    [2, [{ ...skillEffect({}), id: 2, level: 1, type: 15000, value: 1200 }]],
  ]);
  master.songs = new Map(
    [1, 2, 3].map((id) => [
      id,
      {
        id,
        musicType: (id % 2) + 1,
        bestTags: [],
        bandIds: [1],
        rankGroup: 1,
        gekisoMissions: [],
        difficulties: [0, 1].map((difficulty) => ({
          difficulty,
          scoreId: id * 10 + difficulty,
          playLevel: 10 + difficulty * 3,
          displayLevel: 10,
          noteCount: 70,
          file: `synthetic-${id}-${difficulty}`,
        })),
      },
    ]),
  );
  master.scoreRanks = new Map([
    [
      1,
      [
        { rank: 2, required: 0, battleRequired: 0 },
        { rank: 3, required: 73500, battleRequired: 0 },
        { rank: 4, required: 84000, battleRequired: 0 },
      ],
    ],
  ]);
  const effect = {
    resourceType: 2,
    characterId: 1,
    bandId: 0,
    cardType: 0,
    tagId: 0,
    memberCardId: 0,
    supportCardId: 0,
    bonusType: 0,
    perRank: [9500],
  };
  master.events = new Map([
    [
      1,
      {
        id: 1,
        startAt: null,
        endAt: null,
        itemId: 0,
        musicId: 0,
        effects: [effect, { ...effect, resourceType: 3, characterId: 0, supportCardId: 2, perRank: [1700] }],
        livePoints: new Map([
          [2, 30],
          [3, 61],
          [4, 99],
        ]),
        challengePoints: new Map(),
        liveRewards: [],
        challengeRewards: [],
      },
    ],
  ]);
  master.boosts = [{ consumed: 3, eventPointRate: 3, rewardRate: 3 }];
  const charts = (_ref: SongRef): ChartSource => ({
    durationMs: 8000,
    skillTimesMs: [100, 1500, 2900, 4300, 5700],
    feverMs: [],
    notes: Array.from({ length: 70 }, (_, i) => ({ timeMs: i * 100, operateType: 1, judgementType: 1, judged: true })),
  });
  const request: EngineRequest = {
    members: [...master.members.keys()].map((id) => ({
      key: `m${id}`,
      cardId: id,
      level: 1,
      awake: 1,
      rank: 1,
      liveSkillLevel: 1,
      gekisoSkillLevel: null,
    })),
    snaps: [...master.snaps.keys()].map((id) => ({ key: `s${id}`, cardId: id, level: 1, rank: 1 })),
    player: {
      characterRanks: Object.fromEntries([...master.characters.keys()].map((id) => [id, 1])),
      characterTotalRank: 6,
      vipRank: 1,
      bandItems: {},
      characterMemory: Object.fromEntries([...master.characters.keys()].map((id) => [id, 0])),
      musicMemory: { "1": 0, "2": 0, "3": 0 },
    },
    unknownPolicy: "min",
    goal: {
      kind: "event",
      measure: "points",
      route: "live",
      eventId: 1,
      songs: [{ songId: 1, difficulty: 0 }],
      consumption: 3,
      play: AP,
      ranking: "pt-only",
    },
    constraints: {
      requiredMembers: [],
      requiredSnaps: [],
      excludedMembers: [],
      excludedSnaps: [],
      leader: null,
      bindings: [],
      noSnaps: false,
      minBonusPercent: null,
    },
    k: 1,
    timeLimitMs: null,
  };
  return { master, request, charts };
}

/** Exhaustive independent traversal. Shares score/power routines, not search, bounds, grouping or reward settlement. */
export function enumerate(master: EngineMaster, request: EngineRequest, source: ChartSource) {
  assert.equal(request.goal.kind, "event");
  if (request.goal.kind !== "event") throw new Error("event");
  const ref = request.goal.songs[0]!;
  const song = master.songs.get(ref.songId)!;
  const chart = compileChart(
    master,
    song,
    song.difficulties.find((d) => d.difficulty === ref.difficulty)!,
    source,
  );
  const prepared = prepareLive(master, chart);
  const box = resolveBox(master, request.members, request.snaps, "min");
  const player = playerState(master, request.player);
  const goal = request.goal;
  const challenge = goal.route === "challenge";
  const items = goal.measure === "items";
  const music = musicView(master, ref.songId, challenge ? goal.eventId : null);
  const event = master.events.get(request.goal.eventId)!;
  const boost = (challenge ? master.challengeBoosts : master.boosts).find((b) => b.consumed === goal.consumption)!;
  const rate = boost.eventPointRate;
  const objective = eventObjective(
    { master, ...box, live: prepared, chart, play: AP },
    eventRoute(master, event.id, challenge ? "challenge" : "live", goal.consumption),
    items ? "items" : "points",
    2,
    0,
    Infinity,
    "pt-only",
    goal.cpExchange,
  );
  let best = -Infinity,
    maximumPower = 0,
    bestPower = 0,
    count = 0,
    crossing = false;
  const all: { team: Team; key: number }[] = [];
  function visitMembers(chosen: number[], from: number) {
    if (chosen.length < 5) {
      for (let i = from; i < box.members.length; i++) {
        if (
          request.constraints.excludedMembers.includes(box.members[i]!.key) ||
          chosen.some((j) => box.members[i]!.card.characterId === box.members[j]!.card.characterId)
        )
          continue;
        visitMembers([...chosen, i], i + 1);
      }
      return;
    }
    if (request.constraints.requiredMembers.some((key) => !chosen.some((i) => box.members[i]!.key === key))) return;
    for (const leader of chosen) {
      if (request.constraints.leader && box.members[leader]!.key !== request.constraints.leader) continue;
      const members = [leader, ...chosen.filter((i) => i !== leader)];
      function photos(picks: number[]) {
        if (picks.length < 5) {
          const key = box.members[members[picks.length]!]!.key;
          const binding = request.constraints.bindings.find(([m]) => m === key);
          for (let j = -1; j < box.snaps.length; j++) {
            if (request.constraints.noSnaps && j >= 0) continue;
            if (j >= 0 && (picks.includes(j) || request.constraints.excludedSnaps.includes(box.snaps[j]!.key)))
              continue;
            if (binding && binding[1] !== (j < 0 ? null : box.snaps[j]!.key)) continue;
            photos([...picks, j]);
          }
          return;
        }
        if (request.constraints.requiredSnaps.some((key) => !picks.some((j) => j >= 0 && box.snaps[j]!.key === key)))
          return;
        const bonus =
          members.reduce((s, i) => s + memberEventPercent(event.effects, box.members[i]!, items ? 1 : 0), 0) +
          picks.reduce((s, j) => s + (j < 0 ? 0 : snapEventPercent(event.effects, box.snaps[j]!, items ? 1 : 0)), 0);
        if (request.constraints.minBonusPercent !== null && bonus < request.constraints.minBonusPercent * 100) return;
        const power = teamPower(
          master,
          player,
          members.map((i) => box.members[i]!),
          picks.map((j) => (j < 0 ? null : box.snaps[j]!)),
          0,
          music,
          challenge ? event.effects : [],
        );
        const skills = members.map((i, slot) =>
          resolveSlotSkill(master, box.members[i]!, picks[slot]! < 0 ? null : box.snaps[picks[slot]!]!),
        );
        const scores = scoreOrdersAP(prepared, power.total, skills);
        const rewards = [...scores.scores].map((score) => {
          let rank = 2;
          for (const row of chart.ranks) if (score >= row.required && row.rank > rank) rank = row.rank;
          // Independent BigInt settlement: no production eventPoints/eventItems/value helpers.
          const direct = items
            ? (challenge ? event.challengeRewards : event.liveRewards)
                .filter((r) => r.scoreRank === rank && r.resourceId === event.itemId)
                .reduce(
                  (sum, r) => sum + (BigInt(r.count) * BigInt(10000 + bonus) * BigInt(boost.rewardRate)) / 10000n,
                  0n,
                )
            : (BigInt((challenge ? event.challengePoints : event.livePoints).get(rank)!) *
                BigInt(rate) *
                BigInt(10000 + bonus)) /
              10000n;
          const cp = challenge ? 0n : BigInt(master.liveChallengePoints.get(rank) ?? 0) * BigInt(rate);
          return Number(
            goal.cpExchange
              ? direct * BigInt(goal.cpExchange.denominator) + cp * BigInt(goal.cpExchange.numerator)
              : direct,
          );
        });
        const mean = rewards.reduce((a, b) => a + b, 0) / 120;
        crossing ||= new Set(rewards).size > 1;
        const team = { members, snaps: picks };
        const weights = members.map((i, slot) => objective.skill(i, picks[slot]!));
        const totals = {
          power: power.total,
          bonus,
          skill: weights.reduce((s, w) => s + w[1], 0),
          skillLow: weights.reduce((s, w) => s + w[0], 0),
        };
        const interval = objective.interval(team, totals);
        assert(interval[0] <= mean && interval[1] >= mean, `interval ${interval} excludes ${mean}`);
        assert(objective.bound(totals) >= mean, "bound excludes exact PT");
        assert((objective.leafBound?.(team, totals) ?? Infinity) >= mean, "leaf bound excludes exact PT");
        assert(
          objective.jointTargets!(mean).some(
            (target) =>
              bonus >= target.bonus && power.total * (objective.productBase! + totals.skill) >= target.product,
          ),
          "joint target excludes a feasible team's exact PT",
        );
        assert.equal(objective.exact(team, power.total, power.slots).key, mean);
        maximumPower = Math.max(maximumPower, power.total);
        if (mean > best) {
          best = mean;
          bestPower = power.total;
        }
        count++;
        all.push({ team, key: mean });
      }
      photos([]);
    }
  }
  visitMembers([], 0);
  return { best, count, all, crossing, maximumPower, bestPower };
}

export async function verify() {
  const passed: string[] = [];
  const { master, request, charts } = fixture();
  const cache = new ChartCache(master, async (_master, ref) => charts(ref));
  assert.deepEqual(validatePtRequest(master, request), []);
  const sparseVip = structuredClone(master);
  sparseVip.vipBonus = new Map([[2, 100]]);
  assert.deepEqual(validatePtRequest(sparseVip, request), []);
  sparseVip.vipBonus = new Map();
  assert(validatePtRequest(sparseVip, request).some((i) => i.target === "p.vip"));
  validatePtChart(master, { songId: 1, difficulty: 0 }, charts({ songId: 1, difficulty: 0 }));
  const brute = enumerate(master, request, charts({ songId: 1, difficulty: 0 }));
  const response = await runEngine(master, cache, request);
  assert.equal(response.results[0]!.proven, true);
  assert.equal(response.overall[0]!.event!.mean, brute.best);
  assert.equal(response.overall[0]!.key, brute.best);
  passed.push(
    `independent enumeration: ${brute.count} configurations; PT settlement, rounding, interval and leaf bounds`,
  );
  assert(brute.crossing, "fixture must cross reward thresholds across skill orders");
  passed.push("reward thresholds crossed within a team's 120 skill orders");
  assert(brute.bestPower < brute.maximumPower, "maximum power must not be the event-PT decision rule");
  passed.push("an event PT winner can have lower power than the highest-power configuration");
  const implicitBase = fixture();
  implicitBase.master.scoreRanks.set(1, [{ rank: 3, required: 1_000_000, battleRequired: 0 }]);
  implicitBase.master.events.set(2, { ...implicitBase.master.events.get(1)!, id: 2 });
  if (implicitBase.request.goal.kind !== "event") throw new Error("event");
  implicitBase.request.goal.eventId = 2;
  const baseBrute = enumerate(
    implicitBase.master,
    implicitBase.request,
    implicitBase.charts({ songId: 1, difficulty: 0 }),
  );
  const baseResult = await runEngine(
    implicitBase.master,
    new ChartCache(implicitBase.master, async (_, ref) => implicitBase.charts(ref)),
    implicitBase.request,
  );
  assert.equal(baseResult.overall[0]!.key, baseBrute.best);
  passed.push("implicit base score rank is retained by joint search bounds");
  const different = fixture();
  different.master.memberRanks = new Map([
    [1, new Map([[1, { rates: [0, 0, 0] as const, leaderSkillLevel: 1, musicTypeRate: 15000, musicTagRate: 0 }]])],
  ]);
  const denseRanks = Array.from({ length: 100 }, (_, i) => ({ rank: i + 2, required: i * 3000, battleRequired: 0 }));
  different.master.scoreRanks = new Map([[1, denseRanks]]);
  different.master.events = new Map([
    [
      1,
      {
        ...different.master.events.get(1)!,
        effects: [],
        livePoints: new Map(denseRanks.map((r) => [r.rank, r.rank * 10])),
      },
    ],
  ]);
  different.request.snaps = [];
  different.request.constraints.noSnaps = true;
  const winners: string[] = [];
  let differentConfigurations = 0;
  for (const songId of [1, 2]) {
    const input = structuredClone(different.request);
    if (input.goal.kind !== "event") throw new Error("event");
    input.goal.songs = [{ songId, difficulty: 0 }];
    const answer = await runEngine(
      different.master,
      new ChartCache(different.master, async (_, ref) => different.charts(ref)),
      input,
    );
    const exhaustive = enumerate(different.master, input, different.charts({ songId, difficulty: 0 }));
    differentConfigurations += exhaustive.count;
    assert.equal(answer.overall[0]!.key, exhaustive.best);
    winners.push([...answer.overall[0]!.members].sort().join(","));
  }
  assert.notEqual(winners[0], winners[1]);
  passed.push("two songs have different optimal member sets, both verified by enumeration");
  const shards = await Promise.all(
    [0, 1, 2].map((index) => runEngine(master, cache, { ...request, noFloor: true, shard: { index, count: 3 } })),
  );
  const merged = mergeShardResponses(shards.reverse(), 1, 0);
  assert.equal(merged.overall[0]!.event!.mean, brute.best);
  assert(merged.results.every((r) => r.proven));
  passed.push("single and reversed-order leader shards agree on optimal PT");

  for (const mutation of [
    (r: EngineRequest) => {
      r.members[0]!.level = null;
    },
    (r: EngineRequest) => {
      r.player.musicMemory["1"] = null;
    },
    (r: EngineRequest) => {
      r.constraints.requiredMembers = ["missing"];
    },
    (r: EngineRequest) => {
      r.constraints.leader = "missing";
    },
    (r: EngineRequest) => {
      r.constraints.bindings = [
        ["m1", "s1"],
        ["m2", "s1"],
      ];
    },
    (r: EngineRequest) => {
      if (r.goal.kind === "event") r.goal.consumption = 7;
    },
  ]) {
    const invalid = structuredClone(request);
    mutation(invalid);
    assert(validatePtRequest(master, invalid).length > 0);
    await assert.rejects(() => runEngine(master, cache, invalid), /pt-input/);
  }
  const badMaster = structuredClone(master);
  badMaster.events.get(1)!.livePoints = new Map([[2, 30]]);
  assert(validatePtRequest(badMaster, request).some((i) => i.code === "event"));
  badMaster.liveSkills = new Map([[1, [{ ...skillEffect({}), level: 1, type: 99999 }]]]);
  assert(validatePtRequest(badMaster, request).some((i) => i.code === "skill"));
  assert.throws(
    () =>
      validatePtChart(
        master,
        { songId: 1, difficulty: 0 },
        { ...charts({ songId: 1, difficulty: 0 }), skillTimesMs: [] },
      ),
    /pt-chart/,
  );
  passed.push(
    "missing practice, bonuses, reward tables, skills, invalid locks, bindings, consumption and chart support fail explicitly",
  );

  const constrained = structuredClone(request);
  constrained.constraints = {
    ...request.constraints,
    requiredMembers: ["m1"],
    requiredSnaps: ["s2"],
    leader: "m2",
    bindings: [["m1", "s1"]],
  };
  const constrainedBrute = enumerate(master, constrained, charts({ songId: 1, difficulty: 0 }));
  const constrainedResult = await runEngine(master, cache, constrained);
  assert.equal(constrainedResult.overall[0]!.event!.mean, constrainedBrute.best);
  assert.equal(constrainedResult.overall[0]!.members[0], "m2");
  passed.push("required members, fixed leader and unique photo bindings match enumeration");

  const multi = structuredClone(request);
  if (multi.goal.kind !== "event") throw new Error("event");
  multi.goal.songs = [
    { songId: 1, difficulty: 0 },
    { songId: 1, difficulty: 1 },
    { songId: 2, difficulty: 0 },
  ];
  const context = {
    server: "test",
    releaseId: "synthetic-pt-v1",
    sourceId: "test",
    owner: "local",
    dataFingerprint: "test-hash",
    assumptions: ["synthetic"],
  };
  const job = await createPtJob(multi, context);
  const saved: PtJob[] = [];
  let calls = 0;
  const store = {
    save: async (value: PtJob) => {
      saved.push(structuredClone(value));
    },
    latest: async () => saved.at(-1) ?? null,
  };
  const engine = {
    run: async (r: EngineRequest): Promise<EngineResponse> => {
      calls++;
      return runEngine(master, cache, r);
    },
    cancel: () => {},
  };
  let runner: PtRunner;
  runner = new PtRunner(
    engine,
    store,
    (j) => {
      if (j.tasks[0]!.status === "complete" && j.tasks[1]!.status === "queued") runner.stop();
    },
    () => assert.fail("storage"),
  );
  await runner.run(job);
  assert.equal(calls, 1);
  assert(!ptComplete(job));
  const resumed = structuredClone(saved.at(-1)!);
  runner = new PtRunner(
    engine,
    store,
    () => {},
    () => assert.fail("storage"),
  );
  await runner.run(resumed);
  assert.equal(calls, 3);
  assert(ptComplete(resumed));
  assert.equal(ptSongRanking(resumed).length, 2);
  assert.equal(new Set(ptSongRanking(resumed).map((h) => h.song!.songId)).size, 2);
  const changed = structuredClone(multi);
  changed.player.vipRank = 2;
  assert.notEqual(await ptFingerprint(changed, "test-hash", "local"), job.fingerprint);
  assert.notEqual(await ptFingerprint(multi, "other-data", "local"), job.fingerprint);
  assert.equal(
    canonical({
      a: new Map([
        [2, "b"],
        [1, "a"],
      ]),
    }),
    canonical({
      a: new Map([
        [1, "a"],
        [2, "b"],
      ]),
    }),
  );
  passed.push("stop, persisted completed-chart resume, grouping before Top-K, and data/input fingerprints");
  const tied = structuredClone(resumed);
  for (const task of tied.tasks)
    for (const hit of task.result?.hits ?? []) {
      hit.key = 100;
      if (hit.event) hit.event.mean = 100;
    }
  tied.tasks.reverse();
  assert.deepEqual(
    ptSongRanking(tied).map((h) => h.song!.songId),
    [1, 2],
  );
  assert.equal(ptSongRanking(tied)[0]!.song!.difficulty, 0);
  const precise = structuredClone(tied);
  const second = precise.tasks.find((t) => t.song.songId === 2)!.result!.hits[0]!;
  second.event!.mean = 100 + 1 / 120;
  second.key = second.event!.mean;
  assert.equal(ptSongRanking(precise)[0]!.song!.songId, 2);
  assert.equal(ptComplete({ ...job, tasks: [] }), false);
  passed.push("PT ties use stable IDs; full precision sorts before display rounding; empty tasks are not proof");
  const interrupted = await createPtJob(multi, context);
  let finish: ((response: EngineResponse) => void) | undefined;
  const pendingEngine = {
    run: async () =>
      new Promise<EngineResponse>((resolve) => {
        finish = resolve;
      }),
    cancel: () => {},
  };
  const stopped = new PtRunner(
    pendingEngine,
    store,
    () => {},
    () => assert.fail("storage"),
  );
  const running = stopped.run(interrupted);
  while (!finish) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  stopped.stop();
  finish(response);
  await running;
  assert.equal(interrupted.tasks[0]!.status, "queued");
  assert.equal(interrupted.tasks[0]!.result, null);
  passed.push("late replies after cancellation cannot become completed results");
  const failing = await createPtJob(multi, context);
  const failingEngine = {
    ...engine,
    run: async (r: EngineRequest) => {
      if (r.goal.kind === "event" && r.goal.songs[0]!.difficulty === 1) throw new Error("chart-http:404");
      return engine.run(r);
    },
  };
  await new PtRunner(
    failingEngine,
    store,
    () => {},
    () => assert.fail("storage"),
  ).run(failing);
  assert.equal(failing.tasks[1]!.status, "failed");
  assert.equal(failing.tasks[2]!.status, "complete");
  assert(!ptComplete(failing));
  passed.push("one failed chart does not stop other charts or fabricate full completion");
  return {
    passed: true,
    cases: passed,
    configurations: brute.count + baseBrute.count + constrainedBrute.count + differentConfigurations,
    evidence:
      "Synthetic algorithm/settlement tests; shared score/power routines are not independent game-formula certification.",
  };
}
