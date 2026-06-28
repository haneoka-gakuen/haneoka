import type { AdvCommand, AdvCommandGroup, AdvCommandGroupAction } from "../types/AdvRuntime";

const finiteSeconds = (value: unknown): number => {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
};

const isCommand = (value: unknown): value is AdvCommand =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Read and normalize the canonical command-group payload. */
export function resolveAdvCommandGroup(value: unknown): AdvCommandGroup | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Partial<AdvCommandGroup>;
  const actions = Array.isArray(source.actions)
    ? source.actions.flatMap((action): AdvCommandGroupAction[] => {
        if (
          !action ||
          typeof action !== "object" ||
          (action.role !== "lifetime" && action.role !== "event") ||
          !isCommand(action.command)
        ) {
          return [];
        }
        return [
          {
            atSeconds: finiteSeconds(action.atSeconds),
            role: action.role,
            command: action.command,
          },
        ];
      })
    : [];
  return {
    waitForPrevious: source.waitForPrevious === true,
    cancelOnManualAdvance: source.cancelOnManualAdvance === true,
    durationSeconds: finiteSeconds(source.durationSeconds),
    actions,
  };
}

/** Stable chronological order used by runtime execution and deterministic replay. */
export function sortAdvCommandGroupActions(actions: readonly AdvCommandGroupAction[]): AdvCommandGroupAction[] {
  return actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => left.action.atSeconds - right.action.atSeconds || left.index - right.index)
    .map(({ action }) => action);
}

/** Nested commands exposed to preload, hydration, and text-mode traversal. */
export function advCommandGroupCommands(command: AdvCommand): AdvCommand[] {
  const group = resolveAdvCommandGroup(command.commandGroup);
  return group ? sortAdvCommandGroupActions(group.actions).map((action) => action.command) : [];
}
