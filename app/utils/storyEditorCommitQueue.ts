export type StoryEditorCommitScheduler = (callback: () => void, delay: number) => () => void;

const scheduleWithTimeout: StoryEditorCommitScheduler = (callback, delay) => {
  const timer = globalThis.setTimeout(callback, delay);
  return () => globalThis.clearTimeout(timer);
};

/**
 * Coalesces field edits without owning their values. Callers can keep the
 * displayed draft local while this queue controls when the expensive project
 * transaction is committed.
 */
export const createStoryEditorCommitQueue = (
  delay = 300,
  schedule: StoryEditorCommitScheduler = scheduleWithTimeout,
) => {
  const pending = new Map<string, { cancel: () => void; commit: () => void }>();

  const cancel = (key: string) => {
    const entry = pending.get(key);
    if (!entry) return false;
    entry.cancel();
    pending.delete(key);
    return true;
  };

  const flush = (key: string) => {
    const entry = pending.get(key);
    if (!entry) return false;
    entry.cancel();
    pending.delete(key);
    entry.commit();
    return true;
  };

  const scheduleCommit = (key: string, commit: () => void) => {
    cancel(key);
    const entry: { cancel: () => void; commit: () => void } = { cancel: () => undefined, commit };
    entry.cancel = schedule(() => {
      if (pending.get(key) !== entry) return;
      pending.delete(key);
      commit();
    }, delay);
    pending.set(key, entry);
  };

  const flushAll = () => {
    for (const key of [...pending.keys()]) flush(key);
  };

  const cancelAll = () => {
    for (const key of [...pending.keys()]) cancel(key);
  };

  return {
    schedule: scheduleCommit,
    flush,
    flushAll,
    cancel,
    cancelAll,
    has: (key: string) => pending.has(key),
  };
};
