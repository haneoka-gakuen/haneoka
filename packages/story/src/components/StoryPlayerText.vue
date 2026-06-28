<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, triggerRef, watch } from "vue";
import { Howl } from "howler";
import { ADV_COMMAND, mergeAdvRuntime } from "../core/AdvConstants";
import { autoPlayIntervalSeconds, type AdvAutoPlayInterval } from "../core/AdvAutoPlayInterval";
import { hasSemanticAdvText, splitAdvTargetNames } from "../core/AdvCommandText";
import { iterateAdvCommands } from "../core/AdvCommandTraversal";
import {
  requireCanonicalStoryResourceUrl,
  resolveStoryLocalizedText,
  storyRuntime,
  type StoryResolvedText,
} from "../runtime";
import type { AdvCommand, AdvRuntimeConfig, AdvStory, AdvVoiceEntry } from "../types/AdvRuntime";
import StoryIcon from "./StoryIcon.vue";
import StoryRichText from "./StoryRichText";

defineOptions({ name: "StoryPlayerText" });

/** Character aggregate built from multiple data sources within the text-mode player. */
interface TextPlayerCharacter {
  target?: string;
  characterId: number;
  name: string;
  nameLang?: string;
  faceImage: string;
  [key: string]: unknown;
}

/** Lightweight target-like record produced by commandTargets() for the text-mode player. */
interface TextPlayerTarget {
  target?: string;
  targetName?: string;
  characterId?: number;
  name?: unknown;
  nickname?: unknown;
  faceImage?: string;
  [key: string]: unknown;
}

interface TalkSnippet {
  type: "talk";
  talkCharacters: TextPlayerCharacter[];
  windowDisplayName: string;
  windowDisplayNameLang?: string;
  body: string;
  bodyLang?: string;
  voices: AdvVoiceEntry[];
}

interface LocationSnippet {
  type: "location";
  title: string;
  titleLang?: string;
}

type TextSnippet = TalkSnippet | LocationSnippet;

const EMPTY_CHAR: TextPlayerCharacter = { characterId: 0, name: "", faceImage: "" };
const TEXT_BUILD_CHUNK_SIZE = 48;
const TEXT_BUILD_BUDGET_MS = 8;
// Building a large script yields frequently to keep input responsive, but it
// does not need to invalidate the rendered virtual layout after every yield.
// Publishing less often prevents repeated full prefix-layout calculation while
// the script is still being parsed.
const TEXT_BUILD_PUBLISH_COMMANDS = 192;
const TEXT_ROW_ESTIMATE = 112;
const TEXT_ROW_GAP = 4;
const TEXT_VIEWPORT_OVERSCAN = 480;

const props = withDefaults(
  defineProps<{
    story?: AdvStory | null;
    storyData?: AdvStory | null;
    volume?: number;
    /** Compatibility-only: text mode intentionally never plays BGM. */
    volumeBgm?: number;
    /** Compatibility-only: text mode intentionally never plays BGM. */
    enableBgm?: number;
    autoPlay?: number;
    autoPlayInterval?: AdvAutoPlayInterval;
    textSize?: number;
    server?: string;
  }>(),
  {
    story: null,
    storyData: null,
    volume: 1,
    volumeBgm: 1,
    enableBgm: 0,
    autoPlay: 0,
    autoPlayInterval: 1,
    textSize: 1,
    server: undefined,
  },
);

const playingIndex = ref<number | null>(null);
const goNext = ref(false);
const failedFaceImages = reactive(new Set<string>());
let howlTalk: Howl[] = [];
let completedHowlTalk = new Set<Howl>();
let howlTalkGeneration = 0;
let queueId: ReturnType<typeof setTimeout> | null = null;

const activeStory = computed(() => props.storyData ?? props.story);
const assetServer = computed(() => {
  const value = props.server || activeStory.value?.assetServer || activeStory.value?.assetServerKey;
  return typeof value === "string" && value ? value : storyRuntime().defaultAssetServer;
});
const runtime = computed(() => mergeAdvRuntime(activeStory.value?.runtime));
const snippets = shallowRef<TextSnippet[]>([]);
const snippetsBuilding = ref(false);
const textScrollRoot = ref<HTMLElement>();
const textScrollTop = ref(0);
const textViewportHeight = ref(640);
const textViewportWidth = ref(0);
const measuredSnippetHeights = reactive(new Map<number, number>());
const snippetElements = new Map<number, HTMLElement>();
let textViewportObserver: ResizeObserver | undefined;
let snippetObserver: ResizeObserver | undefined;
let textViewportFrame: number | undefined;
let snippetBuildGeneration = 0;
let disposed = false;

