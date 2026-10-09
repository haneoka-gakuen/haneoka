import assert from "node:assert/strict";
import { fixture, enumerate } from "./pt-recommendation.test";
import {
  ChartCache,
  runEngine,
  eventRoute,
  type EngineRequest,
  type EngineResponse,
} from "../../src/lib/team-builder/engine/api";
import { eventPoints, eventItems } from "../../src/lib/team-builder/engine/objectives";
import { cpExchange } from "../../src/lib/team-builder/engine/pt-value";
import { validatePtRequest } from "../../src/lib/team-builder/engine/pt-eligibility";
import { mergeShardResponses } from "../../src/lib/team-builder/engine/merge";
import { compileFromTeamData } from "../../src/lib/team-builder/engine/master";
import type { TeamBuilderData } from "../../src/lib/team-builder/data";
import {
  createPtJob,
  ptComplete,
  ptChallengeBest,
  ptSongRanking,
  ptFingerprint,
  PtRunner,
  type PtJob,
} from "../../src/lib/team-builder/pt-recommendation";

function cycleFixture() {
  const data = fixture();
  const { master } = data;
  const event = master.events.get(1)!;
  event.itemId = 7;
  event.challengePoints = new Map([
    [2, 1200],
    [3, 1900],
    [4, 3100],
  ]);
  const row = { group: 1, resourceType: 10, resourceId: 7, probability: 10000 };
  event.liveRewards = [2, 3, 4].flatMap((rank) => [
    { ...row, scoreRank: rank, count: rank * 17 },
    { ...row, scoreRank: rank, count: rank * 7 + 1 },
  ]);
  event.challengeRewards = event.liveRewards.map((r) => ({ ...r, count: r.count * 12 }));
  event.effects = [
    ...event.effects,
    { ...event.effects[0]!, characterId: 6, bonusType: 1, perRank: [8300] },
    { ...event.effects[0]!, characterId: 5, bonusType: 2, perRank: [4300] },
  ];
  master.liveChallengePoints = new Map([
    [2, 5],
    [3, 11],
    [4, 18],
  ]);
  master.challengeBoosts = [{ consumed: 200, eventPointRate: 1, rewardRate: 1 }];
  master.challengeMusics = [1, 2, 3].map((id) => ({
    id,
    eventId: 1,
    liveMusicId: id,
    musicType: master.songs.get(id)!.musicType,
  }));
  return data;
}

