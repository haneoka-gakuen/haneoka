/**
 * Runtime asset manifest for the embedded Our Notes live skin.
 *
 * Source media uses real Unity `Assets/` paths. JSON needed by the renderer is
 * a deterministic runtime projection of the immutable bundle object archive.
 */

import { unityStringHash } from "./unityHash.js";
import { OUR_NOTES_BUNDLED_NOTE_ATLASES } from "./noteAtlas.js";
import { OUR_NOTES_CHART_UI_PROFILE, type OurNotesChartUiProfile } from "./chartUiProfile.js";
import effectParticleActivity from "./effect-particle-activity.json";

export interface SpriteMetadataRef {
  /** Unity Sprite.m_Name. */
  name: string;
  /** Decoded Unity Sprite JSON (`*.asset`). */
  metadataUrl: string;
  metadata?: unknown;
}

export interface SpriteAtlasManifest {
  id: string;
  textureUrl: string;
  atlasMetadataUrl: string;
  atlasMetadata?: unknown;
  sprites: ReadonlyArray<SpriteMetadataRef>;
}

export interface LaneAssetManifest {
  baseTextureUrl: string;
  materialBaseTextureUrl: string;
  tapAreaTextureUrl: string;
  outsideLineTextureUrl: string;
  lineTextureUrl: string;
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
  /** effect001Simple note_point_simple material texture (ef_circle_icon). */
  circleIconTextureUrl: string;
  /** Omitted when the native material uses its default white texture. */
  slideLineTextureUrl?: string;
  /** Layer-25 LiveLaneEffectView assets, separate from HDR note effects. */
  laneEffects: Readonly<Record<Exclude<LaneEffectAssetKey, "gekisou">, LaneEffectParticleAssetRef> & { gekisou?: LaneEffectParticleAssetRef }>;
  effect001Prefabs: Readonly<Record<string, Effect001PrefabAssetRef>>;
  /** LiveNoteEffectAssetSettings prefab slots. */
  effect001PrefabIds: typeof EFFECT001_PREFAB_IDS;
}

export interface OurNotesSlideLineGradient {
  readonly colors: readonly (readonly [number, number, number, number])[];
  readonly alpha: readonly [number, number, number, number];
}

/** Serialized Live/Unlit/SlideLine material parameters. */
export interface OurNotesSlideLineGlow {
  readonly color: readonly [number, number, number, number];
  readonly intensity: number;
  readonly falloff: number;
  readonly width: number;
  readonly disabledScale: number;
  readonly enabledScale: number;
  readonly pressedScale: number;
}

export interface OurNotesSlideLineStyle {
  readonly disabled: OurNotesSlideLineGradient;
  readonly widthScale: number;
  readonly glowRangeScale: number;
  readonly normal: OurNotesSlideLineGradient;
  readonly pressed: OurNotesSlideLineGradient;
  readonly guide: readonly [number, number, number, number];
  readonly glow: OurNotesSlideLineGlow;
}

export type LaneEffectAssetKey = "inVain" | "normal" | "slide" | "flick" | "flickLeft" | "flickRight" | "gekisou";

/** Lane effects are a separate native pipeline from note judgement effects. */
export interface LaneEffectParticleAssetRef {
  textureUrl: string;
  particleSystemMetadataUrl: string;
  /** Effective real-time lifetime: startLifetime / ParticleSystem.simulationSpeed. */
  lifetime: number;
}

export type Effect001TextureKey = "star" | "longStar" | "centerPillar" | "centerPillar02" | "wall" | "circleIcon";
export type Effect001AnimationJudgement = "perfect" | "great" | "good" | "bad";

/** A visible ParticleSystem component in an effect001 prefab. */
export interface Effect001ParticleSystemAssetRef {
  /** Unity GameObject name; component filenames alone have no semantic ordering. */
  name: string;
  /** Animator-relative GameObject path used to respect authored active windows. */
  animationPath?: string;
  /** Animator-relative source GameObject defaults, including every ancestor. */
  baseActiveHierarchy?: ReadonlyArray<{ path: string; active: boolean }>;
  rendererEnabled?: boolean;
  metadataUrl: string;
  /** Original particle owner identity for the source-bound Simple Circle Transform data. */
  originalIdentity?: { serializedFile: string; pathId: string };
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
  /** Unity render mode: View Billboard=0, HorizontalBillboard=2, VerticalBillboard=3. */
  rendererRenderMode?: 0 | 2 | 3;
  /** Authored renderer material _TintColor; absent uses the established texture default. */
  materialTint?: readonly [number, number, number, number];
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
  materialTint?: readonly [number, number, number, number];
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

export interface HudSpriteGeometry {
  rectWidth: number;
  rectHeight: number;
  textureWidth: number;
  textureHeight: number;
  offsetX: number;
  offsetY: number;
}

export interface HudComboTierAssets {
  labelUrl: string;
  baseDigitUrls: ReadonlyArray<string>;
  fillDigitUrls: ReadonlyArray<string>;
  glowUrl?: string;
  geometry?: {
    label: HudSpriteGeometry;
    baseDigits: ReadonlyArray<HudSpriteGeometry>;
    fillDigits: ReadonlyArray<HudSpriteGeometry>;
    glow?: HudSpriteGeometry;
  };
}

export interface HudAssetManifest {
  judgementImages: Readonly<Record<"just" | "perfect" | "great" | "good" | "bad" | "miss" | "fast" | "late", string>>;
  comboLabelUrl: string;
  comboDigitUrls: ReadonlyArray<string>;
  perfectComboLabelUrl: string;
  perfectComboDigitUrls: ReadonlyArray<string>;
  /** LiveComboSpriteAsset's native three tiers; legacy combined sprites remain supported. */
  comboTiers?: Readonly<Record<"normal" | "fullCombo" | "allPerfect", HudComboTierAssets>>;
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

export type OurNotesNoteSeGroup = 1 | 2 | 3 | 4;
export const OUR_NOTES_NOTE_SE_GROUP_IDS: readonly OurNotesNoteSeGroup[] = [1, 2, 3, 4];

export type OurNotesNoteSeType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export const OUR_NOTES_NOTE_SE_TYPE_IDS: readonly OurNotesNoteSeType[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
];

/** Native cue names resolved from MasterLiveNoteSe + MasterSound. */
export type OurNotesNoteSeCue = string | readonly [string, string];

export const OUR_NOTES_NOTE_SE_CUES: Readonly<
  Record<OurNotesNoteSeGroup, Readonly<Record<OurNotesNoteSeType, OurNotesNoteSeCue>>>
> = {
  1: {
    1: "default_in_vain",
    2: "default_good",
    3: "default_great",
    4: "default_perfect",
    5: "default_flick",
    6: "default_flick_side",
    7: ["default_long_1", "default_long_2"],
    8: "just_01",
    9: "default_trace",
    10: "default_trace",
    11: "default_geki_tap",
    12: "default_geki_flick",
    13: "default_geki_flick_side",
    14: "default_geki_long",
  },
  2: {
    1: "solid_in_vain",
    2: "solid_good",
    3: "solid_great",
    4: "solid_perfect",
    5: "solid_flick",
    6: "solid_flick_side",
    7: "solid_long",
    8: "just_01",
    9: "solid_trace",
    10: "solid_trace",
    11: "solid_geki_tap",
    12: "solid_geki_flick",
    13: "solid_geki_flick_side",
    14: "solid_geki_long",
  },
  3: {
    1: "wood_in_vain",
    2: "wood_good",
    3: "wood_great",
    4: "wood_perfect",
    5: "wood_flick",
    6: "wood_flick_side",
    7: "wood_long",
    8: "just_01",
    9: "wood_trace",
    10: "wood_trace",
    11: "wood_geki_tap",
    12: "wood_geki_flick",
    13: "wood_geki_flick_side",
    14: "wood_geki_long",
  },
  4: {
    1: "typing_in_vain",
    2: "typing_good",
    3: "typing_great",
    4: "typing_perfect",
    5: "typing_flick",
    6: "typing_flick_side",
    7: "typing_long",
    8: "just_01",
    9: "typing_trace",
    10: "typing_trace",
    11: "typing_geki_tap",
    12: "typing_geki_flick",
    13: "typing_geki_flick_side",
    14: "typing_geki_long",
  },
};

export const OUR_NOTES_NOTE_SE_TYPE_NAMES: Readonly<Record<OurNotesNoteSeType, string>> = {
  1: "InVain",
  2: "Good",
  3: "Great",
  4: "Perfect",
  5: "Flick",
  6: "FlickSide",
  7: "Long",
  8: "Just",
  9: "Trace",
  10: "SlideConnect",
  11: "GekiTap",
  12: "GekiFlick",
  13: "GekiFlickSide",
  14: "GekiLong",
};

export type NoteSoundAssetKey =
  | "good"
  | "great"
  | "perfect"
  | "flick"
  | "flickDirection"
  | "slide"
  | "just"
  | "trace"
  | `type${OurNotesNoteSeType}`;

export interface NoteSoundAssetLayer {
  url: string;
  gain: number;
  loopStartSeconds?: number;
  loopEndSeconds?: number;
}

export type NoteSoundAsset = string | ReadonlyArray<NoteSoundAssetLayer>;

export type NoteSoundAssetManifest = Readonly<Record<NoteSoundAssetKey, NoteSoundAsset>>;

export interface OurNotesArrowGradientSettings {
  readonly bandWidth: number;
  readonly minAlpha: number;
}

/**
 * skin003 ArrowGradientSettings / ArrowGradientSettingsLeft/Right: the
 * Sirius/ArrowGradientCenter shader sweeps a brightness band along each
 * flick arrow with a per-direction band width and minimum alpha.
 */
export interface OurNotesArrowGradientStyle {
  readonly durationSeconds: number;
  readonly pauseSeconds: number;
  readonly center: OurNotesArrowGradientSettings;
  readonly directional: OurNotesArrowGradientSettings;
}

export interface OurNotesAssetManifest {
  id: string;
  /** URI mapping for optional Source presentations, independent of transport and renderer. */
  presentationAssets?: OurNotesAssetResolver;
  uiProfile: OurNotesChartUiProfile;
  source: {
    game: "BanG Dream! Our Notes";
    noteSkin: OurNotesNoteSkin;
    laneSkin: "skin001";
    noteEffectSkin: OurNotesNoteEffectSkin;
    authoredProfile: OurNotesAuthoredEffectProfile;
  };
  /** Selected MasterLiveQualitySettings row (defaults to the native High row). */
  liveQuality: OurNotesLiveQualitySettings;
  noteAtlas: SpriteAtlasManifest;
  /** Present only for skins whose flick arrows carry authored gradient settings. */
  arrowGradient?: OurNotesArrowGradientStyle;
  lane: LaneAssetManifest;
  particles: ParticleAssetManifest;
  slideLineStyle: OurNotesSlideLineStyle;
  hud: HudAssetManifest;
  tmpSdfFont?: TmpSdfFontAssetManifest;
  /** Selected MasterLiveNoteSeGroup row. */
  noteSeGroup: OurNotesNoteSeGroup;
  noteSounds: NoteSoundAssetManifest;
  palette: OurNotesPalette;
  /** NoteSkinAssetUnit tilt thresholds, measured in lane units. */
  tiltThresholds: ReadonlyArray<{ distance: number; value: number }>;
}

/** Exact build-specific media URLs resolved from Unity source descriptors. */
export interface OurNotesRuntimeMediaManifest {
  /** The selected immutable source ships the seventh Gekisou lane prefab. */
  gekisouLaneAvailable?: boolean;
  noteAtlasTextureUrl?: string;
  /** Selected from the note skins present in the active release. */
  noteSkin?: OurNotesNoteSkin;
  /** Selected from the note effect skins present in the active release. */
  noteEffectSkin?: OurNotesNoteEffectSkin;
  /** Native ILiveResourceLoadParameter.CurrentQuality; quality 2 selects Light for effect001. */
  currentQuality?: number;
  /** Selected MasterLiveNoteSeGroup row; omitted for the formal group-1 default. */
  noteSeGroup?: OurNotesNoteSeGroup;
  fontAtlasTextureUrl?: string;
  hud: HudAssetManifest;
}

/** Native live quality values: 0 = High, 1 = Middle, 2 = Low. */
export type OurNotesLiveQuality = 0 | 1 | 2;

export interface OurNotesLiveQualitySettings {
  quality: OurNotesLiveQuality;
  /** LiveEffectCamera render scale for the HDR effect target. */
  effectRenderingScale: number;
  backgroundCameraFps: number;
  live2dFps: number;
}

/** MasterLiveQualitySettings rows, keyed by `_quality`. */
export const OUR_NOTES_LIVE_QUALITY_SETTINGS: Readonly<Record<OurNotesLiveQuality, OurNotesLiveQualitySettings>> = {
  0: { quality: 0, effectRenderingScale: 1, backgroundCameraFps: 30, live2dFps: 30 },
  1: { quality: 1, effectRenderingScale: 0.85, backgroundCameraFps: 25, live2dFps: 25 },
  2: { quality: 2, effectRenderingScale: 0.71, backgroundCameraFps: 20, live2dFps: 20 },
};

export const OUR_NOTES_LIVE_QUALITIES: readonly OurNotesLiveQuality[] = [0, 1, 2];

export const OUR_NOTES_LIVE_QUALITY_NAMES: Readonly<Record<OurNotesLiveQuality, Readonly<Record<string, string>>>> = {
  0: { ja: "高", en: "High", "zh-TW": "高", "zh-CN": "高", ko: "높음" },
  1: { ja: "中", en: "Middle", "zh-TW": "中", "zh-CN": "中", ko: "중간" },
  2: { ja: "低", en: "Low", "zh-TW": "低", "zh-CN": "低", ko: "낮음" },
};

export type OurNotesNoteSkin = "skin001" | "skin002" | "skin003";

export const OUR_NOTES_NOTE_SKINS: readonly OurNotesNoteSkin[] = ["skin001", "skin002", "skin003"];

export const OUR_NOTES_NOTE_SKIN_NAMES: Readonly<Record<OurNotesNoteSkin, Readonly<Record<string, string>>>> = {
  skin001: { ja: "アワーノーツ", en: "Our Notes", "zh-TW": "交織的樂章", "zh-CN": "交织的乐章", ko: "아워 노트" },
  skin002: { ja: "ガルパ", en: "Garupa", "zh-TW": "邦邦", "zh-CN": "少女乐团派对", ko: "걸파" },
  skin003: { ja: "ハニカム", en: "Honeycomb", "zh-TW": "Honeycomb", "zh-CN": "蜂巢", ko: "허니콤" },
};

export type OurNotesNoteEffectSkin = "effect001" | "effect001Simple";

/** Native LiveNoteEffectAssetSettings profile, kept separate from user skin selection. */
export type OurNotesAuthoredEffectProfile = "full" | "light" | "simple";

export const OUR_NOTES_AUTHORED_EFFECT_PROFILES: readonly OurNotesAuthoredEffectProfile[] = ["full", "light", "simple"];

export const OUR_NOTES_NOTE_EFFECT_SKINS: readonly OurNotesNoteEffectSkin[] = ["effect001", "effect001Simple"];

export const OUR_NOTES_NOTE_EFFECT_SKIN_NAMES: Readonly<
  Record<OurNotesNoteEffectSkin, Readonly<Record<string, string>>>
> = {
  effect001: { ja: "スタンダード", en: "Standard", "zh-TW": "標準", "zh-CN": "标准", ko: "스탠다드" },
  effect001Simple: { ja: "シンプル", en: "Simple", "zh-TW": "簡約", "zh-CN": "简洁", ko: "심플" },
};

export const OUR_NOTES_LANE_SKIN_NAMES: Readonly<Record<"skin001", Readonly<Record<string, string>>>> = {
  skin001: { ja: "スタンダード", en: "Standard", "zh-TW": "標準", "zh-CN": "标准", ko: "스탠다드" },
};

export const OUR_NOTES_STAGE_NAMES: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  0: { ja: "ステージ", en: "Stage", "zh-TW": "舞台", "zh-CN": "舞台", ko: "스테이지" },
  1: { ja: "MyGO!!!!!", en: "MyGO!!!!!", "zh-TW": "MyGO!!!!!", "zh-CN": "MyGO!!!!!", ko: "MyGO!!!!!" },
  2: { ja: "Ave Mujica", en: "Ave Mujica", "zh-TW": "Ave Mujica", "zh-CN": "Ave Mujica", ko: "Ave Mujica" },
  3: {
    ja: "夢限大みゅーたいぷ",
    en: "Mugendai MewType",
    "zh-TW": "夢限大MewType",
    "zh-CN": "梦限大MewType",
    ko: "무겐다이 뮤타입",
  },
  4: { ja: "millsage", en: "millsage", "zh-TW": "millsage", "zh-CN": "millsage", ko: "millsage" },
  5: {
    ja: "一家Dumb Rock!",
    en: "Ikka Dumb Rock!",
    "zh-TW": "一家Dumb Rock!",
    "zh-CN": "一家Dumb Rock!",
    ko: "일가 Dumb Rock!",
  },
};

export const OUR_NOTES_NOTE_SE_GROUP_NAMES: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  1: { ja: "アワーノーツ", en: "Our Notes", "zh-TW": "交織的樂章", "zh-CN": "交织的乐章", ko: "아워 노트" },
  2: { ja: "ソリッド", en: "Solid", "zh-TW": "厚實", "zh-CN": "清脆", ko: "솔리드" },
  3: { ja: "ウッド", en: "Wood", "zh-TW": "木質", "zh-CN": "木材", ko: "우드" },
  4: { ja: "タイピング", en: "Typing", "zh-TW": "打字", "zh-CN": "打字", ko: "타이핑" },
};

