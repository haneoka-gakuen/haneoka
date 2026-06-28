export interface PendingCharacterMotion {
  readonly name: string;
  readonly fadeInSeconds?: number;
}

export interface PendingCharacterExpression {
  readonly name: string;
  readonly fadeInSeconds?: number;
}

export interface PendingCharacterLipSync {
  readonly source: "voice" | "timed";
  readonly timedMode?: "oscillating" | "hold-open";
  readonly holdOpenLevel?: number;
  readonly sources?: readonly unknown[];
  readonly voiceSpeed?: number;
  readonly voiceMultiplier?: number;
  readonly voiceExpiresAtSeconds?: number;
  readonly durationSeconds: number;
  readonly speed: number;
  readonly multiplier: number;
  readonly queuedAtSeconds: number;
}

export interface PendingCharacterLookEvent {
  readonly kind: "set" | "stop";
  readonly x: number;
  readonly y: number;
  readonly durationSeconds: number;
  readonly queuedAtSeconds: number;
}

export interface PendingCharacterAngleEvent {
  readonly angle: number;
  readonly bodyAngle: number;
  readonly durationSeconds: number;
  readonly queuedAtSeconds: number;
}

export interface PendingCharacterBrightness {
  readonly route: "renderer" | "direct";
  readonly positionType?: number;
  readonly value: number;
  readonly durationSeconds: number;
  readonly queuedAtSeconds: number;
}

export interface PendingCharacterAlphaEvent {
  readonly operationId: number;
  readonly from: number;
  readonly value: number;
  readonly durationSeconds: number;
  readonly queuedAtSeconds: number;
  readonly startedAtSeconds: number | null;
}

export interface PendingCharacterRimLightEvent {
  readonly color: { readonly r: number; readonly g: number; readonly b: number; readonly a: number };
  readonly shadowIntensity: number;
}

export interface PendingCharacterDoFSet {
  readonly kind: "set";
  readonly intensity: number;
  readonly durationSeconds: number;
  readonly ease: unknown;
  readonly queuedAtSeconds: number;
}

export interface PendingCharacterDoFCancel {
  readonly kind: "cancel";
  readonly queuedAtSeconds: number;
}

export type PendingCharacterDoF = PendingCharacterDoFSet | PendingCharacterDoFCancel;

export interface PendingCharacterPauseEvent {
  readonly paused: boolean;
  readonly queuedAtSeconds: number;
}

export interface PendingCharacterPresentation {
  readonly motion?: PendingCharacterMotion;
  readonly expression?: PendingCharacterExpression;
  readonly activeMotion?: PendingCharacterMotion;
  readonly activeExpression?: PendingCharacterExpression;
  readonly lipSync?: PendingCharacterLipSync;
  readonly lookEvents?: readonly PendingCharacterLookEvent[];
  readonly angleEvents?: readonly PendingCharacterAngleEvent[];
  readonly lookOverridePrepared?: boolean;
  readonly angleOverridePrepared?: boolean;
  readonly motionQueuedWhilePaused?: boolean;
  readonly expressionQueuedWhilePaused?: boolean;
  readonly brightnessEvents?: readonly PendingCharacterBrightness[];
  readonly alphaEvents?: readonly PendingCharacterAlphaEvent[];
  readonly rimLightEvents?: readonly PendingCharacterRimLightEvent[];
  readonly dofEvents?: readonly PendingCharacterDoF[];
  readonly pauseEvents?: readonly PendingCharacterPauseEvent[];
  readonly paused?: boolean;
  readonly currentExpressionName?: string;
  readonly currentExpressionFadeInSeconds?: number;
}

export interface PendingCharacterLoad extends PendingCharacterPresentation {
  readonly token: number;
}

export interface PendingCharacterCommandsSnapshot {
  readonly loads: readonly (readonly [string, PendingCharacterLoad])[];
}

export interface PendingCharacterResourceChange {
  readonly revision: number;
  readonly changed: Promise<void>;
}

interface PendingCharacterResourceChangeState extends PendingCharacterResourceChange {
  readonly token: number;
  readonly controller: AbortController;
}

/**
 * Retains presentation commands issued between CharacterIn and completion of
 * the browser's asynchronous model load. This is a Web compatibility adapter,
 * not a native character-loading state: the reference runtime preloads
 * controllers through LoadCharacter, and CharacterIn synchronously reaches
 * Show/position/reset before its no-wait task detaches.
 *
 * The latest command per motion/expression channel therefore has to win just
 * as it does under native synchronous dispatch. Live2DCharacter's separate
 * pause/resume pending slots for PlayMotion and PlayExpression provide the
 * same single-channel overwrite semantics, but are not themselves used by the
 * reference runtime as a lazy-load queue.
 */
