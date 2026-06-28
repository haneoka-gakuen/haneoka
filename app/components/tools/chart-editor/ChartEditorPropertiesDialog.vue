<script setup lang="ts">
import {
  MaterialIcon,
  UiButton,
  UiDialog,
  UiIconButton,
  UiSelect,
  UiSwitch,
  UiTextField,
  type UiFieldValue,
  type UiSelectOption,
} from "@haneoka/ui";

import {
  beatToTick,
  resolveLinePointShape,
  tickToBeat,
  type LinePoint,
  type MeterEvent,
  type NoteDirection,
  type NoteLine,
  type NoteType,
  type Project,
  type ProjectMeta,
  type SingleNote,
  type TempoEvent,
  type TimeScaleEvent,
} from "@haneoka/chart-editor/model";
import type { ChartEditorTool, SelectionPatch } from "~/composables/useChartEditorWorkspace";

type PropertiesContext = "selection" | "tool" | "project" | "tempo" | "meter" | "timeScale";

interface EventPatchPayload<Patch> {
  id: string;
  patch: Patch;
}

type TempoPatchPayload = EventPatchPayload<Partial<Omit<TempoEvent, "id">>>;
type MeterPatchPayload = EventPatchPayload<Partial<Omit<MeterEvent, "id">>>;
type TimeScalePatchPayload = EventPatchPayload<Partial<Omit<TimeScaleEvent, "id">>>;
type SelectionTarget =
  | { kind: "single"; note: SingleNote }
  | { kind: "point"; note: LinePoint; line: NoteLine }
  | { kind: "line"; line: NoteLine };

interface MixedValue<T> {
  value: T | undefined;
  mixed: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    context: PropertiesContext;
    project: Project;
    selectedIds?: readonly string[];
    playheadTick?: number;
    tool?: ChartEditorTool;
    noteSize?: number;
    critical?: boolean;
    direction?: NoteDirection;
  }>(),
  {
    selectedIds: () => [],
    playheadTick: 0,
    tool: "select",
    noteSize: 2,
    critical: false,
    direction: "up",
  },
);

const emit = defineEmits<{
  "update:modelValue": [open: boolean];
  "patch-meta": [patch: Partial<ProjectMeta>];
  "patch-audio-offset": [value: number];
  "patch-lane-basis": [value: number];
  "patch-selection": [patch: SelectionPatch];
  "add-tempo": [tick: number];
  "update-tempo": [payload: TempoPatchPayload];
  "delete-tempo": [id: string];
  "add-meter": [tick: number];
  "update-meter": [payload: MeterPatchPayload];
  "delete-meter": [id: string];
  "add-time-scale": [tick: number];
  "update-time-scale": [payload: TimeScalePatchPayload];
  "delete-time-scale": [id: string];
  "update:noteSize": [value: number];
  "update:critical": [value: boolean];
  "update:direction": [value: NoteDirection];
}>();

const { messages, t } = useLocale();
const copy = messages("chartEditorPage");
const laneListId = useId();

const targetForId = (id: string): SelectionTarget | undefined => {
  const single = props.project.singles.find((item) => item.id === id);
  if (single) return { kind: "single", note: single };
  for (const line of props.project.lines) {
    if (line.id === id) return { kind: "line", line };
    const point = line.points.find((item) => item.id === id);
    if (point) return { kind: "point", note: point, line };
  }
};

const selectionTargets = computed(() => props.selectedIds.flatMap((id) => targetForId(id) ?? []));
const selectedNotes = computed(() =>
  selectionTargets.value.flatMap((target) => (target.kind === "line" ? [] : [target])),
);
const selectedLines = computed(() => {
  const lines = new Map<string, NoteLine>();
  for (const target of selectionTargets.value) {
    if (target.kind === "line" || target.kind === "point") lines.set(target.line.id, target.line);
  }
  return [...lines.values()];
});
const selectedPoint = computed(() =>
  selectionTargets.value.length === 1 && selectionTargets.value[0]?.kind === "point"
    ? selectionTargets.value[0]
    : undefined,
);
const allFlicks = computed(
  () => selectedNotes.value.length > 0 && selectedNotes.value.every((target) => target.note.type === "flick"),
);
const canAutoLane = computed(
  () => selectedNotes.value.length > 0 && selectedNotes.value.every((target) => target.kind === "point"),
);
const isNoteOrSlideTool = computed(() => ["tap", "flick", "trace", "long", "guide"].includes(props.tool));

