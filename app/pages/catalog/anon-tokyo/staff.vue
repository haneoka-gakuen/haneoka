<script setup lang="ts">
import type { AnonTokyoCatalogField } from "~/components/catalog/AnonTokyoEntityCatalog.vue";
import type { AnonTokyoEntity } from "~/types/anonTokyo";
import { anonTokyoField } from "~/types/anonTokyo";
import { anonTokyoRawLabel, useAnonTokyoCatalogData } from "~/composables/useAnonTokyoData";

const { t, messages } = useLocale();
const copy = messages("anonTokyoPage");
const { document, pending, error, refresh, text, section, appearancePreview, characterPortrait } = useAnonTokyoCatalogData();

const skillLabel = (raw: unknown): string =>
  String(raw || "")
    .split(";")
    .filter(Boolean)
    .map((entry) => {
      const [skillId, value] = entry.split(",");
      const skill = section(document.value?.staffing?.deliverySkills).find(
        (candidate) => String(candidate.rawId) === skillId?.trim(),
      );
      const name = text(skill?.name) || `#${skillId}`;
      return value ? `${name.replace(/\{0\}/, "").trim()} ${value}` : name;
    })
    .join(" · ");

const entries = computed<readonly AnonTokyoEntity[]>(() => {
  const withPortrait = (entry: AnonTokyoEntity, url: string | undefined) =>
    url ? { ...entry, preview: { url } } : entry;
  // Helper tiers (base/faster/elite) share the delivery appearance skeletons
  // (helper_other / helper_animal_0001 / helper_animal_0002), so reuse the
  // delivery appearance recipe of the same tier.
  const recipes = section(document.value?.spine?.renderRecipes);
  const recipePreview = (id: string): string | undefined => {
    const recipe = recipes.find((candidate) => candidate.id === id);
    return recipe?.preview?.status === "rendered" ? recipe.preview.url || undefined : undefined;
  };
  return [
    ...section(document.value?.staffing?.clerks).map((entry) =>
      withPortrait(entry, characterPortrait(Number(entry.characterId))),
    ),
    ...section(document.value?.staffing?.helpers).map((entry) =>
      withPortrait(entry, recipePreview(`anon-tokyo-delivery-${entry.rawId}`)),
    ),
    ...section(document.value?.staffing?.deliveries).map((entry) =>
      withPortrait(entry, appearancePreview(entry.defaultAvatarIds) || recipePreview(`anon-tokyo-delivery-${entry.rawId}`)),
    ),
  ];
});
const fields = computed<AnonTokyoCatalogField[]>(() => [
  {
    key: "point",
    label: copy.value.point,
    value: (entry: AnonTokyoEntity) => anonTokyoRawLabel(entry.point ?? anonTokyoField(entry, "point")),
    align: "end",
  },
  { key: "skill", label: copy.value.skill, value: (entry: AnonTokyoEntity) => skillLabel(entry.helperSkillReward ?? entry.deliverySkillReward) },
]);

useSeoMeta({ title: () => `${copy.value.staffSection} · ${t("anonTokyo")} · haneoka` });
</script>

<template>
  <AnonTokyoEntityCatalog
    :title="copy.staffSection"
    :entries="entries"
    :pending="pending"
    :error="error"
    :available="document?.available ?? false"
    :unavailable-label="copy.unavailable"
    query-key="staff"
    icon="badge"
    :fields="fields"
    image-ratio="member"
    @retry="refresh()"
  />
</template>
