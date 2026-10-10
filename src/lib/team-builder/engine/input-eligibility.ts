/** Real input qualification, shared by the page and every engine entry point. */
import type { EngineRequest, Goal, PlayerInput } from "./api";
import type { MemberInput, SnapInput } from "./box";
import type { EngineMaster } from "./master";
import { memberLevelCap, snapLevelCap } from "./power";

export type InputIntent = "actual" | "simulation";
export interface InputIssue {
  key: string;
  field: string;
  code: "missing" | "invalid" | "required" | "characters";
  /** Existing synchronized inventory key. No new persistence contract. */
  storageKey?: string;
  values?: number[];
  min?: number;
  max?: number;
}
const integer = (value: unknown, min = 0, max = 0x7fffffff): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const keys = (map: ReadonlyMap<number, unknown> | undefined) => [...(map?.keys() ?? [])].sort((a, b) => a - b);

export function cardInputIssues(
  master: EngineMaster,
  members: readonly MemberInput[],
  snaps: readonly SnapInput[],
  goal: Goal,
): InputIssue[] {
  const issues: InputIssue[] = [];
  const check = (key: string, field: string, value: unknown, values: number[], storageKey: string) => {
    if (!integer(value) || !values.includes(value))
      issues.push({ key, field, code: value == null ? "missing" : "invalid", values, storageKey });
  };
  const live = goal.kind !== "power" && goal.kind !== "gekiso" && !(goal.kind === "event" && goal.route === "skip");
  for (const input of members) {
    const card = master.members.get(input.cardId);
    if (!card) {
      issues.push({ key: input.key, field: "cardId", code: "invalid" });
      continue;
    }
    const prefix = `m.${input.cardId}`;
    check(input.key, "training", input.awake, keys(master.memberAwake.get(card.awakeGroup)), `${prefix}.awk`);
    check(input.key, "awakening", input.rank, keys(master.memberRanks.get(card.rankGroup)), `${prefix}.rnk`);
    const awake = input.awake ?? Math.max(1, ...keys(master.memberAwake.get(card.awakeGroup)));
    check(
      input.key,
      "level",
      input.level,
      keys(master.memberLevels.get(card.levelGroup)).filter((level) => level <= memberLevelCap(master, card, awake)),
      `${prefix}.lvl`,
    );
    if (live && card.liveSkillId)
      check(
        input.key,
        "liveSkillLevel",
        input.liveSkillLevel,
        [...new Set(master.liveSkills.get(card.liveSkillId)?.map((row) => row.level) ?? [])],
        `${prefix}.sk`,
      );
    if ((goal.kind === "gekiso" || (goal.kind === "event" && goal.gekiso)) && card.gekisoSkillId)
      check(
        input.key,
        "gekisoSkillLevel",
        input.gekisoSkillLevel,
        [...new Set(master.gekisoSkills.get(card.gekisoSkillId)?.effects.map((row) => row.level) ?? [])],
        `${prefix}.gsk`,
      );
  }
  for (const input of snaps) {
    const card = master.snaps.get(input.cardId);
    if (!card) {
      issues.push({ key: input.key, field: "cardId", code: "invalid" });
      continue;
    }
    check(input.key, "awakening", input.rank, keys(master.snapRanks.get(card.rankGroup)), `s.${input.cardId}.rnk`);
    const rank = input.rank ?? Math.max(1, ...keys(master.snapRanks.get(card.rankGroup)));
    check(
      input.key,
      "level",
      input.level,
      keys(master.snapLevels.get(card.levelGroup)).filter((level) => level <= snapLevelCap(master, card, rank)),
      `s.${input.cardId}.lvl`,
    );
  }
  return issues;
}

