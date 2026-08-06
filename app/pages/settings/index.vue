<script setup lang="ts">
import { localeFlagIconUrls } from "~/utils/flagIcons";

const { locale, locales, setLocale, t } = useLocale();
const { releaseServer, releases, setReleaseServer } = useReleaseServer();
const { themePreference, setThemePreference } = useUiTheme();
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
const releaseOptions = computed(() =>
  releases.value.map((release) => ({
    value: release.id,
    label:
      release.displayName === release.id
        ? release.id
        : `${release.displayName} · ${release.region.toLocaleUpperCase()} (${release.id})`,
  })),
);

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
