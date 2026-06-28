<script setup lang="ts">
import type { Band, Character } from "~/types/archive";
import type { FacetOption } from "~/components/ui/FacetGroup.vue";
import { langOf, textOf } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";

const props = withDefaults(
  defineProps<{
    bands: Band[];
    characters: Character[];
    bandIds: Array<string | number>;
    characterIds: Array<string | number>;
    availableBandIds?: number[];
    availableCharacterIds?: number[];
    characterOptions?: FacetOption[];
  }>(),
  { availableBandIds: () => [], availableCharacterIds: () => [] },
);

const emit = defineEmits<{
  "update:bandIds": [value: Array<string | number>];
  "update:characterIds": [value: Array<string | number>];
}>();

const { resolveLocalized, t } = useLocale();
const availableBands = computed(() => new Set(props.availableBandIds));
const availableCharacters = computed(() => new Set(props.availableCharacterIds));
const fullCharacterName = (character: Character | undefined): string =>
  textOf(resolveLocalized(character?.characterName, { sourceHint: "ja" })) ||
  textOf(resolveLocalized(character?.englishName, { sourceHint: "en" }));
const bandOptions = computed(() =>
  [...props.bands]
    .filter((band) => !availableBands.value.size || availableBands.value.has(band.bandId))
    .sort((left, right) => left.bandId - right.bandId)
    .map((band) => {
      const label = resolveLocalized(band.bandName, { sourceHint: "ja" }) || String(band.bandId);
      const image = band.icon || band.logo;
      return {
        value: band.bandId,
        label,
        color: band.color,
        image,
        imageFit: "contain" as const,
        avatarText: entityAvatarText(label),
        avatarLang: langOf(label),
        icon: image ? undefined : "music_note",
      };
    }),
);
const resolvedCharacterOptions = computed<FacetOption[]>(() => {
  if (props.characterOptions) {
    return props.characterOptions.map((option) => {
      const character = props.characters.find((candidate) => candidate.characterId === Number(option.value));
      const tooltip = fullCharacterName(character);
      return tooltip ? { ...option, tooltip } : option;
    });
  }
  return [...props.characters]
    .filter((character) => !availableCharacters.value.size || availableCharacters.value.has(character.characterId))
    .sort((left, right) => left.characterId - right.characterId)
    .map((character) => {
      const image = character.faceImage || character.thumbnailImage || character.profileImage;
      const label = fullCharacterName(character) || String(character.characterId);
      return {
        value: character.characterId,
        label,
        color: character.colorCode,
        image,
        imageFit: "cover" as const,
        avatarText: entityAvatarText(label),
        avatarLang: langOf(label),
        icon: image ? undefined : "person",
        tooltip: fullCharacterName(character),
      };
    });
});
</script>

<template>
  <FacetGroup
    :model-value="bandIds"
    :title="t('band')"
    :options="bandOptions"
    icon-only
    @update:model-value="emit('update:bandIds', $event)"
  />
  <FacetGroup
    :model-value="characterIds"
    :title="t('character')"
    :options="resolvedCharacterOptions"
    icon-only
    @update:model-value="emit('update:characterIds', $event)"
  />
</template>
