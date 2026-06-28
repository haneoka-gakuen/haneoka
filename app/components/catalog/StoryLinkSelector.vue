<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

import type { CSSProperties } from "vue";
import type { Character } from "~/types/archive";
import { langOf, textOf, type DisplayText } from "~/types/displayText";

interface FriendshipSlot {
  x: string;
  y: string;
  arrowX: string;
  arrowY: string;
  arrowRotation: string;
}

interface PartnerGroup {
  bandId: number;
  characters: Character[];
}

type FriendshipStyle = CSSProperties & Record<`--${string}`, string>;

const props = withDefaults(
  defineProps<{
    characters: Character[];
    partners: Character[];
    firstId?: number;
    secondId?: number;
    nameOf: (character: Character) => DisplayText;
    bandNameOf: (bandId: number) => DisplayText;
  }>(),
  { firstId: undefined, secondId: undefined },
);

const emit = defineEmits<{
  first: [characterId: number];
  second: [characterId: number];
  swap: [];
}>();

const { resolveLocalized, t } = useLocale();
const { assetRoot, assetUrl } = useAssetServer();
const releaseAssetUrl = (path: string) => assetUrl(`${assetRoot.value}/${path}`);
const first = computed(() => props.characters.find((character) => character.characterId === props.firstId));
const second = computed(() => props.partners.find((character) => character.characterId === props.secondId));
const byCharacterId = (left: Character, right: Character) => left.characterId - right.characterId;
const orderedCharacters = computed(() => [...props.characters].sort(byCharacterId));

// Serialized _characterIcon order and RectTransforms from BandBoard_Self (1312 × 964).
const selfSlots: readonly FriendshipSlot[] = [
  {
    x: "18.82622%",
    y: "43.36100%",
    arrowX: "90.85714%",
    arrowY: "68.57143%",
    arrowRotation: "-11.853991deg",
  },
  {
    x: "27.59146%",
    y: "77.80083%",
    arrowX: "93.28571%",
    arrowY: "33.08571%",
    arrowRotation: "-44.430576deg",
  },
  {
    x: "74.16159%",
    y: "67.20954%",
    arrowX: "3.51429%",
    arrowY: "40.37143%",
    arrowRotation: "29.744215deg",
  },
  {
    x: "73.93293%",
    y: "25.82988%",
    arrowX: "7.42857%",
    arrowY: "80.62857%",
    arrowRotation: "-29.195091deg",
  },
];

// Serialized _characterIcon order and RectTransforms from BandBoard_Other (1312 × 964).
const otherSlots: readonly FriendshipSlot[] = [
  {
    x: "19.28354%",
    y: "30.18672%",
    arrowX: "90.60000%",
    arrowY: "75.37143%",
    arrowRotation: "29.658096deg",
  },
  {
    x: "20.88415%",
    y: "69.91701%",
    arrowX: "96.00000%",
    arrowY: "44.85714%",
    arrowRotation: "-36.740987deg",
  },
  {
    x: "68.90244%",
    y: "80.18672%",
    arrowX: "10.71429%",
    arrowY: "13.57143%",
    arrowRotation: "52.050356deg",
  },
  {
    x: "79.64939%",
    y: "49.48133%",
    arrowX: "-0.28571%",
    arrowY: "50.00000%",
    arrowRotation: "3.755137deg",
  },
  {
    x: "71.95122%",
    y: "20.12448%",
    arrowX: "9.34286%",
    arrowY: "86.82857%",
    arrowRotation: "-43.944990deg",
  },
];

const partnerGroups = computed<PartnerGroup[]>(() => {
  const groups = new Map<number, Character[]>();
  for (const character of [...props.partners].sort(byCharacterId)) {
    const bandId = Number(character.bandId) || 0;
    const values = groups.get(bandId) || [];
    values.push(character);
    groups.set(bandId, values);
  }
  const firstBandId = Number(first.value?.bandId) || 0;
  return [...groups.entries()]
    .map(([bandId, characters]) => ({ bandId, characters }))
    .sort(
      (left, right) =>
        Number(right.bandId === firstBandId) - Number(left.bandId === firstBandId) || left.bandId - right.bandId,
    );
});

const activePartnerBandId = ref<number>();

watch(
  [partnerGroups, second],
  ([groups, selected]) => {
    const selectedBandId = Number(selected?.bandId) || 0;
    if (selected && groups.some((group) => group.bandId === selectedBandId)) {
      activePartnerBandId.value = selectedBandId;
      return;
    }
    if (!groups.some((group) => group.bandId === activePartnerBandId.value)) {
      activePartnerBandId.value = groups[0]?.bandId;
    }
  },
  { immediate: true },
);