const snippetLayout = computed(() => {
  const offsets = [0];
  for (let index = 0; index < snippets.value.length; index += 1) {
    const height = measuredSnippetHeights.get(index) ?? TEXT_ROW_ESTIMATE;
    offsets.push(offsets[index]! + height + (index + 1 < snippets.value.length ? TEXT_ROW_GAP : 0));
  }
  return { offsets, total: offsets.at(-1) || 0 };
});

const snippetIndexAt = (offsets: readonly number[], value: number): number => {
  const count = Math.max(0, offsets.length - 1);
  if (!count) return 0;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1]! <= value) low = middle + 1;
    else high = middle;
  }
  return low;
};

const snippetVirtualRange = computed(() => {
  const count = snippets.value.length;
  if (!count) return { start: 0, end: 0 };
  const overscan = Math.max(TEXT_VIEWPORT_OVERSCAN, textViewportHeight.value * 0.5);
  const offsets = snippetLayout.value.offsets;
  const start = snippetIndexAt(offsets, Math.max(0, textScrollTop.value - overscan));
  const end = Math.min(count, snippetIndexAt(offsets, textScrollTop.value + textViewportHeight.value + overscan) + 1);
  return { start, end: Math.max(start + 1, end) };
});

interface VisibleSnippet {
  snippet: TextSnippet;
  index: number;
}

const visibleSnippets = computed<VisibleSnippet[]>(() => {
  const { start, end } = snippetVirtualRange.value;
  return snippets.value.slice(start, end).map((snippet, offset) => ({ snippet, index: start + offset }));
});

const textCanvasStyle = computed(() => ({ height: `${Math.max(1, snippetLayout.value.total)}px` }));
const textWindowStyle = computed(() => ({
  transform: `translateY(${snippetLayout.value.offsets[snippetVirtualRange.value.start] || 0}px)`,
}));
const playingSnippet = computed(() => (playingIndex.value == null ? null : snippets.value[playingIndex.value] || null));
const playingVoices = computed(() =>
  playableVoices(playingSnippet.value?.type === "talk" ? playingSnippet.value : null),
);
const textScale = computed(() => Math.max(0.5, Math.min(2, Number(props.textSize) || 1)));

onMounted(() => {
  textViewportObserver = new ResizeObserver(scheduleTextViewportUpdate);
  if (textScrollRoot.value) textViewportObserver.observe(textScrollRoot.value);
  snippetObserver = new ResizeObserver((entries) => {
    const root = textScrollRoot.value;
    const offsets = snippetLayout.value.offsets;
    const anchor = snippetIndexAt(offsets, root?.scrollTop ?? textScrollTop.value);
    let scrollCorrection = 0;
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      const index = Number(element.dataset.snippetIndex);
      if (!Number.isSafeInteger(index) || index < 0) continue;
      const borderBox = entry.borderBoxSize?.[0];
      const height = Math.max(1, Math.ceil(borderBox?.blockSize ?? entry.contentRect.height));
      const previousHeight = measuredSnippetHeights.get(index) ?? TEXT_ROW_ESTIMATE;
      if (Math.abs(height - previousHeight) <= 1) continue;
      measuredSnippetHeights.set(index, height);
      if (index < anchor) scrollCorrection += height - previousHeight;
    }
    if (root && scrollCorrection) root.scrollTop += scrollCorrection;
    scheduleTextViewportUpdate();
  });
  for (const element of snippetElements.values()) snippetObserver.observe(element);
  updateTextViewport();
});
onBeforeUnmount(() => {
  disposed = true;
  snippetBuildGeneration += 1;
  textViewportObserver?.disconnect();
  snippetObserver?.disconnect();
  if (textViewportFrame !== undefined) window.cancelAnimationFrame(textViewportFrame);
  snippetElements.clear();
  cancelNextVoice();
  unloadTalk();
});

