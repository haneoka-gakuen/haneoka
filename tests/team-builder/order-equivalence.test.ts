import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture } from "./pt-recommendation.test";
import { performanceFixture } from "./performance-fixtures";
import { compileChart, type ChartSource } from "../../src/lib/team-builder/engine/chart";
import {
  ORDERS,
  prepareLive,
  playJudgements,
  scoreOrdersAP,
  scoreOrdersPlay,
  type OrderScores,
} from "../../src/lib/team-builder/engine/live";
import { gekisoChart, gekisoContext, scoreOrdersGekiso } from "../../src/lib/team-builder/engine/gekiso";
import { resolveBox } from "../../src/lib/team-builder/engine/box";
import { performer } from "../../src/lib/team-builder/engine/full/deck";
import { skillOrderPlan, restoreOrderScores } from "../../src/lib/team-builder/engine/order-equivalence";
import type { SlotSkill } from "../../src/lib/team-builder/engine/skills";

const skill = (): SlotSkill => ({
  effects: [
    { type: 2000, delta: 38500, seconds: 1.7, gate: { kind: "always" }, judgements: [] },
    {
      type: 2004,
      delta: 12000,
      seconds: 1.125,
      gate: { kind: "life-at-least", value: 600, positive: true },
      judgements: [4, 5, 6],
    },
  ],
  extensionMs: 300.3,
  recovery: 130,
  convert: { judgements: [4, 3], limit: 4 },
});

/** Shared inputs for the frozen pre-change scorer oracle and ordinary regression tests. */
export function scoringFixtures() {
  return [70, 1200].map((count) => {
    const { master, request } = performanceFixture(fixture(), "gekiso-fallback");
    master.live.judgePercent = new Map([
      [1, 110],
      [2, 100],
      [3, 80],
      [4, 50],
      [5, 30],
      [6, 0],
    ]);
    master.live.damage = [0, 80, 40, 0, 0, 0, 0];
    master.live.lifeBase = 1000;
    master.live.gekiso.luckBasePoints = [1, 2, 3, 4, 5, 6].map((judgement) => ({
      category: 0,
      judgement,
      weight: 1,
      point: 50,
    }));
    const source: ChartSource = {
      durationMs: count * 100 + 1000,
      notes: Array.from({ length: count }, (_, i) => ({
        timeMs: i * 100,
        operateType: 1,
        judgementType: 1,
        judged: true,
      })),
      // Deliberately include simultaneous and out-of-index-order activations.
      skillTimesMs: count === 70 ? [100, 1500, 4300, 2900, 4300] : [1020, 20700, 66000, 41900, 97500],
      feverMs:
        count === 70
          ? [
              [500, 1600],
              [2500, 3600],
              [4500, 5600],
            ]
          : [
              [500, 20000],
              [35000, 55000],
              [85000, 115000],
            ],
    };
    source.enumeration = source.notes.map((note) => ({
      op: note.operateType,
      timeMs: note.timeMs,
      judgementType: note.judgementType,
    }));
    const song = master.songs.get(1)!;
    const chart = compileChart(master, song, song.difficulties[0]!, source);
    const live = prepareLive(master, chart);
    const gk = gekisoChart(master, source, 27, [2, 3, 1], { just: 0.25, great: 0.15, missEvery: 13 }, 1);
    const box = resolveBox(master, request.members, request.snaps, "min");
    const deck = box.members
      .slice(0, 5)
      .map((member, index) => performer(master, member, index === 0 ? box.snaps[0]! : null));
    const contexts = [[0], [19461103], [0, 19461103]].map((seeds) => gekisoContext(master, gk, deck, seeds));
    const choices = Array.from({ length: 5 }, (_, i) => {
      const value = skill();
      value.effects = value.effects.map((effect) => ({ ...effect, delta: effect.delta + i * 937 }));
      value.extensionMs += i * 33.3;
      value.recovery += i * 75;
      if (i === 1) value.convert!.limit = Infinity;
      if (i === 2) value.convert = null;
      if (i === 3) value.effects = [...value.effects].reverse();
      if (i === 4)
        value.effects = value.effects.map((effect) => ({
          ...effect,
          gate: { kind: "life-at-least", value: 650, positive: false },
        }));
      return value;
    });
    const groups = [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 1, 1],
      [0, 1, 2, 3, 4],
      [0, 1, 0, 1, 2],
    ].map((indices) => indices.map((index) => structuredClone(choices[index]!)));
    const judgements = playJudgements(count, { great: 0.2, good: 0.1, bad: 0.05, miss: 0, missEvery: 13 });
    return { count, master, live, gk, contexts, groups, judgements };
  });
}

