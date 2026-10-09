import assert from "node:assert/strict";
import type {
  EngineHit,
  EngineRequest,
  EngineResponse,
  SongRef,
  SongResult,
} from "../../src/lib/team-builder/engine/api";
import {
  createPtJob,
  ptAllComplete,
  ptComplete,
  ptCutoff,
  ptSongRanking,
  PtRunner,
  type PtJob,
} from "../../src/lib/team-builder/pt-recommendation";
import { fixture } from "./pt-recommendation.test";

const context = {
  server: "test",
  releaseId: "scheduler-test",
  sourceId: "synthetic",
  owner: "local",
  dataFingerprint: "scheduler-test",
  assumptions: ["synthetic rewards"],
};
const stats = { leaders: 0, memberNodes: 0, snapNodes: 0, candidates: 0, exact: 0, elapsedMs: 0 };

function input() {
  const request = fixture().request;
  if (request.goal.kind !== "event") throw new Error("event");
  request.goal.songs = [
    { songId: 1, difficulty: 0 },
    { songId: 1, difficulty: 1 },
    ...Array.from({ length: 7 }, (_, index) => ({ songId: index + 2, difficulty: 0 })),
  ];
  return request;
}

function expected(request: EngineRequest): EngineHit {
  if (request.goal.kind !== "event") throw new Error("event");
  const goal = request.goal;
  const song = goal.songs[0]!;
  const points = [110, 109, 108, 107, 106, 99, 106, 108];
  const medals = [210, 209, 208, 207, 206, 220, 207, 100];
  const direct =
    goal.route === "challenge"
      ? 10 * song.songId
      : (goal.measure === "points" ? points : medals)[song.songId - 1]! + song.difficulty * 5;
  const denominator = goal.cpExchange?.denominator ?? 1;
  const cp = goal.route === "live" ? 1 : 0;
  const key = direct * denominator + cp * (goal.cpExchange?.numerator ?? 0);
  return {
    song,
    members: ["m1", "m2", "m3", "m4", "m5"],
    snaps: [null, null, null, null, null],
    power: 100,
    slotPowers: [20, 20, 20, 20, 20],
    key,
    score: null,
    skipScore: null,
    potential: null,
    event: {
      mean: key / denominator,
      bonusPercent: 0,
      challengePoints: cp,
      perPlayMin: direct,
      perPlayMax: direct,
      directMean: direct,
      convertedMean: key / denominator - direct,
      rewardSum: direct * 120,
      comparisonSum: key * 120,
      orders: 120,
    },
  };
}

function reply(request: EngineRequest): EngineResponse {
  const hit = expected(request);
  const excluded = request.rewardCutoff !== undefined && hit.key < request.rewardCutoff;
  const result: SongResult = {
    song: hit.song,
    hits: excluded ? [] : [hit],
    proven: !excluded,
    bound: null,
    stats,
    ...(excluded ? { excludedBelow: request.rewardCutoff! } : {}),
  };
  return { results: [result], overall: result.hits, unknownCards: [], elapsedMs: 0 };
}