export class PendingCharacterCommands {
  private readonly loads = new Map<string, PendingCharacterLoad>();
  private readonly resourceChanges = new Map<string, PendingCharacterResourceChangeState>();

  begin(target: string, token: number, currentExpressionName = ""): void {
    this.resourceChanges.get(target)?.controller.abort();
    this.loads.set(target, { token, currentExpressionName });
    this.resourceChanges.set(target, this.createResourceChangeState(token, 0));
  }

  invalidate(target: string): void {
    this.loads.delete(target);
    this.resourceChanges.get(target)?.controller.abort();
    this.resourceChanges.delete(target);
  }

  clear(): void {
    this.loads.clear();
    for (const state of this.resourceChanges.values()) state.controller.abort();
    this.resourceChanges.clear();
  }

  get hasPendingLoads(): boolean {
    return this.loads.size > 0;
  }

  createSnapshot(): PendingCharacterCommandsSnapshot {
    return {
      loads: [...this.loads.entries()].map(([target, pending]) => [
        target,
        {
          ...pending,
          ...(pending.motion ? { motion: { ...pending.motion } } : {}),
          ...(pending.expression ? { expression: { ...pending.expression } } : {}),
          ...(pending.activeMotion ? { activeMotion: { ...pending.activeMotion } } : {}),
          ...(pending.activeExpression ? { activeExpression: { ...pending.activeExpression } } : {}),
          ...(pending.lipSync
            ? {
                lipSync: {
                  ...pending.lipSync,
                  ...(pending.lipSync.sources ? { sources: [...pending.lipSync.sources] } : {}),
                },
              }
            : {}),
          ...(pending.lookEvents ? { lookEvents: pending.lookEvents.map((event) => ({ ...event })) } : {}),
          ...(pending.angleEvents ? { angleEvents: pending.angleEvents.map((event) => ({ ...event })) } : {}),
          ...(pending.brightnessEvents
            ? { brightnessEvents: pending.brightnessEvents.map((event) => ({ ...event })) }
            : {}),
          ...(pending.alphaEvents ? { alphaEvents: pending.alphaEvents.map((event) => ({ ...event })) } : {}),
          ...(pending.rimLightEvents
            ? {
                rimLightEvents: pending.rimLightEvents.map((event) => ({
                  ...event,
                  color: { ...event.color },
                })),
              }
            : {}),
          ...(pending.dofEvents ? { dofEvents: pending.dofEvents.map((event) => ({ ...event })) } : {}),
          ...(pending.pauseEvents ? { pauseEvents: pending.pauseEvents.map((event) => ({ ...event })) } : {}),
        },
      ]),
    };
  }

  restoreSnapshot(snapshot: PendingCharacterCommandsSnapshot): void {
    this.clear();
    for (const [target, pending] of snapshot.loads || []) {
      this.loads.set(target, {
        ...pending,
        ...(pending.motion ? { motion: { ...pending.motion } } : {}),
        ...(pending.expression ? { expression: { ...pending.expression } } : {}),
        ...(pending.activeMotion ? { activeMotion: { ...pending.activeMotion } } : {}),
        ...(pending.activeExpression ? { activeExpression: { ...pending.activeExpression } } : {}),
        ...(pending.lipSync
          ? {
              lipSync: {
                ...pending.lipSync,
                ...(pending.lipSync.sources ? { sources: [...pending.lipSync.sources] } : {}),
              },
            }
          : {}),
        ...(pending.lookEvents ? { lookEvents: pending.lookEvents.map((event) => ({ ...event })) } : {}),
        ...(pending.angleEvents ? { angleEvents: pending.angleEvents.map((event) => ({ ...event })) } : {}),
        ...(pending.brightnessEvents
          ? { brightnessEvents: pending.brightnessEvents.map((event) => ({ ...event })) }
          : {}),
        ...(pending.alphaEvents ? { alphaEvents: pending.alphaEvents.map((event) => ({ ...event })) } : {}),
        ...(pending.rimLightEvents
          ? {
              rimLightEvents: pending.rimLightEvents.map((event) => ({
                ...event,
                color: { ...event.color },
              })),
            }
          : {}),
        ...(pending.dofEvents ? { dofEvents: pending.dofEvents.map((event) => ({ ...event })) } : {}),
        ...(pending.pauseEvents ? { pauseEvents: pending.pauseEvents.map((event) => ({ ...event })) } : {}),
      });
      this.resourceChanges.set(target, this.createResourceChangeState(pending.token, 0));
    }
  }