watch(activeStory, () => {
  playingIndex.value = null;
  goNext.value = false;
  if (textScrollRoot.value) textScrollRoot.value.scrollTop = 0;
  failedFaceImages.clear();
  cancelNextVoice();
  unloadTalk();
});
watch(
  () => props.volume,
  () => {
    for (const howl of howlTalk) howl.volume(clampVolume(props.volume));
  },
);
watch([playingIndex, playingVoices], ([, voices]) => {
  unloadTalk();
  if (voices.length) {
    const generation = howlTalkGeneration;
    howlTalk = voices.map((voice) => {
      const playableUrl = canonicalResourceUrl(voice.playableUrl, "voice playback");
      const howl = new Howl({
        src: [playableUrl],
        html5: true,
        volume: clampVolume(props.volume),
        autoplay: true,
        onend: () => settleHowlTalk(howl, generation),
        onloaderror: () => settleHowlTalk(howl, generation),
      });
      return howl;
    });
    return;
  }
  if (playingSnippet.value) {
    if (goNext.value) queueNextVoice(0);
    else playingIndex.value = null;
  }
});

function createSnippetBuilder(
  story: AdvStory,
  activeRuntime: AdvRuntimeConfig,
  entries: TextSnippet[],
): (command: AdvCommand) => void {
  const characterByTarget = new Map<string, TextPlayerCharacter>();
  const characterById = new Map<number, TextPlayerCharacter>();

  rememberStoryAssetCharacters(story, characterByTarget, characterById);
  return (command: AdvCommand) => {
    rememberCharacters(command, activeRuntime, characterByTarget, characterById);
    if (command.command === ADV_COMMAND.Location && hasSemanticAdvText(command)) {
      const title = resolveStoryLocalizedText(command.text || "");
      if (title.text) {
        entries.push({
          type: "location",
          title: title.text,
          titleLang: title.lang,
        });
      }
      return;
    }
    if (command.command !== ADV_COMMAND.Talk || !hasSemanticAdvText(command)) return;
    const body = resolveStoryLocalizedText(command.text || "");
    const bodyText = parseDialogueUsername(body.text);
    if (!bodyText) return;
    const targets = commandTargets(command, activeRuntime);
    const displayName = targetDisplayName(command, activeRuntime, targets);
    const talkCharacters =
      command.targetStatus === 1 || command.targetStatus === 2
        ? []
        : (targets
            .map((target) => resolveTalkCharacter(target, command, characterByTarget, characterById))
            .filter(Boolean) as TextPlayerCharacter[]);
    const snippet: TalkSnippet = {
      type: "talk",
      talkCharacters,
      windowDisplayName: displayName.text,
      windowDisplayNameLang: displayName.lang,
      body: bodyText,
      bodyLang: body.lang,
      voices: command.voices || [],
    };
    entries.push(snippet);
  };
}

const buildNow = () => (typeof performance === "undefined" ? Date.now() : performance.now());

const yieldTextBuild = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve();
      return;
    }
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => resolve(), { timeout: 50 });
      return;
    }
    window.setTimeout(resolve, 0);
  });

async function buildSnippetsProgressively(
  story: AdvStory | null | undefined,
  activeRuntime: AdvRuntimeConfig,
): Promise<void> {
  const generation = ++snippetBuildGeneration;
  measuredSnippetHeights.clear();
  snippets.value = [];
  snippetsBuilding.value = Boolean(story?.commands?.length);
  try {
    if (!story?.commands?.length) return;

    const entries = snippets.value;
    const append = createSnippetBuilder(story, activeRuntime, entries);
    const iterator = iterateAdvCommands(story.commands);
    let next = iterator.next();
    let processed = 0;
    let commandsSincePublish = 0;
    let hasUnpublishedChanges = false;
    let publishedOnce = false;
    let chunkStartedAt = buildNow();

    while (!next.done) {
      const entryCount = entries.length;
      append(next.value);
      if (entries.length !== entryCount) hasUnpublishedChanges = true;
      next = iterator.next();
      processed += 1;
      commandsSincePublish += 1;
      if (!next.done && (processed >= TEXT_BUILD_CHUNK_SIZE || buildNow() - chunkStartedAt >= TEXT_BUILD_BUDGET_MS)) {
        if (disposed || generation !== snippetBuildGeneration) return;
        processed = 0;
        if (hasUnpublishedChanges && (!publishedOnce || commandsSincePublish >= TEXT_BUILD_PUBLISH_COMMANDS)) {
          triggerRef(snippets);
          hasUnpublishedChanges = false;
          publishedOnce = true;
          commandsSincePublish = 0;
        }
        await yieldTextBuild();
        if (disposed || generation !== snippetBuildGeneration) return;
        chunkStartedAt = buildNow();
      }
    }
    if (disposed || generation !== snippetBuildGeneration) return;
    if (hasUnpublishedChanges) triggerRef(snippets);
  } finally {
    if (generation === snippetBuildGeneration) snippetsBuilding.value = false;
  }
}

