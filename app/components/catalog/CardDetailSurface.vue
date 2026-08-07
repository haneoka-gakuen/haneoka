<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { DetailHeaderIconItem, DetailMediaItem } from "~/components/detail/types";
import type { CostLevelRow, CostMaterial } from "~/components/detail/DetailLevelCostList.vue";
import {
  runtimeReleaseForCatalogOrigin,
  type CatalogContentOrigin,
} from "~/features/catalog/contentSource";
import { assetRootForRelease } from "~/composables/useReleaseServer";
import type { CardStatLevel, Character, MemberCard, SupportCard } from "~/types/archive";
import { textOf, type DisplayText } from "~/types/displayText";

interface CardLevelRate {
  group: number;
  level: number;
  exp?: number;
  performanceRate: number;
  technicRate: number;
  visualRate: number;
}

/** Raw progression rows served inside the `progression` document. Member-card
 *  rank/awake/level-limit tables are uniform (a single group each), so the raw
 *  rows are complete for every card. */
interface RankRaw {
  _group?: number;
  _rank?: number;
  _leaderSkillLevel?: number;
  _requiredRankUpItemCount?: number;
  _performanceRate?: number;
  _technicRate?: number;
  _visualRate?: number;
  _musicTypeBonusRate?: number;
  _musicTagBonusRate?: number;
}
interface AwakeRaw {
  _group?: number;
  _awakeCount?: number;
  _performanceRate?: number;
  _technicRate?: number;
  _visualRate?: number;
}
interface LevelLimitRaw {
  _awakeCount?: number;
  _rarity?: number;
  _limitLevel?: number;
}
interface SupportRankRaw {
  _group?: number;
  _rank?: number;
  _requiredRankUpItemCount?: number;
  _supportSkillLevel?: number;
  _gekisouSupportSkillLevel?: number;
  _limitLevel?: number;
}
interface ProgressionDocument {
  memberCardRanks?: { raw?: RankRaw }[];
  memberCardAwake?: { raw?: AwakeRaw }[];
  memberCardAwakeResources?: AwakeResource[];
  memberCardLevelLimits?: { raw?: LevelLimitRaw }[];
  supportCardRanks?: { raw?: SupportRankRaw }[];
}

interface AwakeResource {
  group: number;
  awakeCount: number;
  itemId: number;
  count: number;
  item?: { itemId?: number; name?: DisplayText; image?: string };
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    card?: MemberCard | SupportCard;
    origin: CatalogContentOrigin;
    kind: "member" | "snap";
    title: DisplayText;
    subtitle?: DisplayText;
    accent?: string;
    pending?: boolean;
    error?: unknown;
  }>(),
  {
    card: undefined,
    subtitle: "",
    accent: "var(--md-sys-color-primary)",
    pending: false,
    error: undefined,
  },
);

const emit = defineEmits<{
  close: [];
  retry: [];
}>();

