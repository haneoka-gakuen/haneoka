import { inject, provide, shallowRef, type InjectionKey, type ShallowRef } from "vue";

import type { DetailHeaderIconItem } from "~/components/detail/types";
import { sameDisplayText, type DisplayText } from "~/types/displayText";

export interface WorkspaceTopAppBarSegmentOption {
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly image?: string;
  readonly imageFit?: "contain" | "cover";
  readonly label: string;
  readonly semanticColor?: string;
  readonly selectedIcon?: string;
  readonly value: string | number;
}

export interface WorkspaceTopAppBarModeControl {
  /** Use the compact native control density when app-bar space is constrained. */
  readonly compact?: boolean;
  readonly iconOnly?: boolean;
  readonly label: string;
  readonly options: readonly WorkspaceTopAppBarSegmentOption[];
  readonly value: string | number;
  readonly update: (value: string | number) => void;
}

export interface WorkspaceTopAppBarOverride {
  readonly count?: number | string;
  readonly leadingIcons?: readonly DetailHeaderIconItem[];
  readonly mode?: WorkspaceTopAppBarModeControl;
  readonly modes?: readonly WorkspaceTopAppBarModeControl[];
  readonly navigate?: () => void;
  readonly navigation?: "back" | "close" | "none";
  readonly navigationLabel?: string;
  readonly subtitle?: DisplayText;
  readonly suppressPageActions?: boolean;
  readonly title: DisplayText;
  readonly variant?: "page" | "detail";
}

interface WorkspaceTopAppBarRegistration {
  readonly owner: symbol;
  readonly value: WorkspaceTopAppBarOverride;
}

interface WorkspaceTopAppBarContext {
  readonly current: ShallowRef<WorkspaceTopAppBarRegistration | null>;
  clear(owner: symbol): void;
  set(owner: symbol, value: WorkspaceTopAppBarOverride): void;
}

const workspaceTopAppBarKey: InjectionKey<WorkspaceTopAppBarContext> = Symbol("workspace-top-app-bar");

const sameModeOptions = (
  left: readonly WorkspaceTopAppBarSegmentOption[],
  right: readonly WorkspaceTopAppBarSegmentOption[],
) =>
  left.length === right.length &&
  left.every(
    (option, index) =>
      option.value === right[index]?.value &&
      option.label === right[index]?.label &&
      option.ariaLabel === right[index]?.ariaLabel &&
      option.disabled === right[index]?.disabled &&
      option.icon === right[index]?.icon &&
      option.image === right[index]?.image &&
      option.imageFit === right[index]?.imageFit &&
      option.semanticColor === right[index]?.semanticColor &&
      option.selectedIcon === right[index]?.selectedIcon,
  );

const sameMode = (
  left: WorkspaceTopAppBarModeControl | undefined,
  right: WorkspaceTopAppBarModeControl | undefined,
) => {
  if (!left || !right) return left === right;
  return (
    left.value === right.value &&
    left.label === right.label &&
    left.compact === right.compact &&
    left.iconOnly === right.iconOnly &&
    sameModeOptions(left.options, right.options)
  );
};

const sameModes = (
  left: readonly WorkspaceTopAppBarModeControl[] | undefined,
  right: readonly WorkspaceTopAppBarModeControl[] | undefined,
) => {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((mode, index) => sameMode(mode, right[index]));
};

/**
 * Workbench children can derive a fresh localized title / options object on
 * every parent render. Re-publishing an equivalent override re-renders the
 * parent and gives that child another fresh prop, which is a feedback loop.
 * Compare the state the app bar actually renders and retain the existing
 * registration when only callback/object identities differ.
 */
const sameOverride = (left: WorkspaceTopAppBarOverride, right: WorkspaceTopAppBarOverride) =>
  left.count === right.count &&
  left.navigation === right.navigation &&
  left.navigationLabel === right.navigationLabel &&
  left.suppressPageActions === right.suppressPageActions &&
  left.variant === right.variant &&
  (left.leadingIcons?.length ?? 0) === (right.leadingIcons?.length ?? 0) &&
  (left.leadingIcons ?? []).every((item, index) => {
    const other = right.leadingIcons?.[index];
    return (
      item.id === other?.id &&
      item.icon === other.icon &&
      item.image === other.image &&
      item.color === other.color &&
      item.shape === other.shape &&
      sameDisplayText(item.label, other.label)
    );
  }) &&
  sameDisplayText(left.title, right.title) &&
  sameDisplayText(left.subtitle, right.subtitle) &&
  sameMode(left.mode, right.mode) &&
  sameModes(left.modes, right.modes);

export function provideWorkspaceTopAppBar(): WorkspaceTopAppBarContext {
  const current = shallowRef<WorkspaceTopAppBarRegistration | null>(null);
  const context: WorkspaceTopAppBarContext = {
    current,
    clear(owner) {
      if (current.value?.owner === owner) current.value = null;
    },
    set(owner, value) {
      if (current.value?.owner === owner && sameOverride(current.value.value, value)) return;
      current.value = { owner, value };
    },
  };
  provide(workspaceTopAppBarKey, context);
  return context;
}

export function useWorkspaceTopAppBar(): WorkspaceTopAppBarContext | null {
  return inject(workspaceTopAppBarKey, null);
}
