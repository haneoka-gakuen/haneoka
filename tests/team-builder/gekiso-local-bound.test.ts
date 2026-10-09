import assert from "node:assert/strict";
import { fixture } from "./pt-recommendation.test";
import { performanceFixture } from "./performance-fixtures";
import { ChartCache, eventRoute, musicView, playerState } from "../../src/lib/team-builder/engine/api";
import { resolveBox } from "../../src/lib/team-builder/engine/box";
import { gekisoContext, scoreOrdersGekiso } from "../../src/lib/team-builder/engine/gekiso";
import { gekisoScoreBound } from "../../src/lib/team-builder/engine/gekiso-score-bound";
import { gekisoRewardObjective } from "../../src/lib/team-builder/engine/gekiso-reward-objective";
import { performer } from "../../src/lib/team-builder/engine/full/deck";
import { noteFactorMill } from "../../src/lib/team-builder/engine/full/score";
import { teamPower } from "../../src/lib/team-builder/engine/power";
import { resolveSlotSkill } from "../../src/lib/team-builder/engine/skills";
import { compileChart } from "../../src/lib/team-builder/engine/chart";
import type { SkillEffectRow } from "../../src/lib/team-builder/engine/master";

export async function verify() {
  const cases: string[] = [];
  let boundedOrders = 0;
  let tightened = 0;
  // Five actual pairings are a stricter relaxation than allowing every member to borrow every photo.
  const plain = performanceFixture(fixture(), "gekiso-small");
  const plainCache = new ChartCache(plain.master, async (_, song) => plain.charts(song));
  const plainChart = await plainCache.gekiso({ songId: 1, difficulty: 0 }, { great: 0, just: 0.25 }, 1);
  const plainBox = resolveBox(plain.master, plain.request.members, plain.request.snaps, "min");
  const global = gekisoScoreBound(plain.master, plainChart, plainBox.members, plainBox.snaps);
  for (let omit = 0; omit < 6; omit++) {
    const chosen = plainBox.members.filter((_, i) => i !== omit);
    for (let photo = -1; photo < 5; photo++) {
      const equipped = chosen.map((_, slot) => (slot === photo ? plainBox.snaps[0]! : null));
      const local = gekisoScoreBound(plain.master, plainChart, chosen, [], equipped);
      assert(local.supported);
      const power = teamPower(
        plain.master,
        playerState(plain.master, plain.request.player),
        chosen,
        equipped,
        0,
        musicView(plain.master, 1, null),
        [],
      ).total;
      assert(local.score(power) <= global.score(power));
      if (local.score(power) < global.score(power)) tightened++;
      const context = gekisoContext(
        plain.master,
        plainChart,
        chosen.map((member, slot) => performer(plain.master, member, equipped[slot]!)),
        [0],
      );
      const scores = scoreOrdersGekiso(
        plain.master,
        plainChart,
        context,
        power,
        chosen.map((member, slot) => resolveSlotSkill(plain.master, member, equipped[slot]!)),
      );
      for (const score of scores.scores) {
        assert(score <= local.score(power));
        boundedOrders++;
      }
    }
  }
  assert(tightened > 0);
  assert(!gekisoScoreBound(plain.master, plainChart, plainBox.members, [], [null]).supported);
  cases.push(
    "all 36 member/photo selections: actual-pair bounds cover 120 orders and tighten the inventory-wide bound without borrowing other slots' photos",
  );

  // 2000/2001 only enter the finite bound with a proof of the number and magnitude of factor commands.
  let activeEffects = 0;
  for (const seconds of [0, 0.2, 20]) {
    const b = performanceFixture(fixture(), "gekiso-fallback");
    b.master.gekisoSkills = new Map(
      [...b.master.gekisoSkills].map(([id, skill]) => [
        id,
        { ...skill, missionType: 4, effects: skill.effects.map((row) => ({ ...row, seconds })) },
      ]),
    );
    b.master.gekisoSupportSkills = new Map(
      [...b.master.gekisoSupportSkills].map(([id, skill]) => [
        id,
        {
          ...skill,
          missionType: 4,
          effects: skill.effects.map((row) => ({
            ...row,
            seconds,
            executeLimit: seconds === 0.2 ? 1 : 0,
            releaseGroup: seconds === 0 ? 9000 : 0,
          })),
        },
      ]),
    );
    const cache = new ChartCache(b.master, async (_, song) => b.charts(song));
    const chart = await cache.gekiso({ songId: 1, difficulty: 0 }, { great: 0, just: 0.25 }, 1);
    const box = resolveBox(b.master, b.request.members, b.request.snaps, "min");
    assert(gekisoScoreBound(b.master, chart, box.members, box.snaps).supported);
    for (let omit = 0; omit < 6; omit++) {
      const chosen = box.members.filter((_, i) => i !== omit);
      for (const photo of [-1, 0, 4]) {
        const equipped = chosen.map((_, slot) => (slot === photo ? box.snaps[0]! : null));
        const local = gekisoScoreBound(b.master, chart, chosen, [], equipped);
        assert(local.supported);
        const power = teamPower(
          b.master,
          playerState(b.master, b.request.player),
          chosen,
          equipped,
          0,
          musicView(b.master, 1, null),
          [],
        ).total;
        for (let seed = 0; seed < 4; seed++) {
          const context = gekisoContext(
            b.master,
            chart,
            chosen.map((member, slot) => performer(b.master, member, equipped[slot]!)),
            [seed],
          );
          if ([...context.up].some((value, i) => value > context.luck[i]!)) activeEffects++;
          const scores = scoreOrdersGekiso(
            b.master,
            chart,
            context,
            power,
            chosen.map((member, slot) => resolveSlotSkill(b.master, member, equipped[slot]!)),
          );
          for (const score of scores.scores) {
            assert(
              score <= local.score(power),
              `${score} > ${local.score(power)}; seconds=${seconds}, photo=${photo}, seed=${seed}`,
            );
            boundedOrders++;
          }
        }
      }
    }
  }
  assert(activeEffects > 0);
  cases.push(
    "2000 plus fixed-count 2001: all member omissions, three photo bindings, four native Luck draws and 120 orders remain bounded with stacking, short expiry, release and execution limits",
  );

  const b = performanceFixture(fixture(), "gekiso-fallback");
  const cache = new ChartCache(b.master, async (_, song) => b.charts(song));
  const chart = await cache.gekiso({ songId: 1, difficulty: 0 }, { great: 0, just: 0.25 }, 1);
  const baseRow = b.master.gekisoSkills.get(901)!.effects[0]!;
  const supportRow = b.master.gekisoSupportSkills.get(902)!.effects[0]!;
  const fallback = (row: SkillEffectRow) => {
    b.master.gekisoSkills = new Map([[901, { missionType: 2, effects: [row] }]]);
    const box = resolveBox(b.master, b.request.members, b.request.snaps, "min");
    const bound = gekisoScoreBound(b.master, chart, box.members, box.snaps);
    assert(!bound.supported);
    assert.equal(bound.score(100000), Infinity);
  };
  for (const patch of [
    { type: 2002 },
    { type: 2005 },
    { type: 99999 },
    { triggerType: 2 },
    { resetGroup: 9000 },
    { triggerGroup: 0 },
    { value: -1 },
    { value: Infinity },
    { value: 1e20 },
  ])
    fallback({ ...baseRow, ...patch });
  const startCondition = b.master.conditions.get(9000)!;
  b.master.conditions = new Map(b.master.conditions).set(9100, { ...startCondition, id: 9100, positive: false });
  for (const sets of [[[9000, 9000]], [[9000], [9000]], [[9100]]]) {
    b.master.conditionSets = new Map(b.master.conditionSets).set(9100, sets);
    fallback({ ...baseRow, triggerGroup: 9100 });
  }
  b.master.cumulative = new Map(b.master.cumulative).set(9999, {
    id: 9999,
    type: 7000,
    values: [1],
    targetIds: [],
    cap: 10,
  });
  fallback({ ...supportRow, cumulativeId: 9999 });
  const fixedCount = b.master.cumulative.get(9001)!;
  for (const cap of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    b.master.cumulative = new Map(b.master.cumulative).set(9998, { ...fixedCount, id: 9998, cap });
    fallback({ ...supportRow, cumulativeId: 9998 });
  }
  b.master.cumulative = new Map(b.master.cumulative).set(9998, { ...fixedCount, id: 9998, type: 3000.5 });
  fallback({ ...supportRow, cumulativeId: 9998 });
  b.master.gekisoSkills = new Map([[901, { missionType: 2, effects: [baseRow] }]]);
  b.master.gekisoSupportSkills = new Map([[902, { missionType: 2, effects: [{ ...supportRow, cumulativeId: 9999 }] }]]);
  const dynamicBox = resolveBox(b.master, b.request.members, b.request.snaps, "min");
  assert(!gekisoScoreBound(b.master, chart, dynamicBox.members, dynamicBox.snaps).supported);
  assert(
    gekisoScoreBound(b.master, chart, dynamicBox.members.slice(0, 5), [], [null, null, null, null, null]).supported,
  );
  assert(
    !gekisoScoreBound(
      b.master,
      chart,
      dynamicBox.members.slice(0, 5),
      [],
      [dynamicBox.snaps[0]!, null, null, null, null],
    ).supported,
  );
  b.master.gekisoSupportSkills = new Map([[902, { missionType: 2, effects: [supportRow] }]]);
  // A fixed count can still cause repeated native command replacement if float->mill->float loses a bit.
  let lossy = 1;
  while (
    lossy < 100000 &&
    Math.fround(Math.fround(noteFactorMill(Math.fround(Math.fround(lossy) / 10000))) / 100000) ===
      Math.fround(Math.fround(lossy) / 10000)
  )
    lossy++;
  assert(lossy < 100000);
  fallback({ ...supportRow, value: lossy, maxValue: 0 });
  cases.push(
    "dynamic member/photo counts, sustained/reset/compound/negative triggers, unknown/negative/nonfinite values and quantization-driven repeated replacements all keep Infinity fallback",
  );

  // One unsupported card in the inventory leaves safe teams' local bounds intact.
  b.master.gekisoSkills = new Map([[901, { missionType: 2, effects: [{ ...baseRow, type: 2002 }] }]]);
  b.master.members = new Map(
    [...b.master.members].map(([id, card]) => [id, { ...card, gekisoSkillId: id === 6 ? 901 : 0 }]),
  );
  b.master.snaps = new Map(
    [...b.master.snaps].map(([id, card]) => [id, { ...card, gekisoSupportSkillIds: [0, 0] as const }]),
  );
  const box = resolveBox(b.master, b.request.members, b.request.snaps, "min");
  const team = { members: [0, 1, 2, 3, 4], snaps: [-1, -1, -1, -1, -1] };
  const power = 20000;
  const local = gekisoScoreBound(
    b.master,
    chart,
    box.members.slice(0, 5),
    [],
    team.snaps.map(() => null),
  );
  const threshold = Math.floor(local.score(power)) + 1;
  assert(Number.isFinite(threshold));
  const song = b.master.songs.get(1)!;
  const compiled = compileChart(b.master, song, song.difficulties[0]!, b.charts({ songId: 1, difficulty: 0 }));
  compiled.ranks = [
    { rank: 2, required: 0, battleRequired: 0 },
    { rank: 3, required: threshold, battleRequired: threshold },
  ];
  const objective = gekisoRewardObjective({
    master: b.master,
    members: box.members,
    snaps: box.snaps,
    chart: compiled,
    gekiso: chart,
    route: eventRoute(b.master, 1, "live", 3),
    measure: "points",
    options: { just: 0.25, rank: 1, luckSamples: 2 },
  });
  const totals = { power, skill: 0, skillLow: 0, bonus: 0 };
  assert(objective.bound(totals) > objective.leafBound!(team, totals));
  assert.equal(objective.leafBound!(team, totals), objective.interval(team, totals)[1]);
  const incompatible = { ...team, members: [0, 1, 2, 3, 5] };
  assert.equal(objective.leafBound!(incompatible, totals), objective.bound(totals));
  const reversed = { members: [...team.members].reverse(), snaps: [...team.snaps].reverse() };
  assert.equal(objective.leafBound!(team, totals), objective.leafBound!(reversed, totals));
  cases.push(
    "inventory-wide unsupported effect no longer contaminates an actual safe team; leaf and interval respect the reward threshold and cache pairings independently of leader order",
  );
  return { passed: true, boundedOrders, activeEffects, tightened, cases };
}