const { resolveLocalized, formatDate, t } = useLocale();
const { releaseServer } = useReleaseServer();
const layerLink = useRouteQueryLayerLink();
const isSnap = computed(() => props.kind === "snap");
const runtimeRelease = computed(() => runtimeReleaseForCatalogOrigin(props.origin, releaseServer.value));
const { data: characterRecord } = useCatalogCollection<Character>("characters", () => props.origin);
const progressionView = computed(() => (isSnap.value ? "support-card-levels" : "member-card-levels"));
const { data: cardLevelEntries } = useCatalogView<CardLevelRate[]>("progression", progressionView, () => props.origin);
const memberCard = computed(() => (isSnap.value ? undefined : (props.card as MemberCard | undefined)));
const snapCard = computed(() => (isSnap.value ? (props.card as SupportCard | undefined) : undefined));
const cardKey = computed(() => memberCard.value?.cardId || snapCard.value?.supportCardId || 0);
const characterMap = computed(
  () => new Map(recordValues(characterRecord.value).map((character) => [character.characterId, character])),
);
const cardCharacters = computed(() => {
  const ids = isSnap.value
    ? snapCard.value?.characterIds?.length
      ? snapCard.value.characterIds
      : snapCard.value?.characterId
        ? [snapCard.value.characterId]
        : []
    : memberCard.value?.characterId
      ? [memberCard.value.characterId]
      : [];
  return [...new Set(ids)]
    .map((id) => characterMap.value.get(Number(id)))
    .filter((character): character is Character => Boolean(character))
    .sort((left, right) => left.characterId - right.characterId);
});
const headerEntities = computed<DetailHeaderIconItem[]>(() =>
  cardCharacters.value.slice(0, 5).map((character) => ({
    id: character.characterId,
    label:
      resolveLocalized(character.characterName, { sourceHint: "ja", fallback: String(character.characterId) }) ||
      String(character.characterId),
    image: character.faceImage || character.thumbnailImage || character.profileImage,
    shape: "avatar",
  })),
);
const detailTitle = computed<DisplayText>(() => {
  const candidates = isSnap.value ? [snapCard.value?.cardName] : [cardCharacters.value[0]?.characterName];
  return (
    resolveLocalized(props.card?.prefix, {
      candidates,
      sourceHint: "ja",
      fallback: textOf(props.title) || (isSnap.value ? t("supportCards") : t("memberCards")),
    }) || props.title
  );
});
const detailSubtitle = computed<DisplayText>(() => {
  const names = cardCharacters.value
    .map(
      (character) =>
        resolveLocalized(character.characterName, {
          sourceHint: "ja",
          fallback: String(character.characterId),
        }) || String(character.characterId),
    )
    .map((value) => textOf(value))
    .filter(Boolean);
  return names.length ? names.join(" · ") : props.subtitle || "";
});
const detailAccent = computed(() => cardCharacters.value[0]?.colorCode || props.accent);
const mediaItems = computed<DetailMediaItem[]>(() => {
  const images = props.card?.images;
  const items: DetailMediaItem[] = [];
  const seen = new Set<string>();
  const add = (item: DetailMediaItem) => {
    if (!item.src || seen.has(item.src)) return;
    seen.add(item.src);
    items.push(item);
  };

  add({
    id: "full",
    label: t("details"),
    src: images?.full || images?.thumbnail || "",
    thumbnail: images?.thumbnail,
    ratio: isSnap.value ? "support" : "member",
    fit: "contain",
  });
  if (!isSnap.value) {
    add({ id: "character", label: t("character"), src: images?.character || "", ratio: "member", fit: "contain" });
    add({ id: "background", label: t("stage"), src: images?.background || "", ratio: "member", fit: "contain" });
  }
  add({
    id: "skill",
    label: t("skills"),
    src: images?.skill || "",
    ratio: isSnap.value ? "support" : "member",
    fit: "contain",
  });
  return items;
});

const activeMedia = useRouteQueryText("media");
const activeMediaItem = computed(
  () => mediaItems.value.find((item) => item.id === activeMedia.value) || mediaItems.value[0],
);

const cardLevelGroup = computed(() =>
  Number(isSnap.value ? snapCard.value?.supportCardLevelGroup : memberCard.value?.memberCardLevelGroup),
);
const cardLevelRates = computed(
  () =>
    cardLevelEntries.value
      ?.filter((entry) => entry.group === cardLevelGroup.value && entry.level > 0)
      .sort((left, right) => left.level - right.level) || [],
);
// The native CalcPower helpers use single-precision SCVTF/FDIV followed by FCVTMS (floor).
const statAtRate = (value: number | undefined, rate: number) =>
  typeof value === "number" ? Math.floor(Math.fround(Math.fround(value * rate) / Math.fround(10_000))) : undefined;
