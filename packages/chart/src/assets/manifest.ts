/**
 * Runtime asset manifest for the embedded Our Notes live skin.
 *
 * Source media uses real Unity `Assets/` paths. JSON needed by the renderer is
 * a deterministic runtime projection of the immutable bundle object archive.
 */

import { unityStringHash } from "./unityHash";

export interface SpriteMetadataRef {
  /** Unity Sprite.m_Name. */
  name: string;
  /** Decoded Unity Sprite JSON (`*.asset`). */
  metadataUrl: string;
}

export interface SpriteAtlasManifest {
  id: string;
  textureUrl: string;
  atlasMetadataUrl: string;
  sprites: ReadonlyArray<SpriteMetadataRef>;
}

export interface LaneAssetManifest {
  baseTextureUrl: string;
  materialBaseTextureUrl: string;
  tapAreaTextureUrl: string;
  outsideLineTextureUrl: string;
  referenceImageUrl: string;
}

export interface ParticleAssetManifest {
  starTextureUrl: string;
  longStarTextureUrl: string;
  tapLineTextureUrl: string;
  tapPillarTextureUrl: string;
  wallTextureUrl: string;
  wallSideTextureUrl: string;
  centerPillarTextureUrl: string;
  centerPillar02TextureUrl: string;
  slideLineTextureUrl: string;
  /** Layer-25 LiveLaneEffectView assets, separate from HDR note effects. */
  laneEffects: Readonly<Record<LaneEffectAssetKey, LaneEffectParticleAssetRef>>;
  effect001RootUrl: string;
  effect001Prefabs: Readonly<Record<keyof typeof EFFECT001_PREFAB_IDS, Effect001PrefabAssetRef>>;
  /** LiveNoteEffectAssetSettings prefab slots. */
  effect001PrefabIds: typeof EFFECT001_PREFAB_IDS;
}

export type LaneEffectAssetKey = "inVain" | "normal" | "slide" | "flick" | "flickLeft" | "flickRight";

/** Lane effects are a separate native pipeline from note judgement effects. */
export interface LaneEffectParticleAssetRef {
  textureUrl: string;
  particleSystemMetadataUrl: string;
  /** Effective real-time lifetime: startLifetime / ParticleSystem.simulationSpeed. */
  lifetime: number;
}

export type Effect001TextureKey = "star" | "longStar" | "centerPillar" | "centerPillar02" | "wall";
export type Effect001AnimationJudgement = "perfect" | "great" | "good" | "bad";

/** A visible ParticleSystem component in an effect001 prefab. */
export interface Effect001ParticleSystemAssetRef {
  /** Unity GameObject name; component filenames alone have no semantic ordering. */
  name: string;
  /** Animator-relative GameObject path used to respect authored active windows. */
  animationPath?: string;
  metadataUrl: string;
  texture: Effect001TextureKey;
  localPosition: readonly [number, number, number];
  localScale?: readonly [number, number, number];
  /** Raw Unity Transform X rotation in radians; conversion happens in the renderer. */
  localRotationX?: number;
  /** LiveNoteEffectAsset.TransformScaleXSetRangeParam inherited from this system's parent. */
  widthScaleRange?: readonly [number, number];
  /** LiveGameNoteEffectBase.SetWidth shape-scale offset, when this system is in that serialized list. */
  shapeWidthOffset?: number;
  /** ParticleSystemRenderer.m_Pivot, in native particle-size units. */
  rendererPivot?: readonly [number, number, number];
  /**
   * ParticleSystemRenderer.m_MaxParticleSize, as a fraction of viewport
   * height. Chart applies this only to native billboard particle systems.
   */
  rendererMaxParticleSize: number;
  /** The source system uses the effect.bundle wall mesh instead of a billboard. */
  renderer?: "billboard" | "wallMesh";
}

export type Effect001SpriteName = "frame" | "pillar01" | "pillar02" | "pillar03" | "pillar04";

/** Static SpriteRenderer values copied from the prefab; its alpha/active/width animation is loaded separately. */
export interface Effect001SpriteAssetRef {
  name: Effect001SpriteName;
  metadataUrl: string;
  baseActive: boolean;
  baseColor: readonly [number, number, number, number];
  baseSize: readonly [number, number];
  /** Unity Sprite.m_Pivot normalized to the authored Sprite rect. */
  pivot: readonly [number, number];
  localPosition: readonly [number, number, number];
  /** Transform values serialized on the SpriteRenderer GameObject. */
  localScale: readonly [number, number, number];
  localRotationX: number;
  flipX?: boolean;
}

export interface Effect001PrefabAssetRef {
  id: number;
  /** note_flick_right/root Transform.m_LocalScale.x; Left remains +1. */
  rootScaleX: 1 | -1;
  loopAnimation: boolean;
  animationClipUrl: string;
  /** Animator state clips selected by LiveGameNoteEffectBase.ConvertAnimType. */
  animationClipUrls?: Readonly<Partial<Record<Effect001AnimationJudgement, string>>>;
  /** Optional independent Transform-position clip used by rate-over-distance emitters. */
  distanceEmitterAnimationClipUrl?: string;
  /** Transform binding path sampled for rate-over-distance emitter motion. */
  distanceEmitterPathHash?: number;
  particleSystems: ReadonlyArray<Effect001ParticleSystemAssetRef>;
  sprites: ReadonlyArray<Effect001SpriteAssetRef>;
}

export interface OurNotesPalette {
  lane: string;
  laneLine: string;
  outsideLine: string;
  judgementLine: string;
  tap: string;
  flick: string;
  flickLeft: string;
  flickRight: string;
  slide: string;
  trace: string;
  critical: string;
  perfect: string;
  great: string;
  good: string;
  bad: string;
  miss: string;
}