watch(
  () => props.firstId,
  () => {
    if (!second.value) activePartnerBandId.value = partnerGroups.value[0]?.bandId;
  },
);

const activePartnerGroup = computed(
  () => partnerGroups.value.find((group) => group.bandId === activePartnerBandId.value) || partnerGroups.value[0],
);
const isSameBand = computed(
  () => Boolean(first.value) && Number(first.value?.bandId) === Number(activePartnerGroup.value?.bandId),
);
const activeSlots = computed(() => (isSameBand.value ? selfSlots : otherSlots));
const boardBandId = computed(() => Number(activePartnerGroup.value?.bandId || first.value?.bandId) || 1);
const positionedPartners = computed(() =>
  (activePartnerGroup.value?.characters || []).slice(0, activeSlots.value.length).map((character, index) => {
    const slot = activeSlots.value[index] || otherSlots[0];
    const arrowRotation =
      isSameBand.value && boardBandId.value === 2 && index === 0 ? "168.146055deg" : slot.arrowRotation;
    return {
      character,
      style: {
        "--slot-x": slot.x,
        "--slot-y": slot.y,
        "--arrow-x": slot.arrowX,
        "--arrow-y": slot.arrowY,
        "--arrow-rotation": arrowRotation,
      } as FriendshipStyle,
    };
  }),
);

const boardBackground = computed(() =>
  releaseAssetUrl(`Assets/AddressableResources/Band/${boardBandId.value}/Friendship/photo_board.png`),
);
const boardLogo = computed(() =>
  releaseAssetUrl(`Assets/AddressableResources/Band/${boardBandId.value}/band_logo.png`),
);
const arrowImage = computed(() =>
  releaseAssetUrl(`Assets/AddressableResources/Band/${boardBandId.value}/Friendship/FriendshipArrow_1.png`),
);
const stageStyle = computed(
  () =>
    ({
      "--friendship-stage": `url("${releaseAssetUrl(
        "Assets/AddressableResources/Image/Background/FriendshipBackground.png",
      )}")`,
    }) as FriendshipStyle,
);

const characterAsset = (character: Character, file: "board_icon.png" | "character_sprite.png") =>
  releaseAssetUrl(`Assets/AddressableResources/Character/Image/${character.characterId}/${file}`);
const boardIconOf = (character: Character) => characterAsset(character, "board_icon.png");
const firstRailItems = computed(() =>
  orderedCharacters.value.map((character) => ({
    id: character.characterId,
    label:
      resolveLocalized(character.characterName, {
        candidates: [character.englishName],
        sourceHint: "ja",
        fallback: textOf(props.nameOf(character)),
      }) || props.nameOf(character),
    image: faceOf(character),
    fallbackImage: boardIconOf(character),
    imageFit: "cover" as const,
    imageShape: "circle" as const,
    color: character.colorCode,
  })),
);
const spriteOf = (character?: Character) =>
  character ? assetUrl(character.spriteImage || characterAsset(character, "character_sprite.png")) : "";
const faceOf = (character?: Character) =>
  character
    ? assetUrl(character.faceImage || character.thumbnailImage || character.profileImage || character.spriteImage || "")
    : "";
const bandLogoOf = (bandId: number) =>
  bandId ? releaseAssetUrl(`Assets/AddressableResources/Band/${bandId}/band_logo.png`) : "";

function replaceFailedImage(event: Event, fallback: string) {
  const image = event.currentTarget as HTMLImageElement;
  if (!fallback || image.dataset.fallback === fallback) {
    image.hidden = true;
    return;
  }
  image.dataset.fallback = fallback;
  image.src = fallback;
}
</script>

