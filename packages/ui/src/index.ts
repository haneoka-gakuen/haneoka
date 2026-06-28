import { defineComponent, h, nextTick, onBeforeUnmount, ref, watch, type PropType } from "vue";
import "@material/web/button/filled-button.js";
import "@material/web/button/filled-tonal-button.js";
import "@material/web/button/outlined-button.js";
import "@material/web/button/text-button.js";
import "@material/web/checkbox/checkbox.js";
import "@material/web/chips/filter-chip.js";
import "@material/web/dialog/dialog.js";
import "@material/web/focus/md-focus-ring.js";
import "@material/web/icon/icon.js";
import "@material/web/iconbutton/filled-tonal-icon-button.js";
import "@material/web/iconbutton/icon-button.js";
import "@material/web/list/list-item.js";
import "@material/web/list/list.js";
import "@material/web/labs/card/filled-card.js";
import "@material/web/progress/circular-progress.js";
import "@material/web/progress/linear-progress.js";
import "@material/web/radio/radio.js";
import "@material/web/ripple/ripple.js";
import "@material/web/labs/segmentedbutton/outlined-segmented-button.js";
import "@material/web/labs/segmentedbuttonset/outlined-segmented-button-set.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import "@material/web/switch/switch.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/tabs/primary-tab.js";
import "@material/web/tabs/tabs.js";

export { usePointerTilt, type UiPointerTiltOptions } from "./usePointerTilt.js";

export type UiButtonTone = "accent" | "danger" | "neutral" | "primary" | "runtime" | "text";
export type UiControlSize = "compact" | "default" | "touch";
export type UiIconButtonTone = "runtime" | "surface";
export type UiRuntimeSurfaceVariant = "dock" | "panel" | "toolbar";

export interface UiIconButtonHandle {
  focus(): void;
  getElement(): HTMLElement | undefined;
}

export interface UiButtonHandle {
  focus(): void;
  getElement(): HTMLElement | undefined;
}

export interface UiTextFieldHandle {
  focus(): void;
  getElement(): HTMLElement | undefined;
  getSelection(): { end: number; start: number };
  setSelectionRange(start: number, end: number): void;
}

export interface UiSelectHandle {
  focus(): void;
  getElement(): HTMLElement | undefined;
}

export interface UiFilePickerHandle {
  open(): void;
}

export interface UiDialogHandle {
  focus(): void;
  getElement(): HTMLElement | undefined;
}

export type UiFieldValue = number | string;

const focusableElementSelector = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
  "md-filled-button:not([disabled])",
  "md-filled-tonal-button:not([disabled])",
  "md-outlined-button:not([disabled])",
  "md-text-button:not([disabled])",
  "md-icon-button:not([disabled])",
  "md-filled-tonal-icon-button:not([disabled])",
  "md-filter-chip:not([disabled])",
  "md-list-item[type='button']:not([disabled])",
  "md-list-item[type='link']:not([disabled])",
  "md-outlined-text-field:not([disabled])",
  "md-outlined-select:not([disabled])",
  "md-checkbox:not([disabled])",
  "md-radio:not([disabled])",
  "md-slider:not([disabled])",
  "md-switch:not([disabled])",
].join(",");

/** Returns visible, enabled focus targets, including Material Web hosts. */
export const collectFocusableElements = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(focusableElementSelector)].filter((element) => {
    if (
      element.hidden ||
      element.getAttribute("aria-disabled") === "true" ||
      element.getAttribute("aria-hidden") === "true" ||
      element.closest("[hidden], [inert]")
    ) {
      return false;
    }
    if (typeof window === "undefined") return true;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  });