function updateTextViewport(): void {
  const root = textScrollRoot.value;
  if (!root) return;
  const width = root.clientWidth;
  if (Math.round(width) !== Math.round(textViewportWidth.value)) measuredSnippetHeights.clear();
  textScrollTop.value = root.scrollTop;
  textViewportHeight.value = root.clientHeight;
  textViewportWidth.value = width;
}

function scheduleTextViewportUpdate(): void {
  if (textViewportFrame !== undefined) return;
  textViewportFrame = window.requestAnimationFrame(() => {
    textViewportFrame = undefined;
    updateTextViewport();
  });
}

function setSnippetElement(element: Element | null, index: number): void {
  const previous = snippetElements.get(index);
  if (previous && previous !== element) snippetObserver?.unobserve(previous);
  if (!(element instanceof HTMLElement)) {
    snippetElements.delete(index);
    return;
  }
  snippetElements.set(index, element);
  snippetObserver?.observe(element);
}

watch([activeStory, runtime], ([story, activeRuntime]) => void buildSnippetsProgressively(story, activeRuntime), {
  immediate: true,
  flush: "post",
});
watch(snippets, () => void nextTick(updateTextViewport), { flush: "post" });

function firstResolvedText(...values: unknown[]): StoryResolvedText {
  for (const value of values) {
    const resolved = resolveStoryLocalizedText(value);
    if (resolved.text) return resolved;
  }
  return { text: "" };
}

function resolvedTextEntries(value: unknown): StoryResolvedText[] {
  const entries = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return entries.map(resolveStoryLocalizedText).filter((entry) => Boolean(entry.text.trim()));
}

function joinResolvedText(entries: readonly StoryResolvedText[], separator: string): StoryResolvedText {
  const values = entries.filter((entry) => Boolean(entry.text));
  if (!values.length) return { text: "" };
  const languages = [...new Set(values.map((entry) => entry.lang).filter((lang): lang is string => Boolean(lang)))];
  const text = values.map((entry) => entry.text).join(separator);
  return languages.length === 1 && values.every((entry) => entry.lang === languages[0])
    ? { text, lang: languages[0] }
    : { text };
}

function rememberStoryAssetCharacters(
  story: AdvStory,
  characterByTarget: Map<string, TextPlayerCharacter>,
  characterById: Map<number, TextPlayerCharacter>,
) {
  const storyRecord = story as Record<string, unknown>;
  const assets = storyRecord.assets as Record<string, unknown> | undefined;
  for (const source of [assets?.characters, assets?.live2d, storyRecord.characters, storyRecord.live2d] as (
    Record<string, unknown> | unknown[] | undefined
  )[]) {
    for (const entry of collectionValues(source)) {
      rememberCharacterEntry(entry as Record<string, unknown> | null | undefined, characterByTarget, characterById);
    }
  }
}

function rememberCharacters(
  command: AdvCommand,
  activeRuntime: AdvRuntimeConfig,
  characterByTarget: Map<string, TextPlayerCharacter>,
  characterById: Map<number, TextPlayerCharacter>,
) {
  for (const target of commandTargets(command, activeRuntime)) {
    const explicitCharacterId = Number(target.characterId ?? command.live2d?.characterId ?? 0);
    const targetKey = target.target || target.targetName || command.targetName || command.live2dKey || "";
    const previous = characterByTarget.get(targetKey) || characterById.get(explicitCharacterId) || EMPTY_CHAR;
    const characterId = explicitCharacterId || previous.characterId;
    const resolvedName = firstResolvedText(
      target.name,
      target.nickname,
      command.live2d?.nickname,
      command.live2d?.characterName,
    );
    const entry: TextPlayerCharacter = {
      ...previous,
      target: targetKey,
      characterId,
      name: resolvedName.text || previous.name || targetKey,
      nameLang: resolvedName.text ? resolvedName.lang : previous.nameLang,
      faceImage: characterImage(target) || characterImage(command.live2d) || previous.faceImage || "",
    };
    if (entry.target)
      characterByTarget.set(entry.target, { ...(characterByTarget.get(entry.target) || EMPTY_CHAR), ...entry });
    if (entry.characterId)
      characterById.set(entry.characterId, { ...(characterById.get(entry.characterId) || EMPTY_CHAR), ...entry });
  }
}