<template>
  <section class="link-selector" :style="stageStyle">
    <StoryMediaRail
      class="link-selector__first-rail"
      :items="firstRailItems"
      :model-value="firstId"
      :label="`${t('character')} 1`"
      appearance="icon"
      @update:model-value="emit('first', Number($event))"
    />

    <div class="link-selector__stage">
      <div class="link-selector__board">
        <img class="link-selector__board-background" :src="boardBackground" alt="" />

        <img v-if="isSameBand" class="link-selector__band-logo" :src="boardLogo" alt="" />

        <img
          v-if="first"
          class="link-selector__lead"
          :src="spriteOf(first)"
          :alt="textOf(nameOf(first))"
          :lang="langOf(nameOf(first))"
          @error="replaceFailedImage($event, faceOf(first))"
        />

        <nav class="link-selector__partners" :aria-label="`${t('character')} 2`">
          <button
            v-for="item in positionedPartners"
            :key="item.character.characterId"
            type="button"
            class="link-selector__partner"
            :class="{ 'is-selected': item.character.characterId === secondId }"
            :style="item.style"
            :aria-label="textOf(nameOf(item.character))"
            :aria-pressed="item.character.characterId === secondId"
            :title="textOf(nameOf(item.character))"
            :lang="langOf(nameOf(item.character))"
            @click="emit('second', item.character.characterId)"
          >
            <md-ripple />
            <img class="link-selector__arrow" :src="arrowImage" alt="" aria-hidden="true" />
            <span class="link-selector__partner-icon">
              <img
                :src="boardIconOf(item.character)"
                alt=""
                @error="replaceFailedImage($event, faceOf(item.character))"
              />
            </span>
          </button>
        </nav>

        <nav v-if="partnerGroups.length > 1" class="link-selector__band-tabs" :aria-label="t('band')">
          <button
            v-for="group in partnerGroups"
            :key="group.bandId"
            type="button"
            :class="{ 'is-selected': group.bandId === activePartnerGroup?.bandId }"
            :aria-pressed="group.bandId === activePartnerGroup?.bandId"
            :aria-label="textOf(bandNameOf(group.bandId))"
            :title="textOf(bandNameOf(group.bandId))"
            :lang="langOf(bandNameOf(group.bandId))"
            @click="activePartnerBandId = group.bandId"
          >
            <md-ripple />
            <img v-if="bandLogoOf(group.bandId)" :src="bandLogoOf(group.bandId)" alt="" />
          </button>
        </nav>

        <UiIconButton
          class="link-selector__swap"
          tone="surface"
          emphasis
          size="compact"
          touch-target
          :disabled="!first || !second"
          :label="t('swap')"
          @click="emit('swap')"
        >
          <MaterialIcon name="swap_horiz" :size="20" aria-hidden="true" />
        </UiIconButton>
      </div>
    </div>

    <div class="link-selector__stories">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.link-selector {
  display: grid;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: 72px minmax(0, 1fr);
  grid-template-rows: clamp(220px, 53%, 410px) minmax(0, 1fr);
  overflow: hidden;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface);
}

.link-selector__first-rail {
  z-index: 3;
  grid-row: 1 / -1;
}

.link-selector__stage {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-column: 2;
  grid-row: 1;
  overflow: hidden;
  place-items: center;
  background: var(--friendship-stage) center / cover;
  container-type: size;
}

.link-selector__board {
  position: relative;
  z-index: 1;
  width: min(calc(100cqw - 18px), calc((100cqh - 12px) * 1.360996));
  min-width: 0;
  aspect-ratio: 1312 / 964;
  filter: drop-shadow(0 10px 11px rgb(15 24 51 / 0.2));
}

.link-selector__board-background {
  position: absolute;
  z-index: 0;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}

.link-selector__band-logo {
  position: absolute;
  z-index: 5;
  top: 8.92%;
  left: 13.35%;
  width: 19.05%;
  height: 14.52%;
  object-fit: contain;
  pointer-events: none;
}

.link-selector__lead {
  position: absolute;
  z-index: 3;
  bottom: -3.8%;
  left: 50%;
  width: 78.05%;
  height: 106.22%;
  object-fit: contain;
  object-position: center bottom;
  filter: drop-shadow(0 4px 3px rgb(28 39 72 / 0.12));
  pointer-events: none;
  transform: translateX(-50%);
}

.link-selector__partners {
  position: absolute;
  z-index: 4;
  inset: 0;
  pointer-events: none;
}

.link-selector__partner {
  position: absolute;
  top: var(--slot-y);
  left: var(--slot-x);
  width: 26.68%;
  aspect-ratio: 1;
  padding: 0;
  overflow: visible;
  border: 0;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
  transform: translate(-50%, -50%);
  transition:
    filter 140ms ease,
    transform 140ms ease;
}

.link-selector__partner:hover {
  z-index: 6;
  filter: brightness(1.04) drop-shadow(0 3px 4px rgb(29 55 94 / 0.2));
  transform: translate(-50%, -50%) scale(1.045);
}

.link-selector__partner:active {
  transform: translate(-50%, -50%) scale(0.94);
}

