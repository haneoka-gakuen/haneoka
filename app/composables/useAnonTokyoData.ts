import type { AnonTokyoDocument, AnonTokyoEntity, AnonTokyoText } from "~/types/anonTokyo";
import { anonTokyoText } from "~/types/anonTokyo";

export interface AnonTokyoRewardPart {
  type: number;
  id?: number;
  count?: number;
}

export interface AnonTokyoPassiveEntry {
  abilityId: number;
  value: number;
}

/**
 * MasterATCharacter._charPassiveAbility stores a per-ability tier in
 * {5,10,15}, not the displayed percent: 15 means no bonus. Verified in game
 * (乐奈 shows +0% checkout while her stored tier is 15).
 */
export const anonTokyoPassivePercent = (tier: number): number => Math.max(0, 15 - tier);

export interface AnonTokyoSpinePartRef {
  modelId?: string;
  order?: number;
  reloadingId?: number;
}

const asInt = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Master reward fields pack either "type,id,count" triples (task and level
 * rewards) or "type,count" pairs (stage buffers). Both appear across tables, so
 * keep the distinction instead of inventing a missing id.
 */
export const parseAnonTokyoReward = (raw: unknown): AnonTokyoRewardPart[] =>
  String(raw || "")
    .split(";")
    .filter(Boolean)
    .map((entry) => {
      const values = entry.split(",").map((value) => value.trim());
      if (values.length >= 3) {
        return { type: Number(values[0]), id: asInt(values[1]), count: asInt(values[2]) };
      }
      return { type: Number(values[0]), count: asInt(values[1]) };
    })
    .filter((part) => Number.isFinite(part.type));

export const parseAnonTokyoPassive = (raw: unknown): AnonTokyoPassiveEntry[] =>
  String(raw || "")
    .split(";")
    .filter(Boolean)
    .map((entry) => {
      const [abilityId, value] = entry.split(",");
      return { abilityId: Number(abilityId), value: Number(value) };
    })
    .filter((part) => Number.isFinite(part.abilityId) && Number.isFinite(part.value));

/** MasterATReplacementparts paths end ``<family>_<slot>_SkeletonData``. */
export const anonTokyoPartSlot = (pathName: unknown): string | undefined => {
  const stem = String(pathName || "").split("/").pop() || "";
  const trimmed = stem.replace(/_skeletondata(\.asset)?$/i, "");
  const separator = trimmed.indexOf("_");
  if (separator < 0) return undefined;
  const slot = trimmed.slice(separator + 1);
  return slot || undefined;
};

/** Compact label for an unknown enum-ish master value. */
export const anonTokyoRawLabel = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((entry) => anonTokyoRawLabel(entry)).filter(Boolean).join(" · ");
  return String(value);
};

export const useAnonTokyoCatalogData = () => {
  const { data: document, pending, error, refresh } = useAnonTokyoCatalog();
  const { locale } = useLocale();

  const text = (value: AnonTokyoText | undefined): string => anonTokyoText(value, locale.value);
  const section = <T>(records: Record<string, T> | undefined): T[] => Object.values(records || {});

  const currencyLabel = (id: number | undefined): string => {
    if (id === undefined) return "";
    const currency = section(document.value?.progression?.currencies).find((entry) => entry.rawId === id);
    return text(currency?.name) || `#${id}`;
  };

  const passiveLabel = (entry: AnonTokyoPassiveEntry): string => {
    const ability = section(document.value?.progression?.passiveAbilities).find(
      (candidate) => candidate.rawId === entry.abilityId,
    );
    const name = text(ability?.name as AnonTokyoText | undefined) || `#${entry.abilityId}`;
    return `${name} +${anonTokyoPassivePercent(entry.value)}%`;
  };

  /**
   * Appearance recipes key exactly by the master's `_defaultAvatar` reloading
   * set, so every customer/town/roam variant resolves to its game portrait.
   */
  const appearancePreview = (defaultAvatarIds: unknown): string | undefined => {
    const ids = (defaultAvatarIds as number[] | undefined) || [];
    if (!ids.length) return undefined;
    const key = [...ids].sort((left, right) => left - right).join(",");
    for (const recipe of section(document.value?.spine?.renderRecipes)) {
      const recipeIds = recipe.defaultAvatarReloadingIds || [];
      if (!recipe.outfitReloadingIds?.length && [...recipeIds].sort((left, right) => left - right).join(",") === key) {
        return recipe.preview?.status === "rendered" ? recipe.preview.url || undefined : undefined;
      }
    }
    return undefined;
  };

  const characterPortrait = (characterId: number | undefined): string | undefined => {
    if (characterId === undefined) return undefined;
    const recipe = section(document.value?.spine?.renderRecipes).find(
      (candidate) => candidate.characterId === characterId && !candidate.outfitReloadingIds?.length,
    );
    return recipe?.preview?.status === "rendered" ? recipe.preview.url || undefined : undefined;
  };

  const passivePercentByAbility = (entry: AnonTokyoEntity | undefined): Map<number, number> => {
    const output = new Map<number, number>();
    for (const part of parseAnonTokyoPassive((entry as { passiveAbility?: unknown })?.passiveAbility)) {
      output.set(part.abilityId, anonTokyoPassivePercent(part.value));
    }
    return output;
  };

  return {
    document,
    pending,
    error,
    refresh,
    text,
    section,
    currencyLabel,
    passiveLabel,
    passivePercentByAbility,
    appearancePreview,
    characterPortrait,
  };
};
