import assert from "node:assert/strict";
import { fixture } from "./pt-recommendation.test";
import { resolveBox } from "../../src/lib/team-builder/engine/box";
import { ChartCache, playerState, runEngine, type SongRef } from "../../src/lib/team-builder/engine/api";
import {
  searchTeams,
  NO_CONSTRAINTS,
  type ObjectiveAdapter,
  type Team,
} from "../../src/lib/team-builder/engine/search";

export async function verify() {
  const cases: string[] = [];
  const { master, request, charts } = fixture();
  const original = master.snaps.get(1)!;
  master.snaps = new Map(Array.from({ length: 20 }, (_, i) => [i + 1, { ...original, id: i + 1 }]));
  request.members = request.members.slice(0, 5);
  request.snaps = [...master.snaps.keys()].map((cardId) => ({ key: `s${cardId}`, cardId, level: 1, rank: 1 }));
  const box = resolveBox(master, request.members, request.snaps, "min");
  const plateau: ObjectiveAdapter<null> = {
    skill: () => [0, 0],
    memberBonus: () => 0,
    snapBonus: () => 0,
    bound: () => 100,
    interval: () => [100, 100],
    exact: () => ({ key: 100, detail: null }),
  };
  const base = {
    master,
    player: playerState(master, request.player),
    ...box,
    music: null,
    k: 1,
    constraints: { ...NO_CONSTRAINTS, leader: 0 },
    disableSnapDominance: true,
    streaming: true,
  };
  const out = searchTeams({ ...base, objective: plateau });
  assert(out.proven);
  assert.equal(out.hits[0]!.key, 100);
  assert(out.stats.candidates < 10, "equal-bound photo permutations should not accumulate");
  assert(out.stats.exact < 10);
  cases.push("20 photos: plateau that exhausted a 96 MB heap now proves its optimum after one exact candidate");

  // A deliberately loose interval leaves more than 4096 viable assignments. The winner arrives last.
  // Streaming must evaluate it, not stop at an arbitrary candidate count.
  const smallBox = { ...box, snaps: box.snaps.slice(0, 8) };
  let exactCalls = 0;
  const lateWinner = (team: Team) => (team.snaps.every((j) => j === -1) ? 90 : 10);
  const loose: ObjectiveAdapter<null> = {
    ...plateau,
    interval: () => [0, 100],
    exact: (team) => {
      exactCalls++;
      return { key: lateWinner(team), detail: null };
    },
  };
  const late = searchTeams({ ...base, ...smallBox, objective: loose });
  assert(late.proven);
  assert.equal(late.hits[0]!.key, 90);
  assert(exactCalls > 4096);
  assert(late.hits[0]!.team.snaps.every((j) => j === -1));
  cases.push(`late winner after ${exactCalls} exact evaluations is retained; no candidate-count cutoff`);

  // Independently enumerate six choose five member sets. Multiple leaders are one member set.
  const f = fixture();
  const six = resolveBox(f.master, f.request.members, [], "min");
  const value = (team: Team) => team.members.reduce((sum, i) => sum + (i + 1) ** 2, 0);
  const objective: ObjectiveAdapter<null> = {
    ...plateau,
    bound: () => 1000,
    interval: () => [0, 1000],
    exact: (team) => ({ key: value(team), detail: null }),
  };
  for (const streaming of [false, true])
    for (const tied of [false, true]) {
      const input = {
        ...base,
        master: f.master,
        player: playerState(f.master, f.request.player),
        ...six,
        k: 3,
        constraints: NO_CONSTRAINTS,
        streaming,
        objective: tied ? plateau : objective,
      };
      const result = searchTeams(input);
      const expected = Array.from({ length: 6 }, (_, omitted) =>
        Array.from({ length: 6 }, (_, i) => i)
          .filter((i) => i !== omitted)
          .reduce((sum, i) => sum + (i + 1) ** 2, 0),
      )
        .sort((a, b) => b - a)
        .slice(0, 3);
      assert.deepEqual(
        result.hits.map((h) => h.key),
        tied ? [100, 100, 100] : expected,
      );
      assert.equal(new Set(result.hits.map((h) => [...h.team.members].sort().join())).size, 3);
      assert(result.proven);
    }
  cases.push(
    "Top-K retains distinct member sets, including ties and leaders; buffered and streaming modes match independent enumeration",
  );

  let clock = 0;
  const originalNow = performance.now.bind(performance);
  Object.defineProperty(performance, "now", { value: () => ++clock, configurable: true });
  try {
    const timed = searchTeams({ ...base, ...smallBox, objective: loose, timeLimitMs: 3 });
    assert.equal(timed.proven, false);
    assert(timed.bound! >= 90);
  } finally {
    Object.defineProperty(performance, "now", { value: originalNow, configurable: true });
  }
  cases.push("time-limited streaming returns an unproven result and a valid remaining upper bound");

  const cacheFixture = fixture();
  const template = cacheFixture.master.songs.get(1)!;
  cacheFixture.master.songs = new Map(Array.from({ length: 32 }, (_, i) => [i + 1, { ...template, id: i + 1 }]));
  let loads = 0;
  const cache = new ChartCache(cacheFixture.master, async (_, ref) => {
    loads++;
    return charts(ref);
  });
  const ref = { songId: 1, difficulty: 0 };
  const first = await cache.chart(ref);
  for (let songId = 2; songId <= 32; songId++) cache.live(await cache.chart({ songId, difficulty: 0 }));
  const again = await cache.chart(ref);
  assert.equal(loads, 33);
  assert.notEqual(first, again);
  assert.deepEqual(first, again);
  const r = cacheFixture.request;
  const one = await runEngine(cacheFixture.master, cache, r);
  for (let songId = 2; songId <= 8; songId++) await cache.chart({ songId, difficulty: 0 });
  const reloaded = await runEngine(cacheFixture.master, cache, r);
  assert.equal(one.overall[0]!.key, reloaded.overall[0]!.key);
  cases.push("32-chart run evicts old chart data; reloaded charts and optimal rewards stay identical");

  let rejectOld!: (reason: Error) => void;
  let firstLoad = true;
  const pending = new ChartCache(cacheFixture.master, async (_, chart: SongRef) => {
    if (chart.songId === 1 && firstLoad) {
      firstLoad = false;
      return await new Promise<ReturnType<typeof charts>>((_, reject) => {
        rejectOld = reject;
      });
    }
    return charts(chart);
  });
  const old = pending.source(ref);
  const rejection = assert.rejects(old, /old-load/);
  for (let songId = 2; songId <= 6; songId++) await pending.source({ songId, difficulty: 0 });
  const fresh = pending.source(ref);
  await fresh;
  rejectOld(new Error("old-load"));
  await rejection;
  assert.equal(pending.source(ref), fresh);
  cases.push("late failed evicted chart load cannot erase its newer successful retry");
  return { passed: true, cases, plateauStats: out.stats, heapUsed: process.memoryUsage().heapUsed };
}
