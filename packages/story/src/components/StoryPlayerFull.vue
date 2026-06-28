<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import "@material/web/progress/linear-progress.js";
import "@material/web/slider/slider.js";
import { AdvPlayer } from "../core/AdvPlayer";
import { mergeAdvRuntime } from "../core/AdvConstants";
import { ADV_CHAT_WINDOW_TRANSITION, evaluateAdvChatOutCubic, evaluateAdvChatOutExpo } from "../core/AdvChatTransition";
import { ADV_TITLE_ANIMATION, isAdvStoryTitleHidden } from "../core/AdvTitle";
import type { AdvChoiceRecord, AdvPlayerState, AdvStory, StoryUiSprites } from "../types/AdvRuntime";
import {
  chatDefaultDataRoot,
  chatDataRootForWindowAsset,
  chatIconImagePath,
  chatWindowSpriteRectForDataRoot,
  isAdvChatIconAssetName,
} from "../core/AdvChatAssets";
import {
  canonicalStorySourceAssetPath,
  requireCanonicalStoryResourceUrl,
  resolveStoryLocalizedText,
  storyRuntime,
} from "../runtime";
import advChatIconAlarm from "../assets/adv-chat-common/alarm.png";
import advChatIconArrowBack from "../assets/adv-chat-common/arrow_back.png";
import advChatIconBars from "../assets/adv-chat-common/bars.png";
import advChatIconBatteryFrame from "../assets/adv-chat-common/battery_frame.png";
import advChatIconCall from "../assets/adv-chat-common/call.png";
import advChatIconNavi from "../assets/adv-chat-common/navi.png";
import advChatIconRss from "../assets/adv-chat-common/rss.png";
import advChatIconSignal from "../assets/adv-chat-common/signal.png";
import StoryIcon from "./StoryIcon.vue";
import StoryRichText from "./StoryRichText";
import { UNITY_ADV_REFERENCE_SIZE, UNITY_ADV_UI_LAYOUT, unityAdvReferenceUnit } from "./UnityAdvUiLayout";

defineOptions({ name: "StoryPlayerFull" });

const props = defineProps<{
  story?: AdvStory;
  storyData?: AdvStory;
  uiSprites: StoryUiSprites;
  volume?: number;
  volumeBgm?: number;
  enableBgm?: number;
  autoPlay?: number;
  autoPlayInterval?: number;
  instantText?: number;
  textSize?: number;
  subtitlesEnabled?: boolean;
  server?: string;
  showProgress?: boolean;
  showStart?: boolean;
}>();

const rootEl = ref<HTMLElement | null>(null);
const canvasHost = ref<HTMLElement | null>(null);
const chatWindowEl = ref<HTMLElement | null>(null);
let player: AdvPlayer | null = null;
let progressSeekTimer: ReturnType<typeof setTimeout> | null = null;
let titleHideTimer: ReturnType<typeof setTimeout> | null = null;
const titledPlayers = new WeakSet<AdvPlayer>();
const chatTransitionFrames = new WeakMap<HTMLElement, number>();
const chatModeTransitionFrames = new WeakMap<HTMLElement, number>();
let chatModeTransitionGeneration = 0;
let progressSeekVersion = 0;
let currentBootCacheKey = "";
let bootGeneration = 0;
let bootController: AbortController | null = null;
let componentUnmounted = false;
const seekDecisionHistory = new Map<number, AdvChoiceRecord>();
const warmedStoryKeys = new Set<string>();
const anonymousStoryKeys = new WeakMap<object, string>();
let anonymousStorySequence = 0;

interface BootAttempt {
  readonly generation: number;
  readonly controller: AbortController;
}

interface ChatModeRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const state = reactive(createState());
const story = computed(() => props.storyData ?? props.story);
const runtime = computed(() => mergeAdvRuntime(story.value?.runtime));
const progressRatio = computed(() => (state.preload.total ? state.preload.done / state.preload.total : 0));
const landscapeAspect = computed(() => Number(runtime.value.layout?.designViewportAspect || 13 / 6));
const portraitAspect = computed(() => Number(runtime.value.layout?.portraitTargetAspect || 16 / 9));
const assetServer = computed(() => {
  const value = props.server || story.value?.assetServer || story.value?.assetServerKey;
  return typeof value === "string" && value ? value : storyRuntime().defaultAssetServer;
});
const lastVisibleChatDataRoot = ref("");
const lastVisibleChatGroup = ref(false);
const defaultChatDataRoot = computed(() => chatDefaultDataRoot(runtime.value));
const chatDataRoot = computed(() => {
  const activeRoot = state.chat.dataRoot || chatDataRootForWindowAsset(state.chat.windowAssetName || "", runtime.value);
  return activeRoot || lastVisibleChatDataRoot.value;
});
const chatWindowSpriteRect = computed(() =>
  chatWindowSpriteRectForDataRoot(chatDataRoot.value || defaultChatDataRoot.value, runtime.value),
);
const textScale = computed(() => {
  const value = Number(props.textSize ?? 1);
  return Number.isFinite(value) ? Math.max(0.5, Math.min(2, value)) : 1;
});
const browserStyle = computed(() => ({
  "--adv-landscape-aspect": String(landscapeAspect.value),
  "--adv-portrait-aspect": String(portraitAspect.value),
  "--adv-text-scale": String(textScale.value),
  "--adv-reference-plane-width": unityAdvReferenceUnit(UNITY_ADV_REFERENCE_SIZE.width),
  "--adv-title-top": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.title.top),
  "--adv-title-padding-x": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.title.paddingX),
  "--adv-title-padding-y": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.title.paddingY),
  "--adv-title-font-size": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.title.fontSize),
  "--adv-title-exit-x": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.title.exitX),
  "--adv-location-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.location.width),
  "--adv-location-frame-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.location.frameHeight),
  "--adv-location-content-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.location.contentHeight),
  "--adv-location-travel-x": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.location.travelX),
  "--adv-location-font-size": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.location.fontSize),
  "--adv-subtitles-bottom": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.subtitles.bottom),
  "--adv-subtitles-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.subtitles.height),
  "--adv-subtitles-font-size": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.subtitles.fontSize),
  "--adv-choices-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.choices.width),
  "--adv-choices-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.choices.height),
  "--adv-choices-center-y": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.choices.centerY),
  "--adv-choice-item-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.choices.itemHeight),
  "--adv-choice-text-left": unityAdvReferenceUnit(-UNITY_ADV_UI_LAYOUT.choices.textWidthDelta / 2),
  "--adv-choice-text-right": unityAdvReferenceUnit(-UNITY_ADV_UI_LAYOUT.choices.textWidthDelta / 2),
  "--adv-choice-text-top": unityAdvReferenceUnit(
    -UNITY_ADV_UI_LAYOUT.choices.textCenterY - UNITY_ADV_UI_LAYOUT.choices.textHeightDelta / 2,
  ),
  "--adv-choice-text-bottom": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.choices.textCenterY - UNITY_ADV_UI_LAYOUT.choices.textHeightDelta / 2,
  ),
  "--adv-choice-font-size": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.choices.fontSizeMax),
  "--adv-default-talk-font-size": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.defaultTalk.fontSize),
  "--adv-default-talk-background-bottom": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.defaultTalk.backgroundBottom),
  "--adv-default-talk-background-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.defaultTalk.backgroundHeight),
  "--adv-default-talk-background-size-delta-x": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.defaultTalk.backgroundHorizontalOverflow * 2,
  ),
  "--adv-default-talk-content-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.defaultTalk.contentWidth),
  "--adv-default-talk-speaker-left": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.defaultTalk.speakerX),
  "--adv-default-talk-speaker-bottom": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.defaultTalk.speakerCenterY - UNITY_ADV_UI_LAYOUT.defaultTalk.speakerHeight / 2,
  ),
  "--adv-default-talk-speaker-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.defaultTalk.speakerWidth),
  "--adv-default-talk-speaker-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.defaultTalk.speakerHeight),
  "--adv-default-talk-text-left": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.defaultTalk.talkX),
  "--adv-default-talk-text-bottom": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.defaultTalk.talkTopY - UNITY_ADV_UI_LAYOUT.defaultTalk.talkHeight,
  ),
  "--adv-default-talk-text-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.defaultTalk.talkWidth),
  "--adv-default-talk-text-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.defaultTalk.talkHeight),
  "--adv-default-talk-indicator-right": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.defaultTalk.indicatorRightCenter - UNITY_ADV_UI_LAYOUT.defaultTalk.indicatorSize / 2,
  ),
  "--adv-default-talk-indicator-bottom": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.defaultTalk.indicatorCenterY - UNITY_ADV_UI_LAYOUT.defaultTalk.indicatorSize / 2,
  ),
  "--adv-default-talk-indicator-size": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.defaultTalk.indicatorSize),
  "--adv-center-talk-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.centerTalk.talkHeight),
  "--adv-center-talk-indicator-top": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.centerTalk.indicatorTopWithinTalk),
  "--adv-center-talk-indicator-right": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.centerTalk.indicatorRight),
  "--adv-center-talk-indicator-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.centerTalk.indicatorWidth),
  "--adv-center-talk-indicator-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.centerTalk.indicatorHeight),
  "--adv-center-talk-font-size": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.centerTalk.fontSize),
  "--adv-psych-talk-font-size": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.fontSize),
  "--adv-psych-baseline-y": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.baselineY),
  "--adv-psych-background-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.backgroundWidth),
  "--adv-psych-background-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.backgroundHeight),
  "--adv-psych-content-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.contentWidth),
  "--adv-psych-content-scale": String(UNITY_ADV_UI_LAYOUT.psychTalk.contentScale),
  "--adv-psych-speaker-left": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.speakerX),
  "--adv-psych-speaker-bottom": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.psychTalk.speakerCenterY - UNITY_ADV_UI_LAYOUT.psychTalk.speakerHeight / 2,
  ),
  "--adv-psych-speaker-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.speakerWidth),
  "--adv-psych-speaker-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.speakerHeight),
  "--adv-psych-speaker-text-left": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.psychTalk.speakerTextCenterX - UNITY_ADV_UI_LAYOUT.psychTalk.speakerTextWidthDelta / 2,
  ),
  "--adv-psych-speaker-text-right": unityAdvReferenceUnit(
    -UNITY_ADV_UI_LAYOUT.psychTalk.speakerTextCenterX - UNITY_ADV_UI_LAYOUT.psychTalk.speakerTextWidthDelta / 2,
  ),
  "--adv-psych-text-left": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.talkX),
  "--adv-psych-text-bottom": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.psychTalk.talkTopY - UNITY_ADV_UI_LAYOUT.psychTalk.talkHeight,
  ),
  "--adv-psych-text-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.talkWidth),
  "--adv-psych-text-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.talkHeight),
  "--adv-psych-line-bottom": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.psychTalk.lineCenterY - UNITY_ADV_UI_LAYOUT.psychTalk.lineHeight / 2,
  ),
  "--adv-psych-line-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.lineWidth),
  "--adv-psych-line-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.lineHeight),
  "--adv-psych-line-border-x": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.lineBorderX),
  "--adv-psych-indicator-right": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.psychTalk.indicatorRightCenter - UNITY_ADV_UI_LAYOUT.psychTalk.indicatorWidth / 2,
  ),
  "--adv-psych-indicator-bottom": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.psychTalk.indicatorCenterY - UNITY_ADV_UI_LAYOUT.psychTalk.indicatorHeight / 2,
  ),
  "--adv-psych-indicator-width": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.indicatorWidth),
  "--adv-psych-indicator-height": unityAdvReferenceUnit(UNITY_ADV_UI_LAYOUT.psychTalk.indicatorHeight),
  "--adv-psych-edge-width": unityAdvReferenceUnit(
    UNITY_ADV_UI_LAYOUT.psychTalk.edgeBorder / UNITY_ADV_UI_LAYOUT.psychTalk.edgePixelsPerUnitMultiplier,
  ),
  "--adv-sprite-story-bottom-band": cssUrl(
    sourceAssetUrl("Assets/AddressableResources/UI/Texture/Bg_StoryBottomBand.png", assetServer.value),
  ),
  "--adv-sprite-tap-next": uiSpriteCssUrl(props.uiSprites.tapNext, "tapNext"),
  "--adv-sprite-tap-next-glow": uiSpriteCssUrl(props.uiSprites.tapNextGlow, "tapNextGlow"),
  "--adv-sprite-next": uiSpriteCssUrl(props.uiSprites.next, "next"),
  "--adv-sprite-psych-edge": uiSpriteCssUrl(props.uiSprites.psychEdge, "psychEdge"),
  "--adv-sprite-psych-line": uiSpriteCssUrl(props.uiSprites.psychLine, "psychLine"),
  "--adv-sprite-choice": uiSpriteCssUrl(props.uiSprites.choice, "choice"),
  "--adv-sprite-choice-blue": uiSpriteCssUrl(props.uiSprites.choiceActive, "choiceActive"),
  "--adv-chat-window-bg": chatDataAssetCss("chatwindow_image.png"),
  "--adv-chat-overlay-width": `${(chatWindowSpriteRect.value.width / 720) * 100}%`,
  "--adv-chat-overlay-height": `${(chatWindowSpriteRect.value.height / 700) * 100}%`,
  "--adv-chat-mask-top": `${(chatWindowSpriteRect.value.maskTop / 700) * 100}%`,
  "--adv-chat-mask-height": `${(chatWindowSpriteRect.value.maskHeight / 700) * 100}%`,
  "--adv-chat-mask-width": `${(chatWindowSpriteRect.value.maskWidth / 720) * 100}%`,
  "--adv-chat-lock-bg": chatDataAssetCss("lock.png"),
  "--adv-chat-back-bg": chatDataAssetCss("back.png"),
  "--adv-chat-icon-signal": cssUrl(advChatIconSignal),
  "--adv-chat-icon-rss": cssUrl(advChatIconRss),
  "--adv-chat-icon-alarm": cssUrl(advChatIconAlarm),
  "--adv-chat-icon-navi": cssUrl(advChatIconNavi),
  "--adv-chat-icon-back": cssUrl(advChatIconArrowBack),
  "--adv-chat-icon-bars": cssUrl(advChatIconBars),
  "--adv-chat-icon-call": cssUrl(advChatIconCall),
  "--adv-chat-icon-battery-frame": cssUrl(advChatIconBatteryFrame),
  "--adv-chat-line-plus": cssUrl(
    sourceAssetUrl(`${defaultChatDataRoot.value}/ADVChatIconLine_Plus.png`, assetServer.value),
  ),
  "--adv-chat-line-photo": cssUrl(
    sourceAssetUrl(`${defaultChatDataRoot.value}/ADVChatIconLine_Photo.png`, assetServer.value),
  ),
  "--adv-chat-line-pic": cssUrl(
    sourceAssetUrl(`${defaultChatDataRoot.value}/ADVChatIconLine_Pic.png`, assetServer.value),
  ),
  "--adv-chat-line-smile": cssUrl(
    sourceAssetUrl(`${defaultChatDataRoot.value}/ADVChatIconLine_Smile.png`, assetServer.value),
  ),
  "--adv-chat-line-mic": cssUrl(
    sourceAssetUrl(`${defaultChatDataRoot.value}/ADVChatIconLine_Mic.png`, assetServer.value),
  ),
}));
const talkWindowClass = computed(() => normalizeTalkWindowClass(state.talk.window));
const chatWindowClass = computed(() => normalizeChatWindowClass(state.chat.screenMode));
const canStart = computed(() => state.ready && !state.playing && !state.finished);
const canReplay = computed(() => state.ready && !state.playing && state.finished);
const activeProgressRatio = computed(() => {
  return state.commandCount ? clamp01(Number(state.commandIndex) / Number(state.commandCount)) : 0;
});
const progressStep = computed(() => (state.commandCount > 0 ? 1 / state.commandCount : 1));
const progressLabel = computed(() => {
  return state.commandCount ? `${Math.min(state.commandIndex, state.commandCount)} / ${state.commandCount}` : "";
});
const progress = computed(() => ({
  visible: Boolean(state.ready && state.commandCount),
  label: progressLabel.value,
  ratio: activeProgressRatio.value,
  seeking: state.seeking,
  videoVisible: state.video.visible,
  canStart: canStart.value,
  canReplay: canReplay.value,
  playing: state.playing,
}));
function cssUrl(value: string) {
  return `url("${String(value).replace(/"/g, "%22")}")`;
}