const settings = [
  { assist: 1, luckPercent: 100 },
  { assist: 0.875, luckPercent: 173 },
];
const power = 543210;

function digest(scores: readonly OrderScores[]): string {
  const hash = createHash("sha256");
  for (const score of scores) {
    hash.update(Buffer.from(score.scores.buffer, score.scores.byteOffset, score.scores.byteLength));
    hash.update(JSON.stringify([score.power, score.mean, score.min, score.max, score.minOrder, score.maxOrder]));
  }
  return hash.digest("hex");
}

export function verifyAgainst(reference: {
  scoreOrdersAP: typeof scoreOrdersAP;
  scoreOrdersPlay: typeof scoreOrdersPlay;
  scoreOrdersGekiso: typeof scoreOrdersGekiso;
}) {
  const results: OrderScores[] = [];
  for (const input of scoringFixtures()) {
    for (const slots of input.groups) {
      for (const setting of settings) {
        const ap = scoreOrdersAP(input.live, power, slots, setting);
        assert.deepEqual(ap, reference.scoreOrdersAP(input.live, power, slots, setting));
        results.push(ap);
        const play = scoreOrdersPlay(input.live, power, slots, input.judgements, setting);
        assert.deepEqual(play, reference.scoreOrdersPlay(input.live, power, slots, input.judgements, setting));
        results.push(play);
      }
      for (const context of input.contexts) {
        const gk = scoreOrdersGekiso(input.master, input.gk, context, power, slots);
        assert.deepEqual(gk, reference.scoreOrdersGekiso(input.master, input.gk, context, power, slots));
        results.push(gk);
      }
    }
  }
  return { arrays: results.length, orderScores: results.length * 120, digest: digest(results) };
}

