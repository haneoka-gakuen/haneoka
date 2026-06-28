<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { DetailHeaderIconItem, DetailMediaItem } from "~/components/detail/types";
import type { CardStatLevel, Character, MemberCard, SupportCard } from "~/types/archive";
import { textOf, type DisplayText } from "~/types/displayText";

interface CardLevelRate {
  group: number;
  level: number;
  performanceRate: number;
  technicRate: number;
  visualRate: number;
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    card?: MemberCard | SupportCard;
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
const layerLink = useRouteQueryLayerLink();
const isSnap = computed(() => props.kind === "snap");
const { data: characterRecord } = useCatalogCollection<Character>("characters");
const progressionView = computed(() => (isSnap.value ? "support-card-levels" : "member-card-levels"));
const { data: cardLevelEntries } = useCatalogView<CardLevelRate[]>("progression", progressionView);
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
const statRows = computed<CardStatLevel[]>(() =>
  cardLevelRates.value.map((entry) => ({
    level: entry.level,
    performance: statAtRate(props.card?.stat?.performance, entry.performanceRate),
    technique: statAtRate(props.card?.stat?.technique, entry.technicRate),
    visual: statAtRate(props.card?.stat?.visual, entry.visualRate),
  })),
);
const statLevels = computed(() =>
  statRows.value.length
    ? statRows.value.map((entry) => entry.level)
    : props.card?.stat?.maxLevel
      ? [props.card.stat.maxLevel]
      : props.card?.levelLimit
        ? [props.card.levelLimit]
        : [],
);
const selectedStatLevel = useRouteQueryInteger("level", 0, { min: 0 });
const stats = computed(() => {
  const source = statRows.value.find((entry) => entry.level === selectedStatLevel.value) || props.card?.stat || {};
  return {
    performance: typeof source.performance === "number" ? source.performance : undefined,
    technique: typeof source.technique === "number" ? source.technique : undefined,
    visual: typeof source.visual === "number" ? source.visual : undefined,
  };
});

const skills = computed(() =>
  isSnap.value
    ? [
        ...(snapCard.value?.resolvedSkills.support || []).map((skill) => ({
          skill,
          label: t("supportSkill"),
        })),
        ...(snapCard.value?.resolvedSkills.gekisouSupport || []).map((skill) => ({
          skill,
          label: t("gekisouSkill"),
        })),
      ]
    : [
        { skill: memberCard.value?.resolvedSkills.leader, label: t("leaderSkill") },
        { skill: memberCard.value?.resolvedSkills.live, label: t("liveSkill") },
        { skill: memberCard.value?.resolvedSkills.gekisou, label: t("gekisouSkill") },
      ],
);
const visibleSkills = computed(() => skills.value.filter((entry) => Boolean(entry.skill)));
const skillLevels = computed(() =>
  [
    ...new Set(
      visibleSkills.value
        .flatMap((entry) => entry.skill?.effects?.map((effect) => Number(effect.level)) || [])
        .filter((level) => Number.isFinite(level) && level > 0),
    ),
  ].sort((left, right) => left - right),
);
const selectedSkillLevel = useRouteQueryInteger("skillLevel", 0, { min: 0 });
const diary = computed(() => resolveLocalized(snapCard.value?.diary, { sourceHint: "ja" }));
const hasDiary = computed(() => Boolean(textOf(diary.value)));
const identityFacts = computed(() => [
  { label: t("id"), value: cardKey.value },
  { label: t("rarity"), value: props.card?.rarity },
  { label: `${t("cards")} ${t("type")}`, value: props.card?.cardType },
  { label: t("type"), value: props.card?.type },
  { label: t("level"), value: selectedStatLevel.value || props.card?.levelLimit },
  {
    label: t("release"),
    value: props.card?.releasedAt?.[0] ? formatDate(props.card.releasedAt[0]) : "",
  },
]);

let observedCardKey = 0;
watch(
  [cardKey, statLevels, skillLevels],
  () => {
    const cardChanged = observedCardKey !== cardKey.value;
    observedCardKey = cardKey.value;
    if (!props.card || props.pending) return;
    if (cardChanged || !statLevels.value.includes(selectedStatLevel.value)) {
      selectedStatLevel.value = Math.max(...statLevels.value, 0);
    }
    if (cardChanged || !skillLevels.value.includes(selectedSkillLevel.value)) {
      selectedSkillLevel.value = Math.max(...skillLevels.value, 0);
    }
    if (!mediaItems.value.some((item) => item.id === activeMedia.value)) {
      activeMedia.value = mediaItems.value[0]?.id || "full";
    }
  },
  { immediate: true },
);
</script>

<template>
  <FullscreenDetailSurface
    :open="open"
    :title="title"
    :subtitle="subtitle"
    :accent="accent"
    :leading-icons="headerEntities"
    body-overflow="hidden"
    @close="emit('close')"
  >
    <template v-if="card" #leading>
      <RarityMark :rarity="card.rarity" />
      <AttributeMark :attribute="card.cardType" icon-only />
    </template>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="emit('retry')" />
    <DetailLayout v-else-if="card" class="card-detail-surface" :style="{ '--md-comp-detail-accent': accent }">
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
        <div v-if="cardCharacters.length" class="card-detail-surface__relations">
          <span class="meta-label">{{ t("characters") }}</span>
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
        </div>
      </DetailSection>

      <DetailSection :title="t('stats')" icon="monitoring">
        <template #actions>
          <DetailLevelSwitch
            v-if="statLevels.length > 1"
            v-model="selectedStatLevel"
            class="card-detail-surface__level-switch"
            :levels="statLevels"
            :label="t('level')"
          />
        </template>
        <DetailStatPanel :stats="stats" />
      </DetailSection>

      <DetailSection v-if="visibleSkills.length" :title="t('skills')" icon="auto_awesome">
        <template #actions>
          <DetailLevelSwitch
            v-if="skillLevels.length > 1"
            v-model="selectedSkillLevel"
            class="card-detail-surface__level-switch"
            :levels="skillLevels"
            :label="t('level')"
          />
        </template>
        <div class="card-detail-surface__skills">
          <SkillBlock
            v-for="entry in visibleSkills"
            :key="`${textOf(entry.label)}:${entry.skill?.id}`"
            :skill="entry.skill"
            :label="entry.label"
            :level="selectedSkillLevel"
          />
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

.card-detail-surface__skills {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--md-sys-spacing-2);
}

.card-detail-surface__level-switch {
  width: clamp(320px, 38vw, 480px);
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
  .card-detail-surface__level-switch {
    width: min(320px, 100%);
  }

  .card-detail-surface__skills {
    grid-template-columns: 1fr;
  }

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
