import type { Matrix4 } from "three";
import type { AdvCubismDrawState, CubismDrawableBounds, CubismParameterFrame } from "./cubism/AdvCubismModel";
import type { AdvMotionSyncCoreStatus } from "./cubism/AdvMotionSyncCore";

/**
 * Render-backend contract for every world-space story character.
 *
 * Cubism 2, Cubism 3 and static portraits all draw into the same character
 * framebuffer with the same camera MVP. Animation methods are capabilities:
 * non-animated backends implement them as stable no-ops.
 */
export interface StoryCharacterModel {
  readonly format: "cubism3" | "cubism2" | "static-portrait";
  readonly modelUrl: string;
  readonly pixelsPerUnit: number;
  /** False once the backend can only silently no-op update/draw calls. */
  readonly isOperational: boolean;
  /** Monotonically advances after the backend commits one model update. */
  readonly updateSerial: number;
  /** Monotonically advances after the backend submits one model draw. */
  readonly drawSerial: number;
  readonly isMotionPlaying: boolean;
  readonly motionSyncStatus: AdvMotionSyncCoreStatus | "unconfigured";

  setPaused(paused: boolean): void;
  setMotionSpeed(speed: number): void;
  setEyeBlinkEnabled(enabled: boolean): void;
  resetExpressionParametersToDefault(): void;
  hasMotion(name: string): boolean;
  stopMotions(): void;
  drawableBounds(visibleOnly?: boolean): CubismDrawableBounds | null;
  canvasBounds(): CubismDrawableBounds;
  resetMotionSync(): void;

  playMotion(name: string, fadeInSeconds?: number): boolean;
  playExpression(name: string, fadeInSeconds?: number): boolean;
  prepareMotion(name: string): Promise<boolean>;
  prepareExpression(name: string): Promise<boolean>;
  isCurrentExpression(name: string): boolean;
  refreshCurrentExpressionFadeIn(name: string, fadeInSeconds?: number): void;
  primeInitialFrame(frame: CubismParameterFrame): void;
  setParameter(id: string, value: number, weight?: number): void;
  parameterRange(id: string): { minimum: number; maximum: number } | null;

  eyeBallPosition(): { x: number; y: number };
  setEyeBallPosition(x: number, y: number): void;
  forceEyeBallPosition(x: number, y: number): void;

  update(deltaSeconds: number, frame: CubismParameterFrame): void;
  draw(
    mvp: Matrix4,
    framebuffer: WebGLFramebuffer | null,
    viewport: readonly [number, number, number, number],
    color: readonly [number, number, number, number],
    drawState?: AdvCubismDrawState,
  ): void;

  release(): void;
}
