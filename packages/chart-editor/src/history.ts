import { structuredCloneValue } from "./model";

export interface HistoryUpdateOptions {
  /** Consecutive updates with the same key undo as one gesture. */
  mergeKey?: string;
}

const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) && left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (typeof left === "object") {
    if (Array.isArray(right)) return false;
    const leftEntries = Object.entries(left as Record<string, unknown>);
    const rightRecord = right as Record<string, unknown>;
    const rightKeys = Object.keys(rightRecord);
    return (
      leftEntries.length === rightKeys.length &&
      leftEntries.every(([key, value]) => Object.hasOwn(rightRecord, key) && sameValue(value, rightRecord[key]))
    );
  }
  return false;
};

export class ProjectHistory<T> {
  readonly capacity: number;
  #present: T;
  #undo: T[] = [];
  #redo: T[] = [];
  #mergeKey: string | undefined;
  #revision = 0;

  constructor(initial: T, capacity = 50) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("History capacity must be positive");
    this.capacity = capacity;
    this.#present = structuredCloneValue(initial);
  }

  get value(): T {
    return structuredCloneValue(this.#present);
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get undoDepth(): number {
    return this.#undo.length;
  }

  get redoDepth(): number {
    return this.#redo.length;
  }

  /** Monotonic counter for observable history state changes. */
  get revision(): number {
    return this.#revision;
  }

  update(updater: (draft: T) => T | void, options: HistoryUpdateOptions = {}): T {
    const draft = structuredCloneValue(this.#present);
    const returned = updater(draft);
    const next = structuredCloneValue(returned === undefined ? draft : returned);
    if (sameValue(next, this.#present)) return this.value;

    const merging = options.mergeKey !== undefined && options.mergeKey === this.#mergeKey && this.#redo.length === 0;
    if (!merging) {
      this.#undo.push(structuredCloneValue(this.#present));
      if (this.#undo.length > this.capacity) this.#undo.splice(0, this.#undo.length - this.capacity);
    }
    this.#present = next;
    this.#redo = [];
    this.#mergeKey = options.mergeKey;
    this.#revision += 1;
    return this.value;
  }

  replace(value: T, options: HistoryUpdateOptions = {}): T {
    return this.update(() => value, options);
  }

  endMerge(): void {
    this.#mergeKey = undefined;
  }

  undo(): T {
    const previous = this.#undo.pop();
    if (!previous) return this.value;
    this.#redo.push(structuredCloneValue(this.#present));
    this.#present = previous;
    this.#mergeKey = undefined;
    this.#revision += 1;
    return this.value;
  }

  redo(): T {
    const next = this.#redo.pop();
    if (!next) return this.value;
    this.#undo.push(structuredCloneValue(this.#present));
    if (this.#undo.length > this.capacity) this.#undo.shift();
    this.#present = next;
    this.#mergeKey = undefined;
    this.#revision += 1;
    return this.value;
  }

  reset(value: T): T {
    this.#present = structuredCloneValue(value);
    this.#undo = [];
    this.#redo = [];
    this.#mergeKey = undefined;
    this.#revision += 1;
    return this.value;
  }
}