export function ourNotesNoteAtlasSource(skin: OurNotesNoteSkin): string {
  return `Assets/AddressableResources/Live/Note/${skin}/${skin}.spriteatlasv2`;
}

export const OUR_NOTES_SLIDE_LINE_STYLES: Readonly<Record<OurNotesNoteSkin, OurNotesSlideLineStyle>> = {
  skin001: {
    disabled: {
      colors: [
        [0.0, 0.16862745583057404, 0.23137255012989044, 0.7058823704719543],
        [1.0, 0.20392157137393951, 0.25882354378700256, 0.6705882549285889],
      ],
      alpha: [0.0, 0.8235294222831726, 1.0, 0.8235294222831726],
    },
    normal: {
      colors: [
        [0.0, 0.3066037893295288, 0.4137139916419983, 1.0],
        [0.5499961852445259, 0.3152367174625397, 0.49328362941741943, 0.8679245114326477],
        [1.0, 0.30371129512786865, 0.537699818611145, 0.8584905862808228],
      ],
      alpha: [0.008819714656290532, 0.7843137383460999, 1.0, 0.7843137383460999],
    },
    pressed: {
      colors: [
        [0.0, 0.3349056839942932, 0.621050238609314, 1.0],
        [0.5499961852445259, 0.2971698045730591, 0.6405064463615417, 1.0],
        [0.758831158922713, 0.2862745523452759, 0.7447482943534851, 1.0],
        [1.0, 0.3529411554336548, 0.9071850776672363, 1.0],
      ],
      alpha: [0.0, 0.7254902124404907, 1.0, 0.6666666865348816],
    },
    widthScale: 0.8999999761581421,
    glowRangeScale: 2.5,
    guide: [0.60784316, 0.48627451, 1, 0.47058824],
    glow: {
      color: [0.13679248094558716, 0.8075256943702698, 1.0, 1.0],
      intensity: 0.5,
      falloff: 2.700000047683716,
      width: 1.0,
      disabledScale: 0.4000000059604645,
      enabledScale: 0.2800000011920929,
      pressedScale: 0.8700000047683716,
    },
  },
  skin002: {
    disabled: {
      colors: [
        [0.0, 0.1809362918138504, 0.35849058628082275, 0.21999824047088623],
        [1.0, 0.18431372940540314, 0.3607843220233917, 0.2235294133424759],
      ],
      alpha: [0.0, 0.5490196347236633, 0.9941252765697719, 0.9019607901573181],
    },
    normal: {
      colors: [
        [0.0, 0.4078431725502014, 0.9333333373069763, 0.4600856900215149],
        [0.5000076295109483, 0.41176465153694153, 0.9333333373069763, 0.48584169149398804],
        [1.0, 0.41176465153694153, 0.9333333373069763, 0.5477529168128967],
      ],
      alpha: [0.0, 0.4313725531101227, 1.0, 0.3921568691730499],
    },
    pressed: {
      colors: [
        [0.0, 0.46751517057418823, 0.9622641801834106, 0.5107074975967407],
        [0.5000076295109483, 0.4493592083454132, 0.9622641801834106, 0.5226312875747681],
        [1.0, 0.4539426863193512, 0.9528301954269409, 0.5877023935317993],
      ],
      alpha: [0.0, 0.5490196347236633, 1.0, 0.5490196347236633],
    },
    widthScale: 0.8999999761581421,
    glowRangeScale: 2.0,
    guide: [0.42697579, 0.9528302, 0.8797366, 0.35294119],
    glow: {
      color: [0.1619793325662613, 0.9811320900917053, 0.22265727818012238, 1.0],
      intensity: 0.8999999761581421,
      falloff: 4.349999904632568,
      width: 0.8700000047683716,
      disabledScale: 0.10000000149011612,
      enabledScale: 0.4000000059604645,
      pressedScale: 0.699999988079071,
    },
  },
  skin003: {
    disabled: {
      colors: [
        [0.0, 0.16862745583057404, 0.23137255012989044, 0.7058823704719543],
        [1.0, 0.20392157137393951, 0.25882354378700256, 0.6705882549285889],
      ],
      alpha: [0.0, 0.8235294222831726, 1.0, 0.8235294222831726],
    },
    normal: {
      colors: [
        [0.0, 0.3066037893295288, 0.4137139916419983, 1.0],
        [0.5499961852445259, 0.3152367174625397, 0.49328362941741943, 0.8679245114326477],
        [1.0, 0.30371129512786865, 0.537699818611145, 0.8584905862808228],
      ],
      alpha: [0.008819714656290532, 0.7843137383460999, 1.0, 0.7843137383460999],
    },
    pressed: {
      colors: [
        [0.0, 0.3349056839942932, 0.621050238609314, 1.0],
        [0.5499961852445259, 0.2971698045730591, 0.6405064463615417, 1.0],
        [0.758831158922713, 0.2862745523452759, 0.7447482943534851, 1.0],
        [1.0, 0.3529411554336548, 0.9071850776672363, 1.0],
      ],
      alpha: [0.0, 0.7254902124404907, 1.0, 0.6666666865348816],
    },
    widthScale: 0.8999999761581421,
    glowRangeScale: 2.5,
    guide: [0.19215685, 0.68298382, 1, 0.43137255],
    glow: {
      color: [0.13679248094558716, 0.8075256943702698, 1.0, 1.0],
      intensity: 0.5,
      falloff: 2.700000047683716,
      width: 1.0,
      disabledScale: 0.4000000059604645,
      enabledScale: 0.2800000011920929,
      pressedScale: 0.8700000047683716,
    },
  },
};

