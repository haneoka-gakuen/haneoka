import type { OurNotesAssetManifest } from "../assets/manifest";

export type RenderNoteKind =
  "tap" | "flick" | "flick-left" | "flick-right" | "slide-start" | "slide-node" | "slide-end" | "trace" | "guide";

export type RenderDirection = "none" | "left" | "right" | "up";

/**
 * Positions are expressed in original chart lane units. Lane 0 is the left
 * edge and the embedded charts use 24 lanes. `approach = 0` is the judgement
 * line and `approach = 1` is the spawn/horizon point.
 */
export interface RenderNote {
  id: string | number;
  kind: RenderNoteKind;
  lane: number;
  width: number;
  approach: number;
  direction?: RenderDirection;
  alpha?: number;
  scale?: number;
  critical?: boolean;
  visible?: boolean;
}

/**
 * Native pair-note line joining the centres of judged notes sharing one
 * timestamp. Coordinates are lane-edge coordinates (0..24), not note lanes.
 */
export interface RenderSimultaneousLine {
  id: string | number;
  leftCenter: number;
  rightCenter: number;
  approach: number;
  visible?: boolean;
}

export type RenderHoldKind = "long" | "slide" | "trace" | "guide";

export type RenderEasing = "linear" | "in" | "out" | "in-out" | number;

export interface RenderPathPoint {
  lane: number;
  width: number;
  approach: number;
  /** Each ribbon edge is interpolated independently, matching the native path builder. */
  leftEasing?: RenderEasing;
  rightEasing?: RenderEasing;
  /** Expansion outside the chart lane edge, expressed in 24-lane half-lane units. */
  leftLineOffset?: number;
  rightLineOffset?: number;
}

export interface RenderHold {
  id: string | number;
  kind: RenderHoldKind;
  points: ReadonlyArray<RenderPathPoint>;
  alpha?: number;
  active?: boolean;
  critical?: boolean;
  color?: string | number;
  visible?: boolean;
}

export type RenderParticleKind =
  | "tap"
  | "flick"
  | "slide"
  | "trace"
  | "spark"
  | "excellent"
  | "slide-loop"
  | "connect"
  /** Native lane_tap_blank_miss_view, distinct from note judgement effects. */
  | "lane-input-blank-miss"
  | "lane-effect-normal"
  | "lane-effect-slide"
  | "lane-effect-flick"
  | "lane-effect-flick-left"
  | "lane-effect-flick-right";

export type RenderLaneEffectKind = Extract<RenderParticleKind, `lane-${string}`>;

export function isRenderLaneEffectKind(kind: RenderParticleKind): kind is RenderLaneEffectKind {
  return (
    kind === "lane-input-blank-miss" ||
    kind === "lane-effect-normal" ||
    kind === "lane-effect-slide" ||
    kind === "lane-effect-flick" ||
    kind === "lane-effect-flick-left" ||
    kind === "lane-effect-flick-right"
  );
}

export interface RenderParticleEffect {
  id: string | number;
  kind: RenderParticleKind;
  lane: number;
  width?: number;
  approach?: number;
  /** Seconds since the effect was spawned. */
  age: number;
  /** Native Animator state; Just reuses Perfect and Miss emits no effect. */
  judgement?: RenderJudgement;
  lifetime?: number;
  intensity?: number;
  direction?: RenderDirection;
  color?: string | number;
  seed?: number;
}

export type RenderJudgement = "just" | "perfect" | "great" | "good" | "bad" | "miss";

export interface RenderSkillBanner {
  id: string | number;
  text: string;
  color?: string;
  icon?: CanvasImageSource;
  age?: number;
  lifetime?: number;
}

export interface RenderHudState {
  visible?: boolean;
  score?: number;
  scoreDelta?: number;
  combo?: number;
  /** Seconds since the current combo value was awarded. */
  comboAge?: number;
  perfectCombo?: boolean;
  life?: number;
  maxLife?: number;
  rank?: string;
  rankProgress?: number;
  rankLabels?: ReadonlyArray<string>;
  judgement?: RenderJudgement;
  judgementAge?: number;
  fastSlow?: "FAST" | "SLOW" | null;
  skills?: ReadonlyArray<RenderSkillBanner>;
  showPause?: boolean;
}

export interface RenderStageState {
  laneOpacity?: number;
  guidelineOpacity?: number;
  judgementLineOpacity?: number;
  /** 0, 4, 6, 8 or 12 are the values exposed by the original option UI. */
  guidelineCount?: number;
  backgroundBrightness?: number;
}

/** Render-only snapshot. It intentionally contains no gameplay state machine. */
export interface RenderFrame {
  time: number;
  deltaTime?: number;
  notes?: ReadonlyArray<RenderNote>;
  simultaneousLines?: ReadonlyArray<RenderSimultaneousLine>;
  holds?: ReadonlyArray<RenderHold>;
  particles?: ReadonlyArray<RenderParticleEffect>;
  hud?: RenderHudState;
  stage?: RenderStageState;
}

export interface OurNotesRendererOptions {
  canvas: HTMLCanvasElement;
  /** Optional transparent 2D overlay; keeps high-density HUD out of WebGL. */
  hudCanvas?: HTMLCanvasElement;
  assets: OurNotesAssetManifest;
  laneCount?: number;
  stageWidth?: number;
  /** Native Unity +Z coordinate; StageProjector reflects it into Three -Z. */
  judgementZ?: number;
  /** Native Unity +Z coordinate; StageProjector reflects it into Three -Z. */
  horizonZ?: number;
  spawnY?: number;
  antialias?: boolean;
  alpha?: boolean;
  pixelRatio?: number;
  backgroundColor?: string | number;
  backgroundAlpha?: number;
  maxParticleEffects?: number;
  particlesPerEffect?: number;
}

export interface OurNotesRendererStats {
  notes: number;
  holds: number;
  particleEffects: number;
  drawCalls: number;
  triangles: number;
  activeNoteVisuals: number;
  activeHoldVisuals: number;
  renderedParticles: number;
  effectRefreshed: boolean;
  cachedSpriteTextureViews: number;
  assetsReady: boolean;
  contextLost: boolean;
}
