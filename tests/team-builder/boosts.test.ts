import assert from "node:assert/strict";
import { LIVE_BOOST_COSTS, liveBoostRow } from "../../src/lib/team-builder/engine/boosts";
import { eventRoute } from "../../src/lib/team-builder/engine/api";
import { validatePtRequest } from "../../src/lib/team-builder/engine/pt-eligibility";
import { issueField } from "../../src/lit/team-builder/pt-fields";
import { fixture } from "./pt-recommendation.test";

export function verify() {
  const { master, request } = fixture();
  if (request.goal.kind !== "event") throw Error("fixture");
  // Public tables can contain unsupported costs and omit the zero-cost row.
  master.boosts = Array.from({ length: 10 }, (_, i) => ({ consumed: i + 1, eventPointRate: i + 2, rewardRate: i + 3 }));
  assert.deepEqual(LIVE_BOOST_COSTS, [0, 1, 2, 3, 4, 5, 10]);
  for (const cost of LIVE_BOOST_COSTS) {
    request.goal.consumption = cost;
    assert.deepEqual(validatePtRequest(master, request), []);
    assert(liveBoostRow(master.boosts, cost));
    assert.doesNotThrow(() => eventRoute(master, 1, "live", cost));
  }
  assert.deepEqual(liveBoostRow(master.boosts, 0), { consumed: 0, eventPointRate: 1, rewardRate: 1 });
  for (const cost of [-1, 0.5, 6, 7, 8, 9, 11, NaN]) {
    request.goal.consumption = cost;
    assert(validatePtRequest(master, request).some((issue) => issue.target === "consumption"));
    assert.equal(liveBoostRow(master.boosts, cost), undefined);
    assert.throws(() => eventRoute(master, 1, "live", cost), /unsupported-live-boost-cost/);
  }
  master.boosts = [];
  request.goal.consumption = 3;
  assert(validatePtRequest(master, request).some((issue) => issue.target === "consumption"));
  request.goal.consumption = 0;
  assert.deepEqual(validatePtRequest(master, request), []);
  assert.doesNotThrow(() => eventRoute(master, 1, "challenge", 200));
  request.goal.route = "challenge";
  request.goal.songs = [];
  assert.deepEqual(
    validatePtRequest(master, request).filter((issue) => issue.code === "chart"),
    [{ code: "chart", target: "challenge-selection" }],
  );
  for (const [code, target, field] of [
    ["practice", "m1.level", "m1.level"],
    ["practice", "s2.rank", "s2.rank"],
    ["player", "p.vip", "p.vip"],
    ["player", "mm.3", "mm.3"],
    ["chart", "selection", "selection"],
    ["chart", "challenge-selection", "challenge-selection"],
    ["event", "consumption", "consumption"],
    ["event", "challenge-consumption", "challenge-consumption"],
    ["constraint", "photo-bindings", "constraints"],
    ["skill", "m1:condition:5", "m1.use"],
    ["constraint", "minBonus", "minBonus"],
    ["mode", "gekiso-input", "gekiso-input"],
    ["inventory", "five-characters", "inventory"],
    ["rules", "cp-value", null],
  ] as const)
    assert.equal(issueField({ code, target }), field);
  return {
    passed: 4,
    scenarios: [
      "seven playable costs and unboosted zero",
      "invalid or missing costs fail closed",
      "challenge CP remains separate",
      "validation targets map to editable controls",
    ],
  };
}