/** Host controls storage: HTTPS, bundled files, or an application resource scheme. */
export interface OurNotesAssetResolver {
  asset(sourcePath: string): string;
  runtime(relativePath: string): string;
}

export function createOurNotesAssetManifest(
  media: OurNotesRuntimeMediaManifest,
  resolver: OurNotesAssetResolver,
): OurNotesAssetManifest {
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value.startsWith(`${RELEASE_TEMPLATE_ASSET_ROOT}/`)) {
        return resolver.asset(decodeURIComponent(value.slice(RELEASE_TEMPLATE_ASSET_ROOT.length + 1)));
      }
      if (value.startsWith(`${RELEASE_TEMPLATE_RUNTIME_ROOT}/`)) {
        return resolver.runtime(decodeURIComponent(value.slice(RELEASE_TEMPLATE_RUNTIME_ROOT.length + 1)));
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
    }
    return value;
  };
  return { ...(visit(buildOurNotesSkinManifest(media)) as OurNotesAssetManifest), presentationAssets: resolver };
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

// Static manifest definitions use a non-server template marker. Hosts must
// replace it with the exact release that owns every runtime asset; never let a
// missing argument silently point a fallback detail at a particular release.
const RELEASE_TEMPLATE_ID = "__release_template__";
const RELEASE_TEMPLATE_ASSET_ROOT = `/assets/${RELEASE_TEMPLATE_ID}`;
const RELEASE_TEMPLATE_RUNTIME_ROOT = `/runtime/${RELEASE_TEMPLATE_ID}`;
const NOTE_SOURCE = "Assets/AddressableResources/Live/Note/skin001";
const LANE_SOURCE = "Assets/AddressableResources/Live/Lane/skin001";
const EFFECT001_SOURCE = "Assets/AddressableResources/Effect/Live/NoteEffect/effect001";
const EFFECT001LIGHT_SOURCE = "Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light";
const EFFECT_COMMON_SOURCE = "Assets/AddressableResources/Effect/Live/NoteEffect/common";
const EFFECT_COMMON_TEXTURE_SOURCE = `${EFFECT_COMMON_SOURCE}/Texture`;
const EFFECT_COMMON_LIGHT_TEXTURE_SOURCE = `${EFFECT_COMMON_SOURCE}/TextureLight`;
const LANE_EFFECT_SOURCE = "Assets/AddressableResources/Effect/Live/LaneEffect/effect001";
const LANE_EFFECT_TEXTURE_SOURCE = "Assets/AddressableResources/Effect/Live/LaneEffect/Common/lane_effect_white.png";
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
const sourceAsset = (value: string): string => `${RELEASE_TEMPLATE_ASSET_ROOT}/${encodeUnityPath(value)}`;
const unityObject = (source: string, type: string, ordinal = 0): string =>
  `${RELEASE_TEMPLATE_RUNTIME_ROOT}/unity-json/${encodeUnityPath(source)}/${type}${ordinal ? `_${ordinal}` : ""}.json`;
const objectOrdinal = (filename: string): { type: string; ordinal: number } => {
  const match = /^([A-Za-z0-9]+)(?:_(\d+))?\.asset$/.exec(filename);
  const type = match?.[1];
  if (!type) throw new TypeError(`Invalid Unity object projection name: ${filename}`);
  return { type, ordinal: Number(match[2] || 0) };
};

const noteSound = (runtimeRoot: string, name: string): string => `${runtimeRoot}/note-se/${name}.mp3`;

/** Confirmed LiveNoteSeType.Slide sequence gains from ACB opcode .0092. */
const NOTE_SE_HELD_GAINS: Readonly<Record<OurNotesNoteSeGroup, number>> = {
  1: 0.35,
  2: 0.45,
  3: 0.35,
  4: 0.35,
};

function resolveNoteSeGroup(group: OurNotesNoteSeGroup | undefined): OurNotesNoteSeGroup {
  const selected = group ?? 1;
  if (!OUR_NOTES_NOTE_SE_GROUP_IDS.includes(selected)) {
    throw new TypeError(`noteSeGroup must be one of ${OUR_NOTES_NOTE_SE_GROUP_IDS.join(", ")}: ${selected}`);
  }
  return selected;
}

function noteSoundForType(
  group: OurNotesNoteSeGroup,
  type: OurNotesNoteSeType,
  runtimeRoot = RELEASE_TEMPLATE_RUNTIME_ROOT,
): NoteSoundAsset {
  const cue = OUR_NOTES_NOTE_SE_CUES[group][type];
  if (typeof cue === "string") {
    return type === 7
      ? [
          {
            url: noteSound(runtimeRoot, cue),
            gain: NOTE_SE_HELD_GAINS[group],
            ...(group === 3 || group === 4
              ? { loopStartSeconds: 0, loopEndSeconds: (group === 3 ? 88065 : 86017) / 48000 }
              : {}),
          },
        ]
      : noteSound(runtimeRoot, cue);
  }
  // Preserve the formal default layer ratio and apply the confirmed sequence gain.
  return [
    { url: noteSound(runtimeRoot, cue[0]), gain: 0.85 * NOTE_SE_HELD_GAINS[group] },
    { url: noteSound(runtimeRoot, cue[1]), gain: 0.75 * NOTE_SE_HELD_GAINS[group] },
  ];
}

function noteSoundManifest(
  group: OurNotesNoteSeGroup,
  runtimeRoot = RELEASE_TEMPLATE_RUNTIME_ROOT,
): NoteSoundAssetManifest {
  const byType = Object.fromEntries(
    OUR_NOTES_NOTE_SE_TYPE_IDS.map((type) => [`type${type}`, noteSoundForType(group, type, runtimeRoot)]),
  ) as Record<`type${OurNotesNoteSeType}`, NoteSoundAsset>;
  return {
    ...byType,
    // Standard gameplay keys retain their established LiveSoundPlayer meaning.
    good: byType.type2,
    great: byType.type3,
    perfect: byType.type4,
    flick: byType.type5,
    flickDirection: byType.type6,
    slide: byType.type7,
    just: byType.type8,
    trace: byType.type9,
  };
}

function normalizeReleaseServer(releaseServer: string): string {
  const normalizedReleaseServer = String(releaseServer || "").trim();
  if (!normalizedReleaseServer) throw new TypeError("A concrete release server is required for chart runtime media");
  if (
    normalizedReleaseServer === "." ||
    normalizedReleaseServer === ".." ||
    normalizedReleaseServer.includes("/") ||
    normalizedReleaseServer.includes("\\")
  ) {
    throw new TypeError(`Invalid release server: ${normalizedReleaseServer}`);
  }
  return encodeURIComponent(normalizedReleaseServer);
}

/** Native gameplay note sounds resolved to the exact server namespace. */
export function ourNotesNoteSoundsForRelease(
  releaseServer: string,
  noteSeGroup?: OurNotesNoteSeGroup,
): NoteSoundAssetManifest {
  const encodedReleaseServer = normalizeReleaseServer(releaseServer);
  return noteSoundManifest(resolveNoteSeGroup(noteSeGroup), `/runtime/${encodedReleaseServer}`);
}

const effect001Root = (prefab: string, objectFile: string): string => {
  const object = objectOrdinal(objectFile);
  return unityObject(`${EFFECT001_SOURCE}/${prefab}`, object.type, object.ordinal);
};
const effect001LightRoot = (prefab: string, objectFile: string): string => {
  const object = objectOrdinal(objectFile);
  return unityObject(`${EFFECT001LIGHT_SOURCE}/${prefab}`, object.type, object.ordinal);
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
  resolveMetadata: (root: string, file: string) => string = effect001Root,
): Effect001ParticleSystemAssetRef {
  const rendererPivot =
    options.rendererPivot ?? (options.renderer === "wallMesh" ? ([0, -0.21, -0.5] as const) : undefined);
  // Source renderer records use .5 for every star/point system and 1 for
  // long-star, center-line and wall systems. Keep the value on the manifest
  // even for walls; ParticleQuadBatch deliberately consumes billboards only.
  const rendererMaxParticleSize = options.rendererMaxParticleSize ?? (texture === "star" ? 0.5 : 1);
  const metadataUrl = resolveMetadata(root, file);
  return {
    name,
    metadataUrl,
    ...particleActivityFor(metadataUrl),
    texture,
    localPosition,
    ...options,
    rendererMaxParticleSize,
    ...(rendererPivot ? { rendererPivot } : {}),
  };
}

