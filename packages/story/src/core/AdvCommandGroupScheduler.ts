import type { AdvCommand, AdvCommandGroup, AdvCommandGroupAction } from "../types/AdvRuntime";
import { resolveAdvCommandGroup, sortAdvCommandGroupActions } from "./AdvCommandGroup";

export interface AdvCommandGroupSchedulerOptions {
  execute: (command: AdvCommand, signal: AbortSignal) => Promise<void> | void;
  delay: (seconds: number, signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
}

interface AdvCommandGroupEventOwner {
  readonly controller: AbortController;
  readonly parent: AdvCommandGroupOwner;
  done: Promise<void>;
}

interface AdvCommandGroupPendingEvent {
  readonly controller: AbortController;
  triggered: boolean;
}

interface AdvCommandGroupOwner {
  readonly controller: AbortController;
  readonly cancelOnManualAdvance: boolean;
  readonly pendingEvents: Set<AdvCommandGroupPendingEvent>;
  runningEvents: number;
  active: boolean;
  done: Promise<void>;
}

function linkedAbortController(parent?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (!parent) return controller;
  if (parent.aborted) {
    controller.abort();
    return controller;
  }
  const abort = (): void => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  controller.signal.addEventListener("abort", () => parent.removeEventListener("abort", abort), { once: true });
  if (parent.aborted) controller.abort();
  return controller;
}

async function waitForTasks(tasks: readonly Promise<void>[], signal?: AbortSignal): Promise<void> {
  if (!tasks.length || signal?.aborted) return;
  if (!signal) {
    await Promise.all(tasks);
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void Promise.all(tasks).then(finish, finish);
    if (signal.aborted) finish();
  });
}

/** Runtime scheduler for source-neutral concurrent command groups. */
export class AdvCommandGroupScheduler {
  private readonly execute: AdvCommandGroupSchedulerOptions["execute"];
  private readonly delay: AdvCommandGroupSchedulerOptions["delay"];
  private readonly onError?: AdvCommandGroupSchedulerOptions["onError"];
  private readonly active = new Set<AdvCommandGroupOwner>();
  private readonly runningEvents = new Set<AdvCommandGroupEventOwner>();
  private generation = 0;

  constructor(options: AdvCommandGroupSchedulerOptions) {
    this.execute = options.execute;
    this.delay = options.delay;
    this.onError = options.onError;
  }

  get hasActive(): boolean {
    return this.active.size > 0;
  }

  get hasPendingWork(): boolean {
    return this.active.size > 0 || this.runningEvents.size > 0;
  }

  /** Admit a group and return after it starts; its lifetime continues asynchronously. */
  async admit(value: AdvCommandGroup | null | undefined, signal?: AbortSignal): Promise<void> {
    const group = resolveAdvCommandGroup(value);
    if (!group || signal?.aborted) return;
    const generation = this.generation;
    if (group.waitForPrevious) await this.waitForIdle(signal);
    if (signal?.aborted || generation !== this.generation) return;

    const owner = this.createOwner(group, signal);
    owner.done = this.runGroup(owner, group).finally(() => this.finishOwner(owner));
    void owner.done;
  }

  /** Execute a group's actions immediately in stable chronological order. */
  async admitImmediate(value: AdvCommandGroup | null | undefined, signal?: AbortSignal): Promise<void> {
    const group = resolveAdvCommandGroup(value);
    if (!group || signal?.aborted) return;
    const generation = this.generation;
    if (group.waitForPrevious) await this.waitForIdle(signal);
    if (signal?.aborted || generation !== this.generation) return;

    const owner = this.createOwner(group, signal);
    owner.done = this.runImmediate(owner, group).finally(() => this.finishOwner(owner));
    await owner.done;
  }

  async waitForIdle(signal?: AbortSignal): Promise<void> {
    while (this.active.size && !signal?.aborted) {
      await waitForTasks(
        [...this.active].map((owner) => owner.done),
        signal,
      );
    }
  }

  async waitForSettled(signal?: AbortSignal): Promise<void> {
    while (this.hasPendingWork && !signal?.aborted) {
      await waitForTasks(
        [...this.active].map((owner) => owner.done).concat([...this.runningEvents].map((owner) => owner.done)),
        signal,
      );
    }
  }