function uiSpriteCssUrl(value: string, key: keyof StoryUiSprites) {
  const url = requireCanonicalStoryResourceUrl(value, `uiSprites.${key}`);
  if (!storyRuntime().resourceBelongsToServer(url, assetServer.value)) {
    throw new TypeError(`Story uiSprites.${key} URL does not belong to asset server ${assetServer.value}: ${url}`);
  }
  return cssUrl(url);
}

function sourceAssetUrl(path: string, server = storyRuntime().defaultAssetServer): string {
  return storyRuntime().sourceAssetUrl(canonicalStorySourceAssetPath(path), server);
}

function message(key: "loading" | "play" | "replay" | "skipVideo"): string {
  return storyRuntime().message(key);
}

function chatDataAssetCss(file: string) {
  return chatDataRoot.value ? cssUrl(sourceAssetUrl(`${chatDataRoot.value}/${file}`, assetServer.value)) : "none";
}

function clamp01(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function normalizeTalkWindowClass(value: unknown) {
  const name = String(value || "").toLowerCase();
  if (name.includes("center")) return "UICenterTalkWindow";
  if (name.includes("simple")) return "UISimpleAdvTalkWindow";
  if (name.includes("psych")) return "UIPsychTalkWindow";
  return "UIDefaultTalkWindow";
}

function normalizeChatWindowClass(value: unknown) {
  const mode = Number(value);
  if (mode === 1) return "IncomingCallScreenMode";
  if (mode === 2) return "LockScreenMode";
  return "ChatScreenMode";
}

function chatImageSrc(value: unknown) {
  const name = String(value || "").trim();
  if (!name) return "";
  if (/^(?:data:|blob:|https?:\/\/)/.test(name)) return name;
  if (name.startsWith("/")) return requireCanonicalStoryResourceUrl(name, "chat image");
  if (isAdvChatIconAssetName(name)) {
    const path = chatIconImagePath(name, runtime.value);
    return path ? sourceAssetUrl(path, assetServer.value) : "";
  }
  const file = name.endsWith(".png") ? name : `${name}.png`;
  if (name.includes("/")) return sourceAssetUrl(name.endsWith(".png") ? name : `${name}.png`, assetServer.value);
  if (/^(?:ADVChat|Icon|stamp)/i.test(name)) {
    return sourceAssetUrl(`${defaultChatDataRoot.value}/${file}`, assetServer.value);
  }
  return sourceAssetUrl(`${chatDataRoot.value || defaultChatDataRoot.value}/${file}`, assetServer.value);
}

function storyCacheKey(value: AdvStory | undefined | null) {
  if (!value) return "";
  const authored = value.storyKey || value.storyId || value.id || value.advId || value.scriptAsset;
  if (authored != null && String(authored)) return String(authored);
  let key = anonymousStoryKeys.get(value);
  if (!key) {
    key = `anonymous-story-${++anonymousStorySequence}`;
    anonymousStoryKeys.set(value, key);
  }
  return key;
}

function preloadCacheKey(value: AdvStory | undefined | null) {
  const key = storyCacheKey(value);
  return key ? `${assetServer.value}\u0000${key}` : "";
}

onMounted(() => void boot());
onBeforeUnmount(() => {
  componentUnmounted = true;
  destroy({ releaseTextures: true });
});
watch(
  () => [storyCacheKey(story.value), assetServer.value] as const,
  async () => {
    seekDecisionHistory.clear();
    destroy({ releaseTextures: true });
    const attempt = beginBootAttempt();
    Object.assign(state, createState());
    state.instantText = props.instantText === 0;
    await nextTick();
    if (!isBootAttemptActive(attempt)) return;
    await boot({}, attempt);
  },
);
watch(
  () => props.instantText,
  () => {
    state.instantText = props.instantText === 0;
  },
  { immediate: true },
);
watch(() => [props.volume, props.volumeBgm, props.enableBgm], syncPlayerAudioSettings, { immediate: true });
watch(() => [props.autoPlay, props.autoPlayInterval], syncPlayerAutoPlay, { immediate: true });
watch(() => props.subtitlesEnabled, syncPlayerSubtitlesSettings, { immediate: true });
watch(
  () => state.playing,
  (playing) => {
    if (playing) showStoryTitleAtPlayStart();
  },
  // AdvPlayer sets `playing` before executing the first command. A synchronous
  // watcher preserves that native StartPlayTask ordering even when command 0
  // itself completes without yielding.
  { flush: "sync" },
);
watch(
  () => state.chat.visible,
  (visible) => {
    if (!visible) return;
    lastVisibleChatDataRoot.value =
      state.chat.dataRoot || chatDataRootForWindowAsset(state.chat.windowAssetName || "", runtime.value);
    lastVisibleChatGroup.value = state.chat.group;
  },
  // ChatWindow assigns its complete visual configuration before visible=true.
  // Keep that configuration alive during the native 0.2s leave transition.
  { flush: "sync" },
);
watch(
  () => state.chat.screenMode,
  (screenMode, previousMode) => {
    const host = chatWindowEl.value;
    const surface = host?.querySelector<HTMLElement>(".AdvChatWindow") || null;
    if (screenMode === previousMode || !state.chat.visible || !host || !surface) return;
    const before = snapshotChatModeRect(surface);
    const current = player;
    const generation = ++chatModeTransitionGeneration;
    void nextTick().then(() => {
      if (generation !== chatModeTransitionGeneration || player !== current || !state.chat.visible) return;
      const currentHost = chatWindowEl.value;
      const currentSurface = currentHost?.querySelector<HTMLElement>(".AdvChatWindow") || null;
      if (!currentHost || !currentSurface) return;
      // A new transition may interrupt an in-flight one. `before` contains its
      // currently displayed transform; clear that transform before measuring
      // the newly authored mode's final RectTransform.
      cancelChatModeTransition(currentSurface);
      runChatModeTransition(currentSurface, before, snapshotChatModeRect(currentSurface));
    });
  },
  { flush: "sync" },
);

function createState(): AdvPlayerState {
  return {
    loading: false,
    ready: false,
    playing: false,
    finished: false,
    seeking: false,
    paused: false,
    autoPlay: false,
    fastForward: false,
    instantText: false,
    error: "",
    commandIndex: 0,
    commandCount: 0,
    currentCommand: null,
    viewport: { x: 0, y: 0, width: 1, height: 1, surfaceWidth: 1, surfaceHeight: 1 },
    session: null,
    stage: null,
    background: null,
    still: null,
    frame: null,
    frameName: "",
    frameOpacity: 0,
    frameSlide: 1,
    frameEntries: {},
    stageEnv: { all: 0, light: 0, effect: 0, postEffect: 0, focusPosition: 0 },
    postEffect: null,
    dofActive: false,
    effect: null,
    cover: { color: "#000000", opacity: 0 },
    talk: {
      visible: false,
      speaker: "",
      speakerLang: undefined,
      text: "",
      textLang: undefined,
      displayedText: "",
      textComplete: true,
      targetName: "",
      window: "default",
      shakeX: 0,
      shakeY: 0,
    },
    title: { visible: false, text: "", lang: undefined, duration: UNITY_ADV_UI_LAYOUT.title.duration },
    location: { visible: false, text: "", lang: undefined },
    subtitles: { visible: false, text: "", lang: undefined, lastText: "", lastLang: undefined },
    chat: {
      visible: false,
      title: "",
      titleLang: undefined,
      messages: [],
      typing: "",
      typingLang: undefined,
      readVisible: false,
      screenMode: 0,
      battery: 100,
      batteryText: "100%",
      chatId: 0,
      participants: "",
      windowKey: "",
      windowAssetName: "",
      dataRoot: "",
      iconAssetName: "",
      group: false,
      memoryId: "",
    },
    choices: { visible: false, items: [] },
    video: {
      visible: false,
      src: "",
      alpha: 1,
      playbackRate: 1,
      playing: false,
      ended: false,
      currentTime: 0,
      duration: 0,
      progress: 0,
    },
    audio: { bgm: "", se: "", voice: "" },
    preload: { done: 0, total: 0, label: "", failures: [] },
    talkLog: [],
    unknownCommands: [],
    unsupported: [],
  };
}

function beginBootAttempt(): BootAttempt {
  bootController?.abort();
  const controller = new AbortController();
  bootController = controller;
  return { generation: ++bootGeneration, controller };
}

function isBootAttemptActive(attempt: BootAttempt): boolean {
  return (
    !componentUnmounted &&
    !attempt.controller.signal.aborted &&
    attempt.generation === bootGeneration &&
    bootController === attempt.controller
  );
}

function invalidateBootAttempt(): void {
  bootGeneration += 1;
  bootController?.abort();
  bootController = null;
}

async function boot(
  options: { reusePreload?: boolean } = {},
  attempt: BootAttempt = beginBootAttempt(),
): Promise<AdvPlayer | null> {
  const mount = canvasHost.value;
  const storyValue = story.value;
  if (!mount || !storyValue || !isBootAttemptActive(attempt)) return null;
  let current: AdvPlayer | null = null;
  try {
    const cacheKey = preloadCacheKey(storyValue);
    const skipPreload = Boolean(options.reusePreload && cacheKey && warmedStoryKeys.has(cacheKey));
    state.instantText = props.instantText === 0;
    current = new AdvPlayer({ mount, story: storyValue, state });
    if (!isBootAttemptActive(attempt)) {
      current.dispose({ releaseTextures: true });
      return null;
    }
    player = current;
    currentBootCacheKey = cacheKey;
    syncPlayerAudioSettings();
    syncPlayerAutoPlay();
    syncPlayerSubtitlesSettings();
    const win = globalThis as unknown as Record<string, unknown>;
    win.__advState = state;
    win.__advPlayer = current;
    await current.boot({ skipPreload });
    if (!isBootAttemptActive(attempt) || player !== current) {
      current.dispose({ releaseTextures: true });
      return null;
    }
    if (cacheKey) warmedStoryKeys.add(cacheKey);
    return current;
  } catch (err: unknown) {
    if (!isBootAttemptActive(attempt) || attempt.controller.signal.aborted) return null;
    state.error = err instanceof Error ? err.message : String(err);
    state.loading = false;
    current?.dispose({ releaseTextures: true });
    if (player === current) {
      player = null;
      currentBootCacheKey = "";
      const win = globalThis as unknown as Record<string, unknown>;
      if (win.__advPlayer === current) win.__advPlayer = null;
      if (win.__advState === state) win.__advState = null;
    }
    return null;
  }
}

function destroy(options: { releaseTextures?: boolean } = {}) {
  invalidateBootAttempt();
  chatModeTransitionGeneration += 1;
  const chatSurface = chatWindowEl.value?.querySelector<HTMLElement>(".AdvChatWindow") || null;
  if (chatSurface) cancelChatModeTransition(chatSurface);
  if (titleHideTimer) {
    clearTimeout(titleHideTimer);
    titleHideTimer = null;
  }
  state.title.visible = false;
  if (progressSeekTimer) {
    clearTimeout(progressSeekTimer);
    progressSeekTimer = null;
  }
  const current = player;
  current?.dispose({ releaseTextures: options.releaseTextures !== false });
  if (options.releaseTextures !== false && currentBootCacheKey) warmedStoryKeys.delete(currentBootCacheKey);
  currentBootCacheKey = "";
  const win = globalThis as unknown as Record<string, unknown>;
  if (win.__advPlayer === current) win.__advPlayer = null;
  if (win.__advState === state) win.__advState = null;
  player = null;
}

function showStoryTitleAtPlayStart(): void {
  const current = player;
  const storyValue = story.value;
  if (!current || titledPlayers.has(current) || current.currentProgressIndex() !== 0) return;
  titledPlayers.add(current);
  if (!storyValue || isAdvStoryTitleHidden(storyValue)) return;
  const text = resolveStoryLocalizedText(storyValue.title);
  if (!text.text) return;

  const playbackRate = Math.max(0.0001, current.Model.getCurrentSpeedRate());
  const duration = ADV_TITLE_ANIMATION.duration / playbackRate;
  state.title = { visible: true, text: text.text, lang: text.lang, duration };
  if (titleHideTimer) clearTimeout(titleHideTimer);
  titleHideTimer = setTimeout(() => {
    titleHideTimer = null;
    if (player === current) state.title.visible = false;
  }, duration * 1000);
}

function snapshotChatModeRect(element: HTMLElement): ChatModeRect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function cancelChatModeTransition(element: HTMLElement): void {
  const frame = chatModeTransitionFrames.get(element);
  if (frame !== undefined) cancelAnimationFrame(frame);
  chatModeTransitionFrames.delete(element);
  element.style.transform = "";
  element.style.transformOrigin = "";
  element.style.willChange = "";
}

function runChatModeTransition(element: HTMLElement, before: ChatModeRect, after: ChatModeRect): void {
  if (after.width <= 0 || after.height <= 0) return;
  const fromScaleX = before.width / after.width;
  const fromScaleY = before.height / after.height;
  const fromX = before.left + before.width / 2 - (after.left + after.width / 2);
  const fromY = before.top + before.height / 2 - (after.top + after.height / 2);
  const playbackRate = Math.max(0.0001, player?.Model.getCurrentSpeedRate() || 1);
  const durationMs = (ADV_CHAT_WINDOW_TRANSITION.screenModeDuration / playbackRate) * 1000;
  const apply = (raw: number): void => {
    const remaining = 1 - evaluateAdvChatOutCubic(raw);
    const x = fromX * remaining;
    const y = fromY * remaining;
    const scaleX = 1 + (fromScaleX - 1) * remaining;
    const scaleY = 1 + (fromScaleY - 1) * remaining;
    element.style.transform = `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})`;
  };

  element.style.transformOrigin = "50% 50%";
  element.style.willChange = "transform";
  apply(0);
  const startedAt = performance.now();
  const tick = (now: number): void => {
    const raw = Math.max(0, Math.min(1, (now - startedAt) / durationMs));
    apply(raw);
    if (raw < 1) {
      chatModeTransitionFrames.set(element, requestAnimationFrame(tick));
      return;
    }
    cancelChatModeTransition(element);
  };
  chatModeTransitionFrames.set(element, requestAnimationFrame(tick));
}

function cancelChatWindowTransition(element: Element): void {
  const target = element as HTMLElement;
  const frame = chatTransitionFrames.get(target);
  if (frame !== undefined) cancelAnimationFrame(frame);
  chatTransitionFrames.delete(target);
  target.style.transform = "";
  target.style.willChange = "";
}

function runChatWindowTransition(
  element: Element,
  fromY: number,
  toY: number,
  nativeDuration: number,
  done: () => void,
): void {
  const target = element as HTMLElement;
  cancelChatWindowTransition(target);
  const playbackRate = Math.max(0.0001, player?.Model.getCurrentSpeedRate() || 1);
  const durationMs = state.seeking ? 0 : (nativeDuration / playbackRate) * 1000;
  const apply = (offsetY: number): void => {
    target.style.transform = `translate(-50%, ${offsetY}px)`;
  };
  if (durationMs <= 0) {
    apply(toY);
    if (toY === 0) target.style.transform = "";
    done();
    return;
  }

  target.style.willChange = "transform";
  const startedAt = performance.now();
  const tick = (now: number): void => {
    const raw = Math.max(0, Math.min(1, (now - startedAt) / durationMs));
    const eased = evaluateAdvChatOutExpo(raw);
    apply(fromY + (toY - fromY) * eased);
    if (raw < 1) {
      chatTransitionFrames.set(target, requestAnimationFrame(tick));
      return;
    }
    chatTransitionFrames.delete(target);
    target.style.willChange = "";
    if (toY === 0) target.style.transform = "";
    done();
  };
  apply(fromY);
  chatTransitionFrames.set(target, requestAnimationFrame(tick));
}

function enterChatWindow(element: Element, done: () => void): void {
  const surface = (element as HTMLElement).querySelector<HTMLElement>(".AdvChatWindow");
  if (surface) cancelChatModeTransition(surface);
  const travel = rootEl.value?.clientHeight || element.parentElement?.clientHeight || 0;
  runChatWindowTransition(element, travel, 0, ADV_CHAT_WINDOW_TRANSITION.showDuration, done);
}

function leaveChatWindow(element: Element, done: () => void): void {
  const surface = (element as HTMLElement).querySelector<HTMLElement>(".AdvChatWindow");
  if (surface) cancelChatModeTransition(surface);
  const travel = rootEl.value?.clientHeight || element.parentElement?.clientHeight || 0;
  runChatWindowTransition(element, 0, travel, ADV_CHAT_WINDOW_TRANSITION.hideDuration, done);
}

function playCurrentPlayer() {
  const current = player;
  if (!current) return;
  void current.play().catch((err: unknown) => {
    if (player !== current) return;
    state.error = err instanceof Error ? err.message : String(err);
    state.playing = false;
  });
}

function startOrAdvance() {
  if (!player || state.loading) return;
  if (canStart.value) {
    playCurrentPlayer();
    return;
  }
  if (canReplay.value) {
    restart();
    return;
  }
  if (state.playing) player.requestNext();
}

async function restart() {
  seekDecisionHistory.clear();
  destroy({ releaseTextures: false });
  const attempt = beginBootAttempt();
  Object.assign(state, createState());
  await nextTick();
  if (!isBootAttemptActive(attempt)) return;
  const current = await boot({ reusePreload: true }, attempt);
  if (current && isBootAttemptActive(attempt) && player === current) playCurrentPlayer();
}

function progressRatioFromEvent(event: Event): number {
  return clamp01(Number((event.currentTarget as { value?: unknown } | null)?.value));
}

function onProgressInput(event: Event) {
  scheduleProgressRatio(progressRatioFromEvent(event));
}

function onProgressChange(event: Event) {
  scheduleProgressRatio(progressRatioFromEvent(event), 0);
}

function onProgressClick(event: MouseEvent) {
  if (event.detail === 0 || event.button !== 0) return;
  const slider = event.currentTarget as HTMLElement | null;
  const bounds = slider?.getBoundingClientRect();
  if (!bounds?.width) return;
  scheduleProgressRatio((event.clientX - bounds.left) / bounds.width, 0);
}

function scheduleProgressRatio(ratio: number, delayMs = 120) {
  if (state.loading || !state.commandCount) return;
  if (progressSeekTimer) clearTimeout(progressSeekTimer);
  progressSeekTimer = setTimeout(
    () => {
      progressSeekTimer = null;
      void seekStoryProgress(clamp01(ratio)).catch((error: unknown) => {
        state.seeking = false;
        state.error = error instanceof Error ? error.message : String(error);
      });
    },
    Math.max(0, delayMs),
  );
}

function seekProgress(ratio: number, delayMs = 0) {
  scheduleProgressRatio(ratio, delayMs);
}

function resize() {
  player?.resize();
}

async function seekStoryProgress(ratio: number) {
  if (!story.value || !state.commandCount) return;
  // The progress rail represents discrete, settled command boundaries. Pick
  // the boundary nearest the clicked position instead of biasing every click
  // toward the preceding command.
  const targetIndex = Math.max(0, Math.min(state.commandCount, Math.round(ratio * state.commandCount)));
  const version = ++progressSeekVersion;
  const current = player;
  // Always rebuild from a proven checkpoint and deterministically replay to
  // the requested boundary. The old fast-forward path left transient scene,
  // audio, and command-task state alive, so forward and backward seeks could
  // produce different results for the same target.
  for (const [key, value] of current?.exportSeekDecisions() || []) seekDecisionHistory.set(key, value);
  destroy({ releaseTextures: false });
  const attempt = beginBootAttempt();
  Object.assign(state, createState());
  await nextTick();
  if (!isBootAttemptActive(attempt)) return;
  const restored = await boot({ reusePreload: true }, attempt);
  if (version !== progressSeekVersion || !restored || player !== restored || !isBootAttemptActive(attempt)) return;
  restored.importSeekDecisions(seekDecisionHistory);
  await restored.replayFromStartTo(targetIndex);
  if (version !== progressSeekVersion || player !== restored || !isBootAttemptActive(attempt)) return;
  playCurrentPlayer();
}

function choose(key: unknown) {
  player?.choose(key);
}

function skipCurrentVideo(event?: Event) {
  event?.preventDefault();
  if (!state.video?.visible) return;
  player?.skip();
}

async function toggleFullscreen() {
  const el = rootEl.value;
  if (!el) return;
  if (document.fullscreenElement) {
    await document.exitFullscreen?.();
  } else {
    await el.requestFullscreen?.();
  }
}

defineExpose({ progress, resize, startOrAdvance, seekProgress, skipCurrentVideo, toggleFullscreen });

function clampVolume(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 1;
}

function syncPlayerAudioSettings() {
  if (!player?.SoundManager) return;
  player.SoundManager.setMasterVolume(clampVolume(props.volume));
  player.SoundManager.setUserCategoryVolume("Bgm", props.enableBgm === 0 ? clampVolume(props.volumeBgm) : 0);
}

function syncPlayerAutoPlay() {
  if (!player?.Model) return;
  player.setAutoPlayInterval(props.autoPlayInterval);
  player.Model.isAutoPlay = props.autoPlay === 0;
  state.autoPlay = player.Model.isAutoPlay;
  if (!player.Model.isAutoPlay) player.cancelAutoAdvance();
  if (player.Model.isAutoPlay && player.Model.NextStepState === 1) player.Model.changeGoNextState();
}

function syncPlayerSubtitlesSettings() {
  player?.setSubtitlesEnabled(props.subtitlesEnabled !== false);
}
</script>

<template>
  <div
    ref="rootEl"
    class="adv-story-browser"
    :class="{ 'is-loading': state.loading, 'is-playing': state.playing, 'is-finished': state.finished }"
    :style="browserStyle"
  >
    <div ref="canvasHost" class="adv-canvas-host" @click="startOrAdvance" />

    <div class="adv-unity-reference-plane">
      <div v-if="state.title.visible" class="adv-title UIAdvTitleView">
        <div class="Title" :style="{ animationDuration: `${state.title.duration}s` }">
          <div class="TitleText adv-rich-text localized-text" :lang="state.title.lang">
            <StoryRichText :value="state.title.text" />
          </div>
        </div>
      </div>

      <div v-if="state.location.visible" class="adv-location UIAdvLocationVIew">
        <div class="Background" />
        <div class="LocationText adv-rich-text localized-text" :lang="state.location.lang">
          <StoryRichText :value="state.location.text" />
        </div>
      </div>

      <Transition
        :css="false"
        @enter="enterChatWindow"
        @leave="leaveChatWindow"
        @enter-cancelled="cancelChatWindowTransition"
        @leave-cancelled="cancelChatWindowTransition"
      >
        <div ref="chatWindowEl" v-if="state.chat.visible" class="adv-chat UIAdvChatWidget" :class="chatWindowClass">
          <div
            class="AdvChatWindow"
            :class="[chatWindowClass, { GroupChat: state.chat.visible ? state.chat.group : lastVisibleChatGroup }]"
          >
            <div class="Mask">
              <div class="Bg" />
              <div class="Top">
                <div class="WindowName localized-text" :lang="state.chat.titleLang">
                  {{ state.chat.title || "CHAT" }}
                </div>
                <div class="BackIcon" />
                <div class="RowsIcon" />
                <div class="CallIcon" />
                <div class="SmallIconsLeft">
                  <span class="Icon SignalIcon" />
                  <span class="Icon RssIcon" />
                  <span class="Icon AlarmIcon" />
                  <span class="Icon NaviIcon" />
                </div>
                <div class="Battery">
                  <div
                    class="Fill"
                    :style="{ '--battery-ratio': `${Math.max(0, Math.min(1, Number(state.chat.battery || 0) / 100))}` }"
                  />
                  <div class="Frame" />
                  <div class="PercentText">{{ state.chat.batteryText || "100%" }}</div>
                </div>
              </div>
              <div class="ScrollView">
                <div class="Viewport">
                  <div class="Content">
                    <div
                      v-for="message in state.chat.messages"
                      :key="message.id"
                      class="adv-chat-message AdvChatNode"
                      :class="[message.self ? 'MyChatNode' : 'OtherChatNode', { 'is-stamp': message.stamp }]"
                    >
                      <div v-if="!message.self" class="ChatIcon">
                        <img v-if="chatImageSrc(message.icon)" :src="chatImageSrc(message.icon)" class="Icon" alt="" />
                      </div>
                      <div :class="message.self ? 'ChatContent' : 'ChatContentAndName'">
                        <div v-if="message.speaker && !message.self" class="Name">
                          <span class="NameText localized-text" :lang="message.speakerLang">{{ message.speaker }}</span>
                        </div>
                        <div v-if="!message.self" class="ChatContent">
                          <div v-if="message.stamp" class="Stamp">
                            <img :src="chatImageSrc(message.stamp)" alt="" />
                          </div>
                          <div v-else class="TextBox">
                            <div class="ChatText localized-text" :lang="message.textLang">{{ message.text }}</div>
                          </div>
                        </div>
                        <template v-else>
                          <div v-if="(message.readCount ?? 0) > 0" class="ReadText">既読</div>
                          <div v-if="message.stamp" class="Stamp">
                            <img :src="chatImageSrc(message.stamp)" alt="" />
                          </div>
                          <div v-else class="TextBox">
                            <div class="ChatText localized-text" :lang="message.textLang">{{ message.text }}</div>
                          </div>
                        </template>
                      </div>
                    </div>
                  </div>
                  <div class="TypingIndicatorBottom">
                    <div class="IndicatorBg" />
                    <div class="PlusIcon" />
                    <div class="PhotoIcon" />
                    <div class="TexIcon" />
                    <div class="MicIcon" />
                    <div class="TypingChatNode">
                      <div class="TypingChatBaseContent">
                        <div class="TypingChatContent">
                          <div class="TypingTextBox">
                            <div v-if="state.chat.typing" class="ChatText localized-text" :lang="state.chat.typingLang">
                              {{ state.chat.typing }}
                            </div>
                            <div class="SmileIcon" />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="LockScreen">
                <div class="LockBg" />
                <div class="LockCallNowText">通知センター</div>
                <div class="LockScrollView">
                  <div class="Viewport">
                    <div class="Content">
                      <div
                        v-for="message in state.chat.messages"
                        :key="`lock-${message.id}`"
                        class="adv-chat-message AdvChatNode"
                        :class="[message.self ? 'MyChatNode' : 'OtherChatNode', { 'is-stamp': message.stamp }]"
                      >
                        <div v-if="!message.self" class="ChatIcon">
                          <img
                            v-if="chatImageSrc(message.icon)"
                            :src="chatImageSrc(message.icon)"
                            class="Icon"
                            alt=""
                          />
                        </div>
                        <div :class="message.self ? 'ChatContent' : 'ChatContentAndName'">
                          <div v-if="message.speaker && !message.self" class="Name">
                            <span class="NameText localized-text" :lang="message.speakerLang">
                              {{ message.speaker }}
                            </span>
                          </div>
                          <div v-if="!message.self" class="ChatContent">
                            <div v-if="message.stamp" class="Stamp">
                              <img :src="chatImageSrc(message.stamp)" alt="" />
                            </div>
                            <div v-else class="TextBox">
                              <div class="ChatText localized-text" :lang="message.textLang">{{ message.text }}</div>
                            </div>
                          </div>
                          <template v-else>
                            <div v-if="(message.readCount ?? 0) > 0" class="ReadText">既読</div>
                            <div v-if="message.stamp" class="Stamp">
                              <img :src="chatImageSrc(message.stamp)" alt="" />
                            </div>
                            <div v-else class="TextBox">
                              <div class="ChatText localized-text" :lang="message.textLang">{{ message.text }}</div>
                            </div>
                          </template>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="IncomingCall">
                <div class="IncomingCallBg" />
                <div class="IncomingCallName localized-text" :lang="state.chat.titleLang">
                  {{ state.chat.title || "CHAT" }}
                </div>
                <div class="IncomingCallNowText">着信中...</div>
              </div>
            </div>
            <div class="Overlay" />
          </div>
        </div>
      </Transition>

      <div v-if="state.subtitles.visible" class="adv-subtitles UIAdvSubtitlesView">
        <div class="SubtitlesText adv-rich-text localized-text" :lang="state.subtitles.lang">
          <StoryRichText :value="state.subtitles.text" />
        </div>
      </div>

      <div
        v-if="state.talk.visible"
        class="adv-talk UITypingTalkWindow"
        :class="talkWindowClass"
        :style="{
          transform: `translate(calc(-50% + ${state.talk.shakeX}px), ${state.talk.shakeY}px)`,
        }"
        @click.stop="startOrAdvance"
      >
        <div class="TalkBackground">
          <template v-if="talkWindowClass === 'UIPsychTalkWindow'">
            <span class="PsychBg" />
            <span class="PsychEdge" />
          </template>
        </div>
        <div class="TalkArea">
          <div class="Content">
            <span v-if="talkWindowClass === 'UIPsychTalkWindow'" class="PsychLine" />
            <div v-if="state.talk.speaker" class="Speaker">
              <div class="Back">
                <div class="SpeakerText localized-text" :lang="state.talk.speakerLang">
                  {{ state.talk.speaker }}
                </div>
              </div>
            </div>
            <div class="TalkText adv-rich-text localized-text" :lang="state.talk.textLang">
              <StoryRichText :value="state.talk.displayedText" />
            </div>
            <div v-if="state.talk.textComplete" class="TalkNextIndicator">
              <span class="GlowIcon" />
              <span class="Icon" />
            </div>
          </div>
        </div>
      </div>

      <div v-if="state.choices.visible" class="adv-choice-layer UIAdvChoiceView">
        <div class="Choices">
          <button
            v-for="choice in state.choices.items"
            :key="String(choice.key ?? '')"
            class="adv-choice ChoiceItem"
            type="button"
            @click.stop="choose(choice.key)"
          >
            <span class="Root">
              <span class="Image" />
              <span class="UIRubyText localized-text" :lang="choice.lang">{{ choice.text }}</span>
            </span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="state.loading" class="adv-loading" aria-live="polite">
      <slot name="loading">
        <div class="adv-loading-title">{{ message("loading") }}</div>
        <md-linear-progress
          class="adv-loading-bar md3-linear-progress"
          :aria-label="message('loading')"
          :max="1"
          :value="progressRatio"
        />
        <div class="adv-loading-count">{{ state.preload.done }} / {{ state.preload.total }}</div>
      </slot>
    </div>

    <button
      v-if="!state.loading && canStart && showStart !== false"
      type="button"
      class="adv-start"
      :aria-label="message('play')"
      @click.stop="startOrAdvance"
    >
      <StoryIcon name="play" />
      <span>{{ message("play") }}</span>
    </button>

    <button
      v-else-if="canReplay && showStart !== false"
      type="button"
      class="adv-start"
      :aria-label="message('replay')"
      @click.stop="restart"
    >
      <StoryIcon name="replay" />
      <span>{{ message("replay") }}</span>
    </button>

    <div v-if="state.error" class="adv-error">
      {{ state.error }}
    </div>
  </div>

  <div
    v-if="showProgress !== false && state.ready && state.commandCount"
    class="adv-player-progress buttons has-addons is-centered"
  >
    <button
      v-if="state.video.visible && state.video.playing"
      type="button"
      class="button is-small is-rounded round adv-video-skip"
      :aria-label="message('skipVideo')"
      :title="message('skipVideo')"
      @click="skipCurrentVideo"
    >
      <StoryIcon name="skip" />
    </button>
    <button type="button" class="button is-small is-rounded round is-static adv-progress-count">
      {{ progressLabel }}
    </button>
    <md-slider
      class="adv-progress-slider"
      :class="{ 'is-seeking': state.seeking }"
      :aria-label="progressLabel"
      :aria-valuetext="progressLabel"
      :max="1"
      :min="0"
      :step="progressStep"
      :value="activeProgressRatio"
      @click="onProgressClick"
      @change="onProgressChange"
      @input="onProgressInput"
    />
  </div>
