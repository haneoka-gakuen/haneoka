<script setup lang="ts">
import { localeFlagIconUrls } from "~/utils/flagIcons";
import { UiSwitch } from "@haneoka/ui";

const { locale, locales, setLocale, t } = useLocale();
const { releaseServer, releases, setReleaseServer } = useReleaseServer();
const { themePreference, setThemePreference } = useUiTheme();
const { forceJapaneseTitles } = toRefs(useSongDisplaySettings().value);
const themeOptions = computed(() => [
  { value: "light", label: t("themeLight"), icon: "light_mode" },
  { value: "system", label: t("themeSystem"), icon: "brightness_auto" },
  { value: "dark", label: t("themeDark"), icon: "dark_mode" },
]);
const localeOptions = computed(() =>
  locales.map((option) => ({
    value: option.value,
    label: option.label,
    lang: option.tag,
    image: localeFlagIconUrls[option.value],
  })),
);
const releaseOptions = computed(() => {
  // gl-cbt remains the default *selected* server (DEFAULT_RELEASE_SERVER). The
  // canonical registry order is left intact because it also drives asset
  // fallback priority; here we only reorder the displayed list so the two CBT
  // builds sit together — jp-cbt first, gl-cbt right behind it.
  const displayPriority = ["jp-cbt", "gl-cbt"];
  return [...releases.value]
    .map((release, index) => ({ release, index }))
    .sort((a, b) => {
      const pa = displayPriority.indexOf(a.release.id);
      const pb = displayPriority.indexOf(b.release.id);
      if (pa !== -1 && pb !== -1) return pa - pb;
      if (pa !== -1) return -1;
      if (pb !== -1) return 1;
      return a.index - b.index;
    })
    .map(({ release }) => ({
      value: release.id,
      label:
        release.displayName === release.id
          ? release.id
          : `${release.displayName} · ${release.region.toLocaleUpperCase()} (${release.id})`,
    }));
});

useHead(() => ({ title: `${t("settings")} · haneoka` }));
</script>

<template>
  <SupportingPageSurface :title="t('settings')" max-width="960px">
    <div class="settings-content">
      <PageSection :title="t('appearance')" icon="palette">
        <SingleChoiceIconRow
          name="ui-theme"
          :label="t('appearance')"
          :model-value="themePreference"
          :options="themeOptions"
          @update:model-value="setThemePreference"
        />
      </PageSection>

      <PageSection :title="t('language')" icon="language" divided>
        <SingleChoiceIconRow
          name="locale"
          :label="t('language')"
          :model-value="locale"
          :options="localeOptions"
          @update:model-value="setLocale"
        />
      </PageSection>

      <PageSection :title="t('songTitles')" icon="music_note" divided>
        <UiSwitch v-model="forceJapaneseTitles" :label="t('forceJapaneseTitles')" />
      </PageSection>

      <PageSection :title="t('releaseServer')" icon="dns" divided>
        <SingleChoiceIconRow
          name="release-server"
          :label="t('releaseServer')"
          :model-value="releaseServer"
          :options="releaseOptions"
          @update:model-value="setReleaseServer"
        >
          <template #leading="{ option }">
            <ServerIcon :server="option.value" :size="40" />
          </template>
        </SingleChoiceIconRow>
      </PageSection>
    </div>
  </SupportingPageSurface>
</template>

<style scoped>
.settings-content {
  display: grid;
  gap: var(--md-sys-spacing-5);
}
</style>
