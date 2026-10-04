import type {
  EvidenceGap,
  OptimizationInput,
  PowerStats,
  ReleaseIdentity,
  ResolvedSlotProfile,
  TeamAssignment,
} from "../contracts.ts";
import { dataRows, nativeRow, type DataRow, type TeamBuilderData } from "../data.ts";
import { nativeConditionSources } from "../data/condition-sources.ts";
import type { InventoryV1 } from "../inventory.ts";
import type { PreparedSong } from "../song-metrics.ts";
import { calculateNativeSlotPower } from "./native-slot.ts";
import { floorPowerBP } from "./power.ts";
import { createFormationLeaderCache } from "../formation-leader-cache";
import { nativeMusicTypeMatchesCard } from "./native-music-types.ts";

const uniform = (value: number): PowerStats => ({ performance: value, technique: value, visual: value });
const zero = (): PowerStats => uniform(0);
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
const ids = (value: unknown): number[] | null => (Array.isArray(value) && value.every(int) ? [...value] : null);
const gap = (code: string, source: string): EvidenceGap => ({ code, source });
function scalar(row: DataRow | null | undefined, field: string, gaps: EvidenceGap[], source: string): number {
  const value = row?.[field];
  if (int(value)) return value;
  gaps.push(gap("native-power-field-unresolved", `${source}/${field}`));
  return 0; // Internal placeholder; a profile with any gap is never scored.
}
function accumulate(stats: PowerStats, type: number, value: number, wrap: boolean): void {
  const add = (key: keyof PowerStats) => {
    stats[key] = wrap ? (stats[key] + value) | 0 : stats[key] + value;
  };
  if (type === 1000) {
    add("performance");
    add("technique");
    add("visual");
  } else if (type === 1001) add("technique");
  else if (type === 1002) add("visual");
  else if (type === 1003) add("performance");
}
interface BonusProfile {
  value: PowerStats;
  gaps: EvidenceGap[];
}
interface MemberProfile extends BonusProfile {
  characterId: number;
  bandId: number;
  cardType: number;
  tags: number[] | null;
  liveCategories: number[] | null;
  gekisoCategories: number[] | null;
  gekisoMission: number | null;
  basePowerBP: PowerStats;
  characterRankBonusBP: PowerStats;
  musicTypeBonusBP: number;
  musicTagBonusBP: number;
  leaderEffects: DataRow[];
}
type Match = boolean | null;
export interface NativeEventPowerResolver {
  identity: ReleaseIdentity & { sourceId?: string };
  resolvePower(assignment: TeamAssignment): {
    value: { memberBP: number[]; snapshotBP: number[] } | null;
    gaps: EvidenceGap[];
  };
}
/** LeaderSkillBonusCalculator.IsTargetMember: OR, distinct from event AND. */
function memberMatches(member: MemberProfile, target: DataRow): Match {
  if (int(target.bandID) && target.bandID >= 1 && target.bandID === member.bandId) return true;
  if (int(target.cardType) && target.cardType !== 0 && target.cardType === member.cardType) return true;
  if (int(target.characterID) && target.characterID >= 1 && target.characterID === member.characterId) return true;
  let unknown = [target.bandID, target.cardType, target.characterID, target.tagID, target.gekisouMissionType].some(
    (value) => typeof value !== "number" || !Number.isSafeInteger(value),
  );
  if (int(target.tagID) && target.tagID >= 1) {
    if (member.tags === null) unknown = true;
    else if (member.tags.includes(target.tagID)) return true;
  }
  for (const [key, categories] of [
    ["liveSkillCategories", member.liveCategories],
    ["gekisouSkillCategories", member.gekisoCategories],
  ] as const) {
    const desired = ids(target[key]);
    if (desired === null) unknown = true;
    else if (desired.length) {
      if (categories === null) unknown = true;
      else if (desired.some((id) => categories.includes(id))) return true;
    }
  }
  if (int(target.gekisouMissionType) && target.gekisouMissionType !== 0) {
    if (member.gekisoMission === null) unknown = true;
    else if (target.gekisouMissionType === member.gekisoMission) return true;
  }
  return unknown ? null : false;
}
function any(matches: Match[]): Match {
  return matches.includes(true) ? true : matches.includes(null) ? null : false;
}
function all(matches: Match[]): Match {
  return matches.includes(false) ? false : matches.includes(null) ? null : true;
}

