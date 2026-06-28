import type { AdvPlayerState } from "../types/AdvRuntime";

const MUTABLE_STATE_KEYS = [
  "viewport",
  "frameEntries",
  "stageEnv",
  "cover",
  "talk",
  "talkLog",
  "title",
  "location",
  "subtitles",
  "chat",
  "choices",
  "video",
  "audio",
  "preload",
  "unknownCommands",
  "unsupported",
] as const;

function cloneDetachedStateValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value == null || typeof value !== "object") return value;
  const source = value as object;
  const previous = seen.get(source);
  if (previous !== undefined) return previous;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(source, clone);
    for (const item of value) clone.push(cloneDetachedStateValue(item, seen));
    return clone;
  }
  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    seen.set(source, clone);
    for (const [key, item] of value) {
      clone.set(cloneDetachedStateValue(key, seen), cloneDetachedStateValue(item, seen));
    }
    return clone;
  }
  if (value instanceof Set) {
    const clone = new Set<unknown>();
    seen.set(source, clone);
    for (const item of value) clone.add(cloneDetachedStateValue(item, seen));
    return clone;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const clone: Record<string, unknown> = {};
  seen.set(source, clone);
  for (const [key, item] of Object.entries(value)) clone[key] = cloneDetachedStateValue(item, seen);
  return clone;
}

/**
 * Creates a private sink for promises that are already unwinding when a player
 * is disposed. The runtime session is deliberately excluded: it contains
 * controllers and methods, while only the plain rendering state needs a sink.
 */
export function createDetachedAdvPlayerState(state: AdvPlayerState): AdvPlayerState {
  const detached = { ...state, session: null } as AdvPlayerState;
  const sourceRecord = state as Record<string, unknown>;
  const detachedRecord = detached as Record<string, unknown>;
  const seen = new WeakMap<object, unknown>();
  for (const key of MUTABLE_STATE_KEYS) {
    detachedRecord[key] = cloneDetachedStateValue(sourceRecord[key], seen);
  }
  return detached;
}