</template>

<style scoped>
.adv-story-browser {
  position: relative;
  width: min(100%, 1180px);
  aspect-ratio: var(--adv-landscape-aspect);
  margin: 0 auto;
  overflow: hidden;
  color: #fff;
  border-radius: 4px;
  isolation: isolate;
  user-select: none;
  container-type: size;
  font-family: inherit;
  /* Recreates the Unity TMP material "OutlineAdvCommon" while typography follows the host page. */
  --adv-text-shadow:
    0.045em 0 0 rgba(46, 46, 46, 0.85), -0.045em 0 0 rgba(46, 46, 46, 0.85), 0 0.045em 0 rgba(46, 46, 46, 0.85),
    0 -0.045em 0 rgba(46, 46, 46, 0.85), 0.032em 0.032em 0 rgba(46, 46, 46, 0.85),
    -0.032em 0.032em 0 rgba(46, 46, 46, 0.85), 0.032em -0.032em 0 rgba(46, 46, 46, 0.85),
    -0.032em -0.032em 0 rgba(46, 46, 46, 0.85), 0 0.03em 0.09em rgba(0, 0, 0, 0.55);
}

@media (orientation: portrait) {
  .adv-story-browser {
    aspect-ratio: var(--adv-portrait-aspect);
  }
}

.adv-canvas-host,
.adv-canvas-host :deep(canvas) {
  position: absolute;
  inset: 0;
}