// 特訓 (MasterMemberCardAwake) and 覚醒 (MasterMemberCardRank) each contribute a
// parallel param rate (0/250/.../1000, i.e. /10000) on top of the per-level rate.
// The level table maxes at exactly 10000, so `card.stat.*` is the max-level base;
// training + awakening raise the realized stat beyond it (up to +20% fully maxed).
const paramRatesOf = (row: { _performanceRate?: number; _technicRate?: number; _visualRate?: number } | undefined) => ({
  performance: row?._performanceRate ?? 0,
  technique: row?._technicRate ?? 0,
  visual: row?._visualRate ?? 0,
});
const trainingParamRates = computed(() => {
  const stage = selectedTraining.value || trainingLevels.value.at(-1) || 0;
  return paramRatesOf(awakeRows.value.find((row) => (row._awakeCount ?? 0) === stage));
});
const awakeningParamRates = computed(() => {
  const rank = selectedAwakening.value || awakeningLevels.value.at(-1) || 0;
  return paramRatesOf(rankRows.value.find((row) => (row._rank ?? 0) === rank));
});
const statRows = computed<CardStatLevel[]>(() => {
  const train = trainingParamRates.value;
  const awake = awakeningParamRates.value;
  return cardLevelRates.value.map((entry) => ({
    level: entry.level,
    performance: statAtRate(props.card?.stat?.performance, entry.performanceRate + train.performance + awake.performance),
    technique: statAtRate(props.card?.stat?.technique, entry.technicRate + train.technique + awake.technique),
    visual: statAtRate(props.card?.stat?.visual, entry.visualRate + train.visual + awake.visual),
  }));
});

// --- Progression document: member-card rank/awake/level-limit + snap ranks. ---
const { data: progressionDocument } = useLazyCatalogDocument<ProgressionDocument>(
  "progression",
  () => props.open && Boolean(props.card),
  undefined,
  () => props.origin,
);

// 覚醒 (awakening) — `MasterMemberCardRank`. Uniform group; raises the leader
// skill level (`_leaderSkillLevel` 1-5), params, and music bonuses. Cost is the
// card-specific メンバーピース (`rankUpItemId` × `_requiredRankUpItemCount`).
const rankRows = computed(() => {
  // Member-only. Rank/awake/level tables are uniform (one group for every card),
  // so default to 1 when the card record omits the group (served data may predate
  // the widened cards projection, which only gates future rebuilds).
  if (!memberCard.value) return [];
  const group = memberCard.value.memberCardRankGroup ?? 1;
  return (progressionDocument.value?.memberCardRanks ?? [])
    .map((row) => row.raw)
    .filter((raw): raw is RankRaw => Boolean(raw && raw._group === group))
    .sort((left, right) => (left._rank ?? 0) - (right._rank ?? 0));
});
const awakeningLevels = computed(() => rankRows.value.map((row) => row._rank ?? 0).filter((rank) => rank > 0));

// 特訓 (training) — `MasterMemberCardAwake`. Uniform group; raises params and,
// via the level-limit table, unlocks the level cap. Cost is coins + 紺碧のかけら.
const awakeRows = computed(() => {
  if (!memberCard.value) return [];
  const group = memberCard.value.memberCardAwakeGroup ?? 1;
  return (progressionDocument.value?.memberCardAwake ?? [])
    .map((row) => row.raw)
    .filter((raw): raw is AwakeRaw => Boolean(raw && raw._group === group))
    .sort((left, right) => (left._awakeCount ?? 0) - (right._awakeCount ?? 0));
});
const trainingLevels = computed(() =>
  awakeRows.value.map((row) => row._awakeCount ?? 0).filter((count) => count > 0),
);

const selectedStatLevel = useRouteQueryInteger("level", 0, { min: 0 });
const selectedTraining = useRouteQueryInteger("training", 0, { min: 0 });
const selectedAwakening = useRouteQueryInteger("awakening", 0, { min: 0 });
const selectedLiveLevel = useRouteQueryInteger("liveLevel", 0, { min: 0 });
const selectedGekisouLevel = useRouteQueryInteger("gekisouLevel", 0, { min: 0 });
const selectedSnapRank = useRouteQueryInteger("rank", 0, { min: 0 });

