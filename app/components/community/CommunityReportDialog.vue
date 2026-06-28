<script setup lang="ts">
import { UiButton, UiSelect, UiTextField, type UiSelectHandle, type UiSelectOption } from "@haneoka/ui";

type ReportTargetKind = "comment" | "post" | "user";
type ReportReason =
  "copyright" | "harassment" | "hate" | "misinformation" | "other" | "privacy" | "sexual" | "spam" | "violence";

interface ReportSummary {
  createdAt: number;
  id: string;
  status: "pending" | "reviewing";
  targetId: number | string;
  targetKind: ReportTargetKind;
  version: number;
}

interface ReportResponse {
  report: ReportSummary;
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    targetId: number | string;
    targetKind: ReportTargetKind;
    targetLabel?: string;
  }>(),
  { targetLabel: "" },
);

const emit = defineEmits<{
  close: [];
  submitted: [report: ReportSummary];
}>();

const route = useRoute();
const { messages } = useLocale();
const { user } = useAuth();
const reasonId = useId();
const detailsId = useId();
const detailsHintId = useId();
const reasonSelect = ref<UiSelectHandle | null>(null);
const activeTargetKind = ref<ReportTargetKind>(props.targetKind);
const activeTargetId = ref<number | string>(props.targetId);
const activeTargetLabel = ref(props.targetLabel);
const reason = ref<ReportReason | "">("");
const details = ref("");
const errorMessage = ref("");
const submitting = ref(false);
let returnFocus: HTMLElement | null = null;

const copy = messages("communityPage");
const reasonOptions: ReportReason[] = [
  "spam",
  "harassment",
  "hate",
  "sexual",
  "violence",
  "privacy",
  "copyright",
  "misinformation",
  "other",
];
const localizedReasonOptions = computed<UiSelectOption[]>(() => [
  { disabled: true, label: copy.value.reportDialog.chooseReason, value: "" },
  ...reasonOptions.map((option) => ({ label: copy.value.reportDialog.reasons[option], value: option })),
]);
const detailsRequired = computed(() => reason.value === "other");
const canSubmit = computed(
  () => Boolean(reason.value) && (!detailsRequired.value || Boolean(details.value.trim())) && !submitting.value,
);

const reset = () => {
  reason.value = "";
  details.value = "";
  errorMessage.value = "";
  submitting.value = false;
};

const activeTargetDiffersFromProps = () =>
  activeTargetKind.value !== props.targetKind || activeTargetId.value !== props.targetId;

const syncActiveTarget = () => {
  activeTargetKind.value = props.targetKind;
  activeTargetId.value = props.targetId;
  activeTargetLabel.value = props.targetLabel;
};

const close = () => {
  if (submitting.value) return;
  emit("close");
};

const apiErrorMessage = (_error: unknown): string => copy.value.reportDialog.failed;

const submit = async () => {
  if (!canSubmit.value || !reason.value) return;
  if (!user.value) {
    errorMessage.value = copy.value.reportDialog.signIn;
    emit("close");
    await navigateTo({ path: "/account", query: { next: route.fullPath } });
    return;
  }
  submitting.value = true;
  errorMessage.value = "";
  try {
    const trimmedDetails = details.value.trim();
    const response = await $fetch<ReportResponse>("/api/v1/community/reports", {
      method: "POST",
      body: {
        targetKind: activeTargetKind.value,
        targetId: activeTargetId.value,
        reasonCode: reason.value,
        ...(trimmedDetails ? { details: trimmedDetails } : {}),
      },
    });
    emit("submitted", response.report);
    emit("close");
    reset();
  } catch (error) {
    errorMessage.value = apiErrorMessage(error);
  } finally {
    submitting.value = false;
    if (props.open && activeTargetDiffersFromProps()) {
      syncActiveTarget();
      reset();
      await nextTick();
      reasonSelect.value?.focus();
    }
  }
};