.adv-canvas-host {
  /*
   * UIAdvWidget keeps Video/Still/Frame on Canvas orders 301/302/303 and
   * all authored ADV UI on FrontCanvas order 304. StoryDomOverlay is mounted
   * inside this host, so this stacking context is the browser equivalent of
   * that Canvas boundary: none of its internal media/frame/fade z-indices can
   * escape above the sibling FrontCanvas reference plane.
   */
  z-index: 0;
}

.adv-canvas-host :deep(canvas) {
  width: 100%;
  height: 100%;
  display: block;
}

/*
 * FrontCanvas uses CanvasScaler(1920x1080, ScreenMatchMode.Expand). Keep a
 * centered 1920-reference-pixel plane for fixed RectTransforms; roots whose
 * anchors stretch across the Canvas explicitly expand back to 100cqw.
 */
.adv-unity-reference-plane {
  height: 100%;
  left: 50%;
  pointer-events: none;
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  width: var(--adv-reference-plane-width);
  z-index: 1;
}

.adv-start {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.25em;
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: 0;
  background-color: rgba(255, 255, 255, 0.8);
  color: rgba(80, 80, 80, 1);
  font-family: inherit;
  font-size: 16px;
  line-height: 1.5;
  cursor: pointer;
}

.adv-start :deep(.story-icon) {
  width: 1.5em;
  height: 1.5em;
}

