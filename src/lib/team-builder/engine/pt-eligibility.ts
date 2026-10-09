/** Input qualification for the local AP solo/challenge reward trial. No inferred practice values. */
import type { EngineRequest, SongRef } from "./api";
import { resolveBox, memberGrowth, snapGrowth } from "./box";
import type { ChartSource } from "./chart";
import type { EngineMaster, SkillEffectRow } from "./master";
import { memberEventPercent, snapEventPercent } from "./power";
import { resolveSlotSkill } from "./skills";
import { missionPattern } from "./full/gekisou";
import { liveBoostRow } from "./boosts";

export interface PtIssue {
  code: "mode" | "inventory" | "practice" | "player" | "constraint" | "event" | "chart" | "skill" | "rules";
  target: string;
}
const integer = (n: unknown, min = 0): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= 2_147_483_647;

export function validatePtRequest(master: EngineMaster, request: EngineRequest): PtIssue[] {
  const issues: PtIssue[] = [];
  const add = (code: PtIssue["code"], target: string) => issues.push({ code, target });
  const checkGekisoEffects = (effects: readonly SkillEffectRow[], target: string) => {
    for (const effect of effects) {
      if (
        ![1, 2].includes(effect.triggerType) ||
        ![effect.value, effect.maxValue, effect.seconds, effect.limitCount].every(Number.isFinite) ||
        effect.targetIds.some((id) => !master.targets.has(id))
      )
        add("skill", target);
      for (const group of [effect.triggerGroup, effect.conditionGroup, effect.releaseGroup, effect.resetGroup]) {
        if (!group) continue;
        const sets = master.conditionSets.get(group);
        if (
          !sets?.length ||
          sets.flat().some((id) => {
            const condition = master.conditions.get(id);
            return !condition || condition.targetIds.some((t) => !master.targets.has(t));
          })
        )
          add("skill", `${target}:condition:${group}`);
      }
      if (effect.cumulativeId) {
        const row = master.cumulative.get(effect.cumulativeId);
        if (!row || row.targetIds.some((id) => !master.targets.has(id))) add("skill", `${target}:cumulative`);
      }
    }
  };
  const goal = request.goal;
  if (
    goal.kind !== "event" ||
    !["live", "challenge"].includes(goal.route) ||
    !["points", "items"].includes(goal.measure) ||
    goal.ranking !== "pt-only" ||
    goal.play.great ||
    goal.play.good ||
    goal.play.bad ||
    goal.play.miss ||
    goal.play.missEvery ||
    request.k !== 1
  ) {
    return [{ code: "mode", target: "solo-ap-rewards" }];
  }
  if (
    goal.gekiso &&
    (goal.route !== "live" ||
      goal.gekiso.rank !== 1 ||
      !Number.isFinite(goal.gekiso.just) ||
      goal.gekiso.just < 0 ||
      goal.gekiso.just > 1 ||
      !Number.isSafeInteger(goal.gekiso.luckSamples) ||
      goal.gekiso.luckSamples < 1)
  )
    add("mode", "gekiso-input");
  if (
    goal.cpExchange &&
    (goal.route !== "live" ||
      !Number.isSafeInteger(goal.cpExchange.numerator) ||
      goal.cpExchange.numerator < 0 ||
      !Number.isSafeInteger(goal.cpExchange.denominator) ||
      goal.cpExchange.denominator < 1)
  )
    add("rules", "cp-value");
  if (!goal.songs.length) add("chart", goal.route === "challenge" ? "challenge-selection" : "selection");
  for (const [kind, rows] of [
    ["member", request.members],
    ["snap", request.snaps],
  ] as const) {
    if (new Set(rows.map((r) => r.key)).size !== rows.length || new Set(rows.map((r) => r.cardId)).size !== rows.length)
      add("inventory", kind);
  }
  for (const row of request.members) {
    const card = master.members.get(row.cardId);
    if (!card) {
      add("inventory", row.key);
      continue;
    }
    const resolved = memberGrowth(master, card, row, "min");
    for (const field of ["level", "awake", "rank", "liveSkillLevel"] as const)
      if (!integer(row[field], 1) || row[field] !== resolved[field]) add("practice", `${row.key}.${field}`);
    if (
      goal.gekiso &&
      card.gekisoSkillId &&
      (!integer(row.gekisoSkillLevel, 1) || row.gekisoSkillLevel !== resolved.gekisoSkillLevel)
    )
      add("practice", `${row.key}.gekisoSkillLevel`);
  }
  for (const row of request.snaps) {
    const card = master.snaps.get(row.cardId);
    if (!card) {
      add("inventory", row.key);
      continue;
    }
    const resolved = snapGrowth(master, card, row, "min");
    for (const field of ["level", "rank"] as const)
      if (!integer(row[field], 1) || row[field] !== resolved[field]) add("practice", `${row.key}.${field}`);
  }
  const box = resolveBox(master, request.members, request.snaps, "min");
  for (const key of box.unknown) add("inventory", key);
  const members = new Map(box.members.map((row) => [row.key, row]));
  const snaps = new Map(box.snaps.map((row) => [row.key, row]));
  const c = request.constraints;
  const usable = box.members.filter((row) => !c.excludedMembers.includes(row.key));
  if (new Set(usable.map((row) => row.card.characterId)).size < 5) add("inventory", "five-characters");
  const required = new Set([...c.requiredMembers, ...c.bindings.map(([key]) => key), ...(c.leader ? [c.leader] : [])]);
  for (const key of [...required, ...c.excludedMembers])
    if (!members.has(key) || (required.has(key) && c.excludedMembers.includes(key))) add("constraint", key);
  if (
    required.size > 5 ||
    new Set([...required].map((key) => members.get(key)?.card.characterId)).size !== required.size
  )
    add("constraint", "required-members");
  const bound = c.bindings.map(([, key]) => key).filter((key): key is string => key !== null);
  const requiredPhotos = new Set([...c.requiredSnaps, ...bound]);
  if (
    requiredPhotos.size > 5 ||
    new Set(bound).size !== bound.length ||
    new Set(c.bindings.map(([key]) => key)).size !== c.bindings.length
  )
    add("constraint", "photo-bindings");
  for (const key of [...requiredPhotos, ...c.excludedSnaps])
    if (!snaps.has(key) || (requiredPhotos.has(key) && (c.noSnaps || c.excludedSnaps.includes(key))))
      add("constraint", key);
  if (c.minBonusPercent !== null && (!Number.isFinite(c.minBonusPercent) || c.minBonusPercent < 0))
    add("constraint", "minBonus");

  const player = request.player;
  const characters = new Set(usable.map((row) => row.card.characterId));
  for (const id of characters) {
    const rank = player.characterRanks[String(id)];
    if (!integer(rank, 1) || rank > master.maxCharacterRank) add("player", `cr.${id}`);
    if (!integer(player.characterMemory[String(id)])) add("player", `cm.${id}`);
  }
  if (player.characterTotalRank === null) {
    for (const id of master.characters.keys())
      if (!integer(player.characterRanks[String(id)], 1)) add("player", "p.total");
  } else if (
    !integer(player.characterTotalRank, 1) ||
    player.characterTotalRank < [...characters].reduce((n, id) => n + (player.characterRanks[String(id)] ?? 0), 0)
  ) {
    add("player", "p.total");
  }
  // The public bonus table is sparse: the base rank (1) has no bonus row.
  // Still require a present table, and never turn an unfilled rank into that base rank.
  if (
    !integer(player.vipRank, 1) ||
    !master.vipBonus.size ||
    (player.vipRank !== 1 && !master.vipBonus.has(player.vipRank))
  )
    add("player", "p.vip");
  for (const [id, item] of master.bandItems) {
    const level = player.bandItems[String(id)];
    if (!integer(level) || (level !== 0 && !item.levels.has(level))) add("player", `bi.${id}`);
  }

  const event = master.events.get(goal.eventId);
  const challenge = goal.route === "challenge";
  const points = challenge ? event?.challengePoints : event?.livePoints;
  const rewards =
    (challenge ? event?.challengeRewards : event?.liveRewards)?.filter((row) => row.resourceId === event?.itemId) ?? [];
  const items = goal.measure === "items";
  const boost = challenge
    ? master.challengeBoosts.find((row) => row.consumed === goal.consumption)
    : liveBoostRow(master.boosts, goal.consumption);
  if (
    !integer(goal.consumption, challenge ? 1 : 0) ||
    !boost ||
    !integer(boost.eventPointRate, 1) ||
    (items && !integer(boost.rewardRate, 1))
  )
    add("event", challenge ? "challenge-consumption" : "consumption");
  if (!items && !points?.size) add("event", "tables");
  if (
    items &&
    (!integer(event?.itemId, 1) ||
      !rewards.length ||
      new Set(rewards.map((row) => row.resourceType)).size !== 1 ||
      rewards.some((row) => row.probability !== 10000 || !integer(row.count)))
  )
    add("event", "guaranteed-medal-rewards");
  const countsAt = (rank: number) =>
    rewards
      .filter((row) => row.scoreRank === rank)
      .map((row) => row.count)
      .sort((a, b) => a - b);
  const seen = new Set<string>();
  for (const ref of goal.songs) {
    const key = `${ref.songId}:${ref.difficulty}`;
    const chartTarget = challenge ? `challenge:${key}` : key;
    if (seen.has(key)) add("chart", chartTarget);
    seen.add(key);
    const song = master.songs.get(ref.songId);
    const diff = song?.difficulties.find((row) => row.difficulty === ref.difficulty);
    if (!song || !diff?.file || !integer(diff.noteCount, 1) || !integer(diff.playLevel, 1)) add("chart", chartTarget);
    if (
      challenge &&
      !master.challengeMusics.some((row) => row.eventId === goal.eventId && row.liveMusicId === ref.songId)
    )
      add("chart", `challenge:${key}`);
    const ranks = song && master.scoreRanks.get(song.rankGroup);
    if (goal.gekiso && song) {
      const missions = song.gekisoMissions;
      if (missions.length !== 3 || missions.some((m) => ![1, 2, 3].includes(m))) add("chart", `gekiso:${key}`);
      else {
        const pattern = missionPattern(missions[0]!, missions[1]!, missions[2]!);
        if (
          [1, 2, 3].some(
            (count) =>
              !master.live.gekiso.rankingBonuses.some(
                (row) =>
                  row.pattern === pattern &&
                  row.count === count &&
                  row.rank === 1 &&
                  Number.isFinite(row.percent) &&
                  row.percent >= 0,
              ),
          )
        )
          add("rules", "gekiso-rank-bonus");
      }
      if (
        !ranks?.some((r) => r.battleRequired > 0) ||
        ranks.some((r) => !Number.isFinite(r.battleRequired) || r.battleRequired < 0)
      )
        add("chart", `gekiso-ranks:${key}`);
      if (missions.includes(3) && (!master.live.justTypes.size || !master.live.judgePercent.has(1)))
        add("rules", "gekiso-just");
    }
    if (!ranks?.length || ranks.some((row) => !Number.isFinite(row.required) || row.required < 0))
      add("chart", chartTarget);
    for (const rank of new Set([2, ...(ranks ?? []).map((row) => row.rank)])) {
      if (items ? !countsAt(rank).length : !integer(points?.get(rank))) add("event", `${goal.eventId}:${rank}`);
      if (goal.cpExchange && !integer(master.liveChallengePoints.get(rank))) add("event", `cp:${rank}`);
    }
    const ordered = [{ rank: 2, required: 0 }, ...(ranks ?? []).filter((r) => r.rank !== 2)].sort(
      (a, b) => a.rank - b.rank,
    );
    if (
      ordered.some(
        (row, i) =>
          i > 0 &&
          (row.required < ordered[i - 1]!.required ||
            (!items && (points?.get(row.rank) ?? 0) < (points?.get(ordered[i - 1]!.rank) ?? 0)) ||
            (items &&
              (countsAt(row.rank).length !== countsAt(ordered[i - 1]!.rank).length ||
                countsAt(row.rank).some((count, j) => count < countsAt(ordered[i - 1]!.rank)[j]!))) ||
            (!!goal.cpExchange &&
              (master.liveChallengePoints.get(row.rank) ?? 0) <
                (master.liveChallengePoints.get(ordered[i - 1]!.rank) ?? 0))),
      )
    )
      add("rules", "rank-monotonicity");
    if (!integer(player.musicMemory[String(ref.songId)])) add("player", `mm.${ref.songId}`);
  }
  // Bound inversion and native integer settlement require a non-negative, non-overflowing domain.
  if (event && boost) {
    if (event.effects.some((row) => row.perRank.some((v) => !integer(v)))) add("rules", "event-bonus");
    const top = (values: number[]) =>
      values
        .sort((a, b) => b - a)
        .slice(0, 5)
        .reduce((a, b) => a + b, 0);
    const bonus =
      top(box.members.map((m) => memberEventPercent(event.effects, m, items ? 1 : 0))) +
      top(box.snaps.map((s) => snapEventPercent(event.effects, s, items ? 1 : 0)));
    const maxBase = items ? Math.max(0, ...rewards.map((row) => row.count)) : Math.max(0, ...(points?.values() ?? []));
    const rate = items ? boost.rewardRate : boost.eventPointRate;
    if (bonus > 1_000_000 || (bonus + 10000) * rate * maxBase > 2_147_483_647) add("rules", "settlement-range");
    if (goal.cpExchange) {
      const cp = Math.max(0, ...master.liveChallengePoints.values()) * boost.eventPointRate;
      const payout = Math.ceil(maxBase * rate * 101) * (items ? rewards.length : 1);
      const sum =
        120 * (goal.gekiso?.luckSamples ?? 1) * (payout * goal.cpExchange.denominator + cp * goal.cpExchange.numerator);
      // Leave one precision bit so dividing the integer order sum by 120 cannot merge adjacent sums.
      if (!integer(cp) || !Number.isSafeInteger(sum) || sum > Number.MAX_SAFE_INTEGER / 2)
        add("rules", "cp-settlement-range");
    }
  }
  for (const member of usable) {
    if (
      goal.gekiso &&
      member.card.gekisoSkillId &&
      !master.gekisoSkills
        .get(member.card.gekisoSkillId)
        ?.effects.some((r) => r.level === member.growth.gekisoSkillLevel)
    )
      add("skill", `${member.key}.gekiso`);
    if (goal.gekiso)
      checkGekisoEffects(
        master.gekisoSkills
          .get(member.card.gekisoSkillId)
          ?.effects.filter((r) => r.level === member.growth.gekisoSkillLevel) ?? [],
        `${member.key}.gekiso`,
      );
    const effects = master.liveSkills.get(member.card.liveSkillId);
    if (member.card.liveSkillId && !effects?.some((row) => row.level === member.growth.liveSkillLevel))
      add("skill", member.key);
    const leaders = master.leaderSkills.get(member.card.leaderSkillId);
    if (member.card.leaderSkillId && !leaders?.some((row) => row.level === member.leaderSkillLevel))
      add("skill", `${member.key}.leader`);
    for (const effect of leaders?.filter((row) => row.level === member.leaderSkillLevel) ?? []) {
      if (
        ![1000, 1001, 1002, 1003, 1500, 1501, 1502, 1503].includes(effect.type) ||
        effect.value < 0 ||
        effect.targetIds.some((id) => !master.targets.has(id))
      )
        add("skill", `${member.key}.leader`);
      if (effect.conditionGroup > 0) {
        const sets = master.conditionSets.get(effect.conditionGroup);
        if (
          !sets?.length ||
          sets.flat().some((id) => {
            const row = master.conditions.get(id);
            return (
              !row ||
              ![0, 3000, 3001, 4012].includes(row.type) ||
              row.targetIds.some((target) => !master.targets.has(target))
            );
          })
        )
          add("skill", `${member.key}.leader-condition`);
      }
      if (effect.cumulativeId > 0) {
        const row = master.cumulative.get(effect.cumulativeId);
        if (
          !row ||
          ![3000, 3001, 3002, 3003, 3004, 3005].includes(row.type) ||
          row.targetIds.some((id) => !master.targets.has(id))
        )
          add("skill", `${member.key}.leader-cumulative`);
      }
    }
    for (const photo of [null, ...(c.noSnaps ? [] : box.snaps.filter((s) => !c.excludedSnaps.includes(s.key)))]) {
      const report = { unsupported: [] as string[] };
      const slotSkill = resolveSlotSkill(master, member, photo, report);
      // The fast order scorer applies live Perfect conversion after the Gekisou simulation.
      // Until that interaction is modeled per order, never report an unchanged JUST rate.
      if (goal.gekiso && slotSkill.convert?.judgements.includes(6)) add("skill", `${member.key}:just-to-perfect`);
      for (const why of report.unsupported) add("skill", `${member.key}${photo ? `/${photo.key}` : ""}:${why}`);
      photo?.card.supportSkillIds.forEach((id, slot) => {
        if (id && !master.supportSkills.get(id)?.some((row) => row.level === photo.skillLevels[slot]))
          add("skill", `${photo.key}:${id}`);
      });
      if (goal.gekiso)
        photo?.card.gekisoSupportSkillIds.forEach((id, slot) => {
          if (
            id &&
            !master.gekisoSupportSkills.get(id)?.effects.some((row) => row.level === photo.gekisoSkillLevels[slot])
          )
            add("skill", `${photo.key}.gekiso:${id}`);
          checkGekisoEffects(
            master.gekisoSupportSkills.get(id)?.effects.filter((row) => row.level === photo.gekisoSkillLevels[slot]) ??
              [],
            `${photo.key}.gekiso:${id}`,
          );
        });
    }
  }
  for (const [id, item] of master.bandItems) {
    const level = player.bandItems[String(id)];
    if (!level) continue;
    for (const effect of item.levels.get(level) ?? [])
      if (
        ![1000, 1001, 1002, 1003].includes(effect.type) ||
        effect.conditionGroup > 0 ||
        effect.cumulativeId > 0 ||
        effect.value < 0 ||
        effect.targetIds.some((target) => !master.targets.has(target))
      )
        add("skill", `bi.${id}`);
  }
  return [...new Map(issues.map((issue) => [`${issue.code}:${issue.target}`, issue])).values()];
}

export function validatePtChart(master: EngineMaster, ref: SongRef, source: ChartSource): void {
  const judged = source.notes.filter((n) => n.judged);
  if (
    !Number.isFinite(source.durationMs) ||
    source.durationMs <= 0 ||
    !judged.length ||
    source.skillTimesMs.length !== 5 ||
    source.skillTimesMs.some((t) => !Number.isFinite(t) || t < 0) ||
    judged.some(
      (n, i) =>
        !Number.isFinite(n.timeMs) ||
        n.timeMs < 0 ||
        (i > 0 && n.timeMs < judged[i - 1]!.timeMs) ||
        !master.live.notePercent.has(n.operateType) ||
        !master.live.timingTypes.has(n.judgementType),
    ) ||
    !Number.isFinite(master.live.adjustment) ||
    master.live.adjustment <= 0 ||
    !master.live.judgePercent.has(2)
  ) {
    throw new Error(`pt-chart-unsupported:${ref.songId}:${ref.difficulty}`);
  }
}