function resolveTalkCharacter(
  target: TextPlayerTarget,
  command: AdvCommand,
  characterByTarget: Map<string, TextPlayerCharacter>,
  characterById: Map<number, TextPlayerCharacter>,
) {
  const explicitCharacterId = Number(target?.characterId ?? command?.live2d?.characterId ?? 0);
  const targetKey = target?.target || target?.targetName || command?.targetName || command?.live2dKey || "";
  const fromTarget = characterByTarget.get(targetKey);
  const characterId = explicitCharacterId || fromTarget?.characterId || 0;
  const fromId = characterById.get(characterId);
  const faceImage =
    characterImage(target) || characterImage(command.live2d) || fromTarget?.faceImage || fromId?.faceImage || "";
  const resolvedName = firstResolvedText(
    target?.name,
    target?.nickname,
    command?.live2d?.nickname,
    command?.live2d?.characterName,
  );
  const storedName = fromTarget?.name ? fromTarget : fromId;
  const name = resolvedName.text || storedName?.name || targetKey;
  const nameLang = resolvedName.text ? resolvedName.lang : storedName?.nameLang;
  if (!characterId && !targetKey && !faceImage && !name) return null;
  return {
    ...(fromId || {}),
    ...(fromTarget || {}),
    characterId,
    name,
    nameLang,
    faceImage,
  };
}

function targetDisplayName(
  command: AdvCommand,
  activeRuntime: AdvRuntimeConfig,
  targets = commandTargets(command, activeRuntime),
): StoryResolvedText {
  if (command.targetStatus === 2) return { text: "" };
  if (command.targetStatus === 1) return { text: "???" };
  const split = activeRuntime.targetNameSplitKey || "・";
  const commandTextNames = resolvedTextEntries(command.targetTextNames ?? command.targetTextNamesLocalized ?? []);
  if (commandTextNames.length) {
    const resolved = joinResolvedText(commandTextNames, split);
    return { ...resolved, text: parseDialogueUsername(resolved.text) };
  }
  const names = (targets || [])
    .map((target) => firstResolvedText(target.name, target.nickname, target.target))
    .filter((entry) => Boolean(entry.text));
  const resolved = names.length ? joinResolvedText(names, split) : resolveStoryLocalizedText(command.targetName || "");
  return { ...resolved, text: parseDialogueUsername(resolved.text) };
}

function commandTargetTextNames(command: AdvCommand): unknown[] {
  const value = command.targetTextNames ?? command.targetTextNamesLocalized ?? [];
  if (Array.isArray(value)) return value;
  return value == null || value === "" ? [] : [value];
}

function commandTargets(command: AdvCommand, activeRuntime: AdvRuntimeConfig): TextPlayerTarget[] {
  const providedTargets = (command.targets || []) as TextPlayerTarget[];
  if (!providedTargets.length && !command?.targetName && !command?.live2d && !command?.live2dKey) return [];
  const targetName = String(command.targetName || "");
  const split = activeRuntime.targetNameSplitKey || "・";
  const targetKeys = splitAdvTargetNames(targetName, split);
  const targetTextNames = commandTargetTextNames(command);
  if (targetKeys.length > 1) {
    const providedByKey = new Map(
      providedTargets
        .map((target) => [target.target || target.targetName || "", target] as const)
        .filter(([target]) => Boolean(target)),
    );
    return targetKeys.map((target, index) => ({
      ...(providedByKey.get(target) || {}),
      target,
      targetName: target,
      name: targetTextNames[index] ?? providedByKey.get(target)?.name ?? target,
    }));
  }
  if (providedTargets.length) return providedTargets;
  return [
    {
      target: targetKeys[0] || command.live2dKey,
      characterId: command.live2d?.characterId as number | undefined,
      name: targetTextNames[0] || command.live2d?.nickname || command.live2d?.characterName || targetKeys[0] || "",
    },
  ];
}