export const UiDialog = defineComponent({
  name: "UiDialog",
  inheritAttrs: false,
  props: {
    open: Boolean,
  },
  emits: {
    cancel: (_event: Event) => true,
    closed: (_event: Event) => true,
    opened: (_event: Event) => true,
  },
  setup(props, { attrs, emit, expose, slots }) {
    const root = ref<HTMLElement>();
    let returnFocus: HTMLElement | null = null;

    watch(
      () => props.open,
      (open) => {
        if (!open || typeof document === "undefined") return;
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      },
      { flush: "sync" },
    );

    const restoreFocus = async () => {
      if (!returnFocus || typeof document === "undefined") return;
      const target = returnFocus;
      returnFocus = null;
      await nextTick();
      const activeModal = document.activeElement?.closest?.("md-dialog[open]");
      if (activeModal || !target.isConnected) return;
      target.focus({ preventScroll: true });
    };

    expose({
      focus: () => root.value?.focus(),
      getElement: () => root.value,
    } satisfies UiDialogHandle);
    return () =>
      h(
        "md-dialog",
        {
          ...attrs,
          ref: root,
          class: ["md3-dialog", attrs.class],
          open: props.open,
          onCancel: (event: Event) => emit("cancel", event),
          onOpened: (event: Event) => emit("opened", event),
          onClosed: (event: Event) => {
            emit("closed", event);
            void restoreFocus();
          },
        },
        [
          slots.headline ? h("div", { class: "md3-dialog__headline", slot: "headline" }, slots.headline()) : null,
          slots.content ? h("div", { class: "md3-dialog__content", slot: "content" }, slots.content()) : null,
          slots.actions ? h("div", { class: "md3-dialog__actions", slot: "actions" }, slots.actions()) : null,
        ],
      );
  },
});

export const UiFilterChip = defineComponent({
  name: "UiFilterChip",
  inheritAttrs: false,
  props: {
    disabled: Boolean,
    selected: Boolean,
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        "md-filter-chip",
        {
          ...attrs,
          class: ["md3-filter-chip", attrs.class],
          disabled: props.disabled,
          hasIcon: Boolean(slots.icon),
          selected: props.selected,
        },
        [
          slots.icon ? h("span", { class: "md3-slot-icon md3-filter-chip__icon", slot: "icon" }, slots.icon()) : null,
          slots.default?.(),
        ],
      );
  },
});

export interface UiSelectOption {
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: UiFieldValue;
}

export const UiRuntimeSurface = defineComponent({
  name: "UiRuntimeSurface",
  inheritAttrs: false,
  props: {
    as: { type: String as PropType<"aside" | "div" | "section">, default: "div" },
    compact: Boolean,
    label: { type: String, required: true },
    variant: { type: String as PropType<UiRuntimeSurfaceVariant>, default: "toolbar" },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        props.as,
        {
          ...attrs,
          "aria-label": props.label,
          class: [
            "md3-runtime-surface",
            `md3-runtime-surface--${props.variant}`,
            { "is-compact": props.compact },
            attrs.class,
          ],
          role: attrs.role ?? (props.variant === "toolbar" ? "toolbar" : undefined),
        },
        [slots.icon ? h("span", { slot: "leading-icon" }, slots.icon()) : null, slots.default?.()],
      );
  },
});

export const UiButton = defineComponent({
  name: "UiButton",
  inheritAttrs: false,
  props: {
    disabled: Boolean,
    href: { type: String, default: "" },
    tone: { type: String as PropType<UiButtonTone>, default: "neutral" },
    type: { type: String as PropType<"button" | "reset" | "submit">, default: "button" },
  },
  setup(props, { attrs, expose, slots }) {
    const root = ref<HTMLElement>();
    expose({
      focus: () => root.value?.focus(),
      getElement: () => root.value,
    } satisfies UiButtonHandle);
    return () => {
      const element =
        props.tone === "primary" || props.tone === "danger"
          ? "md-filled-button"
          : props.tone === "accent"
            ? "md-filled-tonal-button"
            : props.tone === "text"
              ? "md-text-button"
              : "md-outlined-button";
      return h(
        element,
        {
          ...attrs,
          ref: root,
          class: ["md3-button", `md3-button--${props.tone}`, attrs.class],
          disabled: props.disabled,
          href: props.href || undefined,
          type: props.type,
        },
        [
          slots.icon ? h("span", { class: "md3-slot-icon md3-button__icon", slot: "icon" }, slots.icon()) : null,
          slots.default?.(),
        ],
      );
    };
  },
});