watch(
  () => [props.open, props.targetKind, props.targetId, props.targetLabel] as const,
  ([open, targetKind, targetId, targetLabel], [wasOpen, wasTargetKind, wasTargetId]) => {
    if (!open) return;
    const identityChanged = !wasOpen || targetKind !== wasTargetKind || targetId !== wasTargetId;
    if (!identityChanged) {
      if (!submitting.value) activeTargetLabel.value = targetLabel;
      return;
    }
    if (submitting.value) return;
    syncActiveTarget();
    reset();
    if (wasOpen && import.meta.client) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : returnFocus;
      void nextTick(() => reasonSelect.value?.focus());
    }
  },
);

watch(
  () => props.open,
  async (open, wasOpen) => {
    if (!import.meta.client) return;
    if (open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      reasonSelect.value?.focus();
    } else if (wasOpen && returnFocus) {
      await nextTick();
      returnFocus.focus();
      returnFocus = null;
    }
  },
);
</script>

<template>
  <ModalSurface :open="open" :title="copy.reportDialog.title" @close="close">
    <form class="report-form" :aria-busy="submitting" @submit.prevent="submit">
      <p v-if="activeTargetLabel" class="report-form__target">
        <span>{{ copy.reportDialog.target }}</span>
        <strong>{{ activeTargetLabel }}</strong>
      </p>

      <UiSelect
        :id="reasonId"
        ref="reasonSelect"
        v-model="reason"
        name="reason"
        required
        :label="copy.reportDialog.reason"
        :options="localizedReasonOptions"
        :disabled="submitting"
        :aria-invalid="!reason && Boolean(errorMessage)"
      />

      <UiTextField
        :id="detailsId"
        v-model="details"
        name="details"
        type="textarea"
        rows="5"
        maxlength="2000"
        :label="copy.reportDialog.details"
        :required="detailsRequired"
        :disabled="submitting"
        :aria-describedby="detailsHintId"
      />
      <div class="report-form__meta">
        <span :id="detailsHintId" :class="{ 'is-required': detailsRequired }">
          {{ detailsRequired ? copy.reportDialog.detailsOtherHint : copy.reportDialog.detailsHint }}
        </span>
        <span class="display-number" aria-hidden="true">{{ details.length }} / 2000</span>
      </div>

      <p v-if="errorMessage" class="report-form__error" role="alert">{{ errorMessage }}</p>

      <footer class="report-form__actions">
        <UiButton :disabled="submitting" @click="close">
          {{ copy.reportDialog.cancel }}
        </UiButton>
        <UiButton tone="danger" type="submit" :disabled="!canSubmit" :aria-busy="submitting">
          {{ submitting ? copy.reportDialog.submitting : copy.reportDialog.submit }}
        </UiButton>
      </footer>
    </form>
  </ModalSurface>
</template>

<style scoped>
.report-form {
  display: grid;
  width: min(100%, 720px);
  margin-inline: auto;
  gap: 14px;
  padding: clamp(15px, 2vw, 22px);
}

.report-form__target {
  display: grid;
  margin: 0;
  gap: 3px;
  padding: 10px 12px;
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
}

.report-form__target span {
  color: var(--md-sys-color-outline);
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.65rem;
  font-weight: 650;
  letter-spacing: 0;
}

.report-form__target strong {
  overflow-wrap: anywhere;
  color: var(--md-sys-color-on-surface);
  font-size: 0.82rem;
}

.report-form__meta {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  margin-top: -8px;
  color: var(--md-sys-color-outline);
  font-size: 0.7rem;
}

.report-form__meta .is-required,
.report-form__error {
  color: var(--md-sys-color-error);
}

.report-form__error {
  margin: 0;
  padding: 9px 11px;
  color: var(--md-sys-color-on-error-container);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-error-container);
  font-size: 0.76rem;
}

.report-form__actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  padding-top: 2px;
}

@media (max-width: 560px) {
  .report-form {
    padding: 13px 12px 18px;
  }

  .report-form__meta {
    display: grid;
    gap: 5px;
  }

  .report-form__actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .report-form__actions > * {
    min-width: 0;
    min-height: 44px;
  }
}
</style>
