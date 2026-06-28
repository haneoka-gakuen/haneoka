import { bestdoriDiagnostic, BestdoriFormatError, type BestdoriDiagnostic } from "./diagnostics.js";
import { isRecord, parseBestdoriJson, type BestdoriInput } from "./input.js";
import { hasBestdoriCharacterIcon } from "./resources.js";
import {
  bestdoriBackgroundStageRef,
  bestdoriCharacterWorldPosition,
  bestdoriPositionTypeFromSide,
  createBestdoriSceneRuntime,
  type BestdoriSceneRuntime,
  type BestdoriSceneVector3,
} from "./scene.js";
import { isBestdoriServer, type BestdoriServer } from "./transport.js";

const CMD = {
  In: 0,
  Out: 1,
  Talk: 2,
  FadeOut: 5,
  FadeIn: 6,
  Expression: 17,
  Location: 20,
  Motion: 21,
  Character: 23,
  Stage: 25,
  Bgm: 15,
  Se: 31,
  MoveToDirection: 64,
  CommandGroup: 500,
} as const;

export interface BestdoriSnippet {
  actionType?: number;
  progressType?: number;
  referenceIndex?: number;
  delay?: number;
  isWaitForSkipMode?: number;
}

export interface BestdoriTalk {
  talkCharacters?: Array<{ characterId?: number }>;
  windowDisplayName?: string;
  body?: string;
  lipSyncMode?: number;
  motions?: Array<{
    characterId?: number;
    motionName?: string;
    expressionName?: string;
    timingSyncValue?: number;
  }>;
  voices?: Array<{ characterId?: number; voiceId?: string; volume?: number }>;
  whenFinishCloseWindow?: number | boolean;
  requirePlayEffect?: number | boolean;
  effectReferenceIdx?: number;
  requirePlaySound?: number | boolean;
  soundReferenceIdx?: number;
}

export interface BestdoriLayout {
  type?: number;
  characterId?: number;
  costumeType?: string;
  motionName?: string;
  expressionName?: string;
  sideFrom?: number;
  sideFromOffsetX?: number;
  sideTo?: number;
  sideToOffsetX?: number;
  depthType?: number;
  moveSpeedType?: number;
}

export interface BestdoriSound {
  playMode?: number;
  bgm?: string;
  se?: string;
  seBundleName?: string;
  volume?: number;
  duration?: number;
}

export interface BestdoriEffect {
  effectType?: number;
  stringVal?: string;
  stringValSub?: string;
  duration?: number;
}

export interface BestdoriSelectable {
  selectables?: Array<{ text?: string; index?: number }>;
}

export interface BestdoriScenarioBase {
  scenarioSceneId?: string;
  storyType?: number;
  appearCharacters?: Array<{ characterId?: number; costumeType?: string }>;
  firstBgm?: string;
  firstBackground?: string;
  firstBackgroundBundleName?: string;
  snippets?: BestdoriSnippet[];
  talkData?: BestdoriTalk[];
  layoutData?: BestdoriLayout[];
  soundData?: BestdoriSound[];
  specialEffectData?: BestdoriEffect[];
  selectableData?: BestdoriSelectable[];
}

export interface BestdoriScenarioSource {
  Base: BestdoriScenarioBase;
}

export interface BestdoriScenarioContext {
  server: BestdoriServer | string;
  voiceBundle: string;
  proxify: (rawBestdoriPath: string) => string;
  resolveCostume?: (characterId: number | undefined, costumeType: string) => string;
}

export type BestdoriAdvCommand = Record<string, unknown>;

export interface BestdoriBackgroundResource {
  resourceRef: string;
  sourcePath?: string;
  url: string;
  /** Source player crop ratio, independent from the image's encoded dimensions. */
  sourceAspectRatio: number;
  stageRef: string;
}

export interface BestdoriSoundResource {
  resourceRef: string;
  sourcePath?: string;
  playableUrl: string;
  volume?: number;
  /** Parsed source value; the published viewer does not apply it during playback. */
  sourceVolume?: number;
  durationMs?: number;
  categoryName?: string;
}

export interface BestdoriLive2dResource {
  live2dKey: string;
  characterId?: number;
  faceImage?: string;
}

export interface BestdoriScenarioResources {
  backgrounds: Record<string, BestdoriBackgroundResource>;
  sounds: Record<string, BestdoriSoundResource>;
  live2d: BestdoriLive2dResource[];
}

export interface BestdoriAdvStory {
  storyId: string;
  title?: unknown;
  commands: BestdoriAdvCommand[];
  assets: BestdoriScenarioResources;
  runtime: BestdoriSceneRuntime;
}