// 特訓 unlocks the level cap; clamp the selectable levels (and the selection)
// to the limit for the current rarity × training stage.
const levelCap = computed(() => {
  const rarity = memberCard.value?.rarity;
  // Before training defaults, assume the max stage so the level slider opens at
  // the full-training cap (e.g. 90 for SSR) rather than the stage-1 cap.
  const stage = selectedTraining.value || trainingLevels.value.at(-1) || 0;
  if (rarity === undefined || !stage) return undefined;
  const match = (progressionDocument.value?.memberCardLevelLimits ?? [])
    .map((row) => row.raw)
    .find((raw) => raw && raw._rarity === rarity && raw._awakeCount === stage);
  return match?._limitLevel;
});
// Snap rank caps the support-card level (`supportCardRanks._limitLevel`) — the
// mirror of how 特訓 unlocks the member-card level cap. Defined ahead of its
// first reader (statLevels); the computed getter resolves lazily.
const snapLevelCap = computed(() => {
  if (!isSnap.value) return undefined;
  const rows = snapRankRows.value;
  if (!rows.length) return undefined;
  const rank = selectedSnapRank.value || snapRankLevels.value.at(-1) || 0;
  return rows.find((row) => (row._rank ?? 0) === rank)?._limitLevel;
});
const statLevels = computed(() => {
  const base = statRows.value.length
    ? statRows.value.map((entry) => entry.level)
    : props.card?.stat?.maxLevel
      ? [props.card.stat.maxLevel]
      : props.card?.levelLimit
        ? [props.card.levelLimit]
        : [];
  const cap = levelCap.value ?? snapLevelCap.value;
  return cap ? base.filter((level) => level <= cap) : base;
});

const leaderSkill = computed(() => memberCard.value?.resolvedSkills.leader);
const liveSkill = computed(() => memberCard.value?.resolvedSkills.live);
const gekisouSkill = computed(() => memberCard.value?.resolvedSkills.gekisou);
const skillLevelsOf = (skill: { effects?: Array<Record<string, unknown>> } | undefined) =>
  [
    ...new Set(
      (skill?.effects || [])
        .map((effect) => Number(effect.level))
        .filter((level) => Number.isFinite(level) && level > 0),
    ),
  ].sort((left, right) => left - right);
const liveLevels = computed(() => skillLevelsOf(liveSkill.value));
const gekisouLevels = computed(() => skillLevelsOf(gekisouSkill.value));
const leaderEffectLevel = computed(() => {
  const rank = selectedAwakening.value || awakeningLevels.value.at(-1) || 0;
  return rankRows.value.find((row) => (row._rank ?? 0) === rank)?._leaderSkillLevel ?? rank;
});

const stats = computed(() => {
  const source = statRows.value.find((entry) => entry.level === selectedStatLevel.value) || props.card?.stat || {};
  return {
    performance: typeof source.performance === "number" ? source.performance : undefined,
    technique: typeof source.technique === "number" ? source.technique : undefined,
    visual: typeof source.visual === "number" ? source.visual : undefined,
  };
});
// EXP in the level tables is cumulative, so the value at the selected level is
// the total needed to reach it.
const cumulativeExp = computed(() => cardLevelRates.value.find((rate) => rate.level === selectedStatLevel.value)?.exp);