.adv-start:hover {
  color: rgba(54, 54, 54, 1);
}

.adv-player-progress {
  align-items: stretch;
  display: flex;
  font-family: inherit;
  justify-content: center;
  margin: 0.75rem auto 0;
  max-width: min(100%, 1180px);
  width: 100%;
}

.adv-player-progress .button {
  align-items: center;
  appearance: none;
  background: #fff;
  border: 1px solid #dbdbdb;
  color: #363636;
  display: inline-flex;
  font: inherit;
  font-size: 0.75rem;
  height: 2.5em;
  justify-content: center;
  line-height: 1.5;
  margin: 0;
  padding: 0.5em 0.75em;
}

.adv-player-progress .button + .button {
  margin-left: -1px;
}

.adv-player-progress .button:first-child {
  border-radius: 999px 0 0 999px;
}

.adv-player-progress .button:last-child {
  border-radius: 0 999px 999px 0;
}

.adv-player-progress .button:only-child {
  border-radius: 999px;
}

.adv-player-progress .button:not(.is-static):hover {
  border-color: #b5b5b5;
  color: #242424;
  z-index: 1;
}

.adv-player-progress .is-expanded {
  flex: 1 1 auto;
}

.adv-player-progress .is-static {
  cursor: default;
  pointer-events: none;
}

.adv-player-progress .round {
  padding-left: 0.75em;
  padding-right: 0.75em;
}

.adv-player-progress .round:first-child {
  padding-left: 1em;
}

.adv-player-progress .round:last-child {
  padding-right: 1em;
}

.adv-progress-count {
  text-align: center;
  width: 7em;
}

.adv-video-skip {
  min-width: 2.75em;
}

.adv-progress-slider {
  min-width: 0;
  flex: 1 1 auto;
  --md-slider-active-track-color: var(--md-comp-runtime-slider-fill);
  --md-slider-inactive-track-color: var(--md-comp-runtime-slider-track);
  --md-slider-handle-color: var(--md-comp-runtime-slider-fill);
  --md-slider-hover-handle-color: var(--md-comp-runtime-slider-fill);
  --md-slider-pressed-handle-color: var(--md-comp-runtime-slider-fill);
  --md-slider-active-track-height: 8px;
  --md-slider-inactive-track-height: 8px;
}

.adv-progress-slider.is-seeking {
  opacity: 0.78;
}

.adv-title {
  bottom: 0;
  left: 50%;
  pointer-events: none;
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  width: 100cqw;
  z-index: 42;
}

.adv-title .Title {
  align-items: center;
  animation: advTitlePlay 6s linear both;
  background: linear-gradient(
    90deg,
    rgba(114, 181, 255, 0.4) 0%,
    rgba(190, 248, 236, 0.352941) 90.019684%,
    rgba(198, 255, 234, 0) 100%
  );
  box-sizing: border-box;
  display: inline-flex;
  justify-content: center;
  left: 0;
  max-width: 100%;
  padding: var(--adv-title-padding-y) var(--adv-title-padding-x);
  position: absolute;
  top: var(--adv-title-top);
  width: max-content;
}

.adv-title .TitleText {
  color: #fff;
  font-size: calc(var(--adv-title-font-size) * var(--adv-text-scale));
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1.2;
  text-shadow: var(--adv-text-shadow);
  white-space: nowrap;
}

/* AdvTitle Play clip: hold through 5s, then Hermite smoothstep
   alpha 1 -> 0 and anchoredPosition.x 0 -> -300 over the final second. */