function particleActivityFor(
  metadataUrl: string,
): Pick<Effect001ParticleSystemAssetRef, "baseActiveHierarchy" | "rendererEnabled"> {
  const key = metadataUrl.slice(RELEASE_TEMPLATE_RUNTIME_ROOT.length + 1);
  const entries: Readonly<Record<string, {
    hierarchy: ReadonlyArray<{ path: string; active: boolean }>;
    rendererEnabled: boolean;
  }>> = effectParticleActivity.particles;
  const source = entries[key];
  if (!source) throw new Error(`Missing original particle activity: ${key}`);
  return { baseActiveHierarchy: source.hierarchy, rendererEnabled: source.rendererEnabled };
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
  perfect: effectCommonRoot("Animation/tap_perfect.anim"),
  great: effectCommonRoot("Animation/tap_great.anim"),
  good: effectCommonRoot("Animation/tap_good.anim"),
  bad: effectCommonRoot("Animation/tap_bad.anim"),
} as const;
const SLIDE_ANIMATION_CLIPS = {
  perfect: effectCommonRoot("Animation/tap_slide_parfect.anim"),
  great: effectCommonRoot("Animation/tap_slide_great.anim"),
  good: effectCommonRoot("Animation/tap_slide_good.anim"),
  bad: effectCommonRoot("Animation/tap_slide_bad.anim"),
} as const;
const FLICK_ANIMATION_CLIPS = {
  perfect: effectCommonRoot("Animation/tap_flick_perfect.anim"),
  great: effectCommonRoot("Animation/tap_flick_great.anim"),
  good: effectCommonRoot("Animation/tap_flick_good.anim"),
  bad: effectCommonRoot("Animation/tap_flick_bad.anim"),
} as const;
const TAP_PERFECT_CLIP = TAP_ANIMATION_CLIPS.perfect;
const SLIDE_PERFECT_CLIP = SLIDE_ANIMATION_CLIPS.perfect;
const FLICK_PERFECT_CLIP = FLICK_ANIMATION_CLIPS.perfect;
const SLIDE_LOOP_CLIP = effectCommonRoot("Animation/tap_slide_loop.anim");

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
        [0.11372549086809158, 0.11764705926179886, 0.9058823585510254, 1],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      effectSprite(
        "note_slide.prefab",
        "SpriteRenderer_4.asset",
        "pillar01",
        [0.11372549086809158, 0.11764705926179886, 0.9058823585510254, 1],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_slide.prefab",
        "SpriteRenderer.asset",
        "pillar02",
        [0.11372549086809158, 0.11764705926179886, 0.9058823585510254, 1],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_slide.prefab",
        "SpriteRenderer_3.asset",
        "pillar03",
        [0.11372549086809158, 0.11764705926179886, 0.9058823585510254, 1],
        [1, 4],
        [-2.5, -0.06, -0.54],
      ),
      effectSprite(
        "note_slide.prefab",
        "SpriteRenderer_2.asset",
        "pillar04",
        [0.11372549086809158, 0.11764705926179886, 0.9058823585510254, 1],
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
      effectParticle("note_just.prefab", "ParticleSystem_2.asset", "ef_particle_point", "star", [0, -0.53, 0], {
        animationPath: "ef_splash/ef_particle_point",
        shapeWidthOffset: 0.08,
      }),
      effectParticle("note_just.prefab", "ParticleSystem_3.asset", "ef_particle_star", "star", [0, -0.531, 0], {
        animationPath: "ef_splash/ef_particle_star",
        shapeWidthOffset: -0.02,
      }),
      effectParticle("note_just.prefab", "ParticleSystem_1.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      effectSprite(
        "note_just.prefab",
        "SpriteRenderer_4.asset",
        "frame",
        [0.5, 0.45834264159202576, 0.030660390853881836, 0],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      effectSprite(
        "note_just.prefab",
        "SpriteRenderer_1.asset",
        "pillar01",
        [0.1603773832321167, 0.14632397890090942, 0.038581348955631256, 0],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_just.prefab",
        "SpriteRenderer_2.asset",
        "pillar02",
        [0.1603773832321167, 0.14632397890090942, 0.038581348955631256, 0],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      effectSprite(
        "note_just.prefab",
        "SpriteRenderer.asset",
        "pillar03",
        [0.28301888704299927, 0.25544610619544983, 0.04405483230948448, 0],
        [1, 4],
        [-2.5, -0.06, -0.54],
      ),
      effectSprite(
        "note_just.prefab",
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
        [0.11372549086809158, 0.11764705926179886, 0.9058823585510254, 1],
        [5.5, 1.75],
        [0, 0, 0],
        true,
      ),
      effectSprite(
        "note_slide_loop.prefab",
        "SpriteRenderer_3.asset",
        "pillar01",
        [0.1137254610657692, 0.11764705926179886, 0.9058823585510254, 0.1568627506494522],
        [4, 6],
        [-2.5, -0.06, 0.64],
        true,
      ),
      effectSprite(
        "note_slide_loop.prefab",
        "SpriteRenderer_2.asset",
        "pillar02",
        [0.1137254610657692, 0.11764705926179886, 0.9058823585510254, 0.1568627506494522],
        [4, 6],
        [2.5, -0.06, 0.64],
        true,
      ),
      effectSprite(
        "note_slide_loop.prefab",
        "SpriteRenderer_4.asset",
        "pillar03",
        [0.1137254610657692, 0.11764705926179886, 0.9058823585510254, 0.1568627506494522],
        [4, 4],
        [-2.5, -0.06, -0.54],
        true,
      ),
      effectSprite(
        "note_slide_loop.prefab",
        "SpriteRenderer.asset",
        "pillar04",
        [0.1137254610657692, 0.11764705926179886, 0.9058823585510254, 0.1568627506494522],
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
        [0.11372549086809158, 0.11764705926179886, 0.9058823585510254, 1],
        [5.5, 1.75],
        [0, 0, 0],
      ),
    ],
  },
};

/** Light authored profile from effect001Light; it is not a user skin. */
function lightParticle(
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
      | "materialTint"
    >
  > = {},
): Effect001ParticleSystemAssetRef {
  return {
    ...effectParticle(root, file, name, texture, localPosition, options, effect001LightRoot),
    materialTint:
      options.materialTint ??
      (texture === "wall"
        ? [0.5471698045730591, 0.5471698045730591, 0.5471698045730591, 1]
        : texture === "centerPillar" || texture === "centerPillar02"
          ? [0.4433962106704712, 0.4433962106704712, 0.4433962106704712, 1]
          : [1, 1, 1, 1]),
  };
}

function lightSprite(
  root: string,
  file: string,
  name: Effect001SpriteName,
  baseColor: readonly [number, number, number, number],
  baseSize: readonly [number, number],
  localPosition: readonly [number, number, number],
  baseActive = false,
  flipX = false,
): Effect001SpriteAssetRef {
  return {
    ...effectSprite(root, file, name, baseColor, baseSize, localPosition, baseActive, flipX),
    metadataUrl: effect001LightRoot(root, file),
    materialTint: [1, 1, 1, 1],
  };
}