export interface HudAssetManifest {
  judgementImages: Readonly<Record<"just" | "perfect" | "great" | "good" | "bad" | "miss" | "fast" | "late", string>>;
  comboLabelUrl: string;
  comboDigitUrls: ReadonlyArray<string>;
  perfectComboLabelUrl: string;
  perfectComboDigitUrls: ReadonlyArray<string>;
  pauseIconUrl: string;
  pauseFrameUrl: string;
  pauseShadowUrl: string;
  lifeIconUrls: Readonly<Record<"normal" | "danger" | "over", string>>;
  rankIconUrls: Readonly<Record<"D" | "C" | "B" | "A" | "S" | "SS", string>>;
  rankBaseUrl: string;
  roundMask14Url: string;
  statusBaseUrl: string;
  scoreStarUrl: string;
  whiteSpriteUrl: string;
}

/** TextMesh Pro SDF source used by the native live HUD. */
export interface TmpSdfFontAssetManifest {
  atlasTextureUrl: string;
  /** Decoded TMP_FontAsset MonoBehaviour JSON. */
  metadataUrl: string;
}

export type NoteSoundAssetKey = "good" | "great" | "perfect" | "flick" | "flickDirection" | "slide" | "just" | "trace";

export interface NoteSoundAssetLayer {
  url: string;
  gain: number;
}

export type NoteSoundAsset = string | ReadonlyArray<NoteSoundAssetLayer>;

export type NoteSoundAssetManifest = Readonly<Record<NoteSoundAssetKey, NoteSoundAsset>>;

export interface OurNotesAssetManifest {
  id: string;
  source: {
    game: "BanG Dream! Our Notes";
    noteSkin: "skin001";
    laneSkin: "skin001";
    noteEffectSkin: "effect001";
  };
  noteAtlas: SpriteAtlasManifest;
  lane: LaneAssetManifest;
  particles: ParticleAssetManifest;
  hud: HudAssetManifest;
  tmpSdfFont?: TmpSdfFontAssetManifest;
  noteSounds: NoteSoundAssetManifest;
  palette: OurNotesPalette;
  /** NoteSkinAssetUnit tilt thresholds, measured in lane units. */
  tiltThresholds: ReadonlyArray<{ distance: number; value: number }>;
}

/** Exact build-specific media URLs resolved from Unity source descriptors. */
export interface OurNotesRuntimeMediaManifest {
  noteAtlasTextureUrl: string;
  fontAtlasTextureUrl?: string;
  hud: HudAssetManifest;
}

/**
 * Coordinate and camera constants for LiveGameCamera/LiveGameLane. Unity uses
 * twelve 1.5933333-unit lanes while charts address each half lane, hence the
 * 24-lane render API.
 */
export const OUR_NOTES_LIVE_GEOMETRY = {
  cameraPosition: [0, 10, 0] as const,
  // Quaternion (x=.2554833591,w=.9668134451) from LiveGameCamera.asset.
  cameraXDegrees: 29.60445665468814,
  cameraFovDegrees: 54,
  cameraNear: 0.1,
  cameraFar: 5000,
  physicalLaneCount: 12,
  chartLaneCount: 24,
  laneUnit: 1.5933333,
  laneWidth: 19.12000084,
  laneLength: 217.6000061,
  laneSpaceLineLength: 1.3,
  // LiveLaneView's physical mesh reaches this far; notes do not travel on
  // this Z axis. They are children of screen_root in the camera plane.
  spawnRootZ: 217.6000061,
  spawnY: 6,
  screenRootZ: 10.6077995,
  // First twelve judgement_position transforms in the LiveGameView prefab. A
  // least-squares fit of their serialized X values gives 1.2847408029 per
  // physical lane (two chart lanes); all twelve serialize Y=-3.1600000858.
  screenJudgementLaneUnit: 1.2847408029166134,
  screenJudgementWidth: 15.416889634999361,
  screenJudgementCenterX: 2.384185791015625e-7,
  screenJudgementY: -3.16,
  judgementRootZ: 9.62,
  judgementLineSize: [19.2, 0.06] as const,
  // livegamepairnoteview SpriteRenderer: drawMode=Sliced, m_Size=(0.04, 0.025).
  // LivePairNoteLineView.SetProgress changes only size.x, so the authored
  // 0.025-unit height stays fixed while the line grows between note centres.
  simultaneousLineSize: [0.04, 0.025] as const,
  tapAreaSize: [19.6, 1.7] as const,
  sortingOrders: {
    laneBase: 4000,
    laneLine: 4100,
    tapArea: 4101,
    holdLine: 4999,
    simultaneousLine: 4999,
    note: 5000,
    noteArrow: 5001,
    noteDecoration: 5500,
  } as const,
  noteSpeedExponent: 1.30999994,
  /** Semantic float literal; its f32 storage is 1.06500006. */
  viewCurveBase: 1.065,
  viewCurveSteps: 45,
} as const;

/** Exact effect001 prefab indices used by LiveNoteEffectAssetSettings. */
export const EFFECT001_PREFAB_IDS = {
  Normal: 2,
  Slide: 3,
  Flick: 4,
  Left: 5,
  Right: 6,
  Excellent: 7,
  SlideLoop: 8,
  Connect: 9,
} as const;

const DEFAULT_ASSET_SERVER = "jp-cbt";
const ASSET_ROOT = `/assets/${DEFAULT_ASSET_SERVER}`;
const RUNTIME_ROOT = `/runtime/${DEFAULT_ASSET_SERVER}`;
const NOTE_SOURCE = "Assets/AddressableResources/Live/Note/skin001";
const LANE_SOURCE = "Assets/AddressableResources/Live/Lane/skin001";
const EFFECT001_SOURCE = "Assets/AddressableResources/Live/NoteEffect/effect001";
const EFFECT_COMMON_SOURCE = "Assets/AddressableResources/Live/NoteEffect/common";
const LANE_EFFECT_SOURCE = "Assets/AddressableResources/Live/Prefabs/LiveGame/Effect";
const LIVE_IMAGE_SOURCE = "Assets/AddressableResources/Live/Images";
const HUD_FONT_SOURCE = "Assets/AddressableResources/Font/VibeMOPro-Medium/VibeMOPro-Medium SDF.asset";