export interface BestdoriScenarioConversion {
  story: BestdoriAdvStory;
  diagnostics: BestdoriDiagnostic[];
  commandSources: BestdoriCommandSource[];
  /** Lossless source payload for editor provenance and unsupported source actions. */
  sourceScenario: BestdoriScenarioBase;
}

export type BestdoriCommandFidelity = "exact" | "approximate" | "unsupported";

export interface BestdoriCommandSource {
  path: string;
  fidelity: BestdoriCommandFidelity;
  snippetIndex?: number;
  actionType?: number;
  referenceIndex?: number;
  note?: string;
}

const fin = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const sourceVolume = (value: unknown): number => Math.max(0, fin(value, 1));
// Bestdori uses this synthetic speaker for dialogue spoken by multiple
// characters. It is not a character resource and must never become a
// `chara_900000` runtime target; the real cast is recovered from the
// middle-dot-separated display name below.
const BESTDORI_GROUP_CHARACTER_ID = 900000;
const positiveCharacterId = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value !== BESTDORI_GROUP_CHARACTER_ID
    ? value
    : undefined;
const characterTargetName = (characterId?: number): string =>
  positiveCharacterId(characterId) === undefined ? "" : `chara_${characterId}`;
const bestdoriSpeakerNames = (value: unknown): string[] =>
  text(value)
    .split(/\s*(?:・|、|，|,|＆|&|\/|\band\b)\s*/iu)
    .map((name) => name.trim())
    .filter(Boolean);

const SERVER_TEXT_SLOT: Record<BestdoriServer, number> = { jp: 0, en: 1, tw: 2, cn: 3, kr: 4 };

const scenarioBase = (input: BestdoriInput): BestdoriScenarioBase => {
  const root = parseBestdoriJson(input, "Bestdori scenario");
  if (!isRecord(root)) throw new BestdoriFormatError("scenario.root", "$", "Bestdori scenario must be an object");
  if (!isRecord(root.Base)) {
    throw new BestdoriFormatError("scenario.base", "$.Base", "Bestdori scenario must contain an object Base");
  }
  return root.Base as BestdoriScenarioBase;
};