@keyframes advTitlePlay {
  0% {
    opacity: 1;
    transform: translateX(0);
  }
  83.333333% {
    animation-timing-function: cubic-bezier(0.3333333333, 0, 0.6666666667, 1);
    opacity: 1;
    transform: translateX(0);
  }
  100% {
    opacity: 0;
    transform: translateX(var(--adv-title-exit-x));
  }
}

.adv-location {
  animation: advLocationIn 2.5s linear both;
  height: var(--adv-location-frame-height);
  left: 50%;
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: var(--adv-location-width);
  z-index: 42;
}

.adv-location .Background,
.adv-location .LocationText {
  height: var(--adv-location-content-height);
  left: 0;
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
}

.adv-location .Background {
  background: linear-gradient(
    90deg,
    rgba(114, 181, 255, 0) 0%,
    rgba(131, 196, 251, 0.4) 20%,
    rgba(181, 239, 240, 0.4) 80%,
    rgba(198, 255, 234, 0) 100%
  );
}

.adv-location .LocationText {
  align-items: center;
  color: #fff;
  display: flex;
  font-size: calc(var(--adv-location-font-size) * var(--adv-text-scale));
  font-weight: 700;
  justify-content: center;
  letter-spacing: 0;
  line-height: 1;
  text-align: center;
  text-shadow: var(--adv-text-shadow);
  white-space: nowrap;
}

/* Unity "Play.asset" (2.5s): fade in 0-0.3s + slide from +300px (0-0.5s); hold; fade out 2.0-2.3s +
   slide to -300px (2.0-2.5s). Expand scales both RectTransform axes by the canvas scale. */
@keyframes advLocationIn {
  0% {
    animation-timing-function: cubic-bezier(0.3333333333, 0, 0.6666666667, 1);
    opacity: 0;
    transform: translate(calc(-50% + var(--adv-location-travel-x)), -50%);
  }
  12% {
    opacity: 1;
  }
  20% {
    transform: translate(-50%, -50%);
  }
  80% {
    animation-timing-function: cubic-bezier(0.3333333333, 0, 0.6666666667, 1);
    opacity: 1;
    transform: translate(-50%, -50%);
  }
  92% {
    opacity: 0;
  }
  100% {
    opacity: 0;
    transform: translate(calc(-50% - var(--adv-location-travel-x)), -50%);
  }
}

.adv-talk {
  color: #fff;
  height: 100%;
  left: 50%;
  pointer-events: auto;
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  width: 100cqw;
  z-index: 44;
}

.adv-talk .TalkArea,
.adv-talk .TalkBackground,
.adv-talk .Content,
.adv-talk .Speaker,
.adv-talk .Back,
.adv-talk .SpeakerText,
.adv-talk .TalkText,
.adv-talk .TalkNextIndicator,
.adv-talk .GlowIcon,
.adv-talk .Icon,
.adv-talk .PsychBg,
.adv-talk .PsychEdge,
.adv-talk .PsychLine {
  position: absolute;
}

.adv-talk .TalkText,
.adv-talk .SpeakerText {
  font-weight: 400;
  letter-spacing: 0;
  white-space: pre-wrap;
}

.adv-talk .TalkText {
  font-size: calc(var(--adv-default-talk-font-size) * var(--adv-text-scale));
  line-height: 1.2;
}

.adv-talk .SpeakerText {
  align-items: center;
  color: #fff;
  display: flex;
  font-size: calc(var(--adv-default-talk-font-size) * var(--adv-text-scale));
  font-weight: 700;
  line-height: 1;
  overflow: hidden;
  text-align: left;
  white-space: nowrap;
}

.UIDefaultTalkWindow .TalkArea {
  inset: 0;
}

.UIDefaultTalkWindow .TalkBackground {
  background: var(--adv-sprite-story-bottom-band) center / 100% 100% repeat-x;
  bottom: var(--adv-default-talk-background-bottom);
  height: var(--adv-default-talk-background-height);
  left: 50%;
  transform: translateX(-50%);
  width: calc(100% + var(--adv-default-talk-background-size-delta-x));
}

.UIDefaultTalkWindow .Content {
  bottom: 0;
  height: 0;
  left: 50%;
  transform: translateX(-50%);
  width: var(--adv-default-talk-content-width);
}

.UIDefaultTalkWindow .Speaker {
  bottom: var(--adv-default-talk-speaker-bottom);
  height: var(--adv-default-talk-speaker-height);
  left: var(--adv-default-talk-speaker-left);
  width: var(--adv-default-talk-speaker-width);
}

.UIDefaultTalkWindow .Back,
.UISimpleAdvTalkWindow .Back {
  align-items: center;
  background: linear-gradient(
    90deg,
    rgba(114, 181, 255, 0.4) 0%,
    rgba(198, 255, 234, 0.2745) 69.65%,
    rgba(198, 255, 234, 0) 100%
  );
  box-sizing: border-box;
  display: inline-flex;
  height: 100%;
  left: 0;
  min-width: 0;
  padding: 0 9.028cqh 0 2.257cqh;
  top: 0;
  width: auto;
}

.UIDefaultTalkWindow .Back .SpeakerText,
.UISimpleAdvTalkWindow .Back .SpeakerText {
  height: 4.063cqh;
  inset: auto;
  overflow: visible;
  padding: 0;
  position: relative;
  text-shadow: var(--adv-text-shadow);
}

.UIDefaultTalkWindow .TalkText {
  bottom: var(--adv-default-talk-text-bottom);
  color: #fff;
  height: var(--adv-default-talk-text-height);
  left: var(--adv-default-talk-text-left);
  overflow: hidden;
  text-shadow: var(--adv-text-shadow);
  width: var(--adv-default-talk-text-width);
}

.UIDefaultTalkWindow .TalkNextIndicator {
  bottom: var(--adv-default-talk-indicator-bottom);
  height: var(--adv-default-talk-indicator-size);
  right: var(--adv-default-talk-indicator-right);
  width: var(--adv-default-talk-indicator-size);
}

.UIDefaultTalkWindow .GlowIcon,
.UIDefaultTalkWindow .Icon,
.UICenterTalkWindow .Icon,
.UIPsychTalkWindow .GlowIcon,
.UIPsychTalkWindow .Icon {
  background-position: center;
  background-repeat: no-repeat;
  background-size: contain;
  inset: 0;
}

.UIDefaultTalkWindow .GlowIcon,
.UIPsychTalkWindow .GlowIcon {
  animation: advTapNextGlow 0.92s ease-in-out infinite;
  background-image: var(--adv-sprite-tap-next-glow);
  transform: scale(1.08);
}

.UIDefaultTalkWindow .Icon,
.UIPsychTalkWindow .Icon {
  animation: advTapNext 0.92s ease-in-out infinite;
  background-image: var(--adv-sprite-tap-next);
  transform: scale(0.64);
}

.UICenterTalkWindow .TalkArea,
.UICenterTalkWindow .TalkBackground {
  height: var(--adv-center-talk-height);
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
}

.UICenterTalkWindow .TalkBackground {
  background: rgba(0, 0, 0, 0.4902);
}

.UICenterTalkWindow .Content {
  align-items: center;
  display: flex;
  height: 100%;
  justify-content: center;
  left: 50%;
  top: 0;
  transform: translateX(-50%);
  width: var(--adv-reference-plane-width);
}

.UICenterTalkWindow .Speaker {
  display: none;
}

.UICenterTalkWindow .TalkText {
  color: #fff;
  font-size: calc(var(--adv-center-talk-font-size) * var(--adv-text-scale));
  max-width: none;
  position: static;
  text-align: left;
  text-shadow: 0 2px 7px rgba(0, 0, 0, 0.85);
  white-space: pre;
  width: max-content;
}

.UICenterTalkWindow .TalkNextIndicator {
  height: var(--adv-center-talk-indicator-height);
  right: var(--adv-center-talk-indicator-right);
  top: var(--adv-center-talk-indicator-top);
  width: var(--adv-center-talk-indicator-width);
}

.UICenterTalkWindow .GlowIcon {
  display: none;
}

.UICenterTalkWindow .Icon {
  background-image: var(--adv-sprite-next);
}

.UISimpleAdvTalkWindow .TalkArea {
  inset: 0;
}

.UISimpleAdvTalkWindow .TalkBackground {
  background: rgba(255, 255, 255, 0.298);
  border: calc(0.37cqh) solid rgba(77, 104, 128, 0.4);
  box-shadow: inset 0 0 0 calc(0.37cqh) rgba(255, 255, 255, 0.6);
  inset: 4.63% 0;
}

.UISimpleAdvTalkWindow .Content {
  inset: 4.63% 6.5%;
}

.UISimpleAdvTalkWindow .Speaker {
  height: 6.17%;
  left: 0;
  top: 2.2%;
  width: 41.667%;
}

.UISimpleAdvTalkWindow .Back {
  bottom: auto;
  left: 0;
  right: auto;
  top: 0;
}

.UISimpleAdvTalkWindow .TalkText {
  color: rgb(5, 18, 51);
  font-size: calc(12px * var(--adv-text-scale));
  font-size: calc(2.222cqh * var(--adv-text-scale));
  inset: 14% 7% 9%;
  line-height: 1.35;
  text-shadow: none;
}

.UISimpleAdvTalkWindow .TalkNextIndicator {
  display: none;
}

.UIPsychTalkWindow .TalkArea {
  bottom: var(--adv-psych-baseline-y);
  height: 0;
  left: 0;
  right: 0;
  transform: scale(var(--adv-psych-content-scale));
  transform-origin: center center;
}

.UIPsychTalkWindow .TalkBackground {
  bottom: var(--adv-psych-baseline-y);
  height: var(--adv-psych-background-height);
  left: 50%;
  transform: translateX(-50%);
  width: var(--adv-psych-background-width);
}

.UIPsychTalkWindow .PsychBg,
.UIPsychTalkWindow .PsychEdge {
  inset: 0;
}

.UIPsychTalkWindow .PsychBg {
  background: rgba(246, 238, 227, 0.5960784554);
}

.UIPsychTalkWindow .PsychEdge {
  border: var(--adv-psych-edge-width) solid transparent;
  border-image-repeat: stretch;
  border-image-slice: 50%;
  border-image-source: var(--adv-sprite-psych-edge);
  border-image-width: var(--adv-psych-edge-width);
  box-sizing: border-box;
  filter: brightness(28.627452%);
}

.UIPsychTalkWindow .Content {
  bottom: 0;
  height: 0;
  left: 50%;
  transform: translateX(-50%);
  width: var(--adv-psych-content-width);
}

.UIPsychTalkWindow .Speaker {
  bottom: var(--adv-psych-speaker-bottom);
  height: var(--adv-psych-speaker-height);
  left: var(--adv-psych-speaker-left);
  width: var(--adv-psych-speaker-width);
}

.UIPsychTalkWindow .Back {
  background: transparent;
  inset: 0;
}