export const UiTextField = defineComponent({
  name: "UiTextField",
  inheritAttrs: false,
  props: {
    disabled: Boolean,
    errorText: { type: String, default: "" },
    label: { type: String, required: true },
    modelValue: { type: [Number, String] as PropType<UiFieldValue>, default: "" },
    required: Boolean,
    supportingText: { type: String, default: "" },
    type: { type: String, default: "text" },
  },
  emits: { "update:modelValue": (_value: UiFieldValue) => true },
  setup(props, { attrs, emit, expose, slots }) {
    const root = ref<
      HTMLElement & {
        selectionEnd?: number | null;
        selectionStart?: number | null;
        setSelectionRange?: (start: number, end: number) => void;
      }
    >();
    expose({
      focus: () => root.value?.focus(),
      getElement: () => root.value,
      getSelection: () => ({
        end: root.value?.selectionEnd ?? 0,
        start: root.value?.selectionStart ?? 0,
      }),
      setSelectionRange: (start: number, end: number) => root.value?.setSelectionRange?.(start, end),
    } satisfies UiTextFieldHandle);
    const maximumLength = () => {
      const raw = attrs.maxlength ?? attrs.maxLength;
      const value = typeof raw === "number" || typeof raw === "string" ? Number(raw) : -1;
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : -1;
    };
    const limitValue = (value: string) => {
      const limit = maximumLength();
      return limit >= 0 ? value.slice(0, limit) : value;
    };
    const forwardedAttrs = () => {
      const values = { ...attrs };
      delete values.maxlength;
      delete values.maxLength;
      return values;
    };
    const update = (event: Event) => {
      const target = event.currentTarget as HTMLElement & { value: string };
      const value = limitValue(target.value);
      if (value !== target.value) target.value = value;
      emit("update:modelValue", props.type === "number" && value !== "" ? Number(value) : value);
    };
    return () =>
      h(
        "md-outlined-text-field",
        {
          ...forwardedAttrs(),
          ref: root,
          class: ["md3-text-field", attrs.class],
          disabled: props.disabled,
          error: Boolean(props.errorText),
          errorText: props.errorText,
          label: props.label,
          required: props.required,
          supportingText: props.supportingText,
          type: props.type,
          "^value": limitValue(String(props.modelValue)),
          onInput: update,
        },
        [
          slots["leading-icon"]
            ? h("span", { class: "md3-slot-icon md3-text-field__icon", slot: "leading-icon" }, slots["leading-icon"]())
            : null,
          slots["trailing-icon"]
            ? h(
                "span",
                { class: "md3-slot-icon md3-text-field__icon md3-text-field__icon--trailing", slot: "trailing-icon" },
                slots["trailing-icon"](),
              )
            : null,
        ],
      );
  },
});

/**
 * Shared single-column form geometry. It keeps native Material controls on one
 * horizontal inset and gives every direct field the same available width.
 */
export const UiFormLayout = defineComponent({
  name: "UiFormLayout",
  inheritAttrs: false,
  props: {
    as: { type: String, default: "form" },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        props.as,
        {
          ...attrs,
          class: ["md3-form-layout", attrs.class],
        },
        slots.default?.(),
      );
  },
});

export const UiFilePicker = defineComponent({
  name: "UiFilePicker",
  inheritAttrs: false,
  props: {
    accept: { type: String, default: "" },
    disabled: Boolean,
    label: { type: String, required: true },
    multiple: Boolean,
    required: Boolean,
    tone: { type: String as PropType<UiButtonTone>, default: "neutral" },
  },
  emits: { select: (_files: File[]) => true },
  setup(props, { attrs, emit, expose, slots }) {
    const input = ref<HTMLInputElement>();
    const open = () => {
      if (!props.disabled) input.value?.click();
    };
    expose({ open } satisfies UiFilePickerHandle);
    const select = (event: Event) => {
      const field = event.currentTarget as HTMLInputElement;
      emit("select", Array.from(field.files ?? []));
      field.value = "";
    };
    return () =>
      h("span", { ...attrs, class: ["md3-file-picker", attrs.class] }, [
        h("input", {
          ref: input,
          accept: props.accept,
          "aria-label": props.label,
          class: "md3-file-picker__input",
          disabled: props.disabled,
          multiple: props.multiple,
          required: props.required,
          type: "file",
          onChange: select,
        }),
        h(
          UiButton,
          { disabled: props.disabled, tone: props.tone, onClick: open },
          { default: slots.default, icon: slots.icon },
        ),
      ]);
  },
});

