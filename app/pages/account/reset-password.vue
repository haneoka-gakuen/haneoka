<script setup lang="ts">
import { UiButton, UiTextField } from "@haneoka/ui";

import { authClient } from "~/lib/auth-client";
import { authClientErrorMessage, authRequestErrorMessage } from "~/lib/auth-error";

const route = useRoute();
const { t } = useLocale();
const newPassword = ref("");
const confirmPassword = ref("");
const busy = ref(false);
const complete = ref(false);
const errorMessage = ref("");

const token = computed(() => (typeof route.query.token === "string" ? route.query.token : ""));
const continuesSignup = computed(() => route.query.claim === "1");

const resetPassword = async () => {
  errorMessage.value = "";
  if (!token.value) {
    errorMessage.value = t("accountPage.invalidResetLink");
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    errorMessage.value = t("accountPage.passwordMismatch");
    return;
  }
  busy.value = true;
  try {
    const result = await authClient.resetPassword({
      newPassword: newPassword.value,
      token: token.value,
    });
    if (result.error) {
      errorMessage.value = authClientErrorMessage(result.error, t, t("accountPage.authFailed"));
      return;
    }
    newPassword.value = "";
    confirmPassword.value = "";
    complete.value = true;
  } catch (error) {
    errorMessage.value = authRequestErrorMessage(error, t("accountPage.authFailed"), t("accountPage.requestTimedOut"));
  } finally {
    busy.value = false;
  }
};

useHead(() => ({ title: `${t("accountPage.resetPasswordTitle")} · haneoka` }));
</script>

<template>
  <WorkspaceScreen
    :title="t('accountPage.resetPasswordTitle')"
    :detail-available="false"
    back-to="/account"
    :back-label="t('accountPage.backToSignIn')"
  >
    <PageContentSurface as="section" max-width="640px" data-scroll-key="reset-password">
      <div class="reset-content">
        <PageSection
          v-if="complete"
          class="reset-content__section"
          :title="t(continuesSignup ? 'accountPage.accountSetupComplete' : 'accountPage.passwordReset')"
          icon="check_circle"
        >
          <div class="reset-state">
            <UiButton href="/account" tone="primary">{{ t("accountPage.backToSignIn") }}</UiButton>
          </div>
        </PageSection>

        <PageSection
          v-else-if="!token"
          class="reset-content__section is-error"
          :title="t('accountPage.invalidResetLink')"
          icon="link_off"
        >
          <div class="reset-state">
            <UiButton href="/account" tone="neutral">{{ t("accountPage.backToSignIn") }}</UiButton>
          </div>
        </PageSection>

        <form v-else class="reset-form" @submit.prevent="resetPassword">
          <PageSection
            :title="t(continuesSignup ? 'accountPage.continueSignupTitle' : 'accountPage.resetPassword')"
            :description="t(continuesSignup ? 'accountPage.continueSignupBody' : 'accountPage.passwordHint')"
            icon="key"
          >
            <div class="reset-form__fields">
              <UiTextField
                v-model="newPassword"
                :label="t('accountPage.newPassword')"
                name="new-password"
                type="password"
                autocomplete="new-password"
                minlength="12"
                maxlength="128"
                required
              />
              <UiTextField
                v-model="confirmPassword"
                :label="t('accountPage.confirmPassword')"
                name="confirm-password"
                type="password"
                autocomplete="new-password"
                minlength="12"
                maxlength="128"
                required
              />
              <InlineNotice v-if="errorMessage" tone="error">{{ errorMessage }}</InlineNotice>
              <UiButton tone="primary" type="submit" :disabled="busy">
                {{ busy ? t("accountPage.working") : t("accountPage.resetPassword") }}
              </UiButton>
            </div>
          </PageSection>
        </form>
      </div>
    </PageContentSurface>
  </WorkspaceScreen>
</template>

<style scoped>
.reset-content {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-4);
}

.reset-state {
  display: flex;
  min-height: 96px;
  align-items: center;
  padding: var(--md-sys-spacing-4) var(--md-sys-spacing-2);
}

.reset-content__section.is-error :deep(.page-section__icon) {
  color: var(--md-sys-color-on-error-container);
  background: var(--md-sys-color-error-container);
}

.reset-form {
  min-width: 0;
}

.reset-form__fields {
  display: grid;
  gap: var(--md-sys-spacing-4);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-2) 0;
}

.reset-form__fields :deep(.md3-text-field),
.reset-form__fields :deep(.md3-button) {
  width: 100%;
}
</style>
