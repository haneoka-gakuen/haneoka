/**
 * Converts detached authored work into a barrier while command-shortcut replay
 * is active. A shallow copy keeps the source command data immutable.
 */
export function deterministicReplayCommand<T extends { noWait?: boolean }>(command: T, shouldShortCut: boolean): T {
  return shouldShortCut && command.noWait ? ({ ...command, noWait: false } as T) : command;
}