export const UiSelect = defineComponent({
  name: "UiSelect",
  inheritAttrs: false,
  props: {
    disabled: Boolean,
    label: { type: String, required: true },
    modelValue: { type: [Number, String] as PropType<UiFieldValue>, required: true },
    options: { type: Array as PropType<readonly UiSelectOption[]>, required: true },
    required: Boolean,
  },
  emits: { "update:modelValue": (_value: UiFieldValue) => true },
  setup(props, { attrs, emit, expose }) {
    const root = ref<HTMLElement>();
    expose({
      focus: () => root.value?.focus(),
      getElement: () => root.value,
    } satisfies UiSelectHandle);
    const update = (event: Event) => {
      const selected = (event.currentTarget as HTMLElement & { value: string }).value;
      const option = props.options.find((candidate) => String(candidate.value) === selected);
      if (option) emit("update:modelValue", option.value);
    };
    return () =>
      h(
        "md-outlined-select",
        {
          ...attrs,
          ref: root,
          class: ["md3-select", attrs.class],
          disabled: props.disabled,
          label: props.label,
          required: props.required,
          value: String(props.modelValue),
          onChange: update,
        },
        props.options.map((option) =>
          h(
            "md-select-option",
            {
              disabled: option.disabled,
              key: String(option.value),
              selected: option.value === props.modelValue,
              "^value": String(option.value),
            },
            h("span", { slot: "headline" }, option.label),
          ),
        ),
      );
  },
});

export const UiCheckbox = defineComponent({
  name: "UiCheckbox",
  inheritAttrs: false,
  props: {
    disabled: Boolean,
    label: { type: String, required: true },
    modelValue: Boolean,
    tone: { type: String as PropType<"runtime" | "surface">, default: "surface" },
  },
  emits: { "update:modelValue": (_value: boolean) => true },
  setup(props, { attrs, emit, slots }) {
    const update = (event: Event) =>
      emit("update:modelValue", Boolean((event.currentTarget as HTMLElement & { checked: boolean }).checked));
    return () => {
      const fieldAttrs = { ...attrs };
      delete fieldAttrs["aria-required"];
      return h(
        "label",
        { ...fieldAttrs, class: ["md3-checkbox-field", `md3-checkbox-field--${props.tone}`, attrs.class] },
        [
          h("span", { class: "md3-checkbox-field__control" }, [
            h("md-checkbox", {
              "aria-required": attrs["aria-required"],
              checked: props.modelValue,
              disabled: props.disabled,
              touchTarget: "none",
              onChange: update,
            }),
          ]),
          h("span", { class: "md3-checkbox-field__label" }, slots.default?.() ?? props.label),
        ],
      );
    };
  },
});

export const UiSwitch = defineComponent({
  name: "UiSwitch",
  inheritAttrs: false,
  props: {
    disabled: Boolean,
    label: { type: String, required: true },
    modelValue: Boolean,
    tone: { type: String as PropType<"runtime" | "surface">, default: "surface" },
  },
  emits: { "update:modelValue": (_value: boolean) => true },
  setup(props, { attrs, emit, slots }) {
    const update = (event: Event) =>
      emit("update:modelValue", Boolean((event.currentTarget as HTMLElement & { selected: boolean }).selected));
    return () =>
      h("label", { ...attrs, class: ["md3-switch-field", `md3-switch-field--${props.tone}`, attrs.class] }, [
        h("span", { class: "md3-switch-field__label" }, slots.default?.() ?? props.label),
        h("md-switch", { disabled: props.disabled, selected: props.modelValue, onChange: update }),
      ]);
  },
});

export const UiList = defineComponent({
  name: "UiList",
  inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    return () => h("md-list", { ...attrs, class: ["md3-list", attrs.class] }, slots.default?.());
  },
});

export const UiListItem = defineComponent({
  name: "UiListItem",
  inheritAttrs: false,
  props: {
    disabled: Boolean,
    headline: { type: String, default: "" },
    href: { type: String, default: "" },
    supportingText: { type: String, default: "" },
    type: { type: String as PropType<"button" | "link" | "text">, default: "button" },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        "md-list-item",
        {
          ...attrs,
          class: ["md3-list-item", attrs.class],
          disabled: props.disabled,
          href: props.href,
          type: props.type,
        },
        [
          slots.start ? h("span", { class: "md3-slot-icon md3-list-item__slot", slot: "start" }, slots.start()) : null,
          h("span", { slot: "headline" }, slots.headline?.() ?? props.headline),
          props.supportingText || slots.supporting
            ? h("span", { slot: "supporting-text" }, slots.supporting?.() ?? props.supportingText)
            : null,
          slots.end ? h("span", { class: "md3-slot-icon md3-list-item__slot", slot: "end" }, slots.end()) : null,
        ],
      );
  },
});