  cancelAll(): void {
    this.generation += 1;
    for (const owner of this.active) owner.controller.abort();
    for (const event of this.runningEvents) event.controller.abort();
  }

  /** Broadcast an explicit user advance to groups that opt into cancellation. */
  requestManualAdvance(): void {
    for (const owner of this.active) {
      if (owner.cancelOnManualAdvance) owner.controller.abort();
    }
  }

  private createOwner(group: AdvCommandGroup, signal?: AbortSignal): AdvCommandGroupOwner {
    const owner: AdvCommandGroupOwner = {
      controller: linkedAbortController(signal),
      cancelOnManualAdvance: group.cancelOnManualAdvance,
      pendingEvents: new Set(),
      runningEvents: 0,
      active: true,
      done: Promise.resolve(),
    };
    this.active.add(owner);
    return owner;
  }

  private finishOwner(owner: AdvCommandGroupOwner): void {
    owner.active = false;
    this.active.delete(owner);
    this.releaseOwnerWhenSettled(owner);
  }

  private async runGroup(owner: AdvCommandGroupOwner, group: AdvCommandGroup): Promise<void> {
    const actions = sortAdvCommandGroupActions(group.actions);
    for (const action of actions) {
      if (action.role === "event") this.scheduleEvent(owner, action);
    }
    const durationController = linkedAbortController(owner.controller.signal);
    const lifetimeTasks = actions
      .filter((action) => action.role === "lifetime")
      .map((action) => this.runLifetimeAction(owner, action));
    try {
      await Promise.all([this.delay(group.durationSeconds, durationController.signal), ...lifetimeTasks]);
    } catch (error) {
      this.report(error);
    } finally {
      durationController.abort();
      for (const event of owner.pendingEvents) {
        if (!event.triggered) event.controller.abort();
      }
      owner.pendingEvents.clear();
    }
  }

  private async runImmediate(owner: AdvCommandGroupOwner, group: AdvCommandGroup): Promise<void> {
    for (const action of sortAdvCommandGroupActions(group.actions)) {
      if (owner.controller.signal.aborted) break;
      try {
        await this.execute(action.command, owner.controller.signal);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private async runLifetimeAction(owner: AdvCommandGroupOwner, action: AdvCommandGroupAction): Promise<void> {
    const controller = linkedAbortController(owner.controller.signal);
    try {
      if (action.atSeconds > 0) await this.delay(action.atSeconds, controller.signal);
      if (!controller.signal.aborted) await this.execute(action.command, controller.signal);
    } catch (error) {
      this.report(error);
    } finally {
      controller.abort();
    }
  }

  private scheduleEvent(owner: AdvCommandGroupOwner, action: AdvCommandGroupAction): void {
    const pending: AdvCommandGroupPendingEvent = {
      controller: linkedAbortController(owner.controller.signal),
      triggered: false,
    };
    owner.pendingEvents.add(pending);
    const schedule = async (): Promise<void> => {
      try {
        if (action.atSeconds > 0) await this.delay(action.atSeconds, pending.controller.signal);
        if (pending.controller.signal.aborted || !owner.active) return;
        pending.triggered = true;
        owner.pendingEvents.delete(pending);
        this.startEvent(owner, action.command);
      } catch (error) {
        this.report(error);
      } finally {
        pending.controller.abort();
        owner.pendingEvents.delete(pending);
      }
    };
    void schedule();
  }

  private startEvent(owner: AdvCommandGroupOwner, command: AdvCommand): void {
    const controller = linkedAbortController(owner.controller.signal);
    owner.runningEvents += 1;
    const event: AdvCommandGroupEventOwner = { controller, parent: owner, done: Promise.resolve() };
    this.runningEvents.add(event);
    event.done = Promise.resolve()
      .then(() => this.execute(command, controller.signal))
      .then(
        () => undefined,
        (error) => this.report(error),
      )
      .finally(() => {
        controller.abort();
        this.runningEvents.delete(event);
        owner.runningEvents = Math.max(0, owner.runningEvents - 1);
        this.releaseOwnerWhenSettled(owner);
      });
  }

  private releaseOwnerWhenSettled(owner: AdvCommandGroupOwner): void {
    if (!owner.active && owner.runningEvents === 0) owner.controller.abort();
  }

  private report(error: unknown): void {
    this.onError?.(error);
  }
}