.UIPsychTalkWindow .SpeakerText {
  color: rgb(67, 67, 67);
  font-size: calc(var(--adv-psych-talk-font-size) * var(--adv-text-scale));
  font-weight: 400;
  inset: 0 var(--adv-psych-speaker-text-right) 0 var(--adv-psych-speaker-text-left);
  letter-spacing: 0;
  padding: 0;
  text-shadow: none;
}

.UIPsychTalkWindow .TalkText {
  bottom: var(--adv-psych-text-bottom);
  color: rgb(67, 67, 67);
  font-size: calc(var(--adv-psych-talk-font-size) * var(--adv-text-scale));
  height: var(--adv-psych-text-height);
  left: var(--adv-psych-text-left);
  text-shadow: none;
  width: var(--adv-psych-text-width);
}

.UIPsychTalkWindow .PsychLine {
  border-color: transparent;
  border-image-repeat: stretch;
  border-image-slice: 0 15 fill;
  border-image-source: var(--adv-sprite-psych-line);
  border-image-width: 0 var(--adv-psych-line-border-x);
  border-style: solid;
  border-width: 0 var(--adv-psych-line-border-x);
  box-sizing: border-box;
  bottom: var(--adv-psych-line-bottom);
  height: var(--adv-psych-line-height);
  left: 50%;
  transform: translateX(-50%);
  width: var(--adv-psych-line-width);
}

.UIPsychTalkWindow .TalkNextIndicator {
  bottom: var(--adv-psych-indicator-bottom);
  height: var(--adv-psych-indicator-height);
  right: var(--adv-psych-indicator-right);
  width: var(--adv-psych-indicator-width);
}

@keyframes advTapNext {
  0%,
  100% {
    opacity: 0.82;
    transform: scale(0.64) translateY(0);
  }
  50% {
    opacity: 1;
    transform: scale(0.58) translateY(5%);
  }
}

@keyframes advTapNextGlow {
  0%,
  100% {
    opacity: 0.66;
    transform: scale(1.08);
  }
  50% {
    opacity: 1;
    transform: scale(0.98);
  }
}

.adv-rich-text {
  white-space: pre-wrap;
}

.adv-rich-text :deep(ruby) {
  ruby-position: over;
}

.adv-rich-text :deep(rt) {
  font-size: 0.46em;
  font-weight: 700;
  line-height: 1;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.85);
}

.adv-subtitles {
  bottom: 0;
  left: 50%;
  pointer-events: none;
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  width: 100cqw;
  z-index: 43;
}

.adv-subtitles .SubtitlesText {
  bottom: var(--adv-subtitles-bottom);
  color: #fff;
  font-size: calc(var(--adv-subtitles-font-size) * var(--adv-text-scale));
  font-weight: 700;
  height: var(--adv-subtitles-height);
  left: 0;
  letter-spacing: 0;
  line-height: 1.2;
  position: absolute;
  right: 0;
  text-align: center;
  text-shadow:
    0 2px 6px #000,
    0 0 2px #000;
}

.adv-chat {
  --adv-chat-icon-color: rgb(48, 38, 41);
  --adv-chat-root-height: 100cqh;
  color: rgb(5, 18, 51);
  container-type: size;
  font-family: inherit;
  height: var(--adv-chat-root-height);
  left: 50%;
  overflow: visible;
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  transform-origin: 50% 0;
  width: calc(var(--adv-chat-root-height) * 1.0285714286);
  z-index: 41;
}

.adv-chat.IncomingCallScreenMode {
  --adv-chat-root-height: calc(100cqh * 0.4557291667);
}

.adv-chat .AdvChatWindow,
.adv-chat .Bg,
.adv-chat .Overlay,
.adv-chat .Mask,
.adv-chat .Top,
.adv-chat .ScrollView,
.adv-chat .LockScrollView,
.adv-chat .Viewport,
.adv-chat .Content,
.adv-chat .TypingIndicatorBottom,
.adv-chat .IndicatorBg,
.adv-chat .LockScreen,
.adv-chat .IncomingCall,
.adv-chat .LockBg,
.adv-chat .IncomingCallBg,
.adv-chat .LockCallNowText,
.adv-chat .IncomingCallName,
.adv-chat .IncomingCallNowText {
  position: absolute;
}

.adv-chat .AdvChatWindow {
  height: 100%;
  left: 0;
  overflow: visible;
  top: 0;
  width: 100%;
}

.adv-chat .Bg {
  background: var(--adv-chat-back-bg) center / 100% 100% no-repeat;
  height: 104.46%;
  left: 50%;
  pointer-events: none;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 109.68%;
}

.adv-chat .Overlay {
  background: var(--adv-chat-window-bg) center / 100% 100% no-repeat;
  height: var(--adv-chat-overlay-height);
  left: 50%;
  pointer-events: none;
  top: 0;
  transform: translateX(-50%);
  width: var(--adv-chat-overlay-width);
  z-index: 10;
}

.adv-chat .Mask {
  border-radius: 8.571cqh;
  clip-path: inset(0 round 8.571cqh);
  height: var(--adv-chat-mask-height);
  left: 50%;
  overflow: hidden;
  top: var(--adv-chat-mask-top);
  transform: translateX(-50%);
  width: var(--adv-chat-mask-width);
  z-index: 1;
}

.adv-chat .Top {
  background: rgb(250, 236, 244);
  height: 22.857cqh;
  left: 0;
  right: 0;
  top: 0;
  z-index: 3;
}

.adv-chat .WindowName {
  align-items: center;
  bottom: 0.571cqh;
  color: rgb(5, 18, 51);
  display: flex;
  font-size: calc(5.143cqh * var(--adv-text-scale));
  font-weight: 700;
  height: 7.143cqh;
  justify-content: center;
  left: 50%;
  letter-spacing: 0;
  line-height: 1;
  overflow: hidden;
  position: absolute;
  text-align: center;
  transform: translateX(-50%);
  white-space: nowrap;
  width: 57.143cqh;
}

.adv-chat .BackIcon,
.adv-chat .RowsIcon,
.adv-chat .CallIcon,
.adv-chat .Battery,
.adv-chat .SmallIconsLeft,
.adv-chat .Fill,
.adv-chat .Frame,
.adv-chat .PercentText,
.adv-chat .Icon {
  position: absolute;
}

.adv-chat .BackIcon,
.adv-chat .RowsIcon,
.adv-chat .CallIcon {
  bottom: 0.571cqh;
  height: 6.857cqh;
  overflow: hidden;
  width: 6.857cqh;
}

.adv-chat .BackIcon {
  left: 7.143cqh;
}

.adv-chat .RowsIcon {
  right: 7.143cqh;
}

.adv-chat .CallIcon {
  right: 15.857cqh;
}

.adv-chat .BackIcon::before,
.adv-chat .RowsIcon::before,
.adv-chat .CallIcon::before,
.adv-chat .SmallIconsLeft .Icon::before,
.adv-chat .Frame::before {
  background: var(--adv-chat-icon-color);
  content: "";
  display: block;
  height: 100%;
  inset: 0;
  mask-image: var(--adv-chat-icon-mask);
  mask-position: 0 0;
  mask-repeat: no-repeat;
  mask-size: 100% 100%;
  position: absolute;
  width: 100%;
  -webkit-mask-image: var(--adv-chat-icon-mask);
  -webkit-mask-position: 0 0;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%;
}

.adv-chat .BackIcon::before {
  --adv-chat-icon-mask: var(--adv-chat-icon-back);
}

.adv-chat .RowsIcon::before {
  --adv-chat-icon-mask: var(--adv-chat-icon-bars);
}

.adv-chat .CallIcon::before {
  --adv-chat-icon-mask: var(--adv-chat-icon-call);
}

.adv-chat .SmallIconsLeft {
  height: 5.832cqh;
  left: calc(50% - 41.253cqh);
  top: 6.227cqh;
  width: 23.649cqh;
}

.adv-chat .SmallIconsLeft .Icon {
  bottom: 0;
  height: 4.571cqh;
  overflow: hidden;
  width: 4.571cqh;
}

.adv-chat .SmallIconsLeft .SignalIcon {
  left: 0;
}
.adv-chat .SmallIconsLeft .RssIcon {
  left: 4.571cqh;
}
.adv-chat .SmallIconsLeft .AlarmIcon {
  left: 9.143cqh;
}
.adv-chat .SmallIconsLeft .NaviIcon {
  left: 13.714cqh;
}

.adv-chat .SmallIconsLeft .SignalIcon::before {
  --adv-chat-icon-mask: var(--adv-chat-icon-signal);
}

.adv-chat .SmallIconsLeft .RssIcon::before {
  --adv-chat-icon-mask: var(--adv-chat-icon-rss);
}

.adv-chat .SmallIconsLeft .AlarmIcon::before {
  --adv-chat-icon-mask: var(--adv-chat-icon-alarm);
}

.adv-chat .SmallIconsLeft .NaviIcon::before {
  --adv-chat-icon-mask: var(--adv-chat-icon-navi);
}

.adv-chat .Battery {
  height: 14.286cqh;
  left: calc(50% + 27cqh);
  top: 2cqh;
  width: 14.286cqh;
}

.adv-chat .Frame {
  height: 80%;
  left: 50%;
  overflow: hidden;
  top: 50%;
  transform: translate(-50%, -50%) rotate(90deg);
  transform-origin: center center;
  width: 80%;
}

.adv-chat .Fill {
  height: 52.112%;
  left: calc(50% - 1.846%);
  overflow: hidden;
  top: 50%;
  transform: translate(-50%, -50%) rotate(90deg);
  transform-origin: center center;
  width: 23.629%;
}

.adv-chat .Frame::before {
  --adv-chat-icon-mask: var(--adv-chat-icon-battery-frame);
}

.adv-chat .Fill::before {
  background: rgb(159, 231, 71);
  content: "";
  display: block;
  height: 100%;
  transform: scaleY(var(--battery-ratio));
  transform-origin: center bottom;
  width: 100%;
}

.adv-chat .PercentText {
  align-items: center;
  color: rgb(5, 18, 51);
  display: flex;
  font-size: calc(3cqh * var(--adv-text-scale));
  height: 50%;
  justify-content: center;
  left: calc(50% - 65.776%);
  line-height: 1;
  overflow: hidden;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 68.45%;
}

.adv-chat .ScrollView {
  bottom: 0;
  left: 0;
  right: 0;
  top: 22.857cqh;
  z-index: 2;
}

.adv-chat .Viewport {
  height: 71.429cqh;
  left: 0;
  overflow: hidden;
  right: 0;
  top: 0;
}

.adv-chat .Content {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  left: 0;
  min-height: 0;
  padding: 4.286cqh;
  right: 0;
  top: 0;
}

.adv-chat .AdvChatNode {
  min-height: 9cqh;
  position: relative;
  width: 91.186cqh;
}

.adv-chat .OtherChatNode {
  display: flex;
  margin: 0 0 0.714cqh 0;
}

.adv-chat .MyChatNode {
  margin: 0 0 0.714cqh 0;
  min-height: 9cqh;
}