function rememberCharacterEntry(
  value: Record<string, unknown> | null | undefined,
  characterByTarget: Map<string, TextPlayerCharacter>,
  characterById: Map<number, TextPlayerCharacter>,
) {
  if (!value) return;
  const characterId = Number(value.characterId || value.id || 0);
  const resolvedName = firstResolvedText(
    value.nickname,
    value.characterName,
    value.live2dName,
    value.name,
    value.title,
    value.label,
  );
  const entry: TextPlayerCharacter = {
    characterId,
    name: resolvedName.text,
    nameLang: resolvedName.lang,
    faceImage: characterImage(value),
  };
  const targets = [value.target, value.targetName, value.live2dKey, value.key].filter(Boolean).map(String);
  if (characterId) {
    const previous = characterById.get(characterId) || EMPTY_CHAR;
    characterById.set(characterId, {
      ...previous,
      ...entry,
      name: entry.name || previous.name,
      nameLang: entry.name ? entry.nameLang : previous.nameLang,
      faceImage: entry.faceImage || previous.faceImage,
    });
  }
  for (const target of targets) {
    const previous = characterByTarget.get(target) || EMPTY_CHAR;
    characterByTarget.set(target, {
      ...previous,
      ...entry,
      target,
      name: entry.name || previous.name,
      nameLang: entry.name ? entry.nameLang : previous.nameLang,
      faceImage: entry.faceImage || previous.faceImage,
    });
  }
}

function collectionValues(value: Record<string, unknown> | unknown[] | null | undefined): unknown[] {
  if (!value) return [];
  return Array.isArray(value) ? value : Object.values(value);
}

function characterImage(value: Record<string, unknown> | null | undefined) {
  return String(
    value?.faceImage || value?.thumbnailImage || value?.profileImage || value?.iconImage || value?.image || "",
  );
}

function canonicalResourceUrl(value: unknown, label: string) {
  const url = requireCanonicalStoryResourceUrl(value, label);
  if (storyRuntime().resourceBelongsToServer(url, assetServer.value)) return url;
  throw new TypeError(`Story ${label} URL does not belong to asset server ${assetServer.value}: ${url}`);
}

function parseDialogueUsername(value: string) {
  return String(value || "").replace(/\{\{userName\}\}/g, "User");
}

function playableVoices(snippet: { voices?: AdvVoiceEntry[] } | null): AdvVoiceEntry[] {
  return (snippet?.voices || []).filter((voice): voice is AdvVoiceEntry & { playableUrl: string } =>
    Boolean(voice?.playableUrl),
  );
}

function hasPlayableVoice(snippet: { voices?: AdvVoiceEntry[] } | null): boolean {
  return playableVoices(snippet).length > 0;
}

function onClickText(index: number) {
  const snippet = snippets.value[index];
  if (!snippet || snippet.type !== "talk" || !hasPlayableVoice(snippet)) return;
  cancelNextVoice();
  if (playingIndex.value === index) {
    const active = howlTalk.filter((howl) => !completedHowlTalk.has(howl));
    if (!active.length) return;
    if (active.some((howl) => howl.playing())) active.forEach((howl) => howl.pause());
    else active.forEach((howl) => howl.play());
    return;
  }
  goNext.value = false;
  playingIndex.value = index;
}

function play() {
  cancelNextVoice();
  if (playingIndex.value != null && howlTalk.length) {
    for (const howl of howlTalk) {
      if (!completedHowlTalk.has(howl) && !howl.playing()) howl.play();
    }
    return;
  }
  const firstIndex = snippets.value.findIndex((snippet) => snippet.type === "talk" && hasPlayableVoice(snippet));
  if (firstIndex < 0) {
    // A user may press play before a progressively parsed story has reached
    // its first voiced line. Preserve that intent instead of silently doing
    // nothing while the remaining commands are still arriving.
    if (snippetsBuilding.value) queueId = setTimeout(play, 50);
    return;
  }
  goNext.value = true;
  playingIndex.value = firstIndex;
}

function pause() {
  cancelNextVoice();
  for (const howl of howlTalk) howl.pause();
}

function settleHowlTalk(howl: Howl, generation: number) {
  if (generation !== howlTalkGeneration || !howlTalk.includes(howl) || completedHowlTalk.has(howl)) return;
  completedHowlTalk.add(howl);
  if (completedHowlTalk.size < howlTalk.length) return;
  if (props.autoPlay === 0) queueNextVoice();
  else playingIndex.value = null;
}