export const UiIconButton = defineComponent({
  name: "UiIconButton",
  inheritAttrs: false,
  props: {
    disabled: Boolean,
    emphasis: Boolean,
    href: { type: String, default: "" },
    label: { type: String, required: true },
    pressed: { type: Boolean, default: undefined },
    size: { type: String as PropType<UiControlSize>, default: "default" },
    touchTarget: Boolean,
    tone: { type: String as PropType<UiIconButtonTone>, default: "surface" },
    type: { type: String as PropType<"button" | "reset" | "submit">, default: "button" },
  },
  setup(props, { attrs, expose, slots }) {
    const root = ref<HTMLElement>();
    expose({
      focus: () => root.value?.focus(),
      getElement: () => root.value,
    } satisfies UiIconButtonHandle);
    return () => {
      // Toggleable actions stay on the same tonal host while their state
      // changes. This gives selected state a real filled container without
      // replacing the keyboard-focused custom element.
      const element = props.emphasis || props.pressed !== undefined ? "md-filled-tonal-icon-button" : "md-icon-button";
      return h(
        element,
        {
          ...attrs,
          ref: root,
          "aria-label": props.label,
          ...(props.pressed === undefined ? {} : { "aria-pressed": props.pressed }),
          class: [
            "md3-icon-button",
            `md3-icon-button--${props.tone}`,
            `md3-icon-button--${props.size}`,
            {
              "is-active": props.pressed,
              "is-emphasis": props.emphasis,
              "is-toggle": props.pressed !== undefined,
              "is-touch-target": props.touchTarget,
            },
            attrs.class,
          ],
          disabled: props.disabled,
          href: props.href,
          selected: props.pressed ?? false,
          title: props.label,
          toggle: props.pressed !== undefined,
          type: props.type,
        },
        h("span", { class: "md3-slot-icon md3-icon-button__icon" }, slots.default?.()),
      );
    };
  },
});

export const MaterialIcon = defineComponent({
  name: "MaterialIcon",
  inheritAttrs: false,
  props: {
    filled: Boolean,
    grade: { type: Number, default: 0 },
    name: { type: String, required: true },
    opticalSize: { type: Number, default: 24 },
    size: { type: [Number, String] as PropType<number | string>, default: 24 },
    weight: { type: Number, default: 400 },
  },
  setup(props, { attrs }) {
    return () => {
      const size = typeof props.size === "number" ? `${props.size}px` : props.size;
      return h(
        "md-icon",
        {
          ...attrs,
          "aria-hidden": attrs["aria-label"] ? undefined : "true",
          class: ["md3-material-icon", attrs.class],
          style: [
            {
              "--md-comp-icon-fill": props.filled ? 1 : 0,
              "--md-comp-icon-grade": props.grade,
              "--md-comp-icon-optical-size": props.opticalSize,
              "--md-comp-icon-size": size,
              "--md-comp-icon-weight": props.weight,
            },
            attrs.style,
          ],
        },
        props.name,
      );
    };
  },
});

function finiteRangeValue(value: number, minimum: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? value : minimum;
  return Math.max(minimum, Math.min(maximum, normalized));
}

export const UiRange = defineComponent({
  name: "UiRange",
  inheritAttrs: false,
  props: {
    ariaValueText: { type: String, default: "" },
    disabled: Boolean,
    label: { type: String, required: true },
    max: { type: Number, default: 1 },
    min: { type: Number, default: 0 },
    modelValue: { type: Number, required: true },
    step: { type: Number, default: 0.01 },
    tone: { type: String as PropType<"runtime" | "surface">, default: "surface" },
    valueLabel: { type: String, default: "" },
  },
  emits: {
    commit: (value: number) => Number.isFinite(value),
    "update:modelValue": (value: number) => Number.isFinite(value),
  },
  setup(props, { attrs, emit, slots }) {
    const bounds = () => {
      const minimum = Number.isFinite(props.min) ? props.min : 0;
      const maximum = Number.isFinite(props.max) ? Math.max(minimum, props.max) : minimum;
      return { maximum, minimum };
    };
    const eventValue = (event: Event) => {
      const { maximum, minimum } = bounds();
      return finiteRangeValue(
        Number((event.currentTarget as HTMLElement & { value?: number }).value),
        minimum,
        maximum,
      );
    };
    const update = (event: Event) => emit("update:modelValue", eventValue(event));
    const commit = (event: Event) => emit("commit", eventValue(event));

    return () => {
      const { maximum, minimum } = bounds();
      const value = finiteRangeValue(props.modelValue, minimum, maximum);
      return h(
        "label",
        {
          ...attrs,
          class: [
            "md3-range",
            `md3-range--${props.tone}`,
            { "has-icon": Boolean(slots.icon), "has-output": props.valueLabel, "is-disabled": props.disabled },
            attrs.class,
          ],
        },
        [
          slots.icon ? h("span", { "aria-hidden": "true", class: "md3-range__icon" }, slots.icon()) : null,
          h("span", { class: "md3-visually-hidden" }, props.label),
          h("md-slider", {
            "aria-valuetext": props.ariaValueText || undefined,
            "aria-label": props.label,
            class: "md3-range__input",
            disabled: props.disabled,
            max: maximum,
            min: minimum,
            step: props.step,
            value,
            onChange: commit,
            onInput: update,
          }),
          props.valueLabel ? h("output", { class: "md3-range__output" }, props.valueLabel) : null,
        ],
      );
    };
  },
});