const toolTitle = computed(() => {
  switch (props.tool) {
    case "tap":
      return copy.value.tap;
    case "flick":
      return copy.value.flick;
    case "trace":
      return copy.value.trace;
    case "long":
      return copy.value.hold;
    case "guide":
      return copy.value.guide;
    default:
      return copy.value.viewAndTool;
  }
});

const dialogTitle = computed(() => {
  switch (props.context) {
    case "selection":
      return copy.value.selection;
    case "tool":
      return toolTitle.value;
    case "project":
      return copy.value.project;
    case "tempo":
      return "BPM";
    case "meter":
      return copy.value.meter;
    case "timeScale":
      return copy.value.timeScale;
  }
});

const mixedValue = <T,>(values: readonly T[]): MixedValue<T> => {
  if (!values.length) return { value: undefined, mixed: false };
  const first = values[0];
  return values.every((value) => Object.is(value, first))
    ? { value: first, mixed: false }
    : { value: undefined, mixed: true };
};

const beatValue = computed(() =>
  mixedValue(selectedNotes.value.map((target) => tickToBeat(target.note.tick, props.project.resolution))),
);
const laneValue = computed(() => mixedValue(selectedNotes.value.map((target) => target.note.lane)));
const sizeValue = computed(() =>
  mixedValue(
    selectedNotes.value.map((target) => {
      if (target.kind === "single") return target.note.size;
      const index = target.line.points.findIndex((point) => point.id === target.note.id);
      return index < 0 ? target.note.size : resolveLinePointShape(target.line.points, index).size;
    }),
  ),
);
const noteTypeValue = computed(() => mixedValue(selectedNotes.value.map((target) => target.note.type)));
const criticalValue = computed(() => mixedValue(selectedNotes.value.map((target) => target.note.critical)));
const directionValue = computed(() => mixedValue(selectedNotes.value.map((target) => target.note.direction)));
const visibleValue = computed(() => mixedValue(selectedNotes.value.map((target) => target.note.visible)));
const lineKindValue = computed(() => mixedValue(selectedLines.value.map((line) => line.kind)));

const inputElement = (event: Event): HTMLInputElement | HTMLSelectElement =>
  event.currentTarget as HTMLInputElement | HTMLSelectElement;
const finiteNumber = (event: Event): number | undefined => {
  const value = Number(inputElement(event).value);
  return Number.isFinite(value) ? value : undefined;
};
const finitePositiveInteger = (event: Event): number | undefined => {
  const value = finiteNumber(event);
  return value === undefined ? undefined : Math.max(1, Math.round(value));
};
const displayValue = <T,>(field: MixedValue<T>): T | "" =>
  field.mixed || field.value === undefined ? "" : field.value;
const eventBeat = (tick: number): number => tickToBeat(tick, props.project.resolution);
const beatFromEvent = (event: Event): number | undefined => {
  const value = finiteNumber(event);
  return value === undefined ? undefined : Math.max(0, beatToTick(value, props.project.resolution));
};

const patchMeta = (
  key: keyof Pick<ProjectMeta, "title" | "artist" | "charter" | "difficulty" | "level">,
  event: Event,
) => emit("patch-meta", { [key]: inputElement(event).value });
const patchAudioOffset = (event: Event) => {
  const value = finiteNumber(event);
  if (value !== undefined) emit("patch-audio-offset", value);
};
const patchLaneBasis = (event: Event) => {
  const value = finitePositiveInteger(event);
  if (value !== undefined) emit("patch-lane-basis", value);
};
const patchBeat = (event: Event) => {
  const value = beatFromEvent(event);
  if (value !== undefined) emit("patch-selection", { tick: value });
};
const patchLane = (event: Event) => {
  const value = inputElement(event).value.trim();
  if (canAutoLane.value && value.toLocaleLowerCase() === "auto") emit("patch-selection", { lane: "auto" });
  else if (Number.isFinite(Number(value))) emit("patch-selection", { lane: Number(value) });
};
const patchSize = (event: Event) => {
  const value = finiteNumber(event);
  if (value !== undefined) emit("patch-selection", { size: Math.max(0, value) });
};
const patchEase = (side: keyof LinePoint["ease"], value: UiFieldValue) => {
  const target = selectedPoint.value;
  if (!target) return;
  emit("patch-selection", { ease: { ...target.note.ease, [side]: String(value) } as LinePoint["ease"] });
};

