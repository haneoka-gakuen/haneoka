import type { EvidenceGap } from "../contracts";
import { dataRows, nativeRow, objectRow, type DataRow, type TeamBuilderData } from "../data";
import { createUnknownPlayerModifiers, playerModifierRanges, validateInventory, type InventoryV1 } from "../inventory";
import { resolveCharacterRankTotal, type CharacterRankTotalScope } from "./character-rank-total";
import { characterRankInventoryIds } from "./character-rank-scope";

/** Same-release raw rows for the native factory. Effect/target enums and
 * threshold selection remain with the native formula owner.
 */
export function nativeConditionSources(data: TeamBuilderData, inventory: InventoryV1, rankScope?: CharacterRankTotalScope | null) {
  const totalRank = resolveCharacterRankTotal(data, inventory, rankScope);
  const validation = validateInventory(inventory, data, {
    accountCharacterIds: characterRankInventoryIds(totalRank),
  });
  if (!validation.valid) throw new Error(`Invalid condition inventory:${validation.issues[0]?.path}`);
  const gaps: EvidenceGap[] = [];
  const gap = (code: string, source: string) => gaps.push({ code, source });
  const exactRank = (table: string, group: number, rank: number | null, source: string): DataRow | null => {
    if (rank === null) {
      gap("unknown-awakening", source);
      return null;
    }
    const rows = (data.progression[table] ?? []).filter(
      (row) => Number(row.group) === group && Number(row.rank) === rank,
    );
    if (rows.length !== 1) {
      gap("missing-or-ambiguous-native-rank", source);
      return null;
    }
    return rows[0]!;
  };
  const members = Object.fromEntries(
    inventory.members.map((state) => {
      const card = data.members[String(state.cardId)]!;
      const rank = exactRank("memberCardRanks", card.awakeningGroup, state.awakening, state.instanceId);
      const leaderSkillLevel =
        typeof rank?.leaderSkillLevel === "number" && Number.isSafeInteger(rank.leaderSkillLevel)
          ? rank.leaderSkillLevel
          : null;
      const leader = data.skills.leader?.[String(card.leaderSkillId)];
      const leaderEffects =
        leaderSkillLevel === null
          ? []
          : dataRows(leader?.effects)
              .map(nativeRow)
              .filter((effect) => effect.level === leaderSkillLevel);
      if (card.leaderSkillId > 0 && (leaderSkillLevel === null || !leaderEffects.length))
        gap("missing-leader-skill-level-or-effects", state.instanceId);
      if (card.bestMusicTagIds === null) gap("missing-member-music-tags", state.instanceId);
      if (!Number.isSafeInteger(card.musicType)) gap("missing-member-music-type", state.instanceId);
      return [state.instanceId, { card, rank, leaderSkillLevel, leaderEffects }] as const;
    }),
  );
  const snapshots = Object.fromEntries(
    inventory.snapshots.map((state) => {
      const card = data.snapshots[String(state.cardId)]!;
      return [
        state.instanceId,
        { card, rank: exactRank("supportCardRanks", card.awakeningGroup, state.awakening, state.instanceId) },
      ] as const;
    }),
  );
  const characterRanks = Object.fromEntries(
    Object.keys(data.characters).map((id) => {
      const rank = inventory.characterRanks[id] ?? null;
      const rows = rank === null ? [] : (data.progression.characterRanks ?? []).filter((row) => row.rank === rank);
      if (rank === null) gap("unknown-character-rank", id);
      else if (rows.length !== 1) gap("missing-or-ambiguous-character-rank", id);
      // MasterCharacterRank.bonus is the cumulative value in this one row.
      return [id, { rank, row: rows.length === 1 ? rows[0]! : null }] as const;
    }),
  );
  const bandUpgrades = Object.fromEntries(
    Object.entries(data.bandItems).map(([id, item]) => {
      const level = inventory.bandItems[id] ?? null;
      const inactive = level === 0;
      const levelRows =
        level === null || inactive
          ? []
          : dataRows(item.levels)
              .map(nativeRow)
              .filter((row) => row.level === level);
      const effects =
        level === null || inactive
          ? []
          : dataRows(item.effects)
              .map(nativeRow)
              .filter((row) => row.level === level);
      if (level === null) gap("unknown-band-upgrade-level", id);
      else if (!inactive && (levelRows.length !== 1 || !effects.length)) gap("missing-band-upgrade-level-or-effects", id);
      return [id, { item, level, inactive, levelRow: levelRows.length === 1 ? levelRows[0]! : null, effects }] as const;
    }),
  );
  const songs = Object.fromEntries(
    Object.entries(data.songs).map(([id, song]) => {
      const musicType = typeof song.musicType === "number" ? song.musicType : null;
      const bestMusicTagIds = Array.isArray(song.bestMusicTagIds) ? song.bestMusicTagIds : null;
      return [id, { musicType, bestMusicTagIds }] as const;
    }),
  );
  const observedPlayerModifiers = inventory.schema === "haneoka-team-inventory-v2" ? inventory.playerModifiers : createUnknownPlayerModifiers();
  const playerModifiers = { ...observedPlayerModifiers, characterTotalRank: totalRank.effective };
  const modifierRanges = playerModifierRanges(data);
  if (playerModifiers.characterTotalRank === null)
    gap("unknown-character-total-rank", "playerModifiers.characterTotalRank");
  if (playerModifiers.vipRank === null) gap("unknown-vip-rank", "playerModifiers.vipRank");
  if (!modifierRanges.vipRanks.length) gap("vip-domain-unavailable", "MasterVip");
  const vipRankRows =
    playerModifiers.vipRank === null
      ? []
      : (data.runtimeRules?.tables.vipRankBonuses.rows ?? []).filter((row) => row.vipRank === playerModifiers.vipRank);
  return {
    identity: { ...data.identity },
    playerModifiers,
    characterRankTotal: totalRank,
    modifierRanges,
    vipRankRows,
    members,
    snapshots,
    characterRanks,
    // T18 resolves the applicable totalRank threshold; partial player ranks
    // are preserved individually and never converted to a purported total.
    characterTotalRankRows: data.progression.characterTotalRanks ?? [],
    bandUpgrades,
    songs,
    conditionSets: dataRows(data.skillReference.conditionSets),
    conditions: dataRows(data.skillReference.conditions),
    cumulativeConditions: dataRows(data.skillReference.cumulativeConditions),
    targets: dataRows(data.skillReference.targets),
    liveSettings: dataRows(data.liveTools.liveSettings),
    runtimeRules: data.runtimeRules ?? null,
    eventRules: objectRow(data.eventRules),
    gaps,
  };
}