export async function verify() {
  const cases: string[] = [];
  const dto = {
    schema: "haneoka-team-builder-data-v1",
    identity: { server: "intl", releaseId: "synthetic-public-dto" },
    members: {},
    snapshots: {},
    characters: {},
    bands: {},
    bandItems: {},
    songs: {},
    events: { "1": { id: 1, eventItem: { resourceId: 43, resourceType: 1 }, tables: {} } },
    eventRules: {},
    progression: {},
    skills: { live: {}, leader: {}, support: {}, gekiso: {}, gekisoSupport: {} },
    skillReference: {},
    liveTools: {},
    gekisoRules: {},
    gaps: [],
  } as TeamBuilderData;
  assert.equal(compileFromTeamData(dto).events.get(1)!.itemId, 43);
  cases.push("public event resourceId is preserved as the medal identity");
  const { master, request, charts } = cycleFixture();
  if (request.goal.kind !== "event") throw new Error("event");
  const cache = new ChartCache(master, async (_, ref) => charts(ref));
  let configurations = 0;
  for (const route of ["live", "challenge"] as const)
    for (const measure of ["points", "items"] as const) {
      const r = structuredClone(request);
      if (r.goal.kind !== "event") throw new Error("event");
      Object.assign(r.goal, { route, measure, consumption: route === "live" ? 3 : 200 });
      assert.deepEqual(validatePtRequest(master, r), []);
      const brute = enumerate(master, r, charts(r.goal.songs[0]!));
      configurations += brute.count;
      const out = await runEngine(master, cache, r);
      assert(out.results[0]!.proven);
      assert.equal(out.overall[0]!.key, brute.best);
      assert.equal(out.overall[0]!.event!.rewardSum! / 120, brute.best);
      if (route === "challenge") assert.equal(out.overall[0]!.event!.challengePoints, 0);
      cases.push(`${route}/${measure}: BigInt reward oracle, every legal team/photo binding, all bounds`);
    }
  for (const measure of ["points", "items"] as const) {
    const r = structuredClone(request);
    if (r.goal.kind !== "event") throw new Error("event");
    r.goal.measure = measure;
    r.goal.cpExchange = cpExchange(530401, 120, 200);
    const brute = enumerate(master, r, charts(r.goal.songs[0]!));
    configurations += brute.count;
    const out = await runEngine(master, cache, r);
    const hit = out.overall[0]!;
    assert.equal(hit.key, brute.best);
    assert.equal(hit.event!.mean, brute.best / r.goal.cpExchange.denominator);
    assert(Math.abs(hit.event!.mean - hit.event!.directMean! - hit.event!.convertedMean!) < 1e-9);
    const shards = await Promise.all(
      [0, 1, 2].map((index) => runEngine(master, cache, { ...r, noFloor: true, shard: { index, count: 3 } })),
    );
    const merged = mergeShardResponses(shards.reverse(), 1, 0);
    assert.equal(merged.overall[0]!.key, hit.key);
    const slots = (members: string[], snaps: (string | null)[]) =>
      members
        .map((m, i) => `${m}/${snaps[i] ?? "-"}`)
        .sort()
        .join();
    const legal = brute.all.some(
      ({ team, key }) =>
        key === hit.key &&
        r.members[team.members[0]!]!.key === hit.members[0] &&
        slots(
          team.members.map((i) => r.members[i]!.key),
          team.snaps.map((i) => (i < 0 ? null : r.snaps[i]!.key)),
        ) === slots(hit.members, hit.snaps),
    );
    assert(legal);
    cases.push(
      `CP conversion/${measure}: exact rational comparison, independent bounds, legal winner, shard agreement`,
    );
  }

  // The old million-BP inversion endpoint overflows int32, although all legal teams are safe.
  const overflow = cycleFixture();
  overflow.master.events.get(1)!.livePoints = new Map([
    [2, 3000],
    [3, 6100],
    [4, 9900],
  ]);
  const brute = enumerate(overflow.master, overflow.request, charts({ songId: 1, difficulty: 0 }));
  configurations += brute.count;
  const out = await runEngine(
    overflow.master,
    new ChartCache(overflow.master, async (_, ref) => charts(ref)),
    overflow.request,
  );
  assert.equal(out.overall[0]!.key, brute.best);
  cases.push("legal settlement near int32 range retains safe bonus-inversion bounds");

  // Public old-planner calibration rows, carried forward as a settlement regression.
  const normal = {
    ...eventRoute(master, 1, "live", 3),
    rate: 20,
    rewardRate: 20,
    points: new Map([[4, 35]]),
    rewards: [{ scoreRank: 4, group: 1, resourceType: 1, resourceId: 7, count: 42, probability: 10000 }],
  };
  const challenge = {
    ...normal,
    kind: "challenge" as const,
    rate: 1,
    rewardRate: 1,
    points: new Map([[4, 2550]]),
    rewards: [{ ...normal.rewards[0]!, count: 3400 }],
  };
  assert.equal(eventPoints(normal, 10600, 4), 1442);
  assert.equal(eventItems(normal, 15000, 4), 2100);
  assert.equal(eventPoints(challenge, 10800, 4), 5304);
  assert.equal(eventItems(challenge, 14000, 4), 8160);
  assert.deepEqual(cpExchange(5304 * 120, 120, 200), { numerator: 663, denominator: 25 });
  assert.equal(1442 + (100 * 5304) / 200, 4094);
  assert.equal(2100 + (100 * 8160) / 200, 6180);
  cases.push("old-planner normal/challenge PT and medals calibration; long-run CP conversion");

  for (const mutate of [
    (m: typeof master) => {
      m.liveChallengePoints = new Map();
    },
    (m: typeof master) => {
      m.events.get(1)!.liveRewards = [];
    },
    (m: typeof master) => {
      m.events.get(1)!.liveRewards = m.events.get(1)!.liveRewards.map((r) => ({ ...r, probability: 5000 }));
    },
  ]) {
    const bad = structuredClone(master);
    mutate(bad);
    const r = structuredClone(request);
    if (r.goal.kind !== "event") throw new Error("event");
    r.goal.measure = "items";
    r.goal.cpExchange = { numerator: 1, denominator: 1 };
    assert(validatePtRequest(bad, r).length > 0);
    await assert.rejects(() => runEngine(bad, cache, r), /pt-input/);
  }
  const badSong = structuredClone(request);
  if (badSong.goal.kind !== "event") throw new Error("event");
  Object.assign(badSong.goal, { route: "challenge", consumption: 200 });
  const noPool = structuredClone(master);
  noPool.challengeMusics = [];
  assert(validatePtRequest(noPool, badSong).some((i) => i.target.startsWith("challenge:")));
  const huge = structuredClone(request);
  if (huge.goal.kind !== "event") throw new Error("event");
  huge.goal.cpExchange = { numerator: Number.MAX_SAFE_INTEGER, denominator: 1 };
  assert(validatePtRequest(master, huge).some((i) => i.target === "cp-settlement-range"));
  cases.push(
    "missing CP/medal data, probabilistic medals, foreign challenge songs and unsafe integer weights rejected",
  );

  const context = {
    server: "test",
    releaseId: "cycle-v2",
    sourceId: "test",
    owner: "test",
    dataFingerprint: "cycle-hash",
    assumptions: ["synthetic"],
  };
  const cycle = {
    songs: [
      { songId: 2, difficulty: 0 },
      { songId: 3, difficulty: 1 },
    ],
    consumption: 200,
  };
  request.goal.songs = [
    { songId: 1, difficulty: 0 },
    { songId: 1, difficulty: 1 },
    { songId: 2, difficulty: 0 },
  ];
  const job = await createPtJob(request, context, cycle);
  let saved: PtJob | null = null;
  const store = {
    save: async (j: PtJob) => {
      saved = structuredClone(j);
    },
    latest: async () => saved,
  };
  const calls: string[] = [];
  let fail = true;
  const engine = {
    cancel: () => {},
    run: async (r: EngineRequest): Promise<EngineResponse> => {
      if (r.goal.kind !== "event") throw new Error("event");
      const key = `${r.goal.route}/${r.goal.measure}/${r.goal.songs[0]!.songId}`;
      calls.push(key);
      if (fail && key === "challenge/points/3") throw new Error("fixture-chart-load");
      return runEngine(master, cache, r);
    },
  };
  const runner = new PtRunner(
    engine,
    store,
    () => {},
    () => assert.fail("storage"),
  );
  await runner.run(job);
  assert(!ptComplete(job));
  assert.equal(ptChallengeBest(job, "points"), null);
  assert.equal(ptSongRanking(job, "points").length, 0);
  assert.equal(ptSongRanking(job, "items").length, 2);
  assert(!calls.some((key) => key.startsWith("live/points")));
  assert.equal(job.tasks.filter((t) => t.status === "failed").length, 1);
  const before = calls.length;
  fail = false;
  const restored = structuredClone(saved!);
  await runner.run(restored);
  assert(ptComplete(restored));
  assert.equal(calls.length - before, 4); // one failed challenge and its three dependent solo charts
  assert.notEqual(
    [...ptSongRanking(restored, "points")[0]!.members].sort().join(),
    [...ptSongRanking(restored, "items")[0]!.members].sort().join(),
    "independent currencies can prefer different member sets",
  );
  for (const measure of ["points", "items"] as const) {
    assert.equal(ptSongRanking(restored, measure).length, 2);
    const best = ptChallengeBest(restored, measure)!;
    const r = structuredClone(request);
    if (r.goal.kind !== "event") throw new Error("event");
    r.goal.measure = measure;
    r.goal.cpExchange = cpExchange(best.event!.rewardSum!, 120, cycle.consumption);
    const brute = enumerate(
      master,
      { ...r, goal: { ...r.goal, songs: [ptSongRanking(restored, measure)[0]!.song!] } },
      charts(r.goal.songs[0]!),
    );
    configurations += brute.count;
    assert.equal(ptSongRanking(restored, measure)[0]!.key, brute.best);
  }
  assert.notEqual(
    await ptFingerprint(request, context.dataFingerprint, context.owner, { ...cycle, consumption: 400 }),
    job.fingerprint,
  );
  assert.notEqual(
    await ptFingerprint(request, context.dataFingerprint, context.owner, { ...cycle, songs: cycle.songs.slice(0, 1) }),
    job.fingerprint,
  );
  const precise = structuredClone(restored);
  const pointTasks = precise.tasks.filter((t) => t.route === "live" && t.measure === "points");
  for (const task of pointTasks) {
    const hit = task.result!.hits[0]!;
    hit.key = 12000000;
    hit.event!.mean = 100;
  }
  const better = pointTasks.find((t) => t.song.songId === 2)!.result!.hits[0]!;
  better.key += 1;
  better.event!.mean += 1 / 120000;
  assert.equal(better.event!.mean.toFixed(3), "100.000");
  assert.equal(ptSongRanking(precise, "points")[0]!.song!.songId, 2);
  cases.push(
    "independent objectives, failed challenge blocks only dependent solo ranking; reload/resume skips completed tasks",
  );
  cases.push(
    "multiple difficulties occupy one song slot; challenge inputs invalidate cache; sub-display precision preserves order",
  );
  return {
    passed: true,
    cases,
    configurations,
    evidence: "Synthetic search/settlement verification, not new in-game measurements.",
  };
}