// --- 特訓 cost (coins + 紺碧のかけら). The awake-resources rows ride along in
//   the same progression document (uniform group), so no extra fetch is needed. ---
const trainingCostRows = computed<CostLevelRow[]>(() => {
  const group = memberCard.value?.memberCardAwakeResourceGroup ?? 1;
  const entries = isSnap.value ? undefined : progressionDocument.value?.memberCardAwakeResources;
  if (!entries) return [];
  const target = selectedTraining.value || trainingLevels.value.at(-1) || 0;
  const byStage = new Map<number, CostMaterial[]>();
  for (const entry of entries) {
    if (entry.group !== group || entry.awakeCount <= 1 || entry.awakeCount > target) continue;
    const material: CostMaterial = { label: entry.item?.name, image: entry.item?.image, amount: entry.count };
    const list = byStage.get(entry.awakeCount);
    if (list) list.push(material);
    else byStage.set(entry.awakeCount, [material]);
  }
  return [...byStage.entries()]
    .map(([level, materials]) => ({ level, materials }))
    .sort((left, right) => left.level - right.level);
});
const trainingCostTotal = computed<CostMaterial[]>(() => aggregateMaterials(trainingCostRows.value));

// --- 覚醒 cost (メンバーピース). The piece icon is built from the card's own
//   resolved asset prefix, so no items-collection fetch is needed. ---
const addressableRoot = computed(() => {
  const sample = String(memberCard.value?.images?.thumbnail || memberCard.value?.images?.full || "");
  const match = /^(\/assets\/[^/]+\/Assets\/AddressableResources\/)/.exec(sample);
  return match?.[1] ?? `${assetRootForRelease(releaseServer.value)}/Assets/AddressableResources/`;
});
const memberPieceImage = computed(() => {
  const id = memberCard.value?.rankUpItemId;
  return typeof id === "number" && id > 0 ? `${addressableRoot.value}Item/${id}/item_icon.png` : undefined;
});
const awakeningCostRows = computed<CostLevelRow[]>(() => {
  const image = memberPieceImage.value;
  if (!image) return [];
  const target = selectedAwakening.value || awakeningLevels.value.at(-1) || 0;
  return rankRows.value
    .filter((row) => (row._rank ?? 0) > 1 && (row._rank ?? 0) <= target)
    .map((row) => ({
      level: row._rank ?? 0,
      materials: [{ label: t("memberPiece"), image, amount: row._requiredRankUpItemCount ?? 0 }] satisfies CostMaterial[],
    }));
});
const awakeningCostTotal = computed<CostMaterial[]>(() => aggregateMaterials(awakeningCostRows.value));

// --- Snap: skills rise with rank (`supportCardRanks`). `_supportCardRankGroup`
//   equals `_supportCardLevelGroup` for every support card, so default to the
//   served level group when the rank group isn't projected (stale served data). ---
const snapRankRows = computed(() => {
  const group = snapCard.value?.supportCardRankGroup ?? snapCard.value?.supportCardLevelGroup;
  if (group === undefined) return [];
  return (progressionDocument.value?.supportCardRanks ?? [])
    .map((row) => row.raw)
    .filter((raw): raw is SupportRankRaw => Boolean(raw && raw._group === group))
    .sort((left, right) => (left._rank ?? 0) - (right._rank ?? 0));
});
const snapRankLevels = computed(() => snapRankRows.value.map((row) => row._rank ?? 0).filter((rank) => rank > 0));
const snapSkillLevel = computed(() => {
  const rank = selectedSnapRank.value || snapRankLevels.value.at(-1) || 0;
  return snapRankRows.value.find((row) => (row._rank ?? 0) === rank)?._supportSkillLevel ?? rank;
});
const snapSkills = computed(() =>
  [
    ...(snapCard.value?.resolvedSkills.support || []).map((skill) => ({ skill, label: t("supportSkill") })),
    ...(snapCard.value?.resolvedSkills.gekisouSupport || []).map((skill) => ({
      skill,
      label: t("gekisouSkill"),
    })),
  ].filter((entry) => Boolean(entry.skill)),
);

const diary = computed(() => resolveLocalized(snapCard.value?.diary, { sourceHint: "ja" }));
const hasDiary = computed(() => Boolean(textOf(diary.value)));
const identityFacts = computed(() => [
  {
    label: t("rarity"),
    value: "",
    mark: { kind: "rarity" as const, rarity: props.card?.rarity ?? 0, runtimeRelease: runtimeRelease.value },
  },
  {
    label: t("attribute"),
    value: "",
    mark: { kind: "attribute" as const, attribute: props.card?.cardType ?? 0, runtimeRelease: runtimeRelease.value },
  },
  { label: t("type"), value: props.card?.type },
  {
    label: t("release"),
    value: props.card?.releasedAt?.[0] ? formatDate(props.card.releasedAt[0]) : "",
  },
]);

