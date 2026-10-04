export interface ReactionState {
  active: boolean;
  likeCount: number;
}

export interface ReactionBinding {
  current(): boolean;
  send(active: boolean, signal: AbortSignal): Promise<ReactionState>;
  apply(state: ReactionState): void;
  reject(error: unknown): void;
  terminal(error: unknown): boolean;
}

interface ReactionIntent {
  confirmed: ReactionState;
  desired: boolean;
  revision: number;
  running: boolean;
  order: number;
  controller: AbortController;
  binding: ReactionBinding;
}

/** One serial, coalescing writer for each target; presentation updates immediately. */
export class CommunityReactions {
  private sequence = 0;
  private readonly intents = new Map<string, ReactionIntent>();

  toggle(key: string, state: ReactionState, binding: ReactionBinding): void {
    if (!binding.current()) return;
    let intent = this.intents.get(key);
    if (intent && (!intent.binding.current() || intent.controller.signal.aborted)) {
      intent.controller.abort();
      this.intents.delete(key);
      intent = undefined;
    }
    if (!intent) {
      intent = {
        confirmed: this.valid(state),
        desired: state.active,
        revision: 0,
        running: false,
        order: 0,
        controller: new AbortController(),
        binding,
      };
      this.intents.set(key, intent);
    } else if (!intent.running) {
      intent.confirmed = this.valid(state);
      intent.desired = state.active;
      intent.binding = binding;
    }
    intent.desired = !intent.desired;
    ++intent.revision;
    intent.order = ++this.sequence;
    this.project(intent);
    if (intent.running) return;
    intent.running = true;
    queueMicrotask(() => void this.drain(key, intent!));
  }

  mark(): number {
    return this.sequence;
  }

  forget(key: string): void {
    this.intents.get(key)?.controller.abort();
    this.intents.delete(key);
  }

  merge(key: string, state: ReactionState, since: number): ReactionState {
    const snapshot = this.valid(state);
    const intent = this.intents.get(key);
    if (!intent || !this.current(key, intent)) return snapshot;
    if (intent.running || intent.order > since) return this.projection(intent);
    intent.confirmed = snapshot;
    intent.desired = snapshot.active;
    return snapshot;
  }

  clear(): void {
    ++this.sequence;
    for (const intent of this.intents.values()) {
      if (intent.binding.current()) intent.binding.apply(intent.confirmed);
      intent.controller.abort();
    }
    this.intents.clear();
  }

  private valid(state: ReactionState): ReactionState {
    if (typeof state.active !== "boolean" || !Number.isSafeInteger(state.likeCount) || state.likeCount < 0)
      throw new Error("Invalid reaction response");
    return { active: state.active, likeCount: state.likeCount };
  }

  private current(key: string, intent: ReactionIntent): boolean {
    return this.intents.get(key) === intent && !intent.controller.signal.aborted && intent.binding.current();
  }

  private projection(intent: ReactionIntent): ReactionState {
    return {
      active: intent.desired,
      likeCount: Math.max(0, intent.confirmed.likeCount + Number(intent.desired) - Number(intent.confirmed.active)),
    };
  }

  private project(intent: ReactionIntent): void {
    if (!intent.binding.current() || intent.controller.signal.aborted) return;
    intent.binding.apply(this.projection(intent));
  }

  private async drain(key: string, intent: ReactionIntent): Promise<void> {
    let force = false;
    try {
      while (this.current(key, intent) && (force || intent.desired !== intent.confirmed.active)) {
        force = false;
        const desired = intent.desired;
        const revision = intent.revision;
        try {
          const result = this.valid(await intent.binding.send(desired, intent.controller.signal));
          if (!this.current(key, intent)) return;
          intent.confirmed = result;
          this.project(intent);
          // A mismatching successful response still cannot satisfy this intent.
          if (intent.revision === revision && result.active !== desired)
            throw new Error("Reaction state was not saved");
        } catch (error) {
          if (!this.current(key, intent)) return;
          if (intent.binding.terminal(error) || intent.revision === revision) {
            intent.desired = intent.confirmed.active;
            this.project(intent);
            intent.binding.reject(error);
            return;
          }
          // An obsolete failure has an unknown server outcome; send the newest intent once.
          force = true;
        }
      }
    } finally {
      intent.running = false;
      if (this.intents.get(key) === intent && !this.current(key, intent)) this.intents.delete(key);
    }
  }
}