export const OUR_NOTES_RUNTIME_SOURCES = {
  noteAtlas: `${NOTE_SOURCE}/skin001.spriteatlasv2`,
  judgementAtlas: "Assets/AddressableResources/Live/Images/Atlas/JudgementAtlas.spriteatlasv2",
  liveAtlas: "Assets/AddressableResources/Live/Images/Atlas/LiveAtlas.spriteatlasv2",
  comboAtlas: "Assets/AddressableResources/Live/Images/Atlas/LiveComboAtlas.spriteatlasv2",
  font: HUD_FONT_SOURCE,
} as const;

const encodeUnityPath = (value: string): string => value.split("/").map(encodeURIComponent).join("/");
const sourceAsset = (value: string): string => `${ASSET_ROOT}/${encodeUnityPath(value)}`;
const unityObject = (source: string, type: string, ordinal = 0): string =>
  `${RUNTIME_ROOT}/unity-json/${encodeUnityPath(source)}/${type}${ordinal ? `_${ordinal}` : ""}.json`;
const objectOrdinal = (filename: string): { type: string; ordinal: number } => {
  const match = /^([A-Za-z0-9]+)(?:_(\d+))?\.asset$/.exec(filename);
  if (!match) throw new TypeError(`Invalid Unity object projection name: ${filename}`);
  return { type: match[1], ordinal: Number(match[2] || 0) };
};

const noteSound = (name: string): string => `${RUNTIME_ROOT}/note-se/${name}.mp3`;
const effect001Root = (prefab: string, objectFile: string): string => {
  const object = objectOrdinal(objectFile);
  return unityObject(`${EFFECT001_SOURCE}/${prefab}`, object.type, object.ordinal);
};
const effectCommonRoot = (source: string): string => unityObject(`${EFFECT_COMMON_SOURCE}/${source}`, "AnimationClip");

function effectParticle(
  root: string,
  file: string,
  name: string,
  texture: Effect001TextureKey,
  localPosition: readonly [number, number, number],
  options: Partial<
    Pick<
      Effect001ParticleSystemAssetRef,
      | "localScale"
      | "localRotationX"
      | "shapeWidthOffset"
      | "widthScaleRange"
      | "rendererPivot"
      | "rendererMaxParticleSize"
      | "renderer"
      | "animationPath"
    >
  > = {},
): Effect001ParticleSystemAssetRef {
  const rendererPivot =
    options.rendererPivot ?? (options.renderer === "wallMesh" ? ([0, -0.21, -0.5] as const) : undefined);
  // Source renderer records use .5 for every star/point system and 1 for
  // long-star, center-line and wall systems. Keep the value on the manifest
  // even for walls; ParticleQuadBatch deliberately consumes billboards only.
  const rendererMaxParticleSize = options.rendererMaxParticleSize ?? (texture === "star" ? 0.5 : 1);
  return {
    name,
    metadataUrl: effect001Root(root, file),
    texture,
    localPosition,
    ...options,
    rendererMaxParticleSize,
    ...(rendererPivot ? { rendererPivot } : {}),
  };
}

function effectSprite(
  root: string,
  file: string,
  name: Effect001SpriteName,
  baseColor: readonly [number, number, number, number],
  baseSize: readonly [number, number],
  localPosition: readonly [number, number, number],
  baseActive = false,
  flipX = false,
): Effect001SpriteAssetRef {
  // Every effect001 `frame` Transform serializes quaternion
  // (x=.7071068287,w=.7071068287) and scale (1.01999998,1,1). The four
  // pillars serialize identity transforms. Keep this transform separate from
  // SpriteRenderer.m_Size: SetWidth changes the latter but not the former.
  const localScale = name === "frame" ? ([1.02, 1, 1] as const) : ([1, 1, 1] as const);
  const localRotationX = name === "frame" ? Math.PI / 2 : 0;
  // ef_tap_line is centered. ef_tap_pillar is authored with its pivot close
  // to the bottom edge; treating it as a centered PlaneGeometry moves every
  // six-unit judgement pillar down by 2.743942 world units.
  const pivot = name === "frame" ? ([0.5, 0.5] as const) : ([0.49672558903694153, 0.04267627373337746] as const);
  return {
    name,
    metadataUrl: effect001Root(root, file),
    baseActive,
    baseColor,
    baseSize,
    pivot,
    localPosition,
    localScale,
    localRotationX,
    ...(flipX ? { flipX: true } : {}),
  };
}

const TAP_ANIMATION_CLIPS = {
  perfect: effectCommonRoot("anim/tap_perfect.anim"),
  great: effectCommonRoot("anim/tap_great.anim"),
  good: effectCommonRoot("anim/tap_good.anim"),
  bad: effectCommonRoot("anim/tap_bad.anim"),
} as const;
const SLIDE_ANIMATION_CLIPS = {
  perfect: effectCommonRoot("anim/tap_slide_parfect.anim"),
  great: effectCommonRoot("anim/tap_slide_great.anim"),
  good: effectCommonRoot("anim/tap_slide_good.anim"),
  bad: effectCommonRoot("anim/tap_slide_bad.anim"),
} as const;
const FLICK_ANIMATION_CLIPS = {
  perfect: effectCommonRoot("anim/tap_flick_perfect.anim"),
  great: effectCommonRoot("anim/tap_flick_great.anim"),
  good: effectCommonRoot("anim/tap_flick_good.anim"),
  bad: effectCommonRoot("anim/tap_flick_bad.anim"),
} as const;
const TAP_PERFECT_CLIP = TAP_ANIMATION_CLIPS.perfect;
const SLIDE_PERFECT_CLIP = SLIDE_ANIMATION_CLIPS.perfect;
const FLICK_PERFECT_CLIP = FLICK_ANIMATION_CLIPS.perfect;
const SLIDE_LOOP_CLIP = effectCommonRoot("anim/tap_slide_loop.anim");