export async function verify() {
  const cases: string[] = [];
  const request = input();
  const cycle = { songs: [1, 2, 3].map((songId): SongRef => ({ songId, difficulty: 0 })), consumption: 200 };
  const job = await createPtJob(request, context, cycle);
  let saved: PtJob | null = null;
  const store = {
    save: async (value: PtJob) => {
      saved = structuredClone(value);
    },
    latest: async () => saved,
  };
  const calls: EngineRequest[] = [];
  const engine = {
    cancel: () => {},
    run: async (value: EngineRequest) => {
      calls.push(structuredClone(value));
      return reply(value);
    },
  };
  const run = (target: PtJob) =>
    new PtRunner(
      engine,
      store,
      () => {},
      () => assert.fail("storage"),
    ).run(target);
  await run(job);
  assert(ptComplete(job));
  assert(!ptAllComplete(job));
  const excluded = job.tasks.filter((task) => task.status === "pruned");
  assert.deepEqual(
    excluded.map((task) => `${task.measure}/${task.song.songId}`),
    ["points/6", "items/8"],
  );
  assert(excluded.every((task) => task.result!.proven === false && task.result!.hits.length === 0));
  assert(job.tasks.filter((task) => task.song.songId === 7).every((task) => task.status === "complete"));
  cases.push(
    "separate reward cutoffs preserve exact ties and only exclude strictly worse charts with explicit certificates",
  );

  for (const call of calls) {
    if (call.goal.kind !== "event") throw new Error("event");
    if (call.goal.route === "challenge" || call.goal.songs[0]!.songId <= 5) assert.equal(call.rewardCutoff, undefined);
  }
  for (let i = 0; i < calls.length; i += 2) {
    const a = calls[i]!.goal,
      b = calls[i + 1]!.goal;
    assert(a.kind === "event" && b.kind === "event");
    assert.equal(a.route, b.route);
    assert.deepEqual(a.songs, b.songs);
    assert.equal(a.measure, "points");
    assert.equal(b.measure, "items");
    assert.equal(a.route, i < 6 ? "challenge" : "live");
    if (a.route === "live") assert(a.cpExchange && b.cpExchange);
  }
  cases.push(
    "multiple difficulties do not create extra song slots; challenges finish first and objectives stay adjacent per chart",
  );

  const top = new Map(
    ["points", "items"].map((measure) => [
      measure,
      ptSongRanking(job, measure as "points" | "items")
        .slice(0, 5)
        .map((hit) => [hit.song!.songId, hit.song!.difficulty, hit.key]),
    ]),
  );
  const countBeforeResume = calls.length;
  const restored = structuredClone(saved!);
  await run(restored);
  assert.equal(calls.length, countBeforeResume);
  assert(ptComplete(restored));
  await new PtRunner(
    engine,
    store,
    () => {},
    () => assert.fail("storage"),
  ).run(restored, "all");
  assert.equal(calls.length - countBeforeResume, 2);
  assert(ptAllComplete(restored));
  assert.equal(restored.scope, "all");
  for (const measure of ["points", "items"] as const) {
    assert.deepEqual(
      ptSongRanking(restored, measure)
        .slice(0, 5)
        .map((hit) => [hit.song!.songId, hit.song!.difficulty, hit.key]),
      top.get(measure),
    );
    assert.equal(ptSongRanking(restored, measure).length, 8);
  }
  assert(calls.slice(countBeforeResume).every((call) => call.rewardCutoff === undefined));
  cases.push(
    "reload preserves exclusion proofs; calculating all revisits only excluded charts and matches the proven top five",
  );

  const legacy = await createPtJob(request, context, cycle);
  delete legacy.scope;
  legacy.tasks.sort((a, b) => a.measure.localeCompare(b.measure));
  const legacyStart = calls.length;
  await run(legacy);
  assert(ptAllComplete(legacy));
  assert.equal(legacy.scope, "all");
  assert(calls.slice(legacyStart).every((call) => call.rewardCutoff === undefined));
  cases.push("legacy checkpoints without a search scope retain exhaustive behavior and are safely reordered");

  const stopped = await createPtJob(request, context, cycle);
  const runner = new PtRunner(
    engine,
    store,
    (value) => {
      if (value.tasks.some((task) => task.status === "pruned")) runner.stop();
    },
    () => assert.fail("storage"),
  );
  await runner.run(stopped);
  assert(!ptComplete(stopped));
  assert(stopped.tasks.some((task) => task.status === "queued"));
  const stoppedCalls = calls.length;
  const completedOrExcluded = stopped.tasks.filter((task) =>
    ["complete", "empty", "pruned"].includes(task.status),
  ).length;
  const reloaded = structuredClone(saved!);
  await run(reloaded);
  assert(ptComplete(reloaded));
  assert.equal(calls.length - stoppedCalls, reloaded.tasks.length - completedOrExcluded);
  cases.push("stop and refresh retain completed and excluded charts without treating queued work as proof");

  const bad = await createPtJob(request, context);
  const badEngine = {
    cancel: () => {},
    run: async (value: EngineRequest): Promise<EngineResponse> => {
      const result = reply(value);
      if (value.rewardCutoff !== undefined) {
        result.results[0] = { ...result.results[0]!, hits: [], proven: false, excludedBelow: value.rewardCutoff + 1 };
        result.overall = [];
      }
      return result;
    },
  };
  await new PtRunner(
    badEngine,
    store,
    () => {},
    () => assert.fail("storage"),
  ).run(bad);
  assert(bad.tasks.some((task) => task.status === "failed" && task.error === "pt-invalid-exclusion"));
  assert(!ptComplete(bad));
  const forged = structuredClone(job);
  forged.tasks.find((task) => task.status === "pruned")!.result!.excludedBelow = ptCutoff(forged, "points")! + 1;
  assert(!ptComplete(forged));
  const repairedStart = calls.length;
  await run(forged);
  assert(ptComplete(forged));
  assert.equal(calls.length - repairedStart, 1);
  const unproven = await createPtJob(request, context);
  const boundOnly = {
    cancel: () => {},
    run: async (value: EngineRequest): Promise<EngineResponse> => {
      const result = reply(value);
      result.results[0] = { ...result.results[0]!, hits: [], proven: false, bound: 0 };
      delete result.results[0].excludedBelow;
      result.overall = [];
      return result;
    },
  };
  await new PtRunner(
    boundOnly,
    store,
    () => {},
    () => assert.fail("storage"),
  ).run(unproven);
  assert(unproven.tasks.every((task) => task.status === "failed" && task.error === "pt-incomplete"));
  assert(!ptComplete(unproven));
  cases.push("mismatched exclusion certificates fail explicitly and cannot fabricate a complete top-five result");

  return {
    passed: true,
    cases,
    evidence: "Deterministic scheduler oracle; engine bound correctness is verified in separate search tests.",
  };
}