let observedCardKey = 0;
watch(
  [cardKey, statLevels, trainingLevels, awakeningLevels, liveLevels, gekisouLevels, snapRankLevels],
  () => {
    const cardChanged = observedCardKey !== cardKey.value;
    observedCardKey = cardKey.value;
    if (!props.card || props.pending) return;
    const latest = <T>(values: T[]) => (values.length ? values[values.length - 1] : 0);
    // Default training/awakening first: the level cap depends on the training
    // stage, so the level must be chosen after training settles (otherwise it
    // pins to the stage-1 cap and never reaches the full-training max).
    if (cardChanged || !trainingLevels.value.includes(selectedTraining.value)) {
      selectedTraining.value = latest(trainingLevels.value);
    }
    if (cardChanged || !awakeningLevels.value.includes(selectedAwakening.value)) {
      selectedAwakening.value = latest(awakeningLevels.value);
    }
    // For support cards the level cap depends on the rank, so default rank before
    // the level (mirroring training → level for member cards).
    if (cardChanged || !snapRankLevels.value.includes(selectedSnapRank.value)) {
      selectedSnapRank.value = latest(snapRankLevels.value);
    }
    if (cardChanged || !statLevels.value.includes(selectedStatLevel.value)) {
      selectedStatLevel.value = latest(statLevels.value);
    }
    if (cardChanged || !liveLevels.value.includes(selectedLiveLevel.value)) {
      selectedLiveLevel.value = latest(liveLevels.value);
    }
    if (cardChanged || !gekisouLevels.value.includes(selectedGekisouLevel.value)) {
      selectedGekisouLevel.value = latest(gekisouLevels.value);
    }
    if (!mediaItems.value.some((item) => item.id === activeMedia.value)) {
      activeMedia.value = mediaItems.value[0]?.id || "full";
    }
  },
  { immediate: true },
);

function aggregateMaterials(rows: CostLevelRow[]): CostMaterial[] {
  const totals = new Map<string, CostMaterial>();
  for (const row of rows) {
    for (const material of row.materials) {
      const key = material.image || (Array.isArray(material.label) ? material.label.join("/") : String(material.label ?? ""));
      const existing = totals.get(key);
      if (existing) existing.amount += material.amount;
      else totals.set(key, { ...material });
    }
  }
  return [...totals.values()];
}
</script>