.adv-chat .ChatIcon {
  background: transparent;
  border-radius: 50%;
  flex: 0 0 12cqh;
  height: 12cqh;
  overflow: hidden;
  position: relative;
  width: 12cqh;
}

.adv-chat .ChatIcon .Icon {
  height: 100%;
  inset: 0;
  object-fit: cover;
  width: 100%;
}

.adv-chat .ChatContentAndName {
  margin-left: 0;
  min-height: 12cqh;
  position: relative;
  width: 70.414cqh;
}

.adv-chat .Name {
  height: 4.571cqh;
  margin-left: 4.286cqh;
  overflow: hidden;
  position: relative;
  width: 69.7cqh;
}

.adv-chat .NameText {
  color: rgb(5, 18, 51);
  display: block;
  font-size: calc(2.857cqh * var(--adv-text-scale));
  font-weight: 700;
  letter-spacing: 0;
  line-height: 4.571cqh;
  white-space: nowrap;
}

.adv-chat .ChatContent {
  position: relative;
}

.adv-chat .OtherChatNode .ChatContent {
  margin-left: 0;
  max-width: 69.7cqh;
  min-height: 9cqh;
}

.adv-chat .MyChatNode > .ChatContent {
  align-items: center;
  display: flex;
  justify-content: flex-end;
  min-height: 9cqh;
  width: 100%;
}

.adv-chat .TextBox,
.adv-chat .TypingTextBox {
  background: #fff;
  border-radius: 2.143cqh;
  box-sizing: border-box;
  display: inline-block;
  max-width: 69.7cqh;
  min-height: 9cqh;
  padding: 2cqh 4.286cqh;
  position: relative;
}

.adv-chat .TextBox::before,
.adv-chat .TypingTextBox::before {
  border-bottom: 1.286cqh solid transparent;
  border-top: 1.286cqh solid transparent;
  content: "";
  position: absolute;
  top: 2.214cqh;
}

.adv-chat .OtherChatNode .TextBox::before,
.adv-chat .TypingTextBox::before {
  border-right: 1.786cqh solid #fff;
  left: -1.286cqh;
}

.adv-chat .MyChatNode .TextBox {
  background: rgb(208, 254, 255);
}

.adv-chat .MyChatNode .TextBox::before {
  border-left: 1.786cqh solid rgb(208, 254, 255);
  right: -1.286cqh;
}

.adv-chat .TypingTextBox {
  background: rgb(239, 239, 239);
}

.adv-chat .TypingTextBox::before {
  border-right-color: rgb(239, 239, 239);
}

.adv-chat .ChatText {
  color: rgb(5, 18, 51);
  font-size: calc(3.429cqh * var(--adv-text-scale));
  font-weight: 400;
  letter-spacing: 0;
  line-height: 1.18;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.adv-chat .ReadText {
  color: rgb(106, 109, 121);
  flex: 0 0 auto;
  font-size: calc(2.857cqh * var(--adv-text-scale));
  line-height: 1;
  margin-right: 1.429cqh;
  white-space: nowrap;
}

.adv-chat .Stamp {
  display: inline-flex;
  max-height: 13.346cqh;
  max-width: 31.25cqh;
  position: relative;
}

.adv-chat .Stamp img {
  display: block;
  height: auto;
  max-height: 13.346cqh;
  max-width: 31.25cqh;
  object-fit: contain;
  width: auto;
}

.adv-chat .TypingChatNode {
  margin-top: 0;
}

.adv-chat .TypingIndicatorBottom {
  bottom: -2.857cqh;
  height: 0;
  left: 0;
  right: 0;
}

.adv-chat .LockScreen,
.adv-chat .IncomingCall {
  display: none;
  inset: 0;
  overflow: hidden;
  z-index: 5;
}

.adv-chat .LockScreenMode .ScrollView,
.adv-chat .IncomingCallScreenMode .ScrollView {
  display: none;
}

.adv-chat .LockScreenMode .LockScreen,
.adv-chat .IncomingCallScreenMode .IncomingCall {
  display: block;
}

.adv-chat .LockBg,
.adv-chat .IncomingCallBg {
  pointer-events: none;
}

.adv-chat .LockBg {
  background: var(--adv-chat-lock-bg) center / 100% 100% no-repeat;
  height: 104.46%;
  left: 50%;
  top: 48.64%;
  transform: translate(-50%, -50%);
  width: 109.68%;
}

.adv-chat .IncomingCallBg {
  background: #000;
  inset: 0;
}

.adv-chat .LockCallNowText,
.adv-chat .IncomingCallName,
.adv-chat .IncomingCallNowText {
  align-items: center;
  color: #fff;
  display: flex;
  font-weight: 700;
  justify-content: center;
  left: 50%;
  line-height: 1;
  overflow: hidden;
  text-align: center;
  transform: translateX(-50%);
  white-space: nowrap;
  width: 71.429cqh;
}

.adv-chat .LockCallNowText {
  font-size: calc(5.714cqh * var(--adv-text-scale));
  height: 7.143cqh;
  top: 26.286cqh;
}

.adv-chat .LockScrollView {
  bottom: 0;
  left: 0;
  right: 0;
  top: 22.857cqh;
}

.adv-chat .LockScrollView .Viewport {
  height: 57.143cqh;
  left: 0;
  overflow: hidden;
  right: 0;
  top: 14.286cqh;
}

.adv-chat .IncomingCallName {
  font-size: calc(6.9cqh * var(--adv-text-scale));
  height: 11.429cqh;
  top: 50cqh;
}

.adv-chat .IncomingCallNowText {
  font-size: calc(4.286cqh * var(--adv-text-scale));
  height: 7.143cqh;
  top: 64.286cqh;
}

.adv-chat .IndicatorBg {
  background: #fff;
  bottom: 0;
  height: 14.286cqh;
  left: 0;
  position: absolute;
  right: 0;
}

.adv-chat .PlusIcon,
.adv-chat .PhotoIcon,
.adv-chat .TexIcon,
.adv-chat .SmileIcon,
.adv-chat .MicIcon {
  background: transparent center / contain no-repeat;
  position: absolute;
  transform: scale(0.8);
  transform-origin: center center;
}

.adv-chat .PlusIcon,
.adv-chat .PhotoIcon,
.adv-chat .TexIcon {
  bottom: 2.214cqh;
  height: 7.286cqh;
  width: 7.429cqh;
}

.adv-chat .TexIcon {
  bottom: 2.357cqh;
}

.adv-chat .SmileIcon {
  bottom: 1.5cqh;
  height: 6.143cqh;
  width: 6.143cqh;
}

.adv-chat .MicIcon {
  bottom: 1.786cqh;
  height: 7.571cqh;
  width: 5.429cqh;
}

.adv-chat .PlusIcon {
  background-image: var(--adv-chat-line-plus);
  left: calc(50% - 44.857cqh);
}
.adv-chat .PhotoIcon {
  background-image: var(--adv-chat-line-photo);
  left: calc(50% - 34.857cqh);
}
.adv-chat .TexIcon {
  background-image: var(--adv-chat-line-pic);
  left: calc(50% - 25cqh);
}
.adv-chat .SmileIcon {
  background-image: var(--adv-chat-line-smile);
  left: calc(50% + 16.6cqh);
}
.adv-chat .MicIcon {
  background-image: var(--adv-chat-line-mic);
  left: calc(50% + 40cqh);
}

.adv-chat .TypingIndicatorBottom > .TypingChatNode {
  bottom: -0.071cqh;
  height: 9cqh;
  left: 34.286cqh;
  position: absolute;
  transform: none;
  width: 70.414cqh;
}

.adv-chat .TypingIndicatorBottom .TypingChatBaseContent,
.adv-chat .TypingIndicatorBottom .TypingChatContent,
.adv-chat .TypingIndicatorBottom .TypingTextBox {
  height: 100%;
  position: absolute;
  width: 100%;
}

.adv-chat .TypingIndicatorBottom .TypingChatBaseContent {
  left: 0;
}

.adv-chat .TypingIndicatorBottom .TypingChatContent {
  left: 0.714cqh;
  width: 52.143cqh;
}

.adv-chat .TypingIndicatorBottom .TypingTextBox {
  background: rgb(239, 239, 239);
  border-radius: 4.5cqh;
  box-sizing: border-box;
  left: 0;
  max-width: none;
  min-height: 0;
  padding: 1.8cqh 8.2cqh 1.8cqh 3.2cqh;
  top: 0;
}

.adv-chat .TypingIndicatorBottom .TypingTextBox::before {
  content: none;
}

.adv-choice-layer {
  height: 100%;
  left: 50%;
  pointer-events: none;
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  width: 100cqw;
  z-index: 55;
}

.adv-choice-layer .Choices {
  display: flex;
  flex-direction: column;
  height: var(--adv-choices-height);
  justify-content: center;
  left: 50%;
  position: absolute;
  top: calc(50% - var(--adv-choices-center-y));
  transform: translate(-50%, -50%);
  width: var(--adv-choices-width);
}

.adv-choice {
  appearance: none;
  background: transparent;
  border: 0;
  color: rgb(5, 18, 51);
  cursor: pointer;
  flex: 0 0 var(--adv-choice-item-height);
  height: var(--adv-choice-item-height);
  margin: 0;
  padding: 0;
  pointer-events: auto;
  position: relative;
  width: 100%;
}

.adv-choice .Root,
.adv-choice .Image,
.adv-choice .UIRubyText {
  position: absolute;
}

.adv-choice .Root,
.adv-choice .Image {
  inset: 0;
}

.adv-choice .Image {
  background: var(--adv-sprite-choice) center / 100% 100% no-repeat;
}

.adv-choice:hover .Image,
.adv-choice:focus-visible .Image {
  background-image: var(--adv-sprite-choice-blue);
}

.adv-choice .UIRubyText {
  align-items: center;
  color: rgb(5, 18, 51);
  display: flex;
  font-size: calc(var(--adv-choice-font-size) * var(--adv-text-scale));
  font-weight: 400;
  bottom: var(--adv-choice-text-bottom);
  justify-content: center;
  left: var(--adv-choice-text-left);
  line-height: 1;
  overflow: hidden;
  text-align: center;
  right: var(--adv-choice-text-right);
  top: var(--adv-choice-text-top);
  white-space: nowrap;
}

.adv-loading,
.adv-error {
  position: absolute;
  inset: 0;
  z-index: 65;
  display: grid;
  place-content: center;
  gap: 12px;
  background: rgba(0, 0, 0, 0.72);
  text-align: center;
}

.adv-loading-title {
  font-weight: 800;
}

.adv-loading-bar {
  width: min(360px, 62vw);
  --md-linear-progress-active-indicator-color: #fff;
  --md-linear-progress-track-color: rgba(255, 255, 255, 0.28);
}

.adv-loading-count {
  font-size: 12px;
  opacity: 0.8;
}

.adv-error {
  color: #ffd8d8;
  padding: 20px;
}

@media (max-width: 760px) {
  .adv-story-browser {
    width: 100%;
    border-radius: 0;
  }

  .adv-choice-layer .Choices {
    width: 68%;
  }
}
</style>