export interface UiSegmentOption {
  /** A fuller accessible name when the visible segment label is intentionally compact. */
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly image?: string;
  readonly imageFit?: "contain" | "cover";
  readonly label: string;
  /** An optional semantic accent for controls such as game difficulty. */
  readonly semanticColor?: string;
  /** @deprecated Selection is expressed by the container background, not a checkmark. */
  readonly selectedIcon?: string;
  readonly value: UiFieldValue;
}

export const UiSegmentedControl = defineComponent({
  name: "UiSegmentedControl",
  props: {
    density: { type: String as PropType<"compact" | "standard">, default: "standard" },
    iconOnly: Boolean,
    label: { type: String, required: true },
    modelValue: { type: [Number, String] as PropType<UiFieldValue>, required: true },
    options: { type: Array as PropType<readonly UiSegmentOption[]>, required: true },
    touchTarget: Boolean,
  },
  emits: { "update:modelValue": (_value: UiFieldValue) => true },
  setup(props, { emit }) {
    const selectOption = (event: Event) => {
      const detail = (event as CustomEvent<{ index?: number; selected?: boolean }>).detail;
      const index = detail?.index;
      if (!detail?.selected || typeof index !== "number" || !Number.isInteger(index)) return;

      const option = props.options[index];
      if (!option || option.disabled) return;
      emit("update:modelValue", option.value);
    };

    const nativeStyle = (option: UiSegmentOption) => {
      if (!option.semanticColor) return undefined;

      const semanticColor = option.semanticColor;
      return {
        "--md-outlined-segmented-button-outline-color": semanticColor,
        "--md-outlined-segmented-button-selected-container-color": `color-mix(in srgb, ${semanticColor} 32%, var(--md-sys-color-surface-container-lowest))`,
        "--md-outlined-segmented-button-selected-focus-icon-color": "var(--md-sys-color-on-surface)",
        "--md-outlined-segmented-button-selected-focus-label-text-color": "var(--md-sys-color-on-surface)",
        "--md-outlined-segmented-button-selected-hover-icon-color": "var(--md-sys-color-on-surface)",
        "--md-outlined-segmented-button-selected-hover-label-text-color": "var(--md-sys-color-on-surface)",
        "--md-outlined-segmented-button-selected-icon-color": "var(--md-sys-color-on-surface)",
        "--md-outlined-segmented-button-selected-label-text-color": "var(--md-sys-color-on-surface)",
        "--md-outlined-segmented-button-selected-pressed-icon-color": "var(--md-sys-color-on-surface)",
        "--md-outlined-segmented-button-selected-pressed-label-text-color": "var(--md-sys-color-on-surface)",
        "--md-outlined-segmented-button-unselected-icon-color": `color-mix(in srgb, ${semanticColor} 78%, var(--md-sys-color-on-surface))`,
        "--md-outlined-segmented-button-unselected-label-text-color": `color-mix(in srgb, ${semanticColor} 78%, var(--md-sys-color-on-surface))`,
      };
    };

    return () =>
      h(
        "md-outlined-segmented-button-set",
        {
          "aria-label": props.label,
          class: [
            "md3-segments",
            {
              "is-compact": props.density === "compact",
              "is-icon-only": props.iconOnly,
              "is-touch-target": props.touchTarget,
            },
          ],
          onSegmentedButtonSetSelection: selectOption,
        },
        props.options.map((option) => {
          const selected = option.value === props.modelValue;
          const visual = option.image
            ? h("img", {
                alt: "",
                "aria-hidden": "true",
                class: ["md3-segments__image", { "is-cover": option.imageFit === "cover" }],
                decoding: "async",
                loading: "lazy",
                src: option.image,
              })
            : option.icon
              ? h(MaterialIcon, { name: option.icon, size: 18 })
              : null;
          const content = props.iconOnly
            ? visual
              ? h("span", { class: "md3-slot-icon md3-segments__icon", slot: "icon" }, visual)
              : null
            : h("span", { class: "md3-segments__content", slot: "icon" }, [
                visual ? h("span", { class: "md3-slot-icon md3-segments__icon" }, visual) : null,
                h("span", { class: "md3-segments__label" }, option.label),
              ]);
          return h(
            "md-outlined-segmented-button",
            {
              "aria-label": option.ariaLabel || option.label,
              class: "md3-segments__option",
              disabled: option.disabled,
              label: "",
              noCheckmark: true,
              selected,
              style: nativeStyle(option),
              title: option.ariaLabel || (props.iconOnly ? option.label : undefined),
            },
            [content],
          );
        }),
      );
  },
});