function queueNextVoice(delay = autoPlayIntervalSeconds(props.autoPlayInterval) * 1000) {
  cancelNextVoice();
  queueId = setTimeout(() => {
    if (playingIndex.value == null) return;
    for (let index = playingIndex.value + 1; index < snippets.value.length; index += 1) {
      const next = snippets.value[index];
      if (next?.type === "talk" && hasPlayableVoice(next)) {
        goNext.value = true;
        playingIndex.value = index;
        return;
      }
    }
    if (snippetsBuilding.value) {
      queueId = setTimeout(() => queueNextVoice(0), 50);
      return;
    }
    playingIndex.value = null;
  }, delay);
}

function cancelNextVoice() {
  if (!queueId) return;
  clearTimeout(queueId);
  queueId = null;
}

function unloadTalk() {
  howlTalkGeneration += 1;
  for (const howl of howlTalk) howl.unload();
  howlTalk = [];
  completedHowlTalk = new Set<Howl>();
}

function clampVolume(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 1;
}

defineExpose({ pause, play });
</script>

<template>
  <div
    ref="textScrollRoot"
    class="adv-text-player"
    :style="{ fontSize: `${textScale}rem` }"
    :aria-busy="snippetsBuilding || undefined"
    @scroll.passive="scheduleTextViewportUpdate"
  >
    <div v-if="snippets.length" class="adv-text-player__stream" :style="textCanvasStyle">
      <div class="adv-text-player__window" :style="textWindowStyle">
        <div
          v-for="entry in visibleSnippets"
          :key="entry.index"
          :ref="(element) => setSnippetElement(element as Element | null, entry.index)"
          class="adv-text-player__snippet"
          :data-snippet-index="entry.index"
        >
          <article
            v-if="entry.snippet.type === 'talk'"
            class="adv-text-player__entry"
            :class="{
              'is-interactive': hasPlayableVoice(entry.snippet),
              'is-playing': playingIndex === entry.index,
            }"
            :role="hasPlayableVoice(entry.snippet) ? 'button' : undefined"
            :tabindex="hasPlayableVoice(entry.snippet) ? 0 : undefined"
            @click="onClickText(entry.index)"
            @keydown.enter.prevent="onClickText(entry.index)"
            @keydown.space.prevent="onClickText(entry.index)"
          >
            <header
              v-if="entry.snippet.talkCharacters.length || entry.snippet.windowDisplayName"
              class="adv-text-player__speaker"
            >
              <span v-if="entry.snippet.talkCharacters.length" class="adv-text-player__avatars" aria-hidden="true">
                <span
                  v-for="(character, charIndex) in entry.snippet.talkCharacters"
                  :key="`${entry.index}-${charIndex}-${character.target || character.characterId || 'speaker'}`"
                  class="adv-text-player__avatar"
                  :title="character.name"
                  :lang="character.nameLang"
                >
                  <img
                    v-if="character.faceImage && !failedFaceImages.has(character.faceImage)"
                    :src="canonicalResourceUrl(character.faceImage, 'character face')"
                    alt=""
                    :lang="character.nameLang"
                    @error="failedFaceImages.add(character.faceImage)"
                  />
                  <StoryIcon v-else name="user" />
                </span>
              </span>
              <span class="adv-text-player__speaker-name localized-text" :lang="entry.snippet.windowDisplayNameLang">
                {{ entry.snippet.windowDisplayName }}
              </span>
            </header>
            <div class="adv-text-player__dialogue">
              <span class="adv-text-player__playback" aria-hidden="true">
                <StoryIcon v-if="playingIndex === entry.index" name="volume" />
              </span>
              <p class="adv-text-player__body localized-text" :lang="entry.snippet.bodyLang">
                <StoryRichText :value="entry.snippet.body" />
              </p>
            </div>
          </article>
          <div
            v-else-if="entry.snippet.type === 'location'"
            class="adv-text-player__location localized-text"
            :lang="entry.snippet.titleLang"
          >
            {{ entry.snippet.title }}
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="snippetsBuilding" class="adv-text-player__empty" aria-live="polite">
      {{ storyRuntime().message("loading") }}
    </div>
    <div v-else class="adv-text-player__empty">
      {{ storyRuntime().message("notAvailable") }}
    </div>
  </div>
</template>
