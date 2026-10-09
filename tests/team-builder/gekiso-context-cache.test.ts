import assert from "node:assert/strict";
import { fixture } from "./pt-recommendation.test";
import { performanceFixture } from "./performance-fixtures";
import { ChartCache } from "../../src/lib/team-builder/engine/api";
import { resolveBox } from "../../src/lib/team-builder/engine/box";
import { performer } from "../../src/lib/team-builder/engine/full/deck";
import { GekisoContextCache } from "../../src/lib/team-builder/engine/gekiso-context-cache";
import { gekisoContext, scoreOrdersGekiso } from "../../src/lib/team-builder/engine/gekiso";
import { resolveSlotSkill } from "../../src/lib/team-builder/engine/skills";

export async function verify() {
  const cases: string[] = [];
  const base = performanceFixture(fixture(), "gekiso-photos");
  const charts = new ChartCache(base.master, async (_, song) => base.charts(song));
  const chart = await charts.gekiso({ songId: 1, difficulty: 0 }, { great: 0, just: 0.25 }, 1);
  const box = resolveBox(base.master, base.request.members, base.request.snaps, "min");
  const members = box.members.slice(0, 5);
  const deck = members.map((m) => performer(base.master, m, box.snaps[0] ?? null));
  const skills = members.map((m) => resolveSlotSkill(base.master, m, box.snaps[0] ?? null));
  const cache = new GekisoContextCache();
  const prefix = cache.prefix(chart, deck);
  const trace = cache.context(prefix, 0, () => gekisoContext(base.master, chart, deck, [0]));
  const pristine = structuredClone(trace);
  const changedLiveSkills = structuredClone(deck);
  changedLiveSkills[0]!.liveSkill = [123456, 9];
  changedLiveSkills[0]!.supportSkills = [[987654, 7]];
  assert.equal(cache.prefix(chart, changedLiveSkills), prefix);
  assert.deepEqual(gekisoContext(base.master, chart, changedLiveSkills, [0]), trace);
  assert.equal(
    cache.context(prefix, 0, () => {
      throw new Error("cache miss");
    }),
    trace,
  );
  for (const power of [1, 1000, 20000, 150000]) {
    const reused = scoreOrdersGekiso(base.master, chart, trace, power, skills);
    const fresh = scoreOrdersGekiso(base.master, chart, gekisoContext(base.master, chart, deck, [0]), power, skills);
    assert.deepEqual(reused, fresh);
  }
  assert.deepEqual(trace, pristine, "scoring must not mutate a reusable trace");
  cases.push(
    "native traces omit only live/support skills and final power; all 120 scores match fresh simulation at four powers without mutating the trace",
  );

  const changeDeck = (change: (value: typeof deck) => void) => {
    const copy = structuredClone(deck);
    change(copy);
    assert.notEqual(cache.prefix(chart, copy), prefix);
  };
  changeDeck((d) => {
    d[0]!.characterId += 100;
  });
  changeDeck((d) => {
    d[0]!.bandId += 100;
  });
  changeDeck((d) => {
    d[0]!.tagIds = [99999];
  });
  changeDeck((d) => {
    d[0]!.cardType += 1;
  });
  changeDeck((d) => {
    d[0]!.liveSkillCategories = [99999];
  });
  changeDeck((d) => {
    d[0]!.gekisouSkillCategories = [99999];
  });
  changeDeck((d) => {
    d[0]!.gekisouMissionType += 1;
  });
  changeDeck((d) => {
    d[0]!.gekisouSkill = [123456, 1];
  });
  changeDeck((d) => {
    d[0]!.gekisouSupportSkills = [[123456, 1]];
  });
  changeDeck((d) => {
    d[0]!.missionOnly = 1;
  });
  changeDeck((d) => {
    d.reverse();
  });
  const changedChart = await charts.gekiso({ songId: 1, difficulty: 0 }, { great: 0, just: 0.5 }, 1);
  assert.notEqual(cache.prefix(changedChart, deck), prefix);
  const nextTrace = cache.context(prefix, 1, () => gekisoContext(base.master, chart, deck, [1]));
  assert.deepEqual(nextTrace, gekisoContext(base.master, chart, deck, [1]));
  assert.equal(cache.computations, 2);
  assert.equal(cache.hits, 1);
  cases.push(
    "chart/JUST, native seed, performer order, all condition metadata and Gekisou effects isolate cache entries",
  );

  const bounded = new GekisoContextCache(20_000);
  const boundedPrefix = bounded.prefix(chart, deck);
  for (let seed = 0; seed < 100; seed++) bounded.context(boundedPrefix, seed, () => structuredClone(trace));
  assert(bounded.bytes <= bounded.maxBytes);
  assert(bounded.size < 100 && bounded.size > 0);
  const computations = bounded.computations;
  bounded.context(boundedPrefix, 0, () => structuredClone(trace));
  assert.equal(bounded.computations, computations + 1);
  for (let i = 0; i < 100; i++) {
    const varied = structuredClone(deck);
    varied[0]!.characterId = i + 1000;
    bounded.prefix(chart, varied);
  }
  assert(bounded.bytes <= bounded.maxBytes);
  assert.notEqual(bounded.prefix(chart, deck), boundedPrefix, "evicted identity cannot reuse a stale id");
  const disabled = new GekisoContextCache(0);
  for (let i = 0; i < 2; i++) disabled.context(disabled.prefix(chart, deck), 0, () => structuredClone(trace));
  assert.equal(disabled.size, 0);
  assert.equal(disabled.bytes, 0);
  assert.equal(disabled.computations, 2);
  cases.push(
    "bounded trace and identity storage evicts/recomputes; zero budget works without retaining buffers or dropping search candidates",
  );
  return { passed: true, cases };
}