export const UiSkeleton = defineComponent({
  name: "UiSkeleton",
  props: { label: { type: String, default: "Loading" } },
  setup(props) {
    return () => h("span", { "aria-label": props.label, class: "md3-skeleton", role: "status" });
  },
});

const normalizeProgress = (value: number, max: number) => {
  const maximum = Number.isFinite(max) && max > 0 ? max : 1;
  return { maximum, value: Math.max(0, Math.min(maximum, Number.isFinite(value) ? value : 0)) };
};

export const UiCircularProgress = defineComponent({
  name: "UiCircularProgress",
  inheritAttrs: false,
  props: {
    indeterminate: Boolean,
    label: { type: String, required: true },
    max: { type: Number, default: 1 },
    value: { type: Number, default: 0 },
  },
  setup(props, { attrs }) {
    return () => {
      const progress = normalizeProgress(props.value, props.max);
      return h("md-circular-progress", {
        ...attrs,
        "aria-label": props.label,
        class: ["md3-circular-progress", attrs.class],
        indeterminate: props.indeterminate,
        max: progress.maximum,
        value: progress.value,
      });
    };
  },
});

export const UiLinearProgress = defineComponent({
  name: "UiLinearProgress",
  inheritAttrs: false,
  props: {
    indeterminate: Boolean,
    label: { type: String, required: true },
    max: { type: Number, default: 1 },
    value: { type: Number, default: 0 },
  },
  setup(props, { attrs }) {
    return () => {
      const progress = normalizeProgress(props.value, props.max);
      return h("md-linear-progress", {
        ...attrs,
        "aria-label": props.label,
        class: ["md3-linear-progress", attrs.class],
        indeterminate: props.indeterminate,
        max: progress.maximum,
        value: progress.value,
      });
    };
  },
});

function finiteTimelineValue(value: number, minimum: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? value : minimum;
  return Math.max(minimum, Math.min(maximum, normalized));
}

