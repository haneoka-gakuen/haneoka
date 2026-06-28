<script setup lang="ts">
import { localeFlagIconUrls } from "~/utils/flagIcons";

const { locale, locales, setLocale, t } = useLocale();
const { assetServer, assetServers, setAssetServer } = useAssetServer();
const localeOptions = computed(() =>
  locales.map((option) => ({
    value: option.value,
    label: option.label,
    lang: option.tag,
    image: localeFlagIconUrls[option.value],
  })),
);
const serverOptions = computed(() => assetServers.value.map((server) => ({ value: server, label: server })));

useHead(() => ({ title: `${t("settings")} · haneoka` }));
</script>

<template>
  <SupportingPageSurface :title="t('settings')" max-width="960px">
    <div class="settings-content">
      <PageSection :title="t('language')" icon="language">
        <SingleChoiceList
          name="locale"
          :label="t('language')"
          :model-value="locale"
          :options="localeOptions"
          @update:model-value="setLocale"
        />
      </PageSection>

      <PageSection :title="t('server')" icon="dns" divided>
        <SingleChoiceList
          name="asset-server"
          :label="t('server')"
          :model-value="assetServer"
          :options="serverOptions"
          @update:model-value="setAssetServer"
        >
          <template #leading="{ option }">
            <ServerIcon :server="option.value" :size="40" />
          </template>
        </SingleChoiceList>
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