.link-selector__partner md-ripple {
  z-index: 8;
  border-radius: 50%;
}

.link-selector__partner-icon {
  position: absolute;
  z-index: 2;
  inset: 0;
  display: block;
  border-radius: 50%;
}

.link-selector__partner-icon::before,
.link-selector__partner-icon::after {
  position: absolute;
  z-index: 3;
  width: 16%;
  height: 16%;
  border-color: transparent;
  content: "";
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}

.link-selector__partner-icon::before {
  top: 5%;
  left: 5%;
  border-top: 3px solid #74efff;
  border-left: 3px solid #74efff;
}

.link-selector__partner-icon::after {
  right: 5%;
  bottom: 5%;
  border-right: 3px solid #74efff;
  border-bottom: 3px solid #74efff;
}

.link-selector__partner.is-selected .link-selector__partner-icon {
  filter: drop-shadow(0 0 2px white) drop-shadow(0 0 5px #48dbea) drop-shadow(0 0 9px rgb(54 157 229 / 0.72));
}

.link-selector__partner.is-selected .link-selector__partner-icon::before,
.link-selector__partner.is-selected .link-selector__partner-icon::after {
  opacity: 1;
}

.link-selector__partner-icon > img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}

.link-selector__arrow {
  position: absolute;
  z-index: 1;
  top: var(--arrow-y);
  left: var(--arrow-x);
  width: 45.71%;
  height: 22.86%;
  object-fit: contain;
  pointer-events: none;
  transform: translate(-50%, -50%) rotate(var(--arrow-rotation));
}

.link-selector__band-tabs {
  position: absolute;
  z-index: 7;
  top: 19%;
  right: 1.3%;
  display: flex;
  width: max(9.5%, 40px);
  flex-direction: column;
  gap: 4px;
}

.link-selector__band-tabs button {
  position: relative;
  display: grid;
  width: 100%;
  min-height: 32px;
  aspect-ratio: 1.35;
  padding: 5%;
  place-items: center;
  overflow: hidden;
  border: 1px solid rgb(255 255 255 / 0.36);
  border-radius: 3px 0 0 3px;
  background: linear-gradient(180deg, rgb(58 88 157 / 0.93), rgb(39 59 117 / 0.95));
  box-shadow: 0 2px 4px rgb(17 28 59 / 0.24);
  cursor: pointer;
}

.link-selector__band-tabs md-ripple {
  z-index: 3;
  border-radius: inherit;
}

.link-selector__band-tabs button.is-selected {
  border-color: #aeffff;
  background: linear-gradient(180deg, rgb(74 180 204 / 0.96), rgb(45 109 168 / 0.96));
  box-shadow:
    0 0 0 1px rgb(83 222 242 / 0.46),
    0 2px 5px rgb(17 28 59 / 0.24);
}

.link-selector__band-tabs img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.link-selector__swap {
  position: absolute;
  z-index: 8;
  top: 4.5%;
  right: 2.8%;
  --md-comp-icon-button-visual-size: 40px;
}

.link-selector__stories {
  min-width: 0;
  min-height: 0;
  grid-column: 2;
  grid-row: 2;
  overflow: hidden;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface);
}

@media (max-width: 760px) {
  .link-selector {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 64px minmax(210px, 0.92fr) minmax(0, 1.08fr);
  }

  .link-selector__first-rail {
    grid-column: 1;
    grid-row: 1;
  }

  .link-selector__stage {
    grid-column: 1;
    grid-row: 2;
  }

  .link-selector__stories {
    grid-column: 1;
    grid-row: 3;
  }

  .link-selector__board {
    width: min(calc(100cqw - 6px), calc((100cqh - 6px) * 1.360996));
  }

  .link-selector__band-tabs {
    right: 0.8%;
    width: 42px;
  }

  .link-selector__band-tabs button {
    min-height: var(--md-comp-control-height-touch);
  }

  .link-selector__swap {
    top: 3.5%;
    right: 2.2%;
    width: var(--md-comp-control-height-touch);
  }
}

@media (max-width: 959px) and (max-height: 500px), (hover: none) and (pointer: coarse) {
  .link-selector__band-tabs button {
    min-height: var(--md-comp-control-height-touch);
  }

  .link-selector__swap {
    width: var(--md-comp-control-height-touch);
  }
}

@media (prefers-reduced-motion: reduce) {
  .link-selector__partner {
    transition: none;
  }
}
</style>