const noteTypeOptions = computed<UiSelectOption[]>(() => [
  { value: "tap", label: copy.value.tap },
  { value: "flick", label: copy.value.flick },
  { value: "trace", label: copy.value.trace },
]);
const directionOptions = computed<UiSelectOption[]>(() => [
  { value: "left", label: copy.value.directionLeft },
  { value: "up", label: copy.value.directionUp },
  { value: "right", label: copy.value.directionRight },
]);
const lineKindOptions = computed<UiSelectOption[]>(() => [
  { value: "long", label: copy.value.longLine },
  { value: "guide", label: copy.value.guideLine },
]);
const easeOptions = computed<UiSelectOption[]>(() => [
  { value: "linear", label: copy.value.easeLinear },
  { value: "in", label: copy.value.easeIn },
  { value: "out", label: copy.value.easeOut },
]);
const optionsWithMixed = (mixed: boolean, options: readonly UiSelectOption[]): readonly UiSelectOption[] =>
  mixed ? [{ value: "", label: "—", disabled: true }, ...options] : options;
const patchNoteType = (value: UiFieldValue) => emit("patch-selection", { type: String(value) as NoteType });
const patchDirection = (value: UiFieldValue) =>
  emit("patch-selection", { direction: String(value) as NoteDirection });
const patchLineKind = (value: UiFieldValue) =>
  emit("patch-selection", { lineKind: String(value) as NoteLine["kind"] });
const updateToolDirection = (value: UiFieldValue) => emit("update:direction", String(value) as NoteDirection);

const updateTempoNumber = (item: TempoEvent, key: "bpm", event: Event) => {
  const value = finiteNumber(event);
  if (value !== undefined) emit("update-tempo", { id: item.id, patch: { [key]: value } });
};
const updateTempoBeat = (item: TempoEvent, event: Event) => {
  const tick = beatFromEvent(event);
  if (tick !== undefined) emit("update-tempo", { id: item.id, patch: { tick } });
};
const updateMeterNumber = (item: MeterEvent, key: "numerator" | "denominator", event: Event) => {
  const value = finitePositiveInteger(event);
  if (value !== undefined) emit("update-meter", { id: item.id, patch: { [key]: value } });
};
const updateMeterBeat = (item: MeterEvent, event: Event) => {
  const tick = beatFromEvent(event);
  if (tick !== undefined) emit("update-meter", { id: item.id, patch: { tick } });
};
const updateTimeScaleNumber = (item: TimeScaleEvent, event: Event) => {
  const value = finiteNumber(event);
  if (value !== undefined) emit("update-time-scale", { id: item.id, patch: { scale: value } });
};
const updateTimeScaleBeat = (item: TimeScaleEvent, event: Event) => {
  const tick = beatFromEvent(event);
  if (tick !== undefined) emit("update-time-scale", { id: item.id, patch: { tick } });
};

const tempos = computed(() =>
  [...props.project.tempos].sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id)),
);
const meters = computed(() =>
  [...props.project.meters].sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id)),
);
const timeScales = computed(() =>
  [...props.project.timeScales].sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id)),
);
const eventTick = computed(() => Math.max(0, Math.round(props.playheadTick)));
const canDeleteTempo = (item: TempoEvent) =>
  props.project.tempos.length > 1 &&
  (item.tick !== 0 || props.project.tempos.filter((event) => event.tick === 0).length > 1);