/**
 * Complete visible effect001 prefab graph. ParticleSystem component assets are
 * named by serialized order, so every entry is explicitly tied back to its
 * Unity GameObject instead of treating `ParticleSystem.asset` as the whole
 * prefab.
 */
export const EFFECT001_PREFABS: Readonly<Record<keyof typeof EFFECT001_PREFAB_IDS, Effect001PrefabAssetRef>> = {
  Normal: {
    id: EFFECT001_PREFAB_IDS.Normal,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: TAP_PERFECT_CLIP,
    animationClipUrls: TAP_ANIMATION_CLIPS,
    particleSystems: [
      effectParticle("note_normal.prefab", "ParticleSystem_3.asset", "ef_particle_point", "star", [0, -0.53, 0], {
        animationPath: "ef_splash/ef_particle_point",
        shapeWidthOffset: 0.08,
      }),
      effectParticle("note_normal.prefab", "ParticleSystem_1.asset", "ef_particle_star", "star", [0, -0.531, 0], {
        animationPath: "ef_splash/ef_particle_star",
        shapeWidthOffset: -0.02,
      }),
      effectParticle("note_normal.prefab", "ParticleSystem.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      effectSprite(
        "note_normal.prefab",
        "SpriteRenderer.asset",
        "frame",
        [0.0777856633067131, 0.23382169008255005, 0.8679245114326477, 0],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      effectSprite(
        "note_normal.prefab",
        "SpriteRenderer_4.asset",
        "pillar01",
        [0, 0.19447201490402222, 0.4433962106704712, 0],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_normal.prefab",
        "SpriteRenderer_1.asset",
        "pillar02",
        [0, 0.19447201490402222, 0.4433962106704712, 0],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_normal.prefab",
        "SpriteRenderer_2.asset",
        "pillar03",
        [0, 0.19447201490402222, 0.4433962106704712, 0],
        [1, 4],
        [-2.5, -0.06, -0.61],
      ),
      effectSprite(
        "note_normal.prefab",
        "SpriteRenderer_3.asset",
        "pillar04",
        [0, 0.19447201490402222, 0.4433962106704712, 0],
        [1, 4],
        [2.5, -0.06, -0.6099997162818909],
      ),
    ],
  },
  Slide: {
    id: EFFECT001_PREFAB_IDS.Slide,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: SLIDE_PERFECT_CLIP,
    animationClipUrls: SLIDE_ANIMATION_CLIPS,
    particleSystems: [
      effectParticle("note_slide.prefab", "ParticleSystem_3.asset", "ef_particle_point", "star", [0, -0.53, 0], {
        animationPath: "ef_splash/ef_particle_point",
        shapeWidthOffset: 0.08,
      }),
      effectParticle("note_slide.prefab", "ParticleSystem.asset", "ef_particle_star", "star", [0, -0.531, 0], {
        animationPath: "ef_splash/ef_particle_star",
        localRotationX: -Math.PI / 2,
        shapeWidthOffset: -0.02,
      }),
      effectParticle("note_slide.prefab", "ParticleSystem_1.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      effectSprite(
        "note_slide.prefab",
        "SpriteRenderer_1.asset",
        "frame",
        [0.29026374220848083, 0.05090780183672905, 0.9811320900917053, 1],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      effectSprite(
        "note_slide.prefab",
        "SpriteRenderer_4.asset",
        "pillar01",
        [0.0716320127248764, 0.03764684498310089, 0.16981130838394165, 1],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_slide.prefab",
        "SpriteRenderer.asset",
        "pillar02",
        [0.0716320127248764, 0.03764684498310089, 0.16981130838394165, 1],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_slide.prefab",
        "SpriteRenderer_3.asset",
        "pillar03",
        [0.15670402348041534, 0.061943765729665756, 0.4528301954269409, 1],
        [1, 4],
        [-2.5, -0.06, -0.54],
      ),
      effectSprite(
        "note_slide.prefab",
        "SpriteRenderer_2.asset",
        "pillar04",
        [0.15670402348041534, 0.061943765729665756, 0.4528301954269409, 1],
        [1, 4],
        [2.5, -0.06, -0.54],
      ),
    ],
  },
  Flick: {
    id: EFFECT001_PREFAB_IDS.Flick,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: FLICK_PERFECT_CLIP,
    animationClipUrls: FLICK_ANIMATION_CLIPS,
    particleSystems: [
      effectParticle("note_flick.prefab", "ParticleSystem_5.asset", "ef_particle_point", "star", [0, -0.53, 0], {
        animationPath: "ef_splash/ef_particle_point",
        shapeWidthOffset: 0.08,
      }),
      effectParticle("note_flick.prefab", "ParticleSystem_4.asset", "ef_particle_star", "star", [0, -0.531, 0], {
        animationPath: "ef_splash/ef_particle_star",
        shapeWidthOffset: -0.02,
      }),
      effectParticle(
        "note_flick.prefab",
        "ParticleSystem_8.asset",
        "ef_particle_point01",
        "star",
        [0, 0.7100000381469727, 0],
        { animationPath: "ef_splash_move/ef_particle_point01", widthScaleRange: [0.05, 3] },
      ),
      effectParticle(
        "note_flick.prefab",
        "ParticleSystem_2.asset",
        "ef_particle_point02",
        "star",
        [0, 0.7100000381469727, 0],
        { animationPath: "ef_splash_move/ef_particle_point02", widthScaleRange: [0.05, 3] },
      ),
      effectParticle("note_flick.prefab", "ParticleSystem_6.asset", "ef_particl_splash", "longStar", [0, 1.8, -0.2], {
        animationPath: "ef_splash_move/ef_particl_splash",
        localScale: [1.02, 1, 1],
        widthScaleRange: [0.05, 3],
      }),
      effectParticle(
        "note_flick.prefab",
        "ParticleSystem_3.asset",
        "ef_particl_splash_line",
        "centerPillar",
        [0, 0.15, -0.2],
        {
          animationPath: "ef_splash_move/ef_particl_splash_line",
          widthScaleRange: [0.05, 3],
          rendererPivot: [0, 0.3, 0],
        },
      ),
      effectParticle(
        "note_flick.prefab",
        "ParticleSystem.asset",
        "ef_particl_splash_line02",
        "centerPillar02",
        [0, -0.5, -0.2],
        {
          animationPath: "ef_splash_move/ef_particl_splash_line02",
          widthScaleRange: [0.05, 3],
          rendererPivot: [0, 0.3, 0],
        },
      ),
      effectParticle("note_flick.prefab", "ParticleSystem_7.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      effectSprite(
        "note_flick.prefab",
        "SpriteRenderer_2.asset",
        "frame",
        [0.6792452931404114, 0.30566415190696716, 0.06728372722864151, 0],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      effectSprite(
        "note_flick.prefab",
        "SpriteRenderer.asset",
        "pillar01",
        [0.37735849618911743, 0.20075224339962006, 0.08721965551376343, 0],
        [3, 6],
        [-2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_flick.prefab",
        "SpriteRenderer_3.asset",
        "pillar02",
        [0.37735849618911743, 0.20075224339962006, 0.08721965551376343, 0],
        [3, 6],
        [2.5, -0.06, 0.64],
        false,
        true,
      ),
      effectSprite(
        "note_flick.prefab",
        "SpriteRenderer_1.asset",
        "pillar03",
        [0.43396228551864624, 0.21204276382923126, 0.07164470851421356, 0],
        [4, 4],
        [-2.5, -0.06, -0.54],
      ),
      effectSprite(
        "note_flick.prefab",
        "SpriteRenderer_4.asset",
        "pillar04",
        [0.43396228551864624, 0.21204276382923126, 0.07164470851421356, 0],
        [4, 4],
        [2.5, -0.06, -0.54],
        false,
        true,
      ),
    ],
  },
  Left: {
    id: EFFECT001_PREFAB_IDS.Left,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: FLICK_PERFECT_CLIP,
    animationClipUrls: FLICK_ANIMATION_CLIPS,
    // Root Animator controller tap_flick binds the moving child Transform at
    // CRC32("ef_splash_move/ef_splash"). The unrelated flick_note_loop
    // controller is not referenced by this prefab.
    distanceEmitterPathHash: unityStringHash("ef_splash_move/ef_splash"),
    particleSystems: [
      effectParticle("note_flick_left.prefab", "ParticleSystem_2.asset", "ef_particle_point", "star", [0, -0.53, 0], {
        animationPath: "ef_splash/ef_particle_point",
        shapeWidthOffset: 0.08,
      }),
      effectParticle("note_flick_left.prefab", "ParticleSystem_6.asset", "ef_particle_star", "star", [0, -0.531, 0], {
        animationPath: "ef_splash/ef_particle_star",
        shapeWidthOffset: -0.02,
      }),
      effectParticle("note_flick_left.prefab", "ParticleSystem_1.asset", "ef_splash", "longStar", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash",
        widthScaleRange: [0.082, 1.5],
      }),
      effectParticle("note_flick_left.prefab", "ParticleSystem.asset", "ef_splash02", "star", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash/ef_splash02",
        widthScaleRange: [0.082, 1.5],
      }),
      effectParticle("note_flick_left.prefab", "ParticleSystem_5.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      effectSprite(
        "note_flick_left.prefab",
        "SpriteRenderer.asset",
        "frame",
        [0.039382338523864746, 0.5566037893295288, 0.14450867474079132, 0],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      effectSprite(
        "note_flick_left.prefab",
        "SpriteRenderer_3.asset",
        "pillar01",
        [0.02429690957069397, 0.1320754885673523, 0.04532688111066818, 0],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_flick_left.prefab",
        "SpriteRenderer_4.asset",
        "pillar02",
        [0.02429690957069397, 0.1320754885673523, 0.04532688111066818, 0],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_flick_left.prefab",
        "SpriteRenderer_1.asset",
        "pillar03",
        [0.05598077550530434, 0.3207547068595886, 0.11271801590919495, 0],
        [1, 4],
        [-2.5, -0.06, -0.54],
      ),
      effectSprite(
        "note_flick_left.prefab",
        "SpriteRenderer_2.asset",
        "pillar04",
        [0.05598077550530434, 0.3207547068595886, 0.11271801590919495, 0],
        [1, 4],
        [2.5, -0.06, -0.54],
      ),
    ],
  },
  Right: {
    id: EFFECT001_PREFAB_IDS.Right,
    rootScaleX: -1,
    loopAnimation: false,
    animationClipUrl: FLICK_PERFECT_CLIP,
    animationClipUrls: FLICK_ANIMATION_CLIPS,
    distanceEmitterPathHash: unityStringHash("ef_splash_move/ef_splash"),
    particleSystems: [
      effectParticle("note_flick_right.prefab", "ParticleSystem_5.asset", "ef_particle_point", "star", [0, -0.53, 0], {
        animationPath: "ef_splash/ef_particle_point",
        shapeWidthOffset: 0.08,
      }),
      effectParticle("note_flick_right.prefab", "ParticleSystem_2.asset", "ef_particle_star", "star", [0, -0.531, 0], {
        animationPath: "ef_splash/ef_particle_star",
        shapeWidthOffset: -0.02,
      }),
      effectParticle("note_flick_right.prefab", "ParticleSystem_6.asset", "ef_splash", "longStar", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash",
        widthScaleRange: [0.082, 1.5],
      }),
      effectParticle("note_flick_right.prefab", "ParticleSystem_4.asset", "ef_splash02", "star", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash/ef_splash02",
        widthScaleRange: [0.082, 1.5],
      }),
      effectParticle("note_flick_right.prefab", "ParticleSystem_3.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      effectSprite(
        "note_flick_right.prefab",
        "SpriteRenderer_1.asset",
        "frame",
        [1, 0.15566039085388184, 0.6591655611991882, 0],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      effectSprite(
        "note_flick_right.prefab",
        "SpriteRenderer_2.asset",
        "pillar01",
        [0.18867921829223633, 0.07386969029903412, 0.14247536659240723, 0],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_flick_right.prefab",
        "SpriteRenderer.asset",
        "pillar02",
        [0.18867921829223633, 0.07386969029903412, 0.14247536659240723, 0],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_flick_right.prefab",
        "SpriteRenderer_3.asset",
        "pillar03",
        [0.4150943160057068, 0.09202562272548676, 0.28141072392463684, 0],
        [1, 4],
        [-2.5, -0.06, -0.54],
      ),
      effectSprite(
        "note_flick_right.prefab",
        "SpriteRenderer_4.asset",
        "pillar04",
        [0.4150943160057068, 0.09202562272548676, 0.28141072392463684, 0],
        [1, 4],
        [2.5, -0.06, -0.54],
      ),
    ],
  },
  Excellent: {
    id: EFFECT001_PREFAB_IDS.Excellent,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: TAP_PERFECT_CLIP,
    animationClipUrls: TAP_ANIMATION_CLIPS,
    particleSystems: [
      effectParticle("note_excellent.prefab", "ParticleSystem_2.asset", "ef_particle_point", "star", [0, -0.53, 0], {
        shapeWidthOffset: 0.08,
      }),
      effectParticle("note_excellent.prefab", "ParticleSystem_3.asset", "ef_particle_star", "star", [0, -0.531, 0], {
        shapeWidthOffset: -0.02,
      }),
      effectParticle("note_excellent.prefab", "ParticleSystem_1.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      effectSprite(
        "note_excellent.prefab",
        "SpriteRenderer_4.asset",
        "frame",
        [0.5, 0.45834264159202576, 0.030660390853881836, 0],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      effectSprite(
        "note_excellent.prefab",
        "SpriteRenderer_2.asset",
        "pillar01",
        [0.1603773832321167, 0.14632397890090942, 0.038581348955631256, 0],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_excellent.prefab",
        "SpriteRenderer_1.asset",
        "pillar02",
        [0.1603773832321167, 0.14632397890090942, 0.038581348955631256, 0],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_excellent.prefab",
        "SpriteRenderer.asset",
        "pillar03",
        [0.28301888704299927, 0.25544610619544983, 0.04405483230948448, 0],
        [1, 4],
        [-2.5, -0.06, -0.54],
      ),
      effectSprite(
        "note_excellent.prefab",
        "SpriteRenderer_3.asset",
        "pillar04",
        [0.28301888704299927, 0.25544610619544983, 0.04405483230948448, 0],
        [1, 4],
        [2.5, -0.06, -0.54],
      ),
    ],
  },
  SlideLoop: {
    id: EFFECT001_PREFAB_IDS.SlideLoop,
    rootScaleX: 1,
    loopAnimation: true,
    animationClipUrl: SLIDE_LOOP_CLIP,
    particleSystems: [
      effectParticle("note_slide_loop.prefab", "ParticleSystem_1.asset", "ef_particle_point", "star", [0, -0.531, 0], {
        localRotationX: -Math.PI / 2,
        shapeWidthOffset: 0.08,
      }),
      effectParticle(
        "note_slide_loop.prefab",
        "ParticleSystem.asset",
        "ef_particle_point_frame",
        "star",
        [0, -0.531, 0],
        {
          localRotationX: -Math.PI / 2,
          shapeWidthOffset: 0.08,
        },
      ),
      effectParticle("note_slide_loop.prefab", "ParticleSystem_2.asset", "ef_wall_center", "wall", [0, 0, 0], {
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      effectSprite(
        "note_slide_loop.prefab",
        "SpriteRenderer_1.asset",
        "frame",
        [0.2976938784122467, 0.051886796951293945, 1, 1],
        [5.5, 1.75],
        [0, 0, 0],
        true,
      ),
      effectSprite(
        "note_slide_loop.prefab",
        "SpriteRenderer_3.asset",
        "pillar01",
        [0.22390960156917572, 0.08050017803907394, 0.6320754289627075, 0.1568627506494522],
        [4, 6],
        [-2.5, -0.06, 0.64],
        true,
      ),
      effectSprite(
        "note_slide_loop.prefab",
        "SpriteRenderer_2.asset",
        "pillar02",
        [0.22390960156917572, 0.08050017803907394, 0.6320754289627075, 0.1568627506494522],
        [4, 6],
        [2.5, -0.06, 0.64],
        true,
      ),
      effectSprite(
        "note_slide_loop.prefab",
        "SpriteRenderer_4.asset",
        "pillar03",
        [0.22390960156917572, 0.08050017803907394, 0.6320754289627075, 0.1568627506494522],
        [4, 4],
        [-2.5, -0.06, -0.54],
        true,
      ),
      effectSprite(
        "note_slide_loop.prefab",
        "SpriteRenderer.asset",
        "pillar04",
        [0.22390960156917572, 0.08050017803907394, 0.6320754289627075, 0.1568627506494522],
        [4, 4],
        [2.5, -0.06, -0.54],
        true,
      ),
    ],
  },
  Connect: {
    id: EFFECT001_PREFAB_IDS.Connect,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: SLIDE_PERFECT_CLIP,
    animationClipUrls: SLIDE_ANIMATION_CLIPS,
    particleSystems: [
      effectParticle(
        "note_slide_connect.prefab",
        "ParticleSystem_1.asset",
        "ef_particle_point",
        "star",
        [0, -0.53, 0],
        {
          shapeWidthOffset: 0.08,
        },
      ),
      effectParticle(
        "note_slide_connect.prefab",
        "ParticleSystem_2.asset",
        "ef_particle_star",
        "star",
        [0, -0.531, 0],
        {
          localRotationX: -Math.PI / 2,
          shapeWidthOffset: -0.02,
        },
      ),
      effectParticle("note_slide_connect.prefab", "ParticleSystem.asset", "ef_splash", "star", [0, 0, 0]),
      effectParticle("note_slide_connect.prefab", "ParticleSystem_3.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      effectSprite(
        "note_slide_connect.prefab",
        "SpriteRenderer.asset",
        "frame",
        [0.39179620146751404, 0.18222679197788239, 0.9905660152435303, 1],
        [5.5, 1.75],
        [0, 0, 0],
      ),
    ],
  },
};

const sprite = (name: string, directory: string): SpriteMetadataRef => ({
  name,
  metadataUrl: unityObject(`${NOTE_SOURCE}/${directory}/${name}.png`, "Sprite"),
});

function sideSprites(prefix: string, directory: string): SpriteMetadataRef[] {
  const values: Array<string | number> = ["L", "R", -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
  return values.map((value) => {
    const suffix = String(value);
    const name = `${prefix}_${suffix}`;
    return sprite(name, directory);
  });
}

const noteSprites: SpriteMetadataRef[] = [
  ...sideSprites("notes_tap_side", "tap"),
  ...sideSprites("notes_flick_side", "flick"),
  ...sideSprites("notes_flick_left_side", "flick_left"),
  ...sideSprites("notes_flick_right_side", "flick_right"),
  ...sideSprites("notes_slide_side", "slide"),
  ...sideSprites("notes_slide_end_side", "slide_end"),
  ...sideSprites("notes_slide_connection_side", "slide_connet"),
  ...sideSprites("notes_trace_side", "trace"),
  sprite("note_trace_3", "trace"),
  sprite("slide_connection_icon", "slide_connet"),
  sprite("tap_decoration", "tap"),
  sprite("flick_decoration", "flick"),
  sprite("slide_decoration", "slide"),
  sprite("flick_left_decoration", "flick_left"),
  sprite("flick_right_decoration", "flick_right"),
  sprite("notes_flick_arrow_upper_S", "flick"),
  sprite("notes_flick_arrow_upper_M", "flick"),
  sprite("notes_flick_arrow_upper_L", "flick"),
  sprite("notes_flick_arrow_upper_LL", "flick"),
  ...Array.from({ length: 8 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return sprite(`notes_flick_arrow_left_${suffix}`, "flick_left");
  }),
  ...Array.from({ length: 8 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return sprite(`notes_flick_arrow_right_${suffix}`, "flick_right");
  }),
];

/**
 * Live skin template. Palette values are sampled from the skin001 reference
 * sheet; build-specific atlas/HUD media must be injected from descriptors.
 */
const buildOurNotesSkin001Manifest = (runtimeMedia: OurNotesRuntimeMediaManifest): OurNotesAssetManifest => ({
  id: "our-notes-skin001-effect001",
  source: {
    game: "BanG Dream! Our Notes",
    noteSkin: "skin001",
    laneSkin: "skin001",
    noteEffectSkin: "effect001",
  },
  noteAtlas: {
    id: "skin001",
    textureUrl: runtimeMedia.noteAtlasTextureUrl,
    atlasMetadataUrl: unityObject(`${NOTE_SOURCE}/skin001.spriteatlasv2`, "SpriteAtlas"),
    sprites: noteSprites,
  },
  lane: {
    baseTextureUrl: sourceAsset(`${LANE_SOURCE}/lane_base.png`),
    materialBaseTextureUrl: sourceAsset(`${LANE_SOURCE}/lane_base.png`),
    tapAreaTextureUrl: sourceAsset(`${LANE_SOURCE}/lane_tap_area.png`),
    outsideLineTextureUrl: sourceAsset(`${LANE_SOURCE}/out_side_line.png`),
    referenceImageUrl: sourceAsset(`${LANE_SOURCE}/reference_image.png`),
  },
  particles: {
    starTextureUrl: sourceAsset(`${EFFECT_COMMON_SOURCE}/ef_tap_particle_star.png`),
    longStarTextureUrl: sourceAsset(`${EFFECT_COMMON_SOURCE}/ef_tap_particle_star_long.png`),
    tapLineTextureUrl: sourceAsset(`${EFFECT_COMMON_SOURCE}/ef_tap_line.png`),
    tapPillarTextureUrl: sourceAsset(`${EFFECT_COMMON_SOURCE}/ef_tap_pillar.png`),
    wallTextureUrl: sourceAsset(`${EFFECT_COMMON_SOURCE}/ef_wall.png`),
    wallSideTextureUrl: sourceAsset(`${EFFECT_COMMON_SOURCE}/ef_wall_side.png`),
    centerPillarTextureUrl: sourceAsset(`${EFFECT_COMMON_SOURCE}/ef_pillar_center.png`),
    centerPillar02TextureUrl: sourceAsset(`${EFFECT_COMMON_SOURCE}/ef_pillar_center02.png`),
    slideLineTextureUrl: sourceAsset(`${NOTE_SOURCE}/slideline_purple2.png`),
    laneEffects: {
      inVain: {
        textureUrl: sourceAsset(`${LIVE_IMAGE_SOURCE}/lane_effect_white.png`),
        particleSystemMetadataUrl: unityObject(
          `${LANE_EFFECT_SOURCE}/lane_tap_blank_miss_view.prefab`,
          "ParticleSystem",
          1,
        ),
        lifetime: 0.44999998807907104 / 2,
      },
      normal: {
        textureUrl: sourceAsset(`${LIVE_IMAGE_SOURCE}/lane_effect_white.png`),
        particleSystemMetadataUrl: unityObject(
          `${LANE_EFFECT_SOURCE}/lane_tap_normal_view.prefab`,
          "ParticleSystem",
          1,
        ),
        lifetime: 0.44999998807907104 / 2,
      },
      slide: {
        textureUrl: sourceAsset(`${LIVE_IMAGE_SOURCE}/lane_effect_white.png`),
        particleSystemMetadataUrl: unityObject(`${LANE_EFFECT_SOURCE}/lane_tap_slide_view.prefab`, "ParticleSystem"),
        lifetime: 0.44999998807907104 / 2,
      },
      flick: {
        textureUrl: sourceAsset(`${LIVE_IMAGE_SOURCE}/lane_effect_white.png`),
        particleSystemMetadataUrl: unityObject(`${LANE_EFFECT_SOURCE}/lane_tap_flick_view.prefab`, "ParticleSystem", 1),
        lifetime: 0.44999998807907104 / 2,
      },
      flickLeft: {
        textureUrl: sourceAsset(`${LIVE_IMAGE_SOURCE}/lane_effect_white.png`),
        particleSystemMetadataUrl: unityObject(
          `${LANE_EFFECT_SOURCE}/lane_tap_flick_left_view.prefab`,
          "ParticleSystem",
        ),
        lifetime: 0.44999998807907104 / 2,
      },
      flickRight: {
        textureUrl: sourceAsset(`${LIVE_IMAGE_SOURCE}/lane_effect_white.png`),
        particleSystemMetadataUrl: unityObject(
          `${LANE_EFFECT_SOURCE}/lane_tap_flick_right_view.prefab`,
          "ParticleSystem",
          1,
        ),
        lifetime: 0.44999998807907104 / 2,
      },
    },
    effect001RootUrl: sourceAsset(`${EFFECT001_SOURCE}/LiveNoteEffectAssetSettings.asset`),
    effect001Prefabs: EFFECT001_PREFABS,
    effect001PrefabIds: EFFECT001_PREFAB_IDS,
  },
  hud: runtimeMedia.hud,
  ...(runtimeMedia.fontAtlasTextureUrl
    ? {
        tmpSdfFont: {
          atlasTextureUrl: runtimeMedia.fontAtlasTextureUrl,
          metadataUrl: unityObject(HUD_FONT_SOURCE, "MonoBehaviour"),
        },
      }
    : {}),
  // MasterLiveNoteSeGroup=1. These WAV files are produced by the CRI processing
  // stage from each CriSerializedBytesAssetImpl. default_long is a Type=0 polyphonic CRI
  // sequence, not one selectable subsong, so both Track rows are layered.
  noteSounds: {
    good: noteSound("default_good"),
    great: noteSound("default_great"),
    perfect: noteSound("default_perfect"),
    flick: noteSound("default_flick"),
    flickDirection: noteSound("default_flick_side"),
    slide: [
      { url: noteSound("default_long_1"), gain: 0.85 },
      { url: noteSound("default_long_2"), gain: 0.75 },
    ],
    just: noteSound("just_01"),
    trace: noteSound("default_trace"),
  },
  palette: {
    lane: "#07162c",
    laneLine: "#7283aa",
    outsideLine: "#eefcff",
    judgementLine: "#d864ff",
    tap: "#78b5ff",
    flick: "#ff7298",
    flickLeft: "#32df79",
    flickRight: "#ff668b",
    slide: "#b66dff",
    trace: "#718dff",
    critical: "#ffc247",
    perfect: "#f4fff2",
    great: "#ffea72",
    good: "#79e9a6",
    bad: "#ff9b58",
    miss: "#d6d8e5",
  },
  tiltThresholds: [0, 2, 4, 6, 8, 10, 12].map((distance, value) => ({ distance, value })),
});

export function ourNotesAssetManifestForServer(
  server: string,
  runtimeMedia: OurNotesRuntimeMediaManifest,
): OurNotesAssetManifest {
  const normalized = String(server || DEFAULT_ASSET_SERVER);
  const encodedServer = encodeURIComponent(normalized);
  const runtimePrefix = `/runtime/${encodedServer}/`;
  const assetPrefixes = [`/assets/${encodedServer}/Assets/`, `/assets/${encodedServer}/Packages/`] as const;
  const runtimeUrls = [
    runtimeMedia.noteAtlasTextureUrl,
    ...(runtimeMedia.fontAtlasTextureUrl ? [runtimeMedia.fontAtlasTextureUrl] : []),
    ...Object.values(runtimeMedia.hud.judgementImages),
    runtimeMedia.hud.comboLabelUrl,
    ...runtimeMedia.hud.comboDigitUrls,
    runtimeMedia.hud.perfectComboLabelUrl,
    ...runtimeMedia.hud.perfectComboDigitUrls,
    runtimeMedia.hud.pauseIconUrl,
    runtimeMedia.hud.pauseFrameUrl,
    runtimeMedia.hud.pauseShadowUrl,
    ...Object.values(runtimeMedia.hud.lifeIconUrls),
    ...Object.values(runtimeMedia.hud.rankIconUrls),
    runtimeMedia.hud.rankBaseUrl,
    runtimeMedia.hud.roundMask14Url,
    runtimeMedia.hud.statusBaseUrl,
    runtimeMedia.hud.scoreStarUrl,
    runtimeMedia.hud.whiteSpriteUrl,
  ];
  const invalidUrl = runtimeUrls.find(
    (url) => !url.startsWith(runtimePrefix) && !assetPrefixes.some((prefix) => url.startsWith(prefix)),
  );
  if (invalidUrl) {
    throw new TypeError(
      `Chart media must use the canonical ${runtimePrefix}, ${assetPrefixes[0]}, or ${assetPrefixes[1]} namespace: ${invalidUrl}`,
    );
  }
  const serialized = JSON.stringify(buildOurNotesSkin001Manifest(runtimeMedia))
    .replaceAll(`${ASSET_ROOT}/`, `/assets/${encodedServer}/`)
    .replaceAll(`${RUNTIME_ROOT}/`, runtimePrefix);
  const manifest = JSON.parse(serialized) as OurNotesAssetManifest;
  return {
    ...manifest,
    noteAtlas: { ...manifest.noteAtlas, textureUrl: runtimeMedia.noteAtlasTextureUrl },
    hud: runtimeMedia.hud,
  };
}