<template>
  <FullscreenDetailSurface
    :open="open"
    :title="detailTitle"
    :subtitle="detailSubtitle"
    :accent="detailAccent"
    :leading-icons="headerEntities"
    body-overflow="hidden"
    @close="emit('close')"
  >
    <template v-if="card" #leading>
      <RarityMark :rarity="card.rarity" :runtime-release="runtimeRelease" />
      <AttributeMark :attribute="card.cardType" :runtime-release="runtimeRelease" icon-only />
    </template>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="emit('retry')" />
    <DetailLayout v-else-if="card" class="card-detail-surface" :style="{ '--md-comp-detail-accent': detailAccent }">
      <template #media>
        <DetailMediaStage v-model="activeMedia" :items="mediaItems" compact />
        <p v-if="activeMediaItem" class="card-detail-surface__media-label">
          <DisplayText :value="activeMediaItem.label" />
          <span v-if="mediaItems.length > 1" class="display-number">
            {{ mediaItems.findIndex((item) => item.id === activeMediaItem?.id) + 1 }}/{{ mediaItems.length }}
          </span>
        </p>
      </template>

      <DetailSection :title="t('details')" icon="info">
        <FactGrid :facts="identityFacts" />
      </DetailSection>

      <DetailSection v-if="cardCharacters.length" :title="t('characters')" icon="groups">
        <div class="card-detail-surface__relation-list">
          <NuxtLink
            v-for="character in cardCharacters"
            :key="character.characterId"
            :to="layerLink(`/catalog/characters?character=${character.characterId}`, 'character')"
          >
            <img
              v-if="character.faceImage || character.thumbnailImage || character.profileImage"
              :src="character.faceImage || character.thumbnailImage || character.profileImage"
              alt=""
              loading="lazy"
              decoding="async"
            />
            <DisplayText
              :value="
                resolveLocalized(character.characterName, {
                  sourceHint: 'ja',
                  fallback: String(character.characterId),
                })
              "
            />
            <MaterialIcon name="north_east" :size="16" aria-hidden="true" />
          </NuxtLink>
        </div>
      </DetailSection>

      <DetailSection :title="t('stats')" icon="monitoring">
        <!-- Member card: 等級 / 特訓 / 覚醒 / 演出技能 / 激奏技能, all driving one panel.
             等級 on its own row; 特訓+覚醒 and 演出+激奏 paired side by side. -->
        <div v-if="!isSnap" class="card-detail-surface__board">
          <div class="card-detail-surface__board-cell">
            <DetailLevelSwitch
              v-if="statLevels.length > 1"
              v-model="selectedStatLevel"
              :levels="statLevels"
              :label="t('level')"
            />
          </div>
          <div class="card-detail-surface__board-pair">
            <DetailLevelSwitch
              v-if="trainingLevels.length > 1"
              v-model="selectedTraining"
              :levels="trainingLevels"
              :label="t('training')"
            />
            <DetailLevelSwitch
              v-if="awakeningLevels.length > 1"
              v-model="selectedAwakening"
              :levels="awakeningLevels"
              :label="t('awakening')"
            />
          </div>
          <div class="card-detail-surface__board-pair">
            <DetailLevelSwitch
              v-if="liveLevels.length > 1"
              v-model="selectedLiveLevel"
              :levels="liveLevels"
              :label="t('liveSkill')"
            />
            <DetailLevelSwitch
              v-if="gekisouLevels.length > 1"
              v-model="selectedGekisouLevel"
              :levels="gekisouLevels"
              :label="t('gekisouSkill')"
            />
          </div>
        </div>
        <!-- Snap: 等級 + rank (skills rise with rank). -->
        <div v-else class="card-detail-surface__board">
          <div class="card-detail-surface__board-cell">
            <DetailLevelSwitch
              v-if="statLevels.length > 1"
              v-model="selectedStatLevel"
              :levels="statLevels"
              :label="t('level')"
            />
          </div>
          <div class="card-detail-surface__board-cell">
            <DetailLevelSwitch
              v-if="snapRankLevels.length > 1"
              v-model="selectedSnapRank"
              :levels="snapRankLevels"
              :label="t('rank')"
            />
          </div>
        </div>

        <DetailStatPanel
          :stats="stats"
          :exp="cumulativeExp"
          :format="isSnap ? 'percent' : 'flat'"
          :show-total="!isSnap"
        />

        <DetailLevelCostList
          v-if="!isSnap && trainingCostRows.length"
          :rows="trainingCostRows"
          :total="trainingCostTotal"
          :label="t('training')"
          :level-tag="t('training')"
        />

        <div class="card-detail-surface__skills">
          <template v-if="!isSnap">
            <div v-if="leaderSkill" class="card-detail-surface__skill-set">
              <DetailLevelCostList
                v-if="awakeningCostRows.length"
                :rows="awakeningCostRows"
                :total="awakeningCostTotal"
                :label="t('awakening')"
                :level-tag="t('rank')"
              />
              <CardSkillBlock
                :skill="leaderSkill"
                :label="t('leaderSkill')"
                :level="leaderEffectLevel"
                :origin="origin"
              />
            </div>
            <CardSkillBlock
              v-if="liveSkill"
              class="card-detail-surface__skill"
              :skill="liveSkill"
              :label="t('liveSkill')"
              :level="selectedLiveLevel"
              :resource-group="memberCard?.liveSkillLevelResourceGroup"
              :origin="origin"
            />
            <CardSkillBlock
              v-if="gekisouSkill"
              class="card-detail-surface__skill"
              :skill="gekisouSkill"
              :label="t('gekisouSkill')"
              :level="selectedGekisouLevel"
              :resource-group="memberCard?.gekisouSkillLevelResourceGroup"
              :origin="origin"
            />
          </template>
          <template v-else>
            <CardSkillBlock
              v-for="(entry, index) in snapSkills"
              :key="`${textOf(entry.label)}:${entry.skill?.id ?? index}`"
              class="card-detail-surface__skill"
              :skill="entry.skill"
              :label="entry.label"
              :level="snapSkillLevel"
              :origin="origin"
            />
          </template>
        </div>
      </DetailSection>

      <DetailSection v-if="hasDiary" :title="t('diary')" icon="menu_book">
        <div class="card-detail-surface__diary">
          <DisplayText :value="diary" />
        </div>
      </DetailSection>
    </DetailLayout>
  </FullscreenDetailSurface>