const canDeleteMeter = (item: MeterEvent) =>
  props.project.meters.length > 1 &&
  (item.tick !== 0 || props.project.meters.filter((event) => event.tick === 0).length > 1);
const canMoveTempo = (item: TempoEvent) =>
  item.tick !== 0 || props.project.tempos.filter((event) => event.tick === 0).length > 1;
const canMoveMeter = (item: MeterEvent) =>
  item.tick !== 0 || props.project.meters.filter((event) => event.tick === 0).length > 1;

const close = () => emit("update:modelValue", false);
</script>

<template>
  <UiDialog class="chart-properties-dialog" :open="modelValue" @cancel="close">
    <template #headline>
      <header class="chart-properties-dialog__headline">
        <MaterialIcon name="tune" :size="22" />
        <strong>{{ dialogTitle }}</strong>
        <UiIconButton size="compact" :label="t('close')" @click="close">
          <MaterialIcon name="close" :size="20" />
        </UiIconButton>
      </header>
    </template>
    <template #content>
      <div class="chart-properties-dialog__body">
          <section v-if="context === 'selection'" class="chart-properties-dialog__fields">
            <template v-if="selectedNotes.length">
              <UiSelect
                class="chart-properties-dialog__field"
                :label="copy.noteType"
                :model-value="displayValue(noteTypeValue)"
                :options="optionsWithMixed(noteTypeValue.mixed, noteTypeOptions)"
                @update:model-value="patchNoteType"
              />
              <UiTextField
                class="chart-properties-dialog__field"
                :label="copy.beat"
                type="number"
                min="0"
                step="any"
                :model-value="displayValue(beatValue)"
                :placeholder="beatValue.mixed ? '—' : ''"
                @change="patchBeat"
              />
              <div class="chart-properties-dialog__field-with-data">
                <UiTextField
                  class="chart-properties-dialog__field"
                  :label="copy.lane"
                  :type="canAutoLane ? 'text' : 'number'"
                  step="any"
                  :model-value="displayValue(laneValue)"
                  :placeholder="laneValue.mixed ? '—' : ''"
                  :list="canAutoLane ? laneListId : undefined"
                  @change="patchLane"
                />
                <datalist v-if="canAutoLane" :id="laneListId">
                  <option value="auto">{{ copy.autoLane }}</option>
                </datalist>
              </div>
              <UiTextField
                class="chart-properties-dialog__field"
                :label="copy.width"
                type="number"
                min="0"
                step="any"
                :model-value="displayValue(sizeValue)"
                :placeholder="sizeValue.mixed ? '—' : ''"
                @change="patchSize"
              />
              <UiSwitch
                class="chart-properties-dialog__switch"
                :label="copy.critical"
                :model-value="criticalValue.value === true"
                @update:model-value="emit('patch-selection', { critical: $event })"
              />
              <UiSelect
                v-if="allFlicks"
                class="chart-properties-dialog__field"
                :label="copy.direction"
                :model-value="displayValue(directionValue)"
                :options="optionsWithMixed(directionValue.mixed, directionOptions)"
                @update:model-value="patchDirection"
              />
              <UiSwitch
                class="chart-properties-dialog__switch"
                :label="copy.visible"
                :model-value="visibleValue.value === true"
                @update:model-value="emit('patch-selection', { visible: $event })"
              />
            </template>

            <UiSelect
              v-if="selectedLines.length"
              class="chart-properties-dialog__field"
              :label="copy.lineType"
              :model-value="displayValue(lineKindValue)"
              :options="optionsWithMixed(lineKindValue.mixed, lineKindOptions)"
              @update:model-value="patchLineKind"
            />
            <template v-if="selectedPoint">
              <UiSelect
                class="chart-properties-dialog__field"
                :label="copy.leftEase"
                :model-value="selectedPoint.note.ease.left"
                :options="easeOptions"
                @update:model-value="patchEase('left', $event)"
              />
              <UiSelect
                class="chart-properties-dialog__field"
                :label="copy.rightEase"
                :model-value="selectedPoint.note.ease.right"
                :options="easeOptions"
                @update:model-value="patchEase('right', $event)"
              />
            </template>
          </section>

          <section v-else-if="context === 'tool'" class="chart-properties-dialog__fields">
            <template v-if="isNoteOrSlideTool">
              <UiTextField
                class="chart-properties-dialog__field"
                :label="copy.noteSize"
                type="number"
                min="0"
                step="1"
                :model-value="noteSize"
                @change="emit('update:noteSize', Math.max(0, Number(inputElement($event).value)))"
              />
              <UiSwitch
                class="chart-properties-dialog__switch"
                :label="copy.defaultCritical"
                :model-value="critical"
                @update:model-value="emit('update:critical', $event)"
              />
              <UiSelect
                v-if="tool === 'flick'"
                class="chart-properties-dialog__field"
                :label="copy.defaultDirection"
                :model-value="direction"
                :options="directionOptions"
                @update:model-value="updateToolDirection"
              />
            </template>
          </section>

          <section v-else-if="context === 'project'" class="chart-properties-dialog__fields">
            <UiTextField class="chart-properties-dialog__field" :label="copy.title" :model-value="project.meta.title" maxlength="180" @change="patchMeta('title', $event)" />
            <UiTextField class="chart-properties-dialog__field" :label="copy.artist" :model-value="project.meta.artist" maxlength="180" @change="patchMeta('artist', $event)" />
            <UiTextField class="chart-properties-dialog__field" :label="copy.charter" :model-value="project.meta.charter" maxlength="180" @change="patchMeta('charter', $event)" />
            <UiTextField class="chart-properties-dialog__field" :label="copy.difficulty" :model-value="project.meta.difficulty" maxlength="80" @change="patchMeta('difficulty', $event)" />
            <UiTextField class="chart-properties-dialog__field" :label="copy.level" :model-value="project.meta.level" maxlength="40" @change="patchMeta('level', $event)" />
            <UiTextField class="chart-properties-dialog__field" :label="copy.audioOffset" type="number" step="0.001" :model-value="project.audioOffset" @change="patchAudioOffset" />
            <UiTextField class="chart-properties-dialog__field" :label="copy.laneBasis" type="number" min="1" step="1" :model-value="project.laneBasis" @change="patchLaneBasis" />
          </section>

          <section v-else-if="context === 'tempo'" class="chart-properties-dialog__events">
            <div v-for="item in tempos" :key="item.id" class="chart-properties-dialog__event-row">
              <UiTextField class="chart-properties-dialog__field" label="BPM" type="number" min="0.001" step="0.001" :model-value="item.bpm" @change="updateTempoNumber(item, 'bpm', $event)" />
              <UiTextField class="chart-properties-dialog__field" :label="copy.beat" type="number" min="0" step="any" :model-value="eventBeat(item.tick)" :disabled="!canMoveTempo(item)" @change="updateTempoBeat(item, $event)" />
              <UiIconButton
                class="chart-properties-dialog__delete-event"
                size="compact"
                :disabled="!canDeleteTempo(item)"
                :label="copy.deleteBpm"
                @click="emit('delete-tempo', item.id)"
              >
                <MaterialIcon name="delete" :size="18" />
              </UiIconButton>
            </div>
            <footer>
              <UiButton class="chart-properties-dialog__add" tone="text" @click="emit('add-tempo', eventTick)">
                <template #icon><MaterialIcon name="add" :size="18" /></template>
                {{ copy.addBpm }}
              </UiButton>
            </footer>
          </section>

          <section v-else-if="context === 'meter'" class="chart-properties-dialog__events">
            <div v-for="item in meters" :key="item.id" class="chart-properties-dialog__event-row">
              <UiTextField class="chart-properties-dialog__field" :label="copy.beat" type="number" min="0" step="any" :model-value="eventBeat(item.tick)" :disabled="!canMoveMeter(item)" @change="updateMeterBeat(item, $event)" />
              <UiTextField class="chart-properties-dialog__field" :label="`${copy.meter} N`" type="number" min="1" step="1" :model-value="item.numerator" @change="updateMeterNumber(item, 'numerator', $event)" />
              <UiTextField class="chart-properties-dialog__field" :label="`${copy.meter} D`" type="number" min="1" step="1" :model-value="item.denominator" @change="updateMeterNumber(item, 'denominator', $event)" />
              <UiIconButton
                class="chart-properties-dialog__delete-event"
                size="compact"
                :disabled="!canDeleteMeter(item)"
                :label="copy.deleteMeter"
                @click="emit('delete-meter', item.id)"
              >
                <MaterialIcon name="delete" :size="18" />
              </UiIconButton>
            </div>
            <footer>
              <UiButton class="chart-properties-dialog__add" tone="text" @click="emit('add-meter', eventTick)">
                <template #icon><MaterialIcon name="add" :size="18" /></template>
                {{ copy.addMeter }}
              </UiButton>
            </footer>
          </section>

          <section v-else class="chart-properties-dialog__events">
            <div v-for="item in timeScales" :key="item.id" class="chart-properties-dialog__event-row">
              <UiTextField class="chart-properties-dialog__field" :label="copy.timeScale" type="number" min="0.001" step="0.001" :model-value="item.scale" @change="updateTimeScaleNumber(item, $event)" />
              <UiTextField class="chart-properties-dialog__field" :label="copy.beat" type="number" min="0" step="any" :model-value="eventBeat(item.tick)" @change="updateTimeScaleBeat(item, $event)" />
              <UiIconButton
                class="chart-properties-dialog__delete-event"
                size="compact"
                :label="copy.deleteTimeScale"
                @click="emit('delete-time-scale', item.id)"
              >
                <MaterialIcon name="delete" :size="18" />
              </UiIconButton>
            </div>
            <footer>
              <UiButton class="chart-properties-dialog__add" tone="text" @click="emit('add-time-scale', eventTick)">
                <template #icon><MaterialIcon name="add" :size="18" /></template>
                {{ copy.addTimeScale }}
              </UiButton>
            </footer>
          </section>
      </div>
    </template>
  </UiDialog>