/** Pure conversion with diagnostics. Network, retries, and caching belong to a host transport. */
export const convertBestdoriScenario = (
  input: BestdoriInput,
  ctx: BestdoriScenarioContext,
): BestdoriScenarioConversion => {
  const scenario = scenarioBase(input);
  const diagnostics: BestdoriDiagnostic[] = [];
  const commands: BestdoriAdvCommand[] = [];
  const commandSources: BestdoriCommandSource[] = [];
  const backgrounds: Record<string, BestdoriBackgroundResource> = {};
  const sounds: Record<string, BestdoriSoundResource> = {};
  const live2dKeys = new Map<string, number>();
  const lastWorldPosition = new Map<string, BestdoriSceneVector3>();
  const selectedLive2dKeys = new Map<string, string>();
  const visibleLive2dKeys = new Map<string, string>();
  const live2dAssetIndices = new Map<string, Map<string, number>>();
  let commandIndex = 0;
  let characterRenderOrder = 0;
  let warnedMissingVoiceBundle = false;

  const addDiagnostic = (
    severity: BestdoriDiagnostic["severity"],
    code: string,
    path: string,
    message: string,
  ): void => {
    diagnostics.push(bestdoriDiagnostic(severity, code, path, message));
  };
  const recordArray = <T>(value: unknown, path: string): T[] => {
    if (value == null) return [];
    if (!Array.isArray(value)) {
      addDiagnostic("warning", "scenario.array", path, "Expected an array; the malformed value was ignored");
      return [];
    }
    return value.flatMap((entry, index) => {
      if (isRecord(entry)) return [entry as T];
      addDiagnostic("warning", "scenario.entry", `${path}[${index}]`, "Expected an object; the entry was ignored");
      return [];
    });
  };
  const indexedRecordArray = <T>(value: unknown, path: string): Array<T | undefined> => {
    if (value == null) return [];
    if (!Array.isArray(value)) {
      addDiagnostic("warning", "scenario.array", path, "Expected an array; the malformed value was ignored");
      return [];
    }
    return value.map((entry, index) => {
      if (isRecord(entry)) return entry as T;
      addDiagnostic("warning", "scenario.entry", `${path}[${index}]`, "Expected an object; the entry was ignored");
      return undefined;
    });
  };
  const missingReference = (kind: string, path: string, referenceIndex: number): void => {
    addDiagnostic(
      "warning",
      "scenario.referenceMissing",
      path,
      `${kind} reference ${referenceIndex} does not exist and was ignored`,
    );
  };

  if (!isBestdoriServer(ctx.server)) {
    addDiagnostic(
      "warning",
      "scenario.server",
      "$.context.server",
      `Unknown Bestdori server '${ctx.server}'; Japanese text slot semantics were used`,
    );
  }

  const server = ctx.server;
  const assetUrl = (rawPath: string): string => ctx.proxify(rawPath);
  const isBestdoriLocalPath = (value: string): boolean => /^\/(?:assets|res)\//.test(value);
  const localizedText = (value: string): string[] => {
    const localized = ["", "", "", "", ""];
    localized[isBestdoriServer(server) ? SERVER_TEXT_SLOT[server] : 0] = value;
    return localized;
  };
  const voiceUrl = (voiceId: string): string =>
    ctx.voiceBundle ? assetUrl(`/assets/${server}/${ctx.voiceBundle}${voiceId}.mp3`) : "";
  const registerLive2d = (characterId: number | undefined, costumeType: unknown): string => {
    const sourceCostume = text(costumeType);
    const resolved = sourceCostume ? ctx.resolveCostume?.(characterId, sourceCostume) || sourceCostume : "";
    if (resolved) live2dKeys.set(resolved, characterId ?? -1);
    return resolved;
  };
  const targetAssetIndex = (target: string, live2dKey: string): number => {
    if (!target || !live2dKey) return 0;
    let variants = live2dAssetIndices.get(target);
    if (!variants) {
      variants = new Map();
      live2dAssetIndices.set(target, variants);
    }
    const existing = variants.get(live2dKey);
    if (existing != null) return existing;
    const index = variants.size;
    variants.set(live2dKey, index);
    return index;
  };
  const resolveLive2dVariant = (
    characterId: number | undefined,
    costumeType: unknown,
    select: boolean,
  ): { live2dKey: string; targetAssetIndex: number } => {
    const target = characterTargetName(characterId);
    const explicitKey = registerLive2d(characterId, costumeType);
    if (select && target && explicitKey) selectedLive2dKeys.set(target, explicitKey);
    const live2dKey = explicitKey || selectedLive2dKeys.get(target) || "";
    return { live2dKey, targetAssetIndex: targetAssetIndex(target, live2dKey) };
  };
  const layoutPresentation = (
    entry: BestdoriLayout,
  ): { motionName?: string; expressionName?: string; fadeInSeconds: number } | undefined => {
    const motionName = text(entry.motionName).trim();
    const expressionName = text(entry.expressionName).trim();
    if (!motionName && !expressionName) return undefined;
    return {
      ...(motionName ? { motionName } : {}),
      ...(expressionName ? { expressionName } : {}),
      // Bestdori starts the parsed Cubism 2 motion without overriding its
      // authored $fadein/$fadeout. -1 is the ADV adapter's "use asset value"
      // sentinel; zero would make every pose and expression snap instantly.
      fadeInSeconds: -1,
    };
  };
  const moveFromWorld = (target: string, entry: BestdoriLayout): BestdoriSceneVector3 => {
    if (entry.sideFrom != null && entry.sideFrom !== 0) {
      return bestdoriCharacterWorldPosition(entry.sideFrom, entry.sideFromOffsetX);
    }
    return { ...(lastWorldPosition.get(target) ?? bestdoriCharacterWorldPosition()) };
  };
  const rememberWorldPosition = (target: string, position: BestdoriSceneVector3): void => {
    if (target) lastWorldPosition.set(target, { ...position });
  };

  const registerBackground = (
    bgValue: unknown,
    bundleValue: unknown,
    path: string,
    sourceAspectRatio = 4 / 3,
  ): string => {
    const bgId = text(bgValue);
    const bundle = text(bundleValue);
    if (!bgId || !bundle) return "";
    const direct = bundle === "BESTDORI##URL";
    const rawPath = direct ? (isBestdoriLocalPath(bgId) ? bgId : "") : `/assets/${server}/${bundle}_rip/${bgId}.png`;
    if (!rawPath) {
      addDiagnostic("warning", "asset.externalPath", path, "External Bestdori background URL was rejected");
      return "";
    }
    const normalizedAspectRatio = sourceAspectRatio === 1334 / 1002 ? 1334 / 1002 : 4 / 3;
    const key = `bg:${rawPath}:aspect:${normalizedAspectRatio}`;
    backgrounds[key] ??= {
      resourceRef: key,
      sourcePath: rawPath,
      url: assetUrl(rawPath),
      sourceAspectRatio: normalizedAspectRatio,
      stageRef: bestdoriBackgroundStageRef(normalizedAspectRatio),
    };
    return key;
  };
  const registerBgm = (nameValue: unknown, volume: unknown = 1, path = "$.Base.soundData"): string => {
    const name = text(nameValue);
    if (!name) return "";
    const direct = name.startsWith("BESTDORI##URL:") ? name.slice("BESTDORI##URL:".length) : "";
    const rawPath = direct
      ? isBestdoriLocalPath(direct)
        ? direct
        : ""
      : `/assets/${server}/sound/scenario/bgm/${name.toLowerCase()}_rip/${name}.mp3`;
    if (!rawPath) {
      addDiagnostic("warning", "asset.externalPath", path, "External Bestdori BGM URL was rejected");
      return "";
    }
    const key = `bgm:${rawPath}`;
    sounds[key] ??= {
      resourceRef: key,
      sourcePath: rawPath,
      playableUrl: assetUrl(rawPath),
      volume: 1,
      sourceVolume: sourceVolume(volume),
      categoryName: "Bgm",
    };
    return key;
  };
  const registerSe = (
    seValue: unknown,
    bundleValue: unknown,
    volume: unknown = 1,
    path = "$.Base.soundData",
  ): string => {
    const se = text(seValue);
    const bundle = text(bundleValue);
    if (!se) return "";
    const direct = bundle === "BESTDORI##URL";
    const rawPath = direct
      ? isBestdoriLocalPath(se)
        ? se
        : ""
      : bundle
        ? `/assets/${server}/sound/se/${bundle}_rip/${se}.mp3`
        : `/res/CommonSE/${se}.mp3`;
    if (!rawPath) {
      addDiagnostic("warning", "asset.externalPath", path, "External Bestdori sound-effect URL was rejected");
      return "";
    }
    const key = `se:${rawPath}`;
    sounds[key] ??= {
      resourceRef: key,
      sourcePath: rawPath,
      playableUrl: assetUrl(rawPath),
      volume: 1,
      sourceVolume: sourceVolume(volume),
      categoryName: "Se",
    };
    return key;
  };

  const firstBackground = text(scenario.firstBackground);
  if (firstBackground) {
    const backgroundRef = registerBackground(
      firstBackground,
      text(scenario.firstBackgroundBundleName) || "bg/scenario0",
      "$.Base.firstBackground",
    );
    if (backgroundRef) {
      commands.push({ index: commandIndex++, command: CMD.Stage, backgroundRef, duration: 0 });
      commandSources.push({ path: "$.Base.firstBackground", fidelity: "exact" });
    }
  }
  const firstBgm = text(scenario.firstBgm);
  if (firstBgm) {
    const bgmRef = registerBgm(firstBgm, 1, "$.Base.firstBgm");
    if (bgmRef) {
      commands.push({ index: commandIndex++, command: CMD.Bgm, bgmRef, params: [0, 0] });
      commandSources.push({ path: "$.Base.firstBgm", fidelity: "exact" });
    }
  }

  const appearCharacters = recordArray<{ characterId?: number; costumeType?: string }>(
    scenario.appearCharacters,
    "$.Base.appearCharacters",
  );
  const layout = indexedRecordArray<BestdoriLayout>(scenario.layoutData, "$.Base.layoutData");
  for (const appear of appearCharacters) {
    const variant = resolveLive2dVariant(appear.characterId, appear.costumeType, true);
    if (variant.live2dKey) targetAssetIndex(characterTargetName(appear.characterId), variant.live2dKey);
  }
  for (const entry of layout) {
    if (entry) registerLive2d(entry.characterId, entry.costumeType);
  }

  const snippets = indexedRecordArray<BestdoriSnippet>(scenario.snippets, "$.Base.snippets");
  const talk = indexedRecordArray<BestdoriTalk>(scenario.talkData, "$.Base.talkData");
  const sound = indexedRecordArray<BestdoriSound>(scenario.soundData, "$.Base.soundData");
  const effect = indexedRecordArray<BestdoriEffect>(scenario.specialEffectData, "$.Base.specialEffectData");

  // Bestdori encodes some chorus lines with characterId=0 or its synthetic
  // 900000 group speaker and carries the actual cast only in a
  // middle-dot-separated windowDisplayName. Build the aliases from
  // unambiguous solo lines across the whole scenario (including lines after
  // the chorus), so the emitted Talk command can stay entirely in the
  // source-neutral targets shape consumed by both story players.
  const characterIdBySpeakerName = new Map<string, number | null>();
  for (const entry of talk) {
    if (!entry) continue;
    const names = bestdoriSpeakerNames(entry.windowDisplayName);
    if (names.length !== 1) continue;
    const rows = [
      ...(Array.isArray(entry.talkCharacters) ? entry.talkCharacters : []),
      ...(Array.isArray(entry.voices) ? entry.voices : []),
    ];
    const characterIds = rows
      .flatMap((row) => (isRecord(row) ? [positiveCharacterId(row.characterId)] : []))
      .filter((characterId): characterId is number => characterId !== undefined)
      .filter((characterId, index, values) => values.indexOf(characterId) === index);
    if (characterIds.length !== 1) continue;
    const [name] = names;
    const [characterId] = characterIds;
    const previous = characterIdBySpeakerName.get(name!);
    characterIdBySpeakerName.set(name!, previous === undefined || previous === characterId ? characterId! : null);
  }

  if (!snippets.length && !commands.length) {
    addDiagnostic("warning", "scenario.empty", "$.Base", "Scenario contains no timeline or initial stage commands");
  }

  for (const [snippetIndex, snippet] of snippets.entries()) {
    if (!snippet) continue;
    const snippetPath = `$.Base.snippets[${snippetIndex}]`;
    const referenceIndex = fin(snippet.referenceIndex, 0);
    const delay = Math.max(0, fin(snippet.delay, 0));
    const actions: Array<{
      atSeconds: number;
      role: "lifetime" | "event";
      command: BestdoriAdvCommand;
    }> = [];
    let admitted = false;
    const lifetime = (command: BestdoriAdvCommand, atSeconds = delay): void => {
      actions.push({ atSeconds: Math.max(0, atSeconds), role: "lifetime", command });
    };
    const event = (command: BestdoriAdvCommand, atSeconds = delay): void => {
      actions.push({ atSeconds: Math.max(0, atSeconds), role: "event", command });
    };
    switch (snippet.actionType) {
      case 1: {
        const entry = talk[referenceIndex];
        if (!entry) {
          missingReference("Talk", `${snippetPath}.referenceIndex`, referenceIndex);
          break;
        }
        admitted = true;
        const talkCharacters = recordArray<{ characterId?: number }>(
          entry.talkCharacters,
          `$.Base.talkData[${referenceIndex}].talkCharacters`,
        );
        const displaySpeakerNames = bestdoriSpeakerNames(entry.windowDisplayName);
        const explicitCharacterIds = talkCharacters.flatMap(({ characterId }) => {
          const resolved = positiveCharacterId(characterId);
          return resolved === undefined ? [] : [resolved];
        });
        const inferredCharacterIds =
          explicitCharacterIds.length === 0 && displaySpeakerNames.length > 0
            ? displaySpeakerNames.flatMap((name) => {
                const characterId = characterIdBySpeakerName.get(name);
                return characterId == null ? [] : [characterId];
              })
            : [];
        const characterIds =
          inferredCharacterIds.length === displaySpeakerNames.length ? inferredCharacterIds : explicitCharacterIds;
        const speaker = characterIds[0];
        const targets = characterIds.flatMap((characterId, characterIndex) => {
          const characterTarget = characterTargetName(characterId);
          if (!characterTarget) return [];
          const characterName = displaySpeakerNames[characterIndex];
          return [
            {
              target: characterTarget,
              characterId,
              ...(characterName ? { name: localizedText(characterName) } : {}),
              ...(hasBestdoriCharacterIcon(characterId)
                ? { faceImage: assetUrl(`/res/icon/chara_icon_${characterId}.png`) }
                : {}),
            },
          ];
        });
        const target = characterTargetName(speaker) || text(targets[0]?.target);
        const displayName = text(entry.windowDisplayName) || target;
        const targetTextNames =
          displaySpeakerNames.length === targets.length
            ? displaySpeakerNames.map((name) => localizedText(name))
            : [localizedText(displayName)];
        if (entry.requirePlayEffect || entry.requirePlaySound) {
          addDiagnostic(
            "info",
            "scenario.talkAttachedActionNoOp",
            `$.Base.talkData[${referenceIndex}]`,
            "The published viewer parses Talk-attached effect and sound references but does not execute them",
          );
        }
        const voiceRows = recordArray<NonNullable<BestdoriTalk["voices"]>[number]>(
          entry.voices,
          `$.Base.talkData[${referenceIndex}].voices`,
        );
        const declaredVoiceTargets = voiceRows.map((voice) => characterTargetName(voice.characterId)).filter(Boolean);
        const fallbackLipSyncTargets = declaredVoiceTargets.length
          ? declaredVoiceTargets
          : targets.map((entry) => text(entry.target)).filter(Boolean);
        const voiceRefs: string[] = [];
        const lipSyncTargets: string[] = [];
        for (const voice of voiceRows) {
          const voiceId = text(voice.voiceId);
          if (!voiceId || voiceId === "#NAME?") continue;
          const url = voiceUrl(voiceId);
          if (!url) {
            if (!warnedMissingVoiceBundle) {
              warnedMissingVoiceBundle = true;
              addDiagnostic(
                "warning",
                "asset.voiceBundleMissing",
                "$.context.voiceBundle",
                "Voice references were omitted because no voice bundle was provided",
              );
            }
            continue;
          }
          const key = `voice:${voiceId}`;
          sounds[key] ??= {
            resourceRef: key,
            sourcePath: `/assets/${server}/${ctx.voiceBundle}${voiceId}.mp3`,
            playableUrl: url,
            volume: 1,
            sourceVolume: sourceVolume(voice.volume),
            categoryName: "Voice",
          };
          voiceRefs.push(key);
          const voiceTarget = characterTargetName(voice.characterId);
          if (voiceTarget) lipSyncTargets.push(voiceTarget);
          else if (voice.characterId === BESTDORI_GROUP_CHARACTER_ID && targets.length) {
            lipSyncTargets.push(...targets.map((entry) => text(entry.target)).filter(Boolean));
          } else if (target) lipSyncTargets.push(target);
        }
        const lipSyncMode = Math.trunc(fin(entry.lipSyncMode, 1));
        lifetime({
          command: CMD.Talk,
          targetName: target,
          targets: targets.length ? targets : [{ target }],
          targetTextNames,
          text: localizedText(text(entry.body)),
          voiceRefs,
          lipSyncTargets: lipSyncTargets.length
            ? lipSyncTargets
            : fallbackLipSyncTargets.length
              ? fallbackLipSyncTargets
              : [target],
          params: [lipSyncMode === 0 ? "airlipsync" : ""],
          ignoreLipSync: lipSyncMode === 2,
          talkPresentation: {
            textReveal: {
              unit: "utf16-code-unit",
              unitsPerSecond: 15,
              delayFirstUnit: true,
            },
            autoAdvanceAfterTextReveal: true,
            preserveAutoAdvanceTimingWhenInstant: true,
            timedLipSyncWhenVoiceUnavailable: true,
            stopVoicesOnManualAdvance: true,
            voicePlayback: "overlap",
          },
          hideTalkOnComplete: Boolean(entry.whenFinishCloseWindow),
        });
        for (const motion of recordArray<NonNullable<BestdoriTalk["motions"]>[number]>(
          entry.motions,
          `$.Base.talkData[${referenceIndex}].motions`,
        )) {
          const motionTarget = characterTargetName(motion.characterId);
          if (!motionTarget) {
            addDiagnostic(
              "warning",
              "scenario.characterMissing",
              `$.Base.talkData[${referenceIndex}].motions`,
              "Motion without a character ID was ignored",
            );
            continue;
          }
          event(
            {
              command: CMD.Motion,
              targetName: motionTarget,
              targets: [{ target: motionTarget }],
              motionName: text(motion.motionName),
              expressionName: text(motion.expressionName),
              motionFadeIn: -1,
            },
            delay + Math.max(0, fin(motion.timingSyncValue, 0)),
          );
        }
        break;
      }
      case 2: {
        const entry = layout[referenceIndex];
        if (!entry) {
          missingReference("Layout", `${snippetPath}.referenceIndex`, referenceIndex);
          break;
        }
        admitted = true;
        const target = characterTargetName(entry.characterId);
        const presentation = layoutPresentation(entry);
        if (entry.type === 2) {
          const variant = resolveLive2dVariant(entry.characterId, entry.costumeType, true);
          const from = moveFromWorld(target, entry);
          const to = bestdoriCharacterWorldPosition(entry.sideTo, entry.sideToOffsetX);
          if (target && visibleLive2dKeys.get(target) === variant.live2dKey) {
            // Bestdori reuses layout type 2 for an already visible controller.
            // Re-running CharacterIn removes that controller, resets alpha to
            // zero, and produces a blank/black flash. Preserve the controller
            // and translate the repeated placement into its actual visual
            // effect: a move plus the authored motion/expression.
            lifetime({
              command: CMD.MoveToDirection,
              targetName: target,
              targets: [{ target }],
              positionType: bestdoriPositionTypeFromSide(entry.sideTo),
              characterWorldTransition: { from, to },
              ...(presentation ? { characterPresentation: presentation } : {}),
              duration: 0.25,
            });
          } else {
            lifetime({
              command: CMD.Character,
              targetName: target,
              targets: [{ target }],
              live2dKey: variant.live2dKey,
              targetAssetIndex: variant.targetAssetIndex,
              characterWorldPosition: from,
            });
            lifetime({
              command: CMD.In,
              targetName: target,
              targets: [{ target }],
              live2dKey: variant.live2dKey,
              targetAssetIndex: variant.targetAssetIndex,
              positionType: bestdoriPositionTypeFromSide(entry.sideTo),
              characterWorldTransition: { from, to },
              // The source viewer moves each appearing model to the front of its
              // forward-drawn array, placing it behind characters already shown.
              characterRenderOrder: ++characterRenderOrder,
              ...(presentation ? { characterPresentation: presentation } : {}),
              duration: 0.25,
            });
            if (target) visibleLive2dKeys.set(target, variant.live2dKey);
          }
          rememberWorldPosition(target, to);
        } else if (entry.type === 3) {
          const restore = { ...(lastWorldPosition.get(target) ?? bestdoriCharacterWorldPosition()) };
          lifetime({
            command: CMD.Out,
            targetName: target,
            targets: [{ target }],
            characterWorldTransition: {
              from: moveFromWorld(target, entry),
              to: bestdoriCharacterWorldPosition(entry.sideTo, entry.sideToOffsetX),
              restore,
            },
            ...(presentation ? { characterPresentation: presentation } : {}),
            duration: 0.2,
          });
          if (target) visibleLive2dKeys.delete(target);
        } else if (entry.type === 4 || entry.type === 5) {
          addDiagnostic(
            "info",
            "scenario.layoutSourceViewerNoOp",
            `$.Base.layoutData[${referenceIndex}].type`,
            `The published viewer parses layout type ${entry.type} but completes it without rendering a shake`,
          );
        } else if (entry.type === 1) {
          const from = moveFromWorld(target, entry);
          const to = bestdoriCharacterWorldPosition(entry.sideTo, entry.sideToOffsetX);
          lifetime({
            command: CMD.MoveToDirection,
            targetName: target,
            targets: [{ target }],
            positionType: bestdoriPositionTypeFromSide(entry.sideTo),
            characterWorldTransition: { from, to },
            ...(presentation ? { characterPresentation: presentation } : {}),
            duration: 0.25,
          });
          rememberWorldPosition(target, to);
        } else {
          addDiagnostic(
            "info",
            "scenario.layoutSourceViewerNoOp",
            `$.Base.layoutData[${referenceIndex}].type`,
            `The published viewer completes unknown layout type ${String(entry.type)} as a no-op after its snippet delay`,
          );
        }
        break;
      }
      case 4: {
        const entry = layout[referenceIndex];
        if (!entry) {
          missingReference("Motion", `${snippetPath}.referenceIndex`, referenceIndex);
          break;
        }
        admitted = true;
        const target = characterTargetName(entry.characterId);
        lifetime({
          command: CMD.Motion,
          targetName: target,
          targets: [{ target }],
          motionName: text(entry.motionName),
          expressionName: text(entry.expressionName),
          motionFadeIn: -1,
        });
        break;
      }
      case 7: {
        const entry = sound[referenceIndex];
        if (!entry) {
          missingReference("Sound", `${snippetPath}.referenceIndex`, referenceIndex);
          break;
        }
        admitted = true;
        if (entry.bgm) {
          const bgmRef = registerBgm(entry.bgm, entry.volume, `$.Base.soundData[${referenceIndex}].bgm`);
          if (bgmRef) {
            lifetime({
              command: CMD.Bgm,
              bgmRef,
              params: [0, 0],
            });
          }
        }
        if (entry.se) {
          const seRef = registerSe(
            entry.se,
            entry.seBundleName,
            entry.volume,
            `$.Base.soundData[${referenceIndex}].se`,
          );
          if (seRef) {
            lifetime({
              command: CMD.Se,
              seRef,
              params: [""],
            });
          }
        }
        if (!entry.bgm && !entry.se) {
          addDiagnostic(
            "info",
            "scenario.soundEmpty",
            `$.Base.soundData[${referenceIndex}]`,
            "Empty sound row produced no command",
          );
        }
        break;
      }
      case 6: {
        const entry = effect[referenceIndex];
        if (!entry) {
          missingReference("Effect", `${snippetPath}.referenceIndex`, referenceIndex);
          break;
        }
        admitted = true;
        switch (entry.effectType) {
          case 1:
          case 3:
            lifetime({
              command: CMD.FadeIn,
              params: [entry.effectType === 1 ? "#000000" : "#ffffff"],
              duration: fin(entry.duration, 0.5),
            });
            break;
          case 2:
          case 4:
            lifetime({
              command: CMD.FadeOut,
              params: [entry.effectType === 2 ? "#000000" : "#ffffff"],
              duration: fin(entry.duration, 0.5),
            });
            break;
          case 5:
          case 6:
            addDiagnostic(
              "info",
              "scenario.effectSourceViewerNoOp",
              `$.Base.specialEffectData[${referenceIndex}].effectType`,
              `The published viewer parses effect ${entry.effectType} but completes it without rendering a shake`,
            );
            break;
          case 7:
          case 11:
          case 17:
            if (entry.stringVal && entry.stringValSub) {
              const backgroundRef = registerBackground(
                entry.stringValSub,
                entry.stringVal,
                `$.Base.specialEffectData[${referenceIndex}]`,
                entry.effectType === 11 ? 1334 / 1002 : 4 / 3,
              );
              if (backgroundRef) {
                lifetime({
                  command: CMD.Stage,
                  backgroundRef,
                  // The published viewer only waits for image load/error; the
                  // authored effect duration does not retain this action.
                  duration: 0,
                });
              }
            } else {
              addDiagnostic(
                "warning",
                "scenario.backgroundIncomplete",
                `$.Base.specialEffectData[${referenceIndex}]`,
                "Background effect is missing its bundle or image name",
              );
            }
            break;
          case 8:
            lifetime({
              command: CMD.Location,
              text: localizedText(text(entry.stringVal)),
            });
            break;
          case 9:
          case 10:
          case 12:
          case 13:
          case 14:
          case 15:
          case 16:
            addDiagnostic(
              "info",
              "scenario.effectSourceViewerNoOp",
              `$.Base.specialEffectData[${referenceIndex}].effectType`,
              `The published viewer completes effect ${entry.effectType} as an immediate no-op after its snippet delay`,
            );
            break;
          default:
            addDiagnostic(
              "info",
              "scenario.effectSourceViewerNoOp",
              `$.Base.specialEffectData[${referenceIndex}].effectType`,
              `The published viewer completes unknown effect type ${String(entry.effectType)} as a no-op after its snippet delay`,
            );
            break;
        }
        break;
      }
      case 0:
        addDiagnostic(
          "info",
          "scenario.actionSourceViewerNoOp",
          `${snippetPath}.actionType`,
          "The published viewer drops action type 0 before playback",
        );
        break;
      case 3:
      case 5: {
        addDiagnostic(
          "info",
          "scenario.actionSourceViewerNoOp",
          `${snippetPath}.actionType`,
          `The published viewer drops ${snippet.actionType === 3 ? "input" : "selectable"} snippets before playback`,
        );
        break;
      }
      default:
        addDiagnostic(
          "info",
          "scenario.actionSourceViewerNoOp",
          `${snippetPath}.actionType`,
          `The published viewer drops unknown action type ${String(snippet.actionType)} before playback`,
        );
        break;
    }
    if (admitted) {
      const index = commandIndex++;
      commandSources.push({
        path: snippetPath,
        fidelity: "exact",
        snippetIndex,
        ...(snippet.actionType === undefined ? {} : { actionType: snippet.actionType }),
        ...(snippet.referenceIndex === undefined ? {} : { referenceIndex }),
      });
      commands.push({
        index,
        command: CMD.CommandGroup,
        commandGroup: {
          // progressType=waitFinished gates admission, but every admitted
          // object still advances the source pointer immediately.
          waitForPrevious: snippet.progressType === 1,
          cancelOnManualAdvance: snippet.actionType === 4,
          durationSeconds: delay,
          actions: actions.map((action) => ({
            ...action,
            command: { ...action.command, index },
          })),
        },
      });
    }
  }

  const live2d = [...live2dKeys.entries()].map(([live2dKey, characterId]) => ({
    live2dKey,
    characterId,
    ...(hasBestdoriCharacterIcon(characterId)
      ? { faceImage: assetUrl(`/res/icon/chara_icon_${characterId}.png`) }
      : {}),
  }));
  return {
    story: {
      storyId: text(scenario.scenarioSceneId) || "bestdori-scenario",
      commands,
      assets: { backgrounds, sounds, live2d },
      runtime: createBestdoriSceneRuntime(),
    },
    diagnostics,
    commandSources,
    sourceScenario: scenario,
  };
};