export function playerInputIssues(
  master: EngineMaster,
  player: PlayerInput,
  members: readonly MemberInput[],
  _goal: Goal,
): InputIssue[] {
  const issues: InputIssue[] = [];
  const check = (field: string, value: unknown, storageKey: string, min: number, max: number, values?: number[]) => {
    if (!integer(value, min, max) || (values && !values.includes(value)))
      issues.push({ key: "player", field, storageKey, min, max, values, code: value == null ? "missing" : "invalid" });
  };
  const cards = members.flatMap((input) => {
    const card = master.members.get(input.cardId);
    return card ? [card] : [];
  });
  const characters = new Set(cards.map((card) => card.characterId));
  for (const id of characters) {
    if (master.characterRankBonus.length)
      check(`characterRanks.${id}`, player.characterRanks[id], `cr.${id}`, 1, master.maxCharacterRank);
  }
  // No source in this importer currently proves the entire character roster.
  // A directly observed total is required; catalogue membership cannot attest completeness.
  if (master.totalRankBonus.length) check("characterTotalRank", player.characterTotalRank, "p.total", 0, 0x7fffffff);
  if (master.vipBonus.size) check("vipRank", player.vipRank, "p.vip", 1, 0x7fffffff, [...new Set([1, ...keys(master.vipBonus)])]);
  for (const [id, item] of master.bandItems) {
    const relevant = [...item.levels.values()].some((effects) =>
      effects.some((effect) =>
        effect.targetIds.some((targetId) => {
          const target = master.targets.get(targetId);
          return (
            target &&
            cards.some(
              (card) =>
                (target.bandId > 0 && target.bandId === card.bandId) ||
                (target.characterId > 0 && target.characterId === card.characterId) ||
                (target.cardType !== 0 && target.cardType === card.cardType),
            )
          );
        }),
      ),
    );
    if (relevant) check(`bandItems.${id}`, player.bandItems[id], `bi.${id}`, 0, 0x7fffffff, [0, ...keys(item.levels)]);
  }
  return issues;
}

export function inspectEngineInput(master: EngineMaster, request: EngineRequest) {
  const constraints = request.constraints;
  let members = request.members.filter((row) => !constraints.excludedMembers.includes(row.key));
  let snaps = constraints.noSnaps ? [] : request.snaps.filter((row) => !constraints.excludedSnaps.includes(row.key));
  if (request.inputIntent === "simulation")
    return { members, snaps, issues: [] as InputIssue[], omitted: [] as string[] };
  const issues = cardInputIssues(master, members, snaps, request.goal);
  const incomplete = new Set(issues.map((issue) => issue.key));
  const required = new Set([
    ...constraints.requiredMembers,
    ...constraints.requiredSnaps,
    ...(constraints.leader ? [constraints.leader] : []),
    ...constraints.bindings.flatMap(([member, snap]) => (snap ? [member, snap] : [member])),
  ]);
  const omitted = request.knownOnly ? [...incomplete].filter((key) => !required.has(key)) : [];
  const removed = new Set(omitted);
  members = members.filter((row) => !removed.has(row.key));
  snaps = snaps.filter((row) => !removed.has(row.key));
  const remaining = issues.filter((issue) => !removed.has(issue.key));
  const present = new Set([...members, ...snaps].map((row) => row.key));
  for (const key of required) if (!present.has(key)) remaining.push({ key, field: "required", code: "required" });
  if (new Set(members.map((input) => master.members.get(input.cardId)?.characterId).filter(Boolean)).size < 5)
    remaining.push({ key: "team", field: "characters", code: "characters" });
  remaining.push(...playerInputIssues(master, request.player, members, request.goal));
  return { members, snaps, issues: remaining, omitted };
}

export function requireEngineInput(master: EngineMaster, request: EngineRequest): EngineRequest {
  const review = inspectEngineInput(master, request);
  if (review.issues.length) throw new RangeError("actual-input-incomplete");
  return {
    ...request,
    members: review.members,
    snaps: review.snaps,
    // Only fields unused by this goal may remain unknown after qualification.
    unknownPolicy: request.inputIntent === "simulation" ? request.unknownPolicy : "min",
  };
}