</template>

<style scoped>
.chart-properties-dialog {
  width: min(672px, calc(100vw - 32px));
  max-width: min(672px, calc(100vw - 32px));
  max-height: min(720px, calc(100dvh - 32px));
  --md-dialog-container-color: var(--md-sys-color-surface-container-high);
}

.chart-properties-dialog__headline {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
}

.chart-properties-dialog__headline strong {
  min-width: 0;
  flex: 1;
  color: var(--md-sys-color-on-surface);
  font-size: var(--md-sys-typescale-title-large-size);
  line-height: var(--md-sys-typescale-title-large-line-height);
}

.chart-properties-dialog__body {
  width: min(624px, calc(100vw - 80px));
  max-height: min(560px, calc(100dvh - 180px));
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.chart-properties-dialog__fields,
.chart-properties-dialog__events {
  display: flex;
  flex-direction: column;
  gap: var(--md-sys-spacing-3);
}

.chart-properties-dialog__field,
.chart-properties-dialog__field-with-data {
  width: 100%;
  min-width: 0;
}

.chart-properties-dialog__switch {
  min-height: var(--md-comp-control-height-touch);
  padding-inline: var(--md-sys-spacing-1);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.chart-properties-dialog__event-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--md-comp-control-height-compact);
  align-items: start;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-2);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-low);
}

.chart-properties-dialog__event-row > .chart-properties-dialog__field {
  grid-column: 1;
}

.chart-properties-dialog__delete-event {
  grid-column: 2;
  grid-row: 1;
  align-self: center;
}

.chart-properties-dialog__events > footer {
  display: flex;
  justify-content: end;
  padding-top: var(--md-sys-spacing-1);
}

.chart-properties-dialog__add {
  --md-comp-control-height: var(--md-comp-control-height-compact);
  --md-text-button-container-height: var(--md-comp-control-height-compact);
}

@media (max-width: 620px) {
  .chart-properties-dialog {
    width: calc(100vw - 16px);
    max-width: calc(100vw - 16px);
    max-height: calc(100dvh - 16px);
  }

  .chart-properties-dialog__body {
    width: calc(100vw - 64px);
    max-height: calc(100dvh - 180px);
  }
}
</style>