export const UiTimeline = defineComponent({
  name: "UiTimeline",
  inheritAttrs: false,
  props: {
    ariaValueText: { type: String, default: "" },
    busy: Boolean,
    disabled: Boolean,
    endLabel: { type: String, default: "" },
    label: { type: String, required: true },
    max: { type: Number, default: 1 },
    min: { type: Number, default: 0 },
    modelValue: { type: Number, required: true },
    startLabel: { type: String, default: "" },
    step: { type: Number, default: 0.001 },
    tone: { type: String as PropType<"runtime" | "surface">, default: "surface" },
    valueLabel: { type: String, default: "" },
  },
  emits: {
    commit: (value: number) => Number.isFinite(value),
    preview: (value: number) => Number.isFinite(value),
    "scrub-end": (value: number) => Number.isFinite(value),
    "scrub-start": (value: number) => Number.isFinite(value),
  },
  setup(props, { attrs, emit }) {
    const bounds = () => {
      const minimum = Number.isFinite(props.min) ? props.min : 0;
      const maximum = Number.isFinite(props.max) ? Math.max(minimum, props.max) : minimum;
      return { maximum, minimum };
    };
    const normalize = (value: number) => {
      const { maximum, minimum } = bounds();
      return finiteTimelineValue(value, minimum, maximum);
    };
    const draft = ref(normalize(props.modelValue));
    const scrubbing = ref(false);
    let previewFrame = 0;
    let pendingPreview: number | undefined;
    let lastPreviewValue: number | undefined;
    let committedValue = draft.value;
    let dirty = false;
    let activePointerId: number | undefined;

    const flushPreview = () => {
      if (previewFrame) cancelAnimationFrame(previewFrame);
      previewFrame = 0;
      if (pendingPreview === undefined) return;
      const value = pendingPreview;
      pendingPreview = undefined;
      if (value === lastPreviewValue) return;
      lastPreviewValue = value;
      emit("preview", value);
    };
    const schedulePreview = (value: number) => {
      pendingPreview = value;
      if (!previewFrame) previewFrame = requestAnimationFrame(flushPreview);
    };
    const eventValue = (event: Event) =>
      normalize(Number((event.currentTarget as HTMLElement & { value?: number }).value));
    const updateDraft = (event: Event) => {
      const value = eventValue(event);
      draft.value = value;
      dirty ||= value !== committedValue;
      schedulePreview(value);
    };
    const commit = (event: Event) => {
      const value = eventValue(event);
      draft.value = value;
      pendingPreview = value;
      flushPreview();
      if (dirty || value !== committedValue) {
        committedValue = value;
        dirty = false;
        emit("commit", value);
      }
    };
    const startScrub = (event: PointerEvent) => {
      if (props.disabled) return;
      activePointerId = event.pointerId;
      committedValue = normalize(props.modelValue);
      dirty = false;
      scrubbing.value = true;
      emit("scrub-start", draft.value);
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    };
    const endScrub = (event: PointerEvent) => {
      if (!scrubbing.value) return;
      if (activePointerId !== undefined && event.pointerId !== activePointerId) return;
      commit(event);
      activePointerId = undefined;
      scrubbing.value = false;
      emit("scrub-end", draft.value);
    };
    const scrubKeys = new Set(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp"]);
    const startKeyboardScrub = (event: KeyboardEvent) => {
      if (props.disabled || scrubbing.value || !scrubKeys.has(event.key)) return;
      committedValue = normalize(props.modelValue);
      dirty = false;
      scrubbing.value = true;
      emit("scrub-start", draft.value);
    };
    const endKeyboardScrub = (event: KeyboardEvent | FocusEvent) => {
      if (!scrubbing.value || activePointerId !== undefined) return;
      if (event instanceof KeyboardEvent && !scrubKeys.has(event.key)) return;
      commit(event);
      scrubbing.value = false;
      emit("scrub-end", draft.value);
    };

    watch(
      () => props.modelValue,
      (value) => {
        const normalized = normalize(value);
        if (!scrubbing.value) {
          draft.value = normalized;
          committedValue = normalized;
          dirty = false;
        }
      },
    );
    watch(
      () => [props.min, props.max] as const,
      () => {
        draft.value = normalize(draft.value);
        committedValue = normalize(committedValue);
      },
    );
    onBeforeUnmount(() => {
      if (previewFrame) cancelAnimationFrame(previewFrame);
    });

    return () => {
      const { maximum, minimum } = bounds();
      const labels = [props.startLabel, props.valueLabel, props.endLabel];
      return h(
        "div",
        {
          ...attrs,
          "aria-busy": props.busy || undefined,
          class: [
            "md3-timeline",
            `md3-timeline--${props.tone}`,
            { "is-busy": props.busy, "is-disabled": props.disabled, "is-scrubbing": scrubbing.value },
            attrs.class,
          ],
        },
        [
          ...labels
            .slice(0, 2)
            .map((label, index) =>
              label
                ? h("span", { class: ["md3-timeline__label", index === 1 && "md3-timeline__label--value"] }, label)
                : null,
            ),
          h("md-slider", {
            "aria-label": props.label,
            "aria-valuetext": props.ariaValueText || props.valueLabel || undefined,
            class: "md3-timeline__input",
            disabled: props.disabled,
            max: maximum,
            min: minimum,
            step: props.step,
            value: draft.value,
            onBlur: endKeyboardScrub,
            onChange: commit,
            onInput: updateDraft,
            onKeydown: startKeyboardScrub,
            onKeyup: endKeyboardScrub,
            onPointercancel: endScrub,
            onPointerdown: startScrub,
            onPointerup: endScrub,
          }),
          props.endLabel ? h("span", { class: "md3-timeline__label" }, props.endLabel) : null,
        ],
      );
    };
  },
});