/** Prepare actual card/character/player/song inputs once. Formation conditions
 * and the five native slot calculations are evaluated against selected IDs.
 * This normal Live path constructs BonusData with both extra memory ints zero;
 * MemberCard.Power's memory enhancement is handled separately below.
 */
export function createNativeNormalSlotResolver(
  data: TeamBuilderData,
  inventory: InventoryV1,
  input: OptimizationInput,
  eventPower?: NativeEventPowerResolver,
  musicTypes?: ReadonlyMap<number, { parameterMusicType: number; skillTargetMusicType: number;
    musicTypeBaseBonusBP?: number; musicTagBaseBonusBP?: number }>,
) {
  const sources = nativeConditionSources(data, inventory);
  const gaps: EvidenceGap[] = [];
  if (
    eventPower &&
    (eventPower.identity.server !== data.identity.server ||
      eventPower.identity.releaseId !== data.identity.releaseId ||
      eventPower.identity.sourceId !== data.identity.sourceId)
  )
    gaps.push(gap("native-event-power-release-mismatch", eventPower.identity.releaseId));
  const tables = sources.runtimeRules?.tables;
  if (sources.runtimeRules?.status !== "ready")
    gaps.push(gap("native-runtime-rules-unverified", "same-release runtime rules"));
  // These are complete empty tables, not absent player inputs. Native current
  // level getters return CardPower.Zero when their selected row is null.
  for (const key of ["memoryMemberLevels", "memorySupportLevels", "memoryMusicGroups"] as const)
    if (tables?.[key].status !== "empty")
      gaps.push(gap("native-memory-growth-state-unresolved", tables?.[key].sourceTable ?? key));
  const parameters = new Map(tables?.parameters.rows.map((row) => [String(row.id), row]) ?? []);
  const parameter = (key: string) => {
    const row = parameters.get(key),
      value = Number(row?.value);
    if (row?.type === "Int32" && int(value)) return value;
    gaps.push(gap("native-power-parameter-unresolved", key));
    return 0;
  };
  const musicTypeBaseBP = parameter("music_type_base_bonus_rate");
  const musicTagBaseBP = parameter("music_tag_base_bonus_rate");
  const typeLinkBaseBP = parameter("type_link_base_bonus_rate");
  let vipBonusBP = 0;
  if (!tables || tables.vipRankBonuses.status === "missing")
    gaps.push(gap("native-vip-bonus-table-missing", "MasterVipRankBonus"));
  else if (tables.vipRankBonuses.status === "empty") vipBonusBP = 0;
  else if (sources.playerModifiers.vipRank === null) gaps.push(gap("unknown-vip-rank", "playerModifiers.vipRank"));
  else {
    // MasterVipRankBonusBox predicate uses exact rank and type equality.
    const rows = tables.vipRankBonuses.rows.filter(
      (row) => row.vipRank === sources.playerModifiers.vipRank && row.vipBonusType === 7,
    );
    if (rows.length > 1) gaps.push(gap("native-vip-bonus-row-ambiguous", "MasterVipRankBonus"));
    else if (rows.length) vipBonusBP = scalar(rows[0], "value", gaps, "MasterVipRankBonus");
  }
  let totalRankPoints = 0;
  if (sources.playerModifiers.characterTotalRank === null)
    gaps.push(gap("unknown-character-total-rank", "playerModifiers.characterTotalRank"));
  else if (!sources.characterTotalRankRows.length)
    gaps.push(gap("native-total-rank-table-missing", "MasterCharacterTotalRank"));
  else {
    const row = [...sources.characterTotalRankRows]
      .sort((a, b) => Number(a.totalRank) - Number(b.totalRank))
      .filter((row) => Number(row.totalRank) <= sources.playerModifiers.characterTotalRank!)
      .at(-1);
    if (row) totalRankPoints = scalar(row, "bonus", gaps, "MasterCharacterTotalRank");
  }
  const targets = new Map(sources.targets.map(nativeRow).map((row) => [Number(row.id), row]));
  const conditions = new Map(sources.conditions.map(nativeRow).map((row) => [Number(row.id), row]));
  const conditionGroups = new Map<number, number[]>();
  for (const raw of sources.conditionSets) {
    const row = nativeRow(raw),
      group = Number(row.group),
      children = ids(row.conditionIds);
    if (!children) continue;
    conditionGroups.set(group, [...(conditionGroups.get(group) ?? []), ...children]);
  }
  const targetList = (value: unknown, local: EvidenceGap[], source: string): DataRow[] | null => {
    const list = ids(value);
    if (!list || list.some((id) => !targets.has(id))) {
      local.push(gap("native-skill-target-unresolved", source));
      return null;
    }
    return list.map((id) => targets.get(id)!);
  };
  // BuildBandItemSkillMap enrolls a whole effect independently into each positive
  // band/character/type key. Multiple matching keys preserve native duplication.
  const bandBonuses = [
    new Map<number, BonusProfile>(),
    new Map<number, BonusProfile>(),
    new Map<number, BonusProfile>(),
  ] as const;
  for (const [id, upgrade] of Object.entries(sources.bandUpgrades)) {
    const available = dataRows(upgrade.item.effects).map(nativeRow);
    const chosen = upgrade.effects;
    const unresolved = upgrade.level === null || !upgrade.levelRow || chosen.length !== 1;
    const rows = unresolved ? available : chosen;
    const used = new Set<string>();
    for (const effect of rows) {
      const local: EvidenceGap[] = [],
        list = targetList(effect.skillTargetIDs, local, `band-item:${id}`);
      if (!list) {
        gaps.push(...local);
        continue;
      }
      if (
        list.some((target) =>
          [target.characterID, target.bandID, target.cardType].some(
            (value) => typeof value !== "number" || !Number.isSafeInteger(value),
          ),
        )
      ) {
        gaps.push(gap("native-band-upgrade-target-unresolved", `band-item:${id}`));
        continue;
      }
      for (const target of list)
        for (const [index, key] of [
          [0, target.characterID],
          [1, target.bandID],
          [2, target.cardType],
        ] as const) {
          if (!int(key) || key < 1) continue;
          const identity = `${index}:${key}`;
          if (unresolved && used.has(identity)) continue;
          used.add(identity);
          const map = bandBonuses[index],
            profile = map.get(key) ?? { value: zero(), gaps: [] };
          if (unresolved) profile.gaps.push(gap("unknown-or-missing-band-upgrade", `band-item:${id}`));
          else
            accumulate(
              profile.value,
              scalar(effect, "skillEffectType", profile.gaps, `band-item:${id}`),
              scalar(effect, "effectValue", profile.gaps, `band-item:${id}`),
              true,
            );
          map.set(key, profile);
        }
    }
  }
  const members = new Map<string, MemberProfile>();
  for (const option of input.members) {
    const source = sources.members[option.instanceId],
      local: EvidenceGap[] = [];
    if (!source) continue;
    const character = sources.characterRanks[String(option.characterId)];
    if (!int(data.characters[String(option.characterId)]?.bandId))
      local.push(gap("native-member-band-unresolved", option.instanceId));
    const rankPoints = scalar(character?.row, "bonus", local, `character:${option.characterId}`);
    const live = data.skills.live?.[String(option.liveSkillId)],
      gekiso = data.skills.gekiso?.[String(option.gekisoSkillId)];
    const value = zero();
    for (const profile of [
      bandBonuses[0].get(option.characterId),
      bandBonuses[1].get(option.bandId),
      bandBonuses[2].get(option.attribute),
    ]) {
      if (!profile) continue;
      for (const key of ["performance", "technique", "visual"] as const)
        value[key] = (value[key] + profile.value[key]) | 0;
      local.push(...profile.gaps);
    }
    if (!option.bpPower) local.push(gap("native-member-power-unresolved", option.instanceId));
    if (source.card.leaderSkillId > 0 && (!source.leaderEffects.length || source.leaderSkillLevel === null))
      local.push(gap("native-leader-effects-unresolved", option.instanceId));
    members.set(option.instanceId, {
      value,
      gaps: local,
      characterId: option.characterId,
      bandId: option.bandId,
      cardType: option.attribute,
      tags: source.card.bestMusicTagIds,
      liveCategories: option.liveSkillId === 0 ? [] : ids(live?.categories),
      gekisoCategories: option.gekisoSkillId === 0 ? [] : ids(gekiso?.categories),
      gekisoMission:
        option.gekisoSkillId === 0 ? 0 : int(gekiso?.gekisouMissionType) ? gekiso.gekisouMissionType : null,
      basePowerBP: option.bpPower ?? zero(),
      characterRankBonusBP: uniform(rankPoints * 10000),
      musicTypeBonusBP: scalar(source.rank, "musicTypeBonusRate", local, option.instanceId),
      musicTagBonusBP: scalar(source.rank, "musicTagBonusRate", local, option.instanceId),
      leaderEffects: source.leaderEffects,
    });
  }
  const snapshots = new Map(
    input.snapshots.map((option) => [option.instanceId, { option, source: sources.snapshots[option.instanceId] }]),
  );
  const songs = new Map(Object.entries(sources.songs).map(([id, song]) => [Number(id), song]));
  const matchesAnyTarget = (member: MemberProfile, list: DataRow[]): Match =>
    list.length ? any(list.map((target) => memberMatches(member, target))) : true;
  const leaderCondition = (
    group: number,
    team: MemberProfile[],
    musicType: number | null,
    local: EvidenceGap[],
  ): Match => {
    if (group < 1 || !conditionGroups.has(group)) return true;
    return all(
      conditionGroups.get(group)!.map((id) => {
        const condition = conditions.get(id);
        if (!condition) {
          local.push(gap("native-leader-condition-unresolved", String(id)));
          return null;
        }
        if (condition.conditionType === 0) return true;
        const list = targetList(condition.conditionTargetIDs, local, `condition:${id}`);
        if (!list) return null;
        if (!list.length) return true;
        if (condition.conditionType === 3000) return any(team.map((member) => matchesAnyTarget(member, list)));
        if (condition.conditionType === 3001) return all(team.map((member) => matchesAnyTarget(member, list)));
        if (condition.conditionType === 4012)
          return musicType === null
            ? null
            : list.some((target) => target.liveMusicType !== 0 && target.liveMusicType === musicType);
        return true; // Native static leader default branch, not a live-skill rule.
      }),
    );
  };
  const leaderCache = createFormationLeaderCache({ data, inventory, input }, (assignment, skillTargetMusicType) => {
    const selected = assignment.memberInstanceIds.map(id => members.get(id));
    const leader = members.get(assignment.leaderInstanceId), local: EvidenceGap[] = [];
    if (!leader || selected.some(member => !member)) return { value: null, gaps: [] };
    const team = selected as MemberProfile[];
      const leaderBonuses = team.map(zero);
      for (const effect of leader?.leaderEffects ?? []) {
        const type = Number(effect.skillEffectType);
        if (type === 0) continue;
        if (![1000, 1001, 1002, 1003].includes(type)) {
          local.push(gap("native-cumulative-leader-rule-unresolved", `effect:${effect.id}`));
          continue;
        }
        const condition = leaderCondition(Number(effect.skillConditionGroup), team, skillTargetMusicType, local);
        if (condition === null) {
          local.push(gap("native-leader-target-state-unresolved", `effect:${effect.id}`));
          continue;
        }
        if (!condition) continue;
        const list = targetList(effect.skillTargetIDs, local, `effect:${effect.id}`);
        if (!list) continue;
        const value = scalar(effect, "effectValue", local, `effect:${effect.id}`);
        for (const [slot, member] of team.entries()) {
          const match = matchesAnyTarget(member, list);
          if (match === null) local.push(gap("native-leader-target-state-unresolved", `effect:${effect.id}`));
          else if (match) accumulate(leaderBonuses[slot]!, type, value, false);
        }
      }
    return { value: local.length ? null : leaderBonuses, gaps: local };
  });
  return {
    gaps,
    resolveSlots(assignment: TeamAssignment, prepared: PreparedSong): (ResolvedSlotProfile | undefined)[] {
      const team = assignment.memberInstanceIds.map((id) => members.get(id));
      if (team.some((member) => !member)) return team.map(() => undefined);
      const selected = team as MemberProfile[],
        leader = members.get(assignment.leaderInstanceId);
      const song = songs.get(prepared.song.songId),
        local: EvidenceGap[] = [];
      const override = musicTypes?.get(prepared.song.songId);
      const parameterMusicType = override?.parameterMusicType ?? song?.musicType ?? null;
      const skillTargetMusicType = override?.skillTargetMusicType ?? song?.musicType ?? null;
      if (override && [parameterMusicType, skillTargetMusicType].some((value) =>
        value === null || !int(value) || !((value >= 0 && value <= 5) || value === 99)))
        local.push(gap("native-challenge-music-type-unresolved", prepared.song.key));
      if (override && [override.musicTypeBaseBonusBP, override.musicTagBaseBonusBP].some((value) =>
        value !== undefined && !int(value))) local.push(gap("native-challenge-music-bonus-unresolved", prepared.song.key));
      const eventBonuses = eventPower?.resolvePower(assignment);
      if (eventBonuses) {
        local.push(...eventBonuses.gaps);
        if (
          !eventBonuses.value ||
          eventBonuses.value.memberBP.length !== selected.length ||
          eventBonuses.value.snapshotBP.length !== selected.length ||
          [...eventBonuses.value.memberBP, ...eventBonuses.value.snapshotBP].some((value) => !int(value))
        )
          local.push(gap("native-event-slot-bonus-unresolved", prepared.song.key));
      }
      if (!leader || !song || parameterMusicType === null || skillTargetMusicType === null || song.bestMusicTagIds === null)
        local.push(gap("native-normal-formation-or-song-unresolved", prepared.song.key));
      const preparedLeader = leaderCache.resolve(assignment, skillTargetMusicType);
      local.push(...preparedLeader.gaps);
      const leaderBonuses = preparedLeader.value ?? selected.map(zero);
      return selected.map((member, slot) => {
        const profileGaps = [...gaps, ...local, ...member.gaps];
        const snapshotId = assignment.snapshotInstanceIds[slot],
          snapshot = snapshotId ? snapshots.get(snapshotId) : undefined;
        const snapshotPresent = snapshotId !== null && snapshotId !== undefined;
        let typeLinkBP = 0;
        if (snapshotPresent && (!snapshot || !snapshot.source || !snapshot.option.bonusBP))
          profileGaps.push(gap("native-snapshot-power-unresolved", snapshotId!));
        if (snapshotPresent && snapshot?.source?.card.attribute === member.cardType)
          typeLinkBP = typeLinkBaseBP + scalar(snapshot.source.rank, "cardTypeLinkBonusRate", profileGaps, snapshotId!);
        if (member.tags === null)
          profileGaps.push(gap("native-member-music-tags-unresolved", assignment.memberInstanceIds[slot]!));
        if (profileGaps.length || !song) return { power: 0, windows: [], gaps: profileGaps };
        const result = calculateNativeSlotPower({
          basePowerBP: member.basePowerBP,
          characterRankBonusBP: member.characterRankBonusBP,
          characterTotalRankBonusBP: uniform(totalRankPoints * 10000),
          memoryBonusPoints: 0,
          memberEventBonusBP: uniform(eventBonuses?.value?.memberBP[slot] ?? 0),
          snapshotPresent,
          snapshotBonusBP: snapshot?.option.bonusBP ?? zero(),
          snapshotEventBonusBP: uniform(eventBonuses?.value?.snapshotBP[slot] ?? 0),
          bandItemBonusBP: member.value,
          leaderSkillBonusBP: leaderBonuses[slot]!,
          typeLinkBonusBP: uniform(typeLinkBP),
          musicTypeBonusBP: parameterMusicType !== null && nativeMusicTypeMatchesCard(parameterMusicType, member.cardType)
            ? (override?.musicTypeBaseBonusBP ?? musicTypeBaseBP) + member.musicTypeBonusBP : 0,
          musicTagBonusBP: member.tags!.some((id) => song.bestMusicTagIds!.includes(id))
            ? (override?.musicTagBaseBonusBP ?? musicTagBaseBP) + member.musicTagBonusBP
            : 0,
          vipBonusBP,
        });
        // CardPower.get_Total adds its independently converted component getters.
        const points = floorPowerBP(result.totalPowerBP);
        return {
          power: ((points.performance + points.technique + points.visual) / 10000) | 0,
          bpPower: result.totalPowerBP,
          windows: [],
          gaps: [],
        };
      });
    },
  };
}