export const EFFECT001LIGHT_PREFABS: Readonly<Record<keyof typeof EFFECT001_PREFAB_IDS, Effect001PrefabAssetRef>> = {
  Normal: {
    id: EFFECT001_PREFAB_IDS.Normal,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: TAP_PERFECT_CLIP,
    animationClipUrls: TAP_ANIMATION_CLIPS,
    particleSystems: [
      lightParticle("note_normal_light.prefab", "ParticleSystem_3.asset", "ef_particle_point", "star", [0, -0.53, 0], {
        animationPath: "ef_splash/ef_particle_point",
        shapeWidthOffset: 0.08,
      }),
      lightParticle("note_normal_light.prefab", "ParticleSystem.asset", "ef_particle_star", "star", [0, -0.531, 0], {
        animationPath: "ef_splash/ef_particle_star",
        shapeWidthOffset: -0.02,
      }),
      lightParticle("note_normal_light.prefab", "ParticleSystem_1.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      lightSprite(
        "note_normal_light.prefab",
        "SpriteRenderer.asset",
        "frame",
        [0.0777856633067131, 0.23382169008255005, 0.8679245114326477, 0],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      lightSprite(
        "note_normal_light.prefab",
        "SpriteRenderer_1.asset",
        "pillar01",
        [0, 0.4424777030944824, 1, 0],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      lightSprite(
        "note_normal_light.prefab",
        "SpriteRenderer_4.asset",
        "pillar02",
        [0, 0.4424777030944824, 1, 0],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      lightSprite(
        "note_normal_light.prefab",
        "SpriteRenderer_3.asset",
        "pillar03",
        [0, 0.4424777030944824, 1, 0],
        [1, 4],
        [-2.5, -0.06, -0.61],
      ),
      lightSprite(
        "note_normal_light.prefab",
        "SpriteRenderer_2.asset",
        "pillar04",
        [0, 0.4424777030944824, 1, 0],
        [1, 4],
        [2.5, -0.06, -0.61],
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
      lightParticle("note_slide_light.prefab", "ParticleSystem_1.asset", "ef_particle_point", "star", [0, -0.53, 0], {
        animationPath: "ef_splash/ef_particle_point",
        shapeWidthOffset: 0.08,
      }),
      lightParticle("note_slide_light.prefab", "ParticleSystem_3.asset", "ef_particle_star", "star", [0, -0.531, 0], {
        animationPath: "ef_splash/ef_particle_star",
        localRotationX: -Math.PI / 2,
        shapeWidthOffset: -0.02,
      }),
      lightParticle("note_slide_light.prefab", "ParticleSystem_2.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      lightSprite(
        "note_slide_light.prefab",
        "SpriteRenderer_3.asset",
        "frame",
        [0.29026374220848083, 0.05090780183672905, 0.9811320900917053, 1],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      lightSprite(
        "note_slide_light.prefab",
        "SpriteRenderer_1.asset",
        "pillar01",
        [0.0716320127248764, 0.03764684498310089, 0.16981130838394165, 1],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      lightSprite(
        "note_slide_light.prefab",
        "SpriteRenderer.asset",
        "pillar02",
        [0.0716320127248764, 0.03764684498310089, 0.16981130838394165, 1],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      lightSprite(
        "note_slide_light.prefab",
        "SpriteRenderer_4.asset",
        "pillar03",
        [0.15670402348041534, 0.061943765729665756, 0.4528301954269409, 1],
        [1, 4],
        [-2.5, -0.06, -0.54],
      ),
      lightSprite(
        "note_slide_light.prefab",
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
      lightParticle("note_flick_light.prefab", "ParticleSystem_9.asset", "ef_particle_point", "star", [0, -0.53, 0], {
        animationPath: "ef_splash/ef_particle_point",
        shapeWidthOffset: 0.08,
      }),
      lightParticle("note_flick_light.prefab", "ParticleSystem_1.asset", "ef_particle_star", "star", [0, -0.531, 0], {
        animationPath: "ef_splash/ef_particle_star",
        shapeWidthOffset: -0.02,
      }),
      lightParticle(
        "note_flick_light.prefab",
        "ParticleSystem_2.asset",
        "ef_particle_point01",
        "star",
        [0, 0.7100000381469727, 0],
        {
          animationPath: "ef_splash_move/ef_particle_point01",
          widthScaleRange: [0.05, 3],
        },
      ),
      lightParticle(
        "note_flick_light.prefab",
        "ParticleSystem_6.asset",
        "ef_particle_point02",
        "star",
        [0, 0.7100000381469727, 0],
        {
          animationPath: "ef_splash_move/ef_particle_point02",
          widthScaleRange: [0.05, 3],
        },
      ),
      lightParticle(
        "note_flick_light.prefab",
        "ParticleSystem_5.asset",
        "ef_particl_splash",
        "longStar",
        [0, 1.8, -0.2],
        {
          animationPath: "ef_splash_move/ef_particl_splash",
          localScale: [1.02, 1, 1],
          widthScaleRange: [0.05, 3],
        },
      ),
      lightParticle(
        "note_flick_light.prefab",
        "ParticleSystem_7.asset",
        "ef_particl_splash_line",
        "centerPillar",
        [0, 0.15, -0.2],
        {
          animationPath: "ef_splash_move/ef_particl_splash_line",
          rendererPivot: [0, 0.3, 0],
          widthScaleRange: [0.05, 3],
        },
      ),
      lightParticle(
        "note_flick_light.prefab",
        "ParticleSystem_4.asset",
        "ef_particl_splash_line02",
        "centerPillar02",
        [0, -0.5, -0.2],
        {
          animationPath: "ef_splash_move/ef_particl_splash_line02",
          rendererPivot: [0, 0.3, 0],
          widthScaleRange: [0.05, 3],
        },
      ),
      lightParticle("note_flick_light.prefab", "ParticleSystem_8.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      lightSprite(
        "note_flick_light.prefab",
        "SpriteRenderer_2.asset",
        "frame",
        [0.6792452931404114, 0.30566415190696716, 0.06728372722864151, 0],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      lightSprite(
        "note_flick_light.prefab",
        "SpriteRenderer_3.asset",
        "pillar01",
        [0.37735849618911743, 0.20075224339962006, 0.08721965551376343, 0],
        [3, 6],
        [-2.5, -0.06, 0.64],
      ),
      lightSprite(
        "note_flick_light.prefab",
        "SpriteRenderer_4.asset",
        "pillar02",
        [0.37735849618911743, 0.20075224339962006, 0.08721965551376343, 0],
        [3, 6],
        [2.5, -0.06, 0.64],
        false,
        true,
      ),
      lightSprite(
        "note_flick_light.prefab",
        "SpriteRenderer_1.asset",
        "pillar03",
        [0.43396228551864624, 0.21204276382923126, 0.07164470851421356, 0],
        [4, 4],
        [-2.5, -0.06, -0.54],
      ),
      lightSprite(
        "note_flick_light.prefab",
        "SpriteRenderer.asset",
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
    distanceEmitterPathHash: unityStringHash("ef_splash_move/ef_splash"),
    particleSystems: [
      lightParticle(
        "note_flick_left_light.prefab",
        "ParticleSystem_6.asset",
        "ef_particle_point",
        "star",
        [0, -0.53, 0],
        {
          animationPath: "ef_splash/ef_particle_point",
          shapeWidthOffset: 0.08,
        },
      ),
      lightParticle(
        "note_flick_left_light.prefab",
        "ParticleSystem_1.asset",
        "ef_particle_star",
        "star",
        [0, -0.531, 0],
        {
          animationPath: "ef_splash/ef_particle_star",
          shapeWidthOffset: -0.02,
        },
      ),
      lightParticle("note_flick_left_light.prefab", "ParticleSystem_2.asset", "ef_splash", "longStar", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash",
        widthScaleRange: [0.082, 1.5],
      }),
      lightParticle("note_flick_left_light.prefab", "ParticleSystem_3.asset", "ef_splash02", "star", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash/ef_splash02",
        widthScaleRange: [0.082, 1.5],
      }),
      lightParticle("note_flick_left_light.prefab", "ParticleSystem_5.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      lightSprite(
        "note_flick_left_light.prefab",
        "SpriteRenderer_1.asset",
        "frame",
        [0.03921568766236305, 0.5568627715110779, 0.14509804546833038, 0],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      lightSprite(
        "note_flick_left_light.prefab",
        "SpriteRenderer_4.asset",
        "pillar01",
        [0.02429690957069397, 0.1320754885673523, 0.04532688111066818, 0],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      lightSprite(
        "note_flick_left_light.prefab",
        "SpriteRenderer_2.asset",
        "pillar02",
        [0.02429690957069397, 0.1320754885673523, 0.04532688111066818, 0],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      lightSprite(
        "note_flick_left_light.prefab",
        "SpriteRenderer_3.asset",
        "pillar03",
        [0.05598077550530434, 0.3207547068595886, 0.11271801590919495, 0],
        [1, 4],
        [-2.5, -0.06, -0.54],
      ),
      lightSprite(
        "note_flick_left_light.prefab",
        "SpriteRenderer.asset",
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
      lightParticle(
        "note_flick_right_light.prefab",
        "ParticleSystem_2.asset",
        "ef_particle_point",
        "star",
        [0, -0.53, 0],
        {
          animationPath: "ef_splash/ef_particle_point",
          shapeWidthOffset: 0.08,
        },
      ),
      lightParticle(
        "note_flick_right_light.prefab",
        "ParticleSystem_4.asset",
        "ef_particle_star",
        "star",
        [0, -0.531, 0],
        {
          animationPath: "ef_splash/ef_particle_star",
          shapeWidthOffset: -0.02,
        },
      ),
      lightParticle("note_flick_right_light.prefab", "ParticleSystem_3.asset", "ef_splash", "longStar", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash",
        widthScaleRange: [0.082, 1.5],
      }),
      lightParticle("note_flick_right_light.prefab", "ParticleSystem_1.asset", "ef_splash02", "star", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash/ef_splash02",
        widthScaleRange: [0.082, 1.5],
      }),
      lightParticle("note_flick_right_light.prefab", "ParticleSystem.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      lightSprite(
        "note_flick_right_light.prefab",
        "SpriteRenderer_4.asset",
        "frame",
        [1, 0.15566039085388184, 0.6591655611991882, 0],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      lightSprite(
        "note_flick_right_light.prefab",
        "SpriteRenderer_2.asset",
        "pillar01",
        [0.18867921829223633, 0.07386969029903412, 0.14247536659240723, 0],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      lightSprite(
        "note_flick_right_light.prefab",
        "SpriteRenderer_3.asset",
        "pillar02",
        [0.18867921829223633, 0.07386969029903412, 0.14247536659240723, 0],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      lightSprite(
        "note_flick_right_light.prefab",
        "SpriteRenderer_1.asset",
        "pillar03",
        [0.4150943160057068, 0.09202562272548676, 0.28141072392463684, 0],
        [1, 4],
        [-2.5, -0.06, -0.54],
      ),
      lightSprite(
        "note_flick_right_light.prefab",
        "SpriteRenderer.asset",
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
      lightParticle("note_just_light.prefab", "ParticleSystem_3.asset", "ef_particle_point", "star", [0, -0.53, 0], {
        animationPath: "ef_splash/ef_particle_point",
        shapeWidthOffset: 0.08,
      }),
      lightParticle("note_just_light.prefab", "ParticleSystem_2.asset", "ef_particle_star", "star", [0, -0.531, 0], {
        animationPath: "ef_splash/ef_particle_star",
        shapeWidthOffset: -0.02,
      }),
      lightParticle("note_just_light.prefab", "ParticleSystem_1.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      lightSprite(
        "note_just_light.prefab",
        "SpriteRenderer_2.asset",
        "frame",
        [0.5, 0.45834264159202576, 0.030660390853881836, 0],
        [5.5, 1.75],
        [0, 0, 0],
      ),
      lightSprite(
        "note_just_light.prefab",
        "SpriteRenderer_4.asset",
        "pillar01",
        [0.1603773832321167, 0.14632397890090942, 0.038581348955631256, 0],
        [1.5, 6],
        [-2.5, -0.06, 0.64],
      ),
      lightSprite(
        "note_just_light.prefab",
        "SpriteRenderer_3.asset",
        "pillar02",
        [0.1603773832321167, 0.14632397890090942, 0.038581348955631256, 0],
        [1.5, 6],
        [2.5, -0.06, 0.64],
      ),
      lightSprite(
        "note_just_light.prefab",
        "SpriteRenderer.asset",
        "pillar03",
        [0.28301888704299927, 0.25544610619544983, 0.04405483230948448, 0],
        [1, 4],
        [-2.5, -0.06, -0.54],
      ),
      lightSprite(
        "note_just_light.prefab",
        "SpriteRenderer_1.asset",
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
      lightParticle(
        "note_slide_loop_light.prefab",
        "ParticleSystem.asset",
        "ef_particle_point",
        "star",
        [0, -0.531, 0],
        {
          animationPath: "ef_slide_loop/ef_particle_point",
          localRotationX: -Math.PI / 2,
          shapeWidthOffset: 0.08,
        },
      ),
      lightParticle(
        "note_slide_loop_light.prefab",
        "ParticleSystem_3.asset",
        "ef_particle_point_frame",
        "star",
        [0, -0.531, 0],
        {
          animationPath: "ef_slide_loop/ef_particle_point_frame",
          localRotationX: -Math.PI / 2,
          shapeWidthOffset: 0.08,
        },
      ),
      lightParticle("note_slide_loop_light.prefab", "ParticleSystem_2.asset", "ef_wall_center", "wall", [0, 0, 0], {
        animationPath: "ef_slide_loop/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      lightSprite(
        "note_slide_loop_light.prefab",
        "SpriteRenderer_4.asset",
        "frame",
        [0.2976938784122467, 0.051886796951293945, 1, 1],
        [5.5, 1.75],
        [0, 0, 0],
        true,
      ),
      lightSprite(
        "note_slide_loop_light.prefab",
        "SpriteRenderer_1.asset",
        "pillar01",
        [0.22390960156917572, 0.08050017803907394, 0.6320754289627075, 0.1568627506494522],
        [4, 6],
        [-2.5, -0.06, 0.64],
        true,
      ),
      lightSprite(
        "note_slide_loop_light.prefab",
        "SpriteRenderer_2.asset",
        "pillar02",
        [0.22390960156917572, 0.08050017803907394, 0.6320754289627075, 0.1568627506494522],
        [4, 6],
        [2.5, -0.06, 0.64],
        true,
      ),
      lightSprite(
        "note_slide_loop_light.prefab",
        "SpriteRenderer_3.asset",
        "pillar03",
        [0.22390960156917572, 0.08050017803907394, 0.6320754289627075, 0.1568627506494522],
        [4, 4],
        [-2.5, -0.06, -0.54],
        true,
      ),
      lightSprite(
        "note_slide_loop_light.prefab",
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
      lightParticle(
        "note_slide_connect_light.prefab",
        "ParticleSystem_1.asset",
        "ef_particle_point",
        "star",
        [0, -0.53, 0],
        {
          animationPath: "ef_splash/ef_particle_point",
          shapeWidthOffset: 0.08,
        },
      ),
      lightParticle(
        "note_slide_connect_light.prefab",
        "ParticleSystem_2.asset",
        "ef_particle_star",
        "star",
        [0, -0.531, 0],
        {
          animationPath: "ef_splash/ef_particle_star",
          localRotationX: -Math.PI / 2,
          shapeWidthOffset: -0.02,
        },
      ),
      lightParticle("note_slide_connect_light.prefab", "ParticleSystem_3.asset", "ef_splash", "star", [0, 0, 0], {
        materialTint: [2.9960782527923584, 2.9960782527923584, 2.9960782527923584, 0.615686297416687],
      }),
      lightParticle("note_slide_connect_light.prefab", "ParticleSystem.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      lightSprite(
        "note_slide_connect_light.prefab",
        "SpriteRenderer.asset",
        "frame",
        [0.39179620146751404, 0.18222679197788239, 0.9905660152435303, 1],
        [5.5, 1.75],
        [0, 0, 0],
      ),
    ],
  },
};

// ---------------------------------------------------------------------------
// effect001Simple (MasterLiveNoteEffectSkin id 2) shipped with the
// international 1.0.1 release. LiveNoteEffectAssetSettings maps its semantic
// slots onto note_groove_simple (FlickJust) and reuses note_slide_simple for
// SlideLoopConnect; note_performance_simple and note_slide_connect_simple are
// serialized but unreferenced by the settings asset and stay unlisted.
// ---------------------------------------------------------------------------

const EFFECT001SIMPLE_SOURCE = "Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple";
const EFFECT_SIMPLE_CLIP = (name: string): string =>
  unityObject(`${EFFECT_COMMON_SOURCE}/AnimationSimple/${name}.anim`, "AnimationClip");

const simpleObject = (prefab: string, type: string, ordinal = 0): string =>
  unityObject(`${EFFECT001SIMPLE_SOURCE}/${prefab}`, type, ordinal);

// Exact enabled Circle Transform records from the four source-owned Simple prefabs.
// Raw quaternion components remain data; this renderer supports their X-only axis.
const SIMPLE_CIRCLE_TRANSFORMS: Readonly<Record<string, {
  position: readonly [number, number, number]; scale: readonly [number, number, number];
  rotation: readonly [number, number, number, number];
  originalIdentity: { serializedFile: string; pathId: string };
}>> = {
  "note_slide_simple.prefab/ParticleSystem_2.asset": { position: [0.0, -0.5299999713897705, 0.550000011920929], scale: [1.0, 1.0, 1.0], rotation: [-0.7071068286895752, 0.0, 0.0, 0.7071068286895752], originalIdentity: { serializedFile: "CAB-4772c090a1eb6addb06df85d610e706e", pathId: "5299125697764409956" } },
  "note_slide_simple.prefab/ParticleSystem.asset": { position: [0.0, -0.5299999713897705, 0.550000011920929], scale: [1.0, 1.0, 1.0], rotation: [0.0, 0.0, 0.0, 1.0], originalIdentity: { serializedFile: "CAB-4772c090a1eb6addb06df85d610e706e", pathId: "-7558382824421113244" } },
  "note_groove_simple.prefab/ParticleSystem_2.asset": { position: [0.0, -0.531000018119812, 0.0], scale: [1.0, 1.0, 1.0], rotation: [0.0, 0.0, 0.0, 1.0], originalIdentity: { serializedFile: "CAB-624441186a770e3e79dab52c0e3d546e", pathId: "3689626888936687615" } },
  "note_groove_simple.prefab/ParticleSystem_3.asset": { position: [0.0, -0.5299999713897705, 0.0], scale: [1.0, 1.0, 1.0], rotation: [0.0, 0.0, 0.0, 1.0], originalIdentity: { serializedFile: "CAB-624441186a770e3e79dab52c0e3d546e", pathId: "8953216847793555455" } },
  "note_slide_simple_loop.prefab/ParticleSystem_1.asset": { position: [0.0, -0.800000011920929, 0.41999998688697815], scale: [1.0, 1.0, 1.0], rotation: [0.9508405327796936, 0.0, 0.0, 0.3096809983253479], originalIdentity: { serializedFile: "CAB-b955f47d8d200fa0f95b8cb064155cb0", pathId: "-2789622563880701922" } },
  "note_slide_simple_loop.prefab/ParticleSystem_3.asset": { position: [0.0, -0.5299999713897705, 0.6499999761581421], scale: [0.75, 1.0, 1.0], rotation: [0.20236001908779144, 0.0, 0.0, 0.9793112874031067], originalIdentity: { serializedFile: "CAB-b955f47d8d200fa0f95b8cb064155cb0", pathId: "7951268161139044382" } },
  "note_normal_simple.prefab/ParticleSystem_2.asset": { position: [0.0, -0.5299999713897705, 0.550000011920929], scale: [1.0, 1.0, 1.0], rotation: [0.0, 0.0, 0.0, 1.0], originalIdentity: { serializedFile: "CAB-0f18d35412a1ae3b3b0ffd03ca141c9d", pathId: "-552148383457270490" } },
  "note_normal_simple.prefab/ParticleSystem.asset": { position: [0.0, -0.5299999713897705, 0.550000011920929], scale: [1.0, 1.0, 1.0], rotation: [-0.7071068286895752, 0.0, 0.0, 0.7071068286895752], originalIdentity: { serializedFile: "CAB-0f18d35412a1ae3b3b0ffd03ca141c9d", pathId: "-8899986100823186138" } },
};
function simpleCircleRotationX(quaternion: readonly [number, number, number, number]): number {
  if (quaternion[1] !== 0 || quaternion[2] !== 0 || !quaternion.every(Number.isFinite) ||
      Math.hypot(quaternion[0], quaternion[3]) === 0) throw new Error("Unsupported original Simple Circle Transform rotation");
  return 2 * Math.atan2(quaternion[0], quaternion[3]);
}

function simpleParticle(
  prefab: string,
  file: string,
  name: string,
  texture: Effect001TextureKey,
  localPosition: readonly [number, number, number],
  options: Partial<
    Pick<
      Effect001ParticleSystemAssetRef,
      | "localScale"
      | "shapeWidthOffset"
      | "widthScaleRange"
      | "renderer"
      | "rendererPivot"
      | "animationPath"
      | "rendererMaxParticleSize"
      | "rendererRenderMode"
    >
  > = {},
): Effect001ParticleSystemAssetRef {
  const rendererPivot =
    options.rendererPivot ?? (options.renderer === "wallMesh" ? ([0, -0.21, -0.5] as const) : undefined);
  const rendererMaxParticleSize = options.rendererMaxParticleSize ?? (texture === "star" ? 0.5 : 1);
  const object = objectOrdinal(file);
  const circleTransform = SIMPLE_CIRCLE_TRANSFORMS[`${prefab}/${file}`];
  const metadataUrl = simpleObject(prefab, object.type, object.ordinal);
  return {
    name,
    metadataUrl,
    ...particleActivityFor(metadataUrl),
    texture,
    localPosition,
    ...options,
    ...(circleTransform ? { originalIdentity: circleTransform.originalIdentity,
      localPosition: circleTransform.position, localScale: circleTransform.scale,
      localRotationX: simpleCircleRotationX(circleTransform.rotation) } : {}),
    rendererMaxParticleSize,
    ...(rendererPivot ? { rendererPivot } : {}),
  };
}

function simpleSprite(prefab: string, baseColor: readonly [number, number, number, number]): Effect001SpriteAssetRef {
  return {
    name: "frame",
    metadataUrl: simpleObject(prefab, "SpriteRenderer"),
    baseActive: false,
    baseColor,
    baseSize: [5.5, 1.75],
    pivot: [0.5, 0.5],
    localPosition: [0, 0, 0],
    localScale: [1.02, 1, 1],
    localRotationX: Math.PI / 2,
  };
}

const SIMPLE_TAP_CLIPS = {
  perfect: EFFECT_SIMPLE_CLIP("note_simple_perfect"),
  great: EFFECT_SIMPLE_CLIP("note_simple_great"),
  good: EFFECT_SIMPLE_CLIP("note_simple_good"),
  bad: EFFECT_SIMPLE_CLIP("note_simple_bad"),
} as const;
const SIMPLE_SLIDE_CLIPS = {
  perfect: EFFECT_SIMPLE_CLIP("note_slide_simple_parfect"),
  great: EFFECT_SIMPLE_CLIP("note_slide_simple_great"),
  good: EFFECT_SIMPLE_CLIP("note_slide_simple_good"),
  bad: EFFECT_SIMPLE_CLIP("note_slide_simple_bad"),
} as const;
const SIMPLE_FLICK_CLIPS = {
  perfect: EFFECT_SIMPLE_CLIP("tap_flick_simple_perfect"),
  great: EFFECT_SIMPLE_CLIP("tap_flick_simple_great"),
  good: EFFECT_SIMPLE_CLIP("tap_flick_simple_good"),
  bad: EFFECT_SIMPLE_CLIP("tap_flick_simple_bad"),
} as const;
const SIMPLE_SLIDE_LOOP_CLIP = EFFECT_SIMPLE_CLIP("note_slide_simple_loop");

export const EFFECT001SIMPLE_PREFABS: Readonly<Record<string, Effect001PrefabAssetRef>> = {
  Normal: {
    id: EFFECT001_PREFAB_IDS.Normal,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: SIMPLE_TAP_CLIPS.perfect,
    animationClipUrls: SIMPLE_TAP_CLIPS,
    particleSystems: [
      simpleParticle(
        "note_normal_simple.prefab",
        "ParticleSystem.asset",
        "ef_particle_point_center",
        "circleIcon",
        [0, -0.53, 0.55],
        {
          animationPath: "ef_splash/ef_particle_point_center",
          shapeWidthOffset: 0.08,
          rendererRenderMode: 3,
          rendererMaxParticleSize: 0.5,
        },
      ),
      simpleParticle(
        "note_normal_simple.prefab",
        "ParticleSystem_2.asset",
        "ef_particle_point",
        "circleIcon",
        [0, -0.53, 0.55],
        {
          animationPath: "ef_splash/ef_particle_point",
          shapeWidthOffset: 0.08,
          rendererRenderMode: 3,
          rendererMaxParticleSize: 0.5,
        },
      ),
      simpleParticle("note_normal_simple.prefab", "ParticleSystem_3.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      simpleSprite("note_normal_simple.prefab", [0.0777856633067131, 0.23382169008255005, 0.8679245114326477, 0]),
    ],
  },
  Slide: {
    id: EFFECT001_PREFAB_IDS.Slide,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: SIMPLE_SLIDE_CLIPS.perfect,
    animationClipUrls: SIMPLE_SLIDE_CLIPS,
    particleSystems: [
      simpleParticle(
        "note_slide_simple.prefab",
        "ParticleSystem.asset",
        "ef_particle_point",
        "circleIcon",
        [0, -0.53, 0.55],
        {
          animationPath: "ef_splash/ef_particle_point",
          shapeWidthOffset: 0.08,
        },
      ),
      simpleParticle(
        "note_slide_simple.prefab",
        "ParticleSystem_2.asset",
        "ef_particle_point_center",
        "circleIcon",
        [0, -0.53, 0.55],
        {
          animationPath: "ef_splash/ef_particle_point_center",
          shapeWidthOffset: 0.08,
        },
      ),
      simpleParticle("note_slide_simple.prefab", "ParticleSystem_3.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      simpleSprite("note_slide_simple.prefab", [0.19215686274509805, 0.11372549019607843, 0.9058823529411765, 1]),
    ],
  },
  Flick: {
    id: EFFECT001_PREFAB_IDS.Flick,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: SIMPLE_FLICK_CLIPS.perfect,
    animationClipUrls: SIMPLE_FLICK_CLIPS,
    particleSystems: [
      simpleParticle(
        "note_flick_simple.prefab",
        "ParticleSystem_1.asset",
        "ef_particle_point01",
        "star",
        [0, 0.7100000381469727, 0],
        { animationPath: "ef_splash_move/ef_particle_point01", widthScaleRange: [0.05, 3] },
      ),
      simpleParticle(
        "note_flick_simple.prefab",
        "ParticleSystem_2.asset",
        "ef_particle_point02",
        "star",
        [0, 0.7100000381469727, 0],
        { animationPath: "ef_splash_move/ef_particle_point02", widthScaleRange: [0.05, 3] },
      ),
      simpleParticle("note_flick_simple.prefab", "ParticleSystem_4.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      simpleSprite("note_flick_simple.prefab", [0.6792452931404114, 0.30566415190696716, 0.06728372722864151, 0]),
    ],
  },
  Left: {
    id: EFFECT001_PREFAB_IDS.Left,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: SIMPLE_FLICK_CLIPS.perfect,
    animationClipUrls: SIMPLE_FLICK_CLIPS,
    // tap_flick_simple clips bind LocalPosition and rateOverDistance on
    // CRC32("ef_splash_move/ef_splash"), the moving long-glow emitter.
    distanceEmitterPathHash: unityStringHash("ef_splash_move/ef_splash"),
    particleSystems: [
      simpleParticle("note_flick_left_simple.prefab", "ParticleSystem.asset", "ef_splash02", "star", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash/ef_splash02",
        widthScaleRange: [0.0820000022649765, 1.5],
      }),
      simpleParticle("note_flick_left_simple.prefab", "ParticleSystem_2.asset", "ef_splash", "longStar", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash",
        widthScaleRange: [0.0820000022649765, 1.5],
      }),
      simpleParticle(
        "note_flick_left_simple.prefab",
        "ParticleSystem_3.asset",
        "ef_wall_center",
        "wall",
        [0, 0, 0.05],
        {
          animationPath: "ef_splash/ef_wall_center",
          localScale: [4.9, 1, 1],
          renderer: "wallMesh",
        },
      ),
    ],
    sprites: [
      simpleSprite("note_flick_left_simple.prefab", [0.039382338523864746, 0.5566037893295288, 0.14450867474079132, 0]),
    ],
  },
  Right: {
    id: EFFECT001_PREFAB_IDS.Right,
    rootScaleX: -1,
    loopAnimation: false,
    animationClipUrl: SIMPLE_FLICK_CLIPS.perfect,
    animationClipUrls: SIMPLE_FLICK_CLIPS,
    distanceEmitterPathHash: unityStringHash("ef_splash_move/ef_splash"),
    particleSystems: [
      simpleParticle("note_flick_right_simple.prefab", "ParticleSystem.asset", "ef_splash02", "star", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash/ef_splash02",
        widthScaleRange: [0.0820000022649765, 1.5],
      }),
      simpleParticle("note_flick_right_simple.prefab", "ParticleSystem_3.asset", "ef_splash", "longStar", [0, 0, 0], {
        animationPath: "ef_splash_move/ef_splash",
        widthScaleRange: [0.0820000022649765, 1.5],
      }),
      simpleParticle(
        "note_flick_right_simple.prefab",
        "ParticleSystem_2.asset",
        "ef_wall_center",
        "wall",
        [0, 0, 0.05],
        {
          animationPath: "ef_splash/ef_wall_center",
          localScale: [4.9, 1, 1],
          renderer: "wallMesh",
        },
      ),
    ],
    sprites: [simpleSprite("note_flick_right_simple.prefab", [1.0, 0.15566039085388184, 0.6591655611991882, 0])],
  },
  // FlickJustEffect slot: the settings asset resolves Just to note_groove_simple.
  Excellent: {
    id: EFFECT001_PREFAB_IDS.Excellent,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: SIMPLE_TAP_CLIPS.perfect,
    animationClipUrls: SIMPLE_TAP_CLIPS,
    particleSystems: [
      simpleParticle(
        "note_groove_simple.prefab",
        "ParticleSystem_2.asset",
        "ef_particle_point",
        "circleIcon",
        [0, -0.531000018119812, 0],
        {
          animationPath: "ef_splash/ef_particle_point",
          shapeWidthOffset: -0.019999999552965164,
        },
      ),
      simpleParticle(
        "note_groove_simple.prefab",
        "ParticleSystem_3.asset",
        "ef_particle_point_center",
        "circleIcon",
        [0, -0.5299999713897705, 0],
        {
          animationPath: "ef_splash/ef_particle_point_center",
          shapeWidthOffset: 0.07999999821186066,
        },
      ),
      simpleParticle("note_groove_simple.prefab", "ParticleSystem.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [simpleSprite("note_groove_simple.prefab", [0.5, 0.45834264159202576, 0.030660390853881836, 0])],
  },
  SlideLoop: {
    id: EFFECT001_PREFAB_IDS.SlideLoop,
    rootScaleX: 1,
    loopAnimation: true,
    animationClipUrl: SIMPLE_SLIDE_LOOP_CLIP,
    particleSystems: [
      // The authored GameObject names keep a trailing underscore / space.
      simpleParticle(
        "note_slide_simple_loop.prefab",
        "ParticleSystem_1.asset",
        "ef_particle_point_",
        "circleIcon",
        [0, -0.800000011920929, 0.41999998688697815],
        { animationPath: "ef_slide_loop/ef_particle_point_", rendererRenderMode: 2, rendererMaxParticleSize: 1 },
      ),
      simpleParticle(
        "note_slide_simple_loop.prefab",
        "ParticleSystem_3.asset",
        "ef_particle_point ",
        "circleIcon",
        [0, -0.5299999713897705, 0.6499999761581421],
        {
          animationPath: "ef_slide_loop/ef_particle_point ",
          shapeWidthOffset: 0.07999999821186066,
          rendererRenderMode: 0,
          rendererMaxParticleSize: 0.5,
        },
      ),
      simpleParticle(
        "note_slide_simple_loop.prefab",
        "ParticleSystem_2.asset",
        "ef_wall_center",
        "wall",
        [0, 0, 0.05],
        {
          animationPath: "ef_slide_loop/ef_wall_center",
          localScale: [4.9, 1, 1],
          renderer: "wallMesh",
        },
      ),
    ],
    sprites: [
      simpleSprite("note_slide_simple_loop.prefab", [0.19215686274509805, 0.11372549019607843, 0.9058823529411765, 1]),
    ],
  },
  // SlideLoopConnectEffect shares note_slide_simple with SlideEffect in the
  // settings asset; both slots reference one asset instance.
  Connect: {
    id: EFFECT001_PREFAB_IDS.Connect,
    rootScaleX: 1,
    loopAnimation: false,
    animationClipUrl: SIMPLE_SLIDE_CLIPS.perfect,
    animationClipUrls: SIMPLE_SLIDE_CLIPS,
    particleSystems: [
      simpleParticle(
        "note_slide_simple.prefab",
        "ParticleSystem.asset",
        "ef_particle_point",
        "circleIcon",
        [0, -0.53, 0.55],
        {
          animationPath: "ef_splash/ef_particle_point",
          shapeWidthOffset: 0.08,
        },
      ),
      simpleParticle(
        "note_slide_simple.prefab",
        "ParticleSystem_2.asset",
        "ef_particle_point_center",
        "circleIcon",
        [0, -0.53, 0.55],
        {
          animationPath: "ef_splash/ef_particle_point_center",
          shapeWidthOffset: 0.08,
        },
      ),
      simpleParticle("note_slide_simple.prefab", "ParticleSystem_3.asset", "ef_wall_center", "wall", [0, 0, 0.05], {
        animationPath: "ef_splash/ef_wall_center",
        localScale: [4.9, 1, 1],
        renderer: "wallMesh",
      }),
    ],
    sprites: [
      simpleSprite("note_slide_simple.prefab", [0.19215686274509805, 0.11372549019607843, 0.9058823529411765, 1]),
    ],
  },
};

interface AuthoredEffectProfileConfig {
  readonly effect001Prefabs: Readonly<Record<string, Effect001PrefabAssetRef>>;
  readonly textureSource: string;
  readonly tapLineTextureSource: string;
  readonly tapLineTextureName: string;
  readonly circleIconTextureSource: string;
}

const authoredEffectProfileConfigs: Readonly<Record<OurNotesAuthoredEffectProfile, AuthoredEffectProfileConfig>> = {
  full: {
    effect001Prefabs: EFFECT001_PREFABS,
    textureSource: EFFECT_COMMON_TEXTURE_SOURCE,
    tapLineTextureSource: EFFECT_COMMON_TEXTURE_SOURCE,
    tapLineTextureName: "ef_tap_line.png",
    circleIconTextureSource: EFFECT_COMMON_TEXTURE_SOURCE,
  },
  light: {
    effect001Prefabs: EFFECT001LIGHT_PREFABS,
    textureSource: EFFECT_COMMON_TEXTURE_SOURCE,
    tapLineTextureSource: EFFECT_COMMON_LIGHT_TEXTURE_SOURCE,
    tapLineTextureName: "ef_tap_line_light.png",
    circleIconTextureSource: EFFECT_COMMON_TEXTURE_SOURCE,
  },
  simple: {
    effect001Prefabs: EFFECT001SIMPLE_PREFABS,
    textureSource: EFFECT_COMMON_TEXTURE_SOURCE,
    tapLineTextureSource: EFFECT_COMMON_TEXTURE_SOURCE,
    tapLineTextureName: "ef_tap_line.png",
    circleIconTextureSource: `${EFFECT_COMMON_SOURCE}/Texture`,
  },
};

function resolveAuthoredEffectProfile(
  noteEffectSkin: OurNotesNoteEffectSkin,
  currentQuality: number | undefined,
): OurNotesAuthoredEffectProfile {
  if (currentQuality !== undefined && (!Number.isFinite(currentQuality) || !Number.isInteger(currentQuality))) {
    throw new TypeError(`currentQuality must be a finite integer: ${currentQuality}`);
  }
  // The selected Simple skin has no SimpleLight asset. The native loader's
  // same-selected-base fallback therefore remains Simple at every quality.
  if (noteEffectSkin === "effect001Simple") return "simple";
  return currentQuality === 2 ? "light" : "full";
}

/** An omitted quality is the High row; resolveAuthoredEffectProfile has already rejected non-integers. */
const liveQualityOf = (currentQuality: number | undefined): OurNotesLiveQuality =>
  currentQuality === 1 || currentQuality === 2 ? currentQuality : 0;

function noteSkinSprites(skin: OurNotesNoteSkin): SpriteMetadataRef[] {
  return Object.entries(OUR_NOTES_BUNDLED_NOTE_ATLASES[skin].spriteMetadata).map(([name, metadata]) => ({
    name,
    metadataUrl: "",
    metadata,
  }));
}

/**
 * Live skin template. Palette values are sampled from the skin001 reference
 * sheet; build-specific atlas/HUD media must be injected from descriptors.
 */
const buildOurNotesSkinManifest = (runtimeMedia: OurNotesRuntimeMediaManifest): OurNotesAssetManifest => {
  const noteSkin = runtimeMedia.noteSkin ?? "skin001";
  const noteSeGroup = resolveNoteSeGroup(runtimeMedia.noteSeGroup);
  const bundledNoteAtlas = OUR_NOTES_BUNDLED_NOTE_ATLASES[noteSkin];
  const noteEffectSkin = runtimeMedia.noteEffectSkin ?? "effect001";
  const authoredProfile = resolveAuthoredEffectProfile(noteEffectSkin, runtimeMedia.currentQuality);
  const defaultAuthoredProfile: OurNotesAuthoredEffectProfile =
    noteEffectSkin === "effect001Simple" ? "simple" : "full";
  const effectProfile = authoredEffectProfileConfigs[authoredProfile];
  const profileId =
    authoredProfile === defaultAuthoredProfile ? noteEffectSkin : `${noteEffectSkin}-${authoredProfile}`;
  const textureSource = effectProfile.textureSource;
  return {
    id: `our-notes-${noteSkin}-${profileId}-se${noteSeGroup}`,
    uiProfile: OUR_NOTES_CHART_UI_PROFILE,
    source: {
      game: "BanG Dream! Our Notes",
      noteSkin,
      laneSkin: "skin001",
      noteEffectSkin,
      authoredProfile,
    },
    liveQuality: OUR_NOTES_LIVE_QUALITY_SETTINGS[liveQualityOf(runtimeMedia.currentQuality)],
    noteAtlas: {
      id: noteSkin,
      textureUrl: bundledNoteAtlas.textureUrl,
      atlasMetadataUrl: "",
      atlasMetadata: bundledNoteAtlas.atlasMetadata,
      sprites: noteSkinSprites(noteSkin),
    },
    slideLineStyle: OUR_NOTES_SLIDE_LINE_STYLES[noteSkin],
    // skin003 ArrowGradientSettings{,Left,Right}; skins 001/002 leave the
    // flick arrows without the shader-driven sweep.
    ...(noteSkin === "skin003"
      ? {
          arrowGradient: {
            durationSeconds: 0.36000001430511475,
            pauseSeconds: 0,
            center: { bandWidth: 0.17000000178813934, minAlpha: 0.699999988079071 },
            directional: { bandWidth: 0.30000001192092896, minAlpha: 0.699999988079071 },
          },
        }
      : {}),
    lane: {
      baseTextureUrl: sourceAsset(`${LANE_SOURCE}/lane_base.png`),
      materialBaseTextureUrl: sourceAsset(`${LANE_SOURCE}/lane_base.png`),
      tapAreaTextureUrl: sourceAsset(`${LANE_SOURCE}/lane_tap_area.png`),
      outsideLineTextureUrl: sourceAsset(`${LANE_SOURCE}/out_side_line.png`),
      lineTextureUrl: sourceAsset(
        "Assets/AddressableResources/Live/Images/NonAtlas/LiveStartAnim/white_line_antialiasing_side.png",
      ),
      referenceImageUrl: sourceAsset(`${LANE_SOURCE}/reference_image.png`),
    },
    particles: {
      starTextureUrl: sourceAsset(`${textureSource}/ef_tap_particle_star.png`),
      longStarTextureUrl: sourceAsset(`${textureSource}/ef_tap_particle_star_long.png`),
      tapLineTextureUrl: sourceAsset(`${effectProfile.tapLineTextureSource}/${effectProfile.tapLineTextureName}`),
      tapPillarTextureUrl: sourceAsset(`${textureSource}/ef_tap_pillar.png`),
      wallTextureUrl: sourceAsset(`${textureSource}/ef_wall.png`),
      wallSideTextureUrl: sourceAsset(`${textureSource}/ef_wall_side.png`),
      centerPillarTextureUrl: sourceAsset(`${textureSource}/ef_pillar_center.png`),
      centerPillar02TextureUrl: sourceAsset(`${textureSource}/ef_pillar_center02.png`),
      circleIconTextureUrl: sourceAsset(`${effectProfile.circleIconTextureSource}/ef_circle_icon.png`),
      laneEffects: {
        ...(runtimeMedia.gekisouLaneAvailable ? { gekisou: {
          textureUrl: sourceAsset(LANE_EFFECT_TEXTURE_SOURCE),
          particleSystemMetadataUrl: unityObject(
            `${LANE_EFFECT_SOURCE}/lane_tap_excellenet_view.prefab`, "ParticleSystem", 2,
          ),
          lifetime: 0.44999998807907104,
        } } : {}),
        inVain: {
          textureUrl: sourceAsset(LANE_EFFECT_TEXTURE_SOURCE),
          particleSystemMetadataUrl: unityObject(
            `${LANE_EFFECT_SOURCE}/lane_tap_blank_miss_view.prefab`,
            // The emitting system of this prefab is the unsuffixed file; the
            // _1 component is the dormant size-1.8 reference here (flipped
            // relative to lane_tap_normal_view).
            "ParticleSystem",
            0,
          ),
          lifetime: 0.44999998807907104 / 2,
        },
        normal: {
          textureUrl: sourceAsset(LANE_EFFECT_TEXTURE_SOURCE),
          particleSystemMetadataUrl: unityObject(
            `${LANE_EFFECT_SOURCE}/lane_tap_normal_view.prefab`,
            "ParticleSystem",
            1,
          ),
          lifetime: 0.44999998807907104 / 2,
        },
        slide: {
          textureUrl: sourceAsset(LANE_EFFECT_TEXTURE_SOURCE),
          particleSystemMetadataUrl: unityObject(`${LANE_EFFECT_SOURCE}/lane_tap_slide_view.prefab`, "ParticleSystem"),
          lifetime: 0.44999998807907104 / 2,
        },
        flick: {
          textureUrl: sourceAsset(LANE_EFFECT_TEXTURE_SOURCE),
          particleSystemMetadataUrl: unityObject(
            `${LANE_EFFECT_SOURCE}/lane_tap_flick_view.prefab`,
            "ParticleSystem",
            1,
          ),
          lifetime: 0.44999998807907104 / 2,
        },
        flickLeft: {
          textureUrl: sourceAsset(LANE_EFFECT_TEXTURE_SOURCE),
          particleSystemMetadataUrl: unityObject(
            `${LANE_EFFECT_SOURCE}/lane_tap_flick_left_view.prefab`,
            "ParticleSystem",
          ),
          lifetime: 0.44999998807907104 / 2,
        },
        flickRight: {
          textureUrl: sourceAsset(LANE_EFFECT_TEXTURE_SOURCE),
          particleSystemMetadataUrl: unityObject(
            `${LANE_EFFECT_SOURCE}/lane_tap_flick_right_view.prefab`,
            "ParticleSystem",
            1,
          ),
          lifetime: 0.44999998807907104 / 2,
        },
      },
      effect001Prefabs: effectProfile.effect001Prefabs,
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
    noteSeGroup,
    noteSounds: noteSoundManifest(noteSeGroup),
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
  };
};

function isContainedReleaseUrl(url: string, prefix: string): boolean {
  if (!url.startsWith(prefix)) return false;
  let suffix: string;
  try {
    suffix = decodeURIComponent(url.slice(prefix.length));
  } catch {
    return false;
  }
  if (!suffix || suffix.startsWith("/") || suffix.includes("\\") || suffix.includes("\0")) return false;
  return suffix.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function ourNotesAssetManifestForRelease(
  releaseServer: string,
  runtimeMedia: OurNotesRuntimeMediaManifest,
): OurNotesAssetManifest {
  const encodedReleaseServer = normalizeReleaseServer(releaseServer);
  const runtimePrefix = `/runtime/${encodedReleaseServer}/`;
  const assetPrefixes = [
    `/assets/${encodedReleaseServer}/Assets/`,
    `/assets/${encodedReleaseServer}/Packages/`,
  ] as const;
  const runtimeUrls = [
    ...(runtimeMedia.fontAtlasTextureUrl ? [runtimeMedia.fontAtlasTextureUrl] : []),
    ...Object.values(runtimeMedia.hud.judgementImages),
    runtimeMedia.hud.comboLabelUrl,
    ...runtimeMedia.hud.comboDigitUrls,
    runtimeMedia.hud.perfectComboLabelUrl,
    ...runtimeMedia.hud.perfectComboDigitUrls,
    ...Object.values(runtimeMedia.hud.comboTiers ?? {}).flatMap((tier) => [
      tier.labelUrl, ...tier.baseDigitUrls, ...tier.fillDigitUrls, ...(tier.glowUrl ? [tier.glowUrl] : []),
    ]),
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
    (url) =>
      !isContainedReleaseUrl(url, runtimePrefix) && !assetPrefixes.some((prefix) => isContainedReleaseUrl(url, prefix)),
  );
  if (invalidUrl) {
    throw new TypeError(
      `Chart media must use the canonical ${runtimePrefix}, ${assetPrefixes[0]}, or ${assetPrefixes[1]} namespace: ${invalidUrl}`,
    );
  }
  const serialized = JSON.stringify(buildOurNotesSkinManifest(runtimeMedia))
    .replaceAll(`${RELEASE_TEMPLATE_ASSET_ROOT}/`, `/assets/${encodedReleaseServer}/`)
    .replaceAll(`${RELEASE_TEMPLATE_RUNTIME_ROOT}/`, runtimePrefix);
  const manifest = JSON.parse(serialized) as OurNotesAssetManifest;
  return {
    ...manifest,
    hud: runtimeMedia.hud,
  };
}
