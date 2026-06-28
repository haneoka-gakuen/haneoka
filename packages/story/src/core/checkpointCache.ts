import type { AdvStory } from "../types/AdvRuntime";

export const ADV_SEEK_CHECKPOINT_VERSION = 1 as const;

export interface AdvSeekCheckpoint<
  TScene = unknown,
  TSession = unknown,
  TLoader = unknown,
  TSound = unknown,
  TState = unknown,
> {
  readonly version: typeof ADV_SEEK_CHECKPOINT_VERSION;
  /** Index of the next command. The snapshot is taken after index - 1 settled. */
  readonly index: number;
  readonly commandCount: number;
  readonly scene: TScene;
  readonly session: TSession;
  readonly loader: TLoader;
  readonly sound: TSound;
  readonly state: TState;
}

/**
 * Bound an in-memory seek cache while keeping useful samples across the whole
 * episode. The checkpoint with the densest neighbours is discarded first;
 * command boundaries near the beginning/end therefore cannot crowd out the
 * rest of the authored timeline.
 */
export function pruneCheckpointCache<T>(cache: Map<number, T>, maxEntries: number): void {
  const limit = Math.max(2, Math.floor(Number(maxEntries) || 2));
  while (cache.size > limit) {
    const keys = [...cache.keys()].sort((left, right) => left - right);
    if (keys.length <= 2) return;
    let removeKey = keys[1];
    let smallestSpan = Number.POSITIVE_INFINITY;
    for (let index = 1; index < keys.length - 1; index += 1) {
      const span = keys[index + 1] - keys[index - 1];
      if (span < smallestSpan) {
        smallestSpan = span;
        removeKey = keys[index];
      }
    }
    cache.delete(removeKey);
  }
}

export function checkpointCacheLimit(value: unknown, fallback = 96): number {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(16, Math.min(256, Math.floor(limit)));
}

const sharedStoryCheckpointCaches = new WeakMap<AdvStory, Map<number, AdvSeekCheckpoint>>();

/**
 * A story object survives the Vue player's backward-seek rebuild. Keeping the
 * cache on that immutable story identity lets the freshly booted renderer
 * restore a proven command boundary without coupling the cache to UI code.
 */
export function sharedCheckpointCacheFor(story: AdvStory): Map<number, AdvSeekCheckpoint> {
  let cache = sharedStoryCheckpointCaches.get(story);
  if (!cache) {
    cache = new Map();
    sharedStoryCheckpointCaches.set(story, cache);
  }
  return cache;
}

export function isCheckpointEnvelopeValid(
  checkpoint: AdvSeekCheckpoint | null | undefined,
  commandCount: number,
): checkpoint is AdvSeekCheckpoint {
  return Boolean(
    checkpoint &&
    checkpoint.version === ADV_SEEK_CHECKPOINT_VERSION &&
    checkpoint.commandCount === commandCount &&
    Number.isInteger(checkpoint.index) &&
    checkpoint.index >= 0 &&
    checkpoint.index <= commandCount,
  );
}

export function nearestCheckpointAtOrBefore(
  cache: ReadonlyMap<number, AdvSeekCheckpoint>,
  targetIndex: number,
  commandCount: number,
  accept: (checkpoint: AdvSeekCheckpoint) => boolean = () => true,
): AdvSeekCheckpoint | null {
  const target = Math.max(0, Math.min(commandCount, Math.floor(Number(targetIndex) || 0)));
  let nearest: AdvSeekCheckpoint | null = null;
  for (const checkpoint of cache.values()) {
    if (!isCheckpointEnvelopeValid(checkpoint, commandCount)) continue;
    if (checkpoint.index > target || checkpoint.index <= (nearest?.index ?? -1)) continue;
    if (!accept(checkpoint)) continue;
    nearest = checkpoint;
  }
  return nearest;
}
