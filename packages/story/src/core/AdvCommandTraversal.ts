import type { AdvCommand } from "../types/AdvRuntime";
import { advCommandGroupCommands } from "./AdvCommandGroup";
import { sortAdvTimelineSignals } from "./AdvPlayableDirector";

const nestedTimelineCommands = (command: AdvCommand): AdvCommand[] =>
  sortAdvTimelineSignals(command.timeline?.signals || [])
    .flatMap((signal) => {
      const episode = signal?.episode;
      return episode && typeof episode === "object" ? [episode] : [];
    })
    .concat(advCommandGroupCommands(command));

/** Depth-first command sequence for prose and resource consumers. */
export function* iterateAdvCommands(commands: readonly AdvCommand[]): Generator<AdvCommand> {
  const pending = [...commands].reverse();
  const seen = new Set<AdvCommand>();
  while (pending.length) {
    const command = pending.pop();
    if (!command || seen.has(command)) continue;
    seen.add(command);
    yield command;
    const children = nestedTimelineCommands(command);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
}

/** Materialized helper for callers that inspect every command, including Timeline signals. */
export function flattenAdvCommands(commands: readonly AdvCommand[]): AdvCommand[] {
  return [...iterateAdvCommands(commands)];
}