</template>

<style scoped>
.card-detail-surface__media-label {
  position: absolute;
  z-index: 5;
  right: 12px;
  bottom: 10px;
  left: 12px;
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: color-mix(in srgb, var(--md-sys-color-surface-container-high) 92%, transparent);
  box-shadow: var(--md-sys-elevation-level1);
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-medium-line-height);
  pointer-events: none;
}

.card-detail-surface__relation-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--md-sys-spacing-2);
  margin-top: var(--md-sys-spacing-2);
}

.card-detail-surface__relation-list a {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-3) var(--md-sys-spacing-1) var(--md-sys-spacing-1);
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container);
  font-family: var(--md-sys-typescale-label-large-font);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
  line-height: var(--md-sys-typescale-label-large-line-height);
}

.card-detail-surface__relation-list a:hover {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}

.card-detail-surface__relation-list img {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  border-radius: 50%;
  object-fit: cover;
}

.card-detail-surface__board {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--md-sys-spacing-2);
}

.card-detail-surface__board-cell {
  min-width: 0;
}

.card-detail-surface__board-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.card-detail-surface__board :deep(.detail-level-switch) {
  width: 100%;
  min-width: 0;
}

@media (max-width: 600px) {
  .card-detail-surface__board-pair {
    grid-template-columns: 1fr;
  }
}

/* Cost lists live inside gap-spaced grids (the stats section and the leader
   column below); drop the component's default top margin so it doesn't compound
   with the container gap and produce uneven padding around the 特訓/覚醒 lists. */
.card-detail-surface :deep(.level-cost-list) {
  margin-top: 0;
}

.card-detail-surface__skills {
  display: grid;
  gap: var(--md-sys-spacing-2);
  grid-template-columns: 1fr;
}

.card-detail-surface__skill {
  min-width: 0;
}

/* Leader column: 覚醒 cost stacked above the leader skill, spaced by the gap. */
.card-detail-surface__skill-set {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-2);
}

.card-detail-surface__diary {
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface-variant);
  border-left: 3px solid var(--md-comp-detail-accent);
  background: var(--md-sys-color-surface-container-low);
  font-family: var(--md-sys-typescale-body-medium-font);
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: var(--md-sys-typescale-body-medium-line-height);
  white-space: pre-line;
}

@media (max-width: 760px) {
  .card-detail-surface__relation-list a {
    min-height: var(--md-comp-control-height-touch);
  }
}

@media (max-width: 959px) and (max-height: 500px), (hover: none) and (pointer: coarse) {
  .card-detail-surface__relation-list a {
    min-height: var(--md-comp-control-height-touch);
  }
}
</style>