  queueMotion(target: string, token: number, motion: PendingCharacterMotion): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    this.loads.set(target, {
      ...pending,
      motion,
      ...(pending.paused
        ? { motionQueuedWhilePaused: true }
        : { activeMotion: motion, motionQueuedWhilePaused: false }),
    });
    this.signalResourceChange(target, token);
    return true;
  }

  queueExpression(target: string, token: number, expression: PendingCharacterExpression): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    if (expression.name && pending.currentExpressionName === expression.name) {
      this.loads.set(target, {
        ...pending,
        currentExpressionFadeInSeconds: expression.fadeInSeconds,
      });
      return true;
    }
    this.loads.set(target, {
      ...pending,
      expression,
      currentExpressionName: expression.name,
      currentExpressionFadeInSeconds: expression.fadeInSeconds,
      ...(pending.paused
        ? { expressionQueuedWhilePaused: true }
        : { activeExpression: expression, expressionQueuedWhilePaused: false }),
    });
    this.signalResourceChange(target, token);
    return true;
  }

  queueLipSync(target: string, token: number, lipSync: PendingCharacterLipSync): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    const previous = pending.lipSync;
    const retainedVoiceSources = lipSync.source === "timed" ? previous?.sources : undefined;
    const retainedVoiceState =
      lipSync.source === "timed" && retainedVoiceSources?.length
        ? {
            voiceSpeed: previous?.voiceSpeed ?? previous?.speed ?? 1,
            voiceMultiplier: previous?.voiceMultiplier ?? previous?.multiplier ?? 1,
            voiceExpiresAtSeconds: previous?.voiceExpiresAtSeconds ?? 0,
          }
        : {};
    this.loads.set(target, {
      ...pending,
      lipSync: retainedVoiceSources?.length
        ? { ...lipSync, ...retainedVoiceState, sources: retainedVoiceSources }
        : lipSync,
    });
    return true;
  }

  queueLook(target: string, token: number, event: PendingCharacterLookEvent): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    this.loads.set(target, {
      ...pending,
      lookEvents: [...(pending.lookEvents || []), event],
    });
    return true;
  }

  queueAngle(target: string, token: number, event: PendingCharacterAngleEvent): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    this.loads.set(target, {
      ...pending,
      angleEvents: [...(pending.angleEvents || []), event],
    });
    return true;
  }

  queueLookOverridePreparation(target: string, token: number): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    this.loads.set(target, { ...pending, lookOverridePrepared: true });
    return true;
  }

  queueAngleOverridePreparation(target: string, token: number): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    this.loads.set(target, { ...pending, angleOverridePrepared: true });
    return true;
  }

  queueBrightness(target: string, token: number, brightness: PendingCharacterBrightness): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    this.loads.set(target, {
      ...pending,
      brightnessEvents: [...(pending.brightnessEvents || []), brightness],
    });
    return true;
  }

  queueAlpha(
    target: string,
    token: number,
    alpha: Omit<PendingCharacterAlphaEvent, "from">,
    baseline: number,
  ): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    const previous = pending.alphaEvents?.at(-1);
    let from = Math.max(0, Math.min(1, Number(baseline) || 0));
    if (previous) {
      from = previous.from;
      if (previous.startedAtSeconds != null) {
        const duration = Math.max(0, previous.durationSeconds);
        const progress =
          duration <= 0 ? 1 : Math.max(0, Math.min(1, (alpha.queuedAtSeconds - previous.startedAtSeconds) / duration));
        from += (Math.max(0, Math.min(1, previous.value)) - from) * progress;
      }
    }
    this.loads.set(target, {
      ...pending,
      alphaEvents: [...(pending.alphaEvents || []), { ...alpha, from }],
    });
    return true;
  }

  markAlphaStarted(target: string, token: number, operationId: number, startedAtSeconds: number): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token || !pending.alphaEvents?.length) return false;
    const index = pending.alphaEvents.findIndex((event) => event.operationId === operationId);
    if (index < 0) return false;
    const alphaEvents = pending.alphaEvents.map((event, eventIndex) =>
      eventIndex === index ? { ...event, startedAtSeconds } : event,
    );
    this.loads.set(target, { ...pending, alphaEvents });
    return true;
  }

  queueRimLight(target: string, token: number, rimLight: PendingCharacterRimLightEvent): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    this.loads.set(target, {
      ...pending,
      rimLightEvents: [...(pending.rimLightEvents || []), rimLight],
    });
    return true;
  }

  queueDoF(target: string, token: number, dof: PendingCharacterDoF): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    this.loads.set(target, {
      ...pending,
      dofEvents: [...(pending.dofEvents || []), dof],
    });
    return true;
  }

  queueDoFCancel(target: string, token: number, queuedAtSeconds: number): boolean {
    return this.queueDoF(target, token, { kind: "cancel", queuedAtSeconds });
  }

  queuePaused(target: string, token: number, paused: boolean, queuedAtSeconds: number): boolean {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return false;
    this.loads.set(target, {
      ...pending,
      paused,
      pauseEvents: [...(pending.pauseEvents || []), { paused, queuedAtSeconds }],
      // Resume dispatches both single pending slots immediately. If another
      // Pause arrives before the browser model is ready, they are now active
      // requests that should be primed before that later Pause.
      ...(paused
        ? {}
        : {
            ...(pending.motionQueuedWhilePaused && pending.motion ? { activeMotion: pending.motion } : {}),
            ...(pending.expressionQueuedWhilePaused && pending.expression
              ? { activeExpression: pending.expression }
              : {}),
            motionQueuedWhilePaused: false,
            expressionQueuedWhilePaused: false,
          }),
    });
    this.signalResourceChange(target, token);
    return true;
  }

  observeResourceChange(target: string, token: number): PendingCharacterResourceChange | null {
    const state = this.resourceChanges.get(target);
    if (!state || state.token !== token) return null;
    return { revision: state.revision, changed: state.changed };
  }

  clearLipSync(target: string, token?: number): boolean {
    const pending = this.loads.get(target);
    if (!pending || (token != null && pending.token !== token) || !pending.lipSync) return false;
    const { lipSync: _lipSync, ...rest } = pending;
    this.loads.set(target, rest);
    return true;
  }

  clearAllLipSync(): void {
    for (const [target, pending] of this.loads) {
      if (!pending.lipSync) continue;
      const { lipSync: _lipSync, ...rest } = pending;
      this.loads.set(target, rest);
    }
  }

  clearTimedLipSync(target: string, token?: number): boolean {
    const pending = this.loads.get(target);
    if (!pending || (token != null && pending.token !== token) || pending.lipSync?.source !== "timed") {
      return false;
    }
    const lipSync = pending.lipSync;
    if (lipSync.sources?.length) {
      this.loads.set(target, {
        ...pending,
        lipSync: {
          source: "voice",
          sources: lipSync.sources,
          voiceSpeed: lipSync.voiceSpeed,
          voiceMultiplier: lipSync.voiceMultiplier,
          voiceExpiresAtSeconds: lipSync.voiceExpiresAtSeconds,
          durationSeconds: 0,
          speed: lipSync.voiceSpeed ?? 1,
          multiplier: lipSync.voiceMultiplier ?? 1,
          queuedAtSeconds: lipSync.queuedAtSeconds,
        },
      });
    } else {
      const { lipSync: _lipSync, ...rest } = pending;
      this.loads.set(target, rest);
    }
    return true;
  }

  clearAllTimedLipSync(): void {
    for (const [target, pending] of this.loads) {
      if (pending.lipSync?.source !== "timed") continue;
      const lipSync = pending.lipSync;
      if (lipSync.sources?.length) {
        this.loads.set(target, {
          ...pending,
          lipSync: {
            source: "voice",
            sources: lipSync.sources,
            voiceSpeed: lipSync.voiceSpeed,
            voiceMultiplier: lipSync.voiceMultiplier,
            voiceExpiresAtSeconds: lipSync.voiceExpiresAtSeconds,
            durationSeconds: 0,
            speed: lipSync.voiceSpeed ?? 1,
            multiplier: lipSync.voiceMultiplier ?? 1,
            queuedAtSeconds: lipSync.queuedAtSeconds,
          },
        });
      } else {
        const { lipSync: _lipSync, ...rest } = pending;
        this.loads.set(target, rest);
      }
    }
  }

  /**
   * Read the latest presentation without consuming its load slot. Character
   * construction uses this to prepare lazy Cubism resources while subsequent
   * no-wait ADV commands remain free to replace the pending values.
   */
  peek(target: string, token: number): PendingCharacterPresentation | null {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return null;
    const {
      motion,
      expression,
      activeMotion,
      activeExpression,
      lipSync,
      lookEvents,
      angleEvents,
      lookOverridePrepared,
      angleOverridePrepared,
      motionQueuedWhilePaused,
      expressionQueuedWhilePaused,
      brightnessEvents,
      alphaEvents,
      rimLightEvents,
      dofEvents,
      pauseEvents,
      paused,
      currentExpressionName,
      currentExpressionFadeInSeconds,
    } = pending;
    return {
      ...(motion ? { motion } : {}),
      ...(expression ? { expression } : {}),
      ...(activeMotion ? { activeMotion } : {}),
      ...(activeExpression ? { activeExpression } : {}),
      ...(lipSync ? { lipSync } : {}),
      ...(lookEvents ? { lookEvents } : {}),
      ...(angleEvents ? { angleEvents } : {}),
      ...(lookOverridePrepared ? { lookOverridePrepared: true } : {}),
      ...(angleOverridePrepared ? { angleOverridePrepared: true } : {}),
      ...(motionQueuedWhilePaused ? { motionQueuedWhilePaused: true } : {}),
      ...(expressionQueuedWhilePaused ? { expressionQueuedWhilePaused: true } : {}),
      ...(brightnessEvents ? { brightnessEvents } : {}),
      ...(alphaEvents ? { alphaEvents } : {}),
      ...(rimLightEvents ? { rimLightEvents } : {}),
      ...(dofEvents ? { dofEvents } : {}),
      ...(pauseEvents ? { pauseEvents } : {}),
      ...(paused != null ? { paused } : {}),
      ...(currentExpressionName ? { currentExpressionName } : {}),
      ...(currentExpressionFadeInSeconds != null ? { currentExpressionFadeInSeconds } : {}),
    };
  }

  consume(target: string, token: number): PendingCharacterPresentation | null {
    const pending = this.loads.get(target);
    if (!pending || pending.token !== token) return null;
    this.loads.delete(target);
    this.resourceChanges.get(target)?.controller.abort();
    this.resourceChanges.delete(target);
    const {
      motion,
      expression,
      activeMotion,
      activeExpression,
      lipSync,
      lookEvents,
      angleEvents,
      lookOverridePrepared,
      angleOverridePrepared,
      motionQueuedWhilePaused,
      expressionQueuedWhilePaused,
      brightnessEvents,
      alphaEvents,
      rimLightEvents,
      dofEvents,
      pauseEvents,
      paused,
      currentExpressionName,
      currentExpressionFadeInSeconds,
    } = pending;
    return {
      ...(motion ? { motion } : {}),
      ...(expression ? { expression } : {}),
      ...(activeMotion ? { activeMotion } : {}),
      ...(activeExpression ? { activeExpression } : {}),
      ...(lipSync ? { lipSync } : {}),
      ...(lookEvents ? { lookEvents } : {}),
      ...(angleEvents ? { angleEvents } : {}),
      ...(lookOverridePrepared ? { lookOverridePrepared: true } : {}),
      ...(angleOverridePrepared ? { angleOverridePrepared: true } : {}),
      ...(motionQueuedWhilePaused ? { motionQueuedWhilePaused: true } : {}),
      ...(expressionQueuedWhilePaused ? { expressionQueuedWhilePaused: true } : {}),
      ...(brightnessEvents ? { brightnessEvents } : {}),
      ...(alphaEvents ? { alphaEvents } : {}),
      ...(rimLightEvents ? { rimLightEvents } : {}),
      ...(dofEvents ? { dofEvents } : {}),
      ...(pauseEvents ? { pauseEvents } : {}),
      ...(paused != null ? { paused } : {}),
      ...(currentExpressionName ? { currentExpressionName } : {}),
      ...(currentExpressionFadeInSeconds != null ? { currentExpressionFadeInSeconds } : {}),
    };
  }

  private createResourceChangeState(token: number, revision: number): PendingCharacterResourceChangeState {
    const controller = new AbortController();
    const changed = new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { token, revision, controller, changed };
  }

  private signalResourceChange(target: string, token: number): void {
    const current = this.resourceChanges.get(target);
    if (!current || current.token !== token) return;
    current.controller.abort();
    this.resourceChanges.set(target, this.createResourceChangeState(token, current.revision + 1));
  }
}