export function verify() {
  const cases: string[] = [];
  const base = skill();
  const mutations: ((value: SlotSkill) => void)[] = [
    (value) => {
      value.extensionMs++;
    },
    (value) => {
      value.recovery++;
    },
    (value) => {
      value.convert = null;
    },
    (value) => {
      value.convert!.limit = Infinity;
    },
    (value) => {
      value.convert!.judgements = [3, 4];
    },
    (value) => {
      value.convert!.judgements = [4];
    },
    (value) => {
      value.effects = value.effects.slice(0, 1);
    },
    (value) => {
      value.effects = [...value.effects].reverse();
    },
    (value) => {
      value.effects[0]!.type = 2004;
    },
    (value) => {
      value.effects[0]!.delta++;
    },
    (value) => {
      value.effects[0]!.seconds += 0.001;
    },
    (value) => {
      value.effects[0]!.gate = { kind: "never" };
    },
    (value) => {
      value.effects[1]!.gate = { kind: "life-at-least", value: 601, positive: true };
    },
    (value) => {
      value.effects[1]!.gate = { kind: "life-at-least", value: 600, positive: false };
    },
    (value) => {
      value.effects[1]!.judgements = [4, 5];
    },
    (value) => {
      value.effects[1]!.judgements = [6, 5, 4];
    },
  ];
  assert.equal(skillOrderPlan(Array.from({ length: 5 }, () => structuredClone(base))).representatives.length, 1);
  for (const mutate of mutations) {
    const different = structuredClone(base);
    mutate(different);
    const slots = [base, base, base, different, structuredClone(different)];
    assert.equal(skillOrderPlan(slots).representatives.length, 10);
  }
  cases.push(
    "all resolved fields distinguish skill classes, including effect order, gates, recovery, conversion and exact duration",
  );

  const partitions: number[][] = [];
  const visit = (groups: number[], next: number) => {
    if (groups.length === 5) partitions.push(groups);
    else for (let group = 0; group <= next; group++) visit([...groups, group], Math.max(next, group + 1));
  };
  visit([0], 1);
  assert.equal(partitions.length, 52);
  const factorial = (n: number): number => (n < 2 ? 1 : n * factorial(n - 1));
  for (const groups of partitions) {
    const slots = groups.map((group) => ({ ...structuredClone(base), recovery: group }));
    const plan = skillOrderPlan(slots);
    const counts = [...new Set(groups)].map((group) => groups.filter((value) => value === group).length);
    assert.equal(plan.representatives.length, 120 / counts.reduce((product, count) => product * factorial(count), 1));
    const values = new Float64Array(120);
    for (const representative of plan.representatives) values[representative] = representative * 31 + 0.25;
    restoreOrderScores(values, plan);
    ORDERS.forEach((order, index) => {
      const representative = plan.sources[index]!;
      assert(representative <= index);
      assert.deepEqual(
        ORDERS[representative]!.map((slot) => groups[slot]),
        order.map((slot) => groups[slot]),
      );
      assert.equal(values[index], representative * 31 + 0.25);
    });
  }
  cases.push(
    "all 52 five-slot partitions preserve 120 order indices and multiplicities; AAAAA/A A A B B/ABCDE need 1/10/120 scores",
  );

  const fixtures = scoringFixtures();
  let debugCalls = 0;
  const scored: OrderScores[] = [];
  const permutation = [4, 2, 1, 3, 0];
  const orderIndices = new Map(ORDERS.map((order, index) => [order.join(), index]));
  for (const input of fixtures) {
    for (const slots of input.groups) {
      const permuted = permutation.map((index) => slots[index]!);
      for (const setting of settings) {
        const ap = scoreOrdersAP(input.live, power, slots, setting);
        const play = scoreOrdersPlay(input.live, power, slots, input.judgements, setting);
        scored.push(ap, play);
        for (const [original, rearranged] of [
          [ap, scoreOrdersAP(input.live, power, permuted, setting)],
          [play, scoreOrdersPlay(input.live, power, permuted, input.judgements, setting)],
        ] as const) {
          ORDERS.forEach((order, index) => {
            const originalIndex = orderIndices.get(order.map((slot) => permutation[slot]).join())!;
            assert.equal(rearranged.scores[index], original.scores[originalIndex]);
          });
          assert.equal(rearranged.mean, original.mean);
        }
      }
      for (const context of input.contexts) {
        const reduced = scoreOrdersGekiso(input.master, input.gk, context, power, slots);
        scored.push(reduced);
        const start = debugCalls;
        const complete = scoreOrdersGekiso(input.master, input.gk, context, power, slots, (order, note) => {
          assert.equal(order, Math.floor((debugCalls - start) / input.count));
          assert.equal(note, (debugCalls - start) % input.count);
          debugCalls++;
        });
        assert.deepEqual(reduced, complete);
      }
    }
  }
  cases.push(
    "70- and 1200-note AP and judgement plays preserve every order under slot permutations with life gates, conversion, recovery, assist and Luck settings",
  );
  cases.push(
    "Gekisou native Luck draws and averaged contexts preserve all scores and exact extrema; debug emits every original order/note",
  );
  // Recorded only after a deep, per-index comparison with the frozen pre-optimization scorers.
  assert.equal(digest(scored), "9444a44f27e2d0796be117397e03640a8a9f9bf56a1751d0c29fa4b733ba472d");
  cases.push("6720 order scores plus means and extreme-order indices match the pre-optimization golden fingerprint");
  return { passed: true, cases, scoreArrays: scored.length, orderScores: scored.length * 120, digest: digest(scored) };
}
