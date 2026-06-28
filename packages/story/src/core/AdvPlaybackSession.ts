import type {
  AdvChatMemoryEntry,
  AdvChatMemoryState,
  AdvChoiceRecord,
  AdvFocusDataRow,
  AdvFlowParameters,
  AdvRuntimeConfig,
  AdvTalkLogEntry,
} from "../types/AdvRuntime";
import { AdvCommandDelayTokens } from "./time";
import { ADV_CAMERA_DISTANCE } from "./AdvConstants";

function clonePlain<T>(value: T): T {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function mapToEntries<K, V>(map: Map<K, V>): Array<[K, V]> {
  return [...map.entries()].map(([key, value]) => [key, clonePlain(value)]);
}

function finiteOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export interface AdvPlaybackSessionSnapshot {
  readonly CurrentStage: unknown;
  readonly CurrentFocusDataSettings: AdvFocusDataRow[];
  readonly CurrentFocusCameraPosition: { x: number; y: number; z: number };
  readonly CurrentFocusCameraZoomRatio: number;
  readonly CurrentFocusCameraDistance: number;
  readonly CurrentPanV2BaseCameraPosition: { x: number; y: number; z: number };
  readonly CurrentPanV2CameraOffset: { x: number; y: number };
  readonly BgmOriginId: number;
  readonly CurrentBgmPlayId: number;
  readonly CurrentVideoInfo: unknown;
  readonly WithVoice: boolean;
  readonly TalkLog: AdvTalkLogEntry[];
  readonly CurrentMasterChat: unknown;
  readonly CurrentChatWindowScreenMode: number;
  readonly CurrentChatMemoryId: string | null;
  readonly chatMemoryStateMap: Array<
    [
      string,
      {
        entries: AdvChatMemoryEntry[];
        senderReadStateMap: Array<[number, { currentReadCount: number; lastReadAppliedEntryCount: number }]>;
      },
    ]
  >;
  readonly targetNameToPositionTypeMap: Array<[string, number]>;
  readonly positionTypeToCharacterMap: Array<[number, string]>;
  readonly CurrentPlacedCharacterPositionTypes: number[];
  readonly choiceRecords: Array<[number, AdvChoiceRecord]>;
  readonly movieSoundVolume: number;
  readonly FlowParameters: { isClipVideoPlaying: false; isClipVideoSkip: boolean };
}

export class AdvPlaybackSession {
  runtime: AdvRuntimeConfig;
  /** Game-runtime stage object; shape is opaque (deep game internals). */
  CurrentStage: unknown;
  CurrentFocusDataSettings: AdvFocusDataRow[];
  CurrentFocusCameraPosition: { x: number; y: number; z: number };
  CurrentFocusCameraZoomRatio: number;
  CurrentFocusCameraDistance: number;
  CurrentPanV2BaseCameraPosition: { x: number; y: number; z: number };
  CurrentPanV2CameraOffset: { x: number; y: number };
  BgmOriginId: number;
  CurrentBgmPlayId: number;
  /** Video info from the current Movie/Clip command; shape is opaque. */
  CurrentVideoInfo: unknown;
  VideoPlaying: boolean;
  WithVoice: boolean;
  TalkLog: AdvTalkLogEntry[];
  DelayTokens: AdvCommandDelayTokens;
  /** Master chat data for the current ChatWindow; shape is opaque. */
  CurrentMasterChat: unknown;
  CurrentChatWindowScreenMode: number;
  CurrentChatMemoryId: string | null;
  chatMemoryStateMap: Map<string, AdvChatMemoryState>;
  targetNameToPositionTypeMap: Map<string, number>;
  positionTypeToCharacterMap: Map<number, string>;
  CurrentPlacedCharacterPositionTypes: number[];
  choiceRecords: Map<number, AdvChoiceRecord>;
  sePlayIds: number[];
  currentVoicePlayIds: number[];
  voicePlaybackScopeVersion: number;
  private voicePlaybackScopeController: AbortController;
  movieSoundVolume: number;
  FlowParameters: AdvFlowParameters;

  constructor(runtime: AdvRuntimeConfig) {
    this.runtime = runtime;
    this.CurrentStage = null;
    this.CurrentFocusDataSettings = runtime.focusData || [];
    this.CurrentFocusCameraPosition = { x: 0, y: 0, z: 0 };
    this.CurrentFocusCameraZoomRatio = 1;
    this.CurrentFocusCameraDistance = ADV_CAMERA_DISTANCE.KneeShot;
    this.CurrentPanV2BaseCameraPosition = { x: 0, y: 0, z: 0 };
    this.CurrentPanV2CameraOffset = { x: 0, y: 0 };
    this.BgmOriginId = 0;
    this.CurrentBgmPlayId = 0;
    this.CurrentVideoInfo = null;
    this.VideoPlaying = false;
    this.WithVoice = true;
    this.TalkLog = [];
    this.DelayTokens = new AdvCommandDelayTokens();
    this.CurrentMasterChat = null;
    this.CurrentChatWindowScreenMode = 0;
    this.CurrentChatMemoryId = null;
    this.chatMemoryStateMap = new Map();
    this.targetNameToPositionTypeMap = new Map();
    this.positionTypeToCharacterMap = new Map();
    this.CurrentPlacedCharacterPositionTypes = [];
    this.choiceRecords = new Map();
    this.sePlayIds = [];
    this.currentVoicePlayIds = [];
    this.voicePlaybackScopeVersion = 0;
    this.voicePlaybackScopeController = new AbortController();
    this.movieSoundVolume = 1;
    this.FlowParameters = {
      isClipVideoPlaying: false,
      isClipVideoSkip: false,
      setClipVideoPlaying(v: boolean) {
        this.isClipVideoPlaying = v;
      },
      setClipSkip(v: boolean) {
        this.isClipVideoSkip = v;
      },
    };
  }

  setMovieSoundVolume(volume: number) {
    this.movieSoundVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
  }

  getMovieSoundVolume() {
    return this.movieSoundVolume;
  }

  getOrCreateChatMemoryState(memoryId: string): AdvChatMemoryState {
    let state = this.chatMemoryStateMap.get(memoryId);
    if (!state) {
      state = {
        entries: [] as AdvChatMemoryEntry[],
        senderReadStateMap: new Map<number, { currentReadCount: number; lastReadAppliedEntryCount: number }>(),
      };
      this.chatMemoryStateMap.set(memoryId, state);
    }
    return state;
  }

  chatMemoryAddTalk(
    memoryId: string,
    senderChatId: number,
    text: string,
    senderName: string,
    readCount: number,
    textLang?: string,
    senderLang?: string,
  ) {
    const state = this.getOrCreateChatMemoryState(memoryId);
    state.entries.push({
      entryType: 0,
      senderChatId,
      senderName,
      senderLang,
      text,
      textLang,
      stampAssetName: "",
      readCount,
    });
  }

  chatMemoryAddStamp(
    memoryId: string,
    senderChatId: number,
    stampAssetName: string,
    senderName: string,
    readCount: number,
    senderLang?: string,
  ) {
    const state = this.getOrCreateChatMemoryState(memoryId);
    state.entries.push({
      entryType: 1,
      senderChatId,
      senderName,
      senderLang,
      text: "",
      stampAssetName,
      readCount,
    });
  }

  chatMemoryApplyRead(memoryId: string, senderChatId: number, readCount: number) {
    const state = this.getOrCreateChatMemoryState(memoryId);
    const senderState = state.senderReadStateMap.get(senderChatId) || {
      currentReadCount: 0,
      lastReadAppliedEntryCount: 0,
    };
    senderState.currentReadCount = readCount;
    senderState.lastReadAppliedEntryCount = state.entries.length;
    state.senderReadStateMap.set(senderChatId, senderState);
  }

  setCurrentStage(stage: unknown) {
    this.CurrentStage = stage || null;
  }

  setCurrentFocusCameraDistance(distance: number) {
    this.CurrentFocusCameraDistance = Math.max(0, Math.min(6, Number(distance) || 0));
  }

  setCurrentFocusCameraPosition(position: { x?: number; y?: number; z?: number } | null) {
    this.CurrentFocusCameraPosition = {
      x: Number(position?.x) || 0,
      y: Number(position?.y) || 0,
      z: Number(position?.z) || 0,
    };
  }

  setCurrentFocusCameraZoomRatio(ratio: number) {
    const value = Number(ratio);
    this.CurrentFocusCameraZoomRatio = Number.isFinite(value) ? value : 1;
  }

  setCurrentPanV2BaseCameraPosition(position: { x?: number; y?: number; z?: number } | null) {
    this.CurrentPanV2BaseCameraPosition = {
      x: Number(position?.x) || 0,
      y: Number(position?.y) || 0,
      z: Number(position?.z) || 0,
    };
  }

  setCurrentPanV2CameraOffset(offset: { x?: number; y?: number } | null) {
    this.CurrentPanV2CameraOffset = { x: Number(offset?.x) || 0, y: Number(offset?.y) || 0 };
  }

  placeCharacter(targetName: string, positionType: number) {
    const target = String(targetName || "");
    const pos = Number(positionType) || 0;
    if (!target || !pos) return;
    const oldPos = this.targetNameToPositionTypeMap.get(target);
    if (oldPos != null && oldPos !== pos) this.positionTypeToCharacterMap.delete(oldPos);
    const oldTarget = this.positionTypeToCharacterMap.get(pos);
    if (oldTarget && oldTarget !== target) this.targetNameToPositionTypeMap.delete(oldTarget);
    this.targetNameToPositionTypeMap.set(target, pos);
    this.positionTypeToCharacterMap.set(pos, target);
    this.CurrentPlacedCharacterPositionTypes = [...this.positionTypeToCharacterMap.keys()].sort((a, b) => a - b);
  }

  removeCharacter(targetName: string) {
    const target = String(targetName || "");
    const pos = this.targetNameToPositionTypeMap.get(target);
    if (pos != null) this.positionTypeToCharacterMap.delete(pos);
    this.targetNameToPositionTypeMap.delete(target);
    this.CurrentPlacedCharacterPositionTypes = [...this.positionTypeToCharacterMap.keys()].sort((a, b) => a - b);
  }

  tryGetTargetNameToPositionType(targetName: string) {
    return this.targetNameToPositionTypeMap.get(String(targetName || "")) || 0;
  }

  getCharacterAt(positionType: number) {
    return this.positionTypeToCharacterMap.get(Number(positionType) || 0) || "";
  }

  addTalkLog(entry: AdvTalkLogEntry) {
    this.TalkLog.push(entry);
  }

  beginVoicePlaybackScope() {
    this.voicePlaybackScopeController.abort();
    this.voicePlaybackScopeController = new AbortController();
    this.voicePlaybackScopeVersion += 1;
    this.currentVoicePlayIds = [];
    return this.voicePlaybackScopeVersion;
  }

  isVoicePlaybackScopeCurrent(scopeVersion: number) {
    return scopeVersion === this.voicePlaybackScopeVersion && !this.voicePlaybackScopeController.signal.aborted;
  }

  voicePlaybackScopeSignal(scopeVersion: number): AbortSignal | null {
    return this.isVoicePlaybackScopeCurrent(scopeVersion) ? this.voicePlaybackScopeController.signal : null;
  }

  cancelVoicePlaybackScope() {
    this.voicePlaybackScopeController.abort();
    this.currentVoicePlayIds = [];
  }

  createSnapshot(): AdvPlaybackSessionSnapshot {
    return {
      // Stage/master/video records come from immutable episode/master data.
      // Share those records while mutable collections below receive copies.
      CurrentStage: this.CurrentStage,
      CurrentFocusDataSettings: clonePlain(this.CurrentFocusDataSettings),
      CurrentFocusCameraPosition: clonePlain(this.CurrentFocusCameraPosition),
      CurrentFocusCameraZoomRatio: this.CurrentFocusCameraZoomRatio,
      CurrentFocusCameraDistance: this.CurrentFocusCameraDistance,
      CurrentPanV2BaseCameraPosition: clonePlain(this.CurrentPanV2BaseCameraPosition),
      CurrentPanV2CameraOffset: clonePlain(this.CurrentPanV2CameraOffset),
      BgmOriginId: this.BgmOriginId,
      CurrentBgmPlayId: this.CurrentBgmPlayId,
      CurrentVideoInfo: this.CurrentVideoInfo,
      WithVoice: this.WithVoice,
      TalkLog: clonePlain(this.TalkLog),
      CurrentMasterChat: this.CurrentMasterChat,
      CurrentChatWindowScreenMode: this.CurrentChatWindowScreenMode,
      CurrentChatMemoryId: this.CurrentChatMemoryId,
      chatMemoryStateMap: [...this.chatMemoryStateMap.entries()].map(([memoryId, state]) => [
        memoryId,
        {
          entries: clonePlain(state.entries || []),
          senderReadStateMap: mapToEntries(state.senderReadStateMap || new Map()),
        },
      ]),
      targetNameToPositionTypeMap: mapToEntries(this.targetNameToPositionTypeMap),
      positionTypeToCharacterMap: mapToEntries(this.positionTypeToCharacterMap),
      CurrentPlacedCharacterPositionTypes: clonePlain(this.CurrentPlacedCharacterPositionTypes),
      choiceRecords: mapToEntries(this.choiceRecords),
      movieSoundVolume: this.movieSoundVolume,
      FlowParameters: {
        isClipVideoPlaying: false,
        isClipVideoSkip: this.FlowParameters.isClipVideoSkip,
      },
    };
  }

  restoreSnapshot(snapshot: AdvPlaybackSessionSnapshot) {
    if (!snapshot) return;
    this.CurrentStage = clonePlain(snapshot.CurrentStage);
    this.CurrentFocusDataSettings = clonePlain(snapshot.CurrentFocusDataSettings || this.runtime.focusData || []);
    this.CurrentFocusCameraPosition = (clonePlain(snapshot.CurrentFocusCameraPosition) as {
      x: number;
      y: number;
      z: number;
    }) || { x: 0, y: 0, z: 0 };
    this.CurrentFocusCameraZoomRatio = finiteOr(snapshot.CurrentFocusCameraZoomRatio, 1);
    this.CurrentFocusCameraDistance = finiteOr(snapshot.CurrentFocusCameraDistance, ADV_CAMERA_DISTANCE.KneeShot);
    this.CurrentPanV2BaseCameraPosition = (clonePlain(snapshot.CurrentPanV2BaseCameraPosition) as {
      x: number;
      y: number;
      z: number;
    }) || { x: 0, y: 0, z: 0 };
    this.CurrentPanV2CameraOffset = (clonePlain(snapshot.CurrentPanV2CameraOffset) as { x: number; y: number }) || {
      x: 0,
      y: 0,
    };
    this.BgmOriginId = Number(snapshot.BgmOriginId) || 0;
    this.CurrentBgmPlayId = Number(snapshot.CurrentBgmPlayId) || 0;
    this.CurrentVideoInfo = clonePlain(snapshot.CurrentVideoInfo);
    this.VideoPlaying = false;
    this.WithVoice = snapshot.WithVoice !== false;
    this.TalkLog = (
      Array.isArray(clonePlain(snapshot.TalkLog)) ? clonePlain(snapshot.TalkLog) : []
    ) as AdvTalkLogEntry[];
    this.CurrentMasterChat = clonePlain(snapshot.CurrentMasterChat);
    this.CurrentChatWindowScreenMode = Number(snapshot.CurrentChatWindowScreenMode) || 0;
    this.CurrentChatMemoryId = typeof snapshot.CurrentChatMemoryId === "string" ? snapshot.CurrentChatMemoryId : null;
    type SnapshotMemoryEntry = {
      entries?: AdvChatMemoryEntry[];
      senderReadStateMap?: Array<[number, { currentReadCount: number; lastReadAppliedEntryCount: number }]>;
    };
    this.chatMemoryStateMap = new Map(
      ((snapshot.chatMemoryStateMap as Array<[string, SnapshotMemoryEntry]>) || []).map(([memoryId, state]) => [
        memoryId,
        {
          entries: clonePlain(state?.entries || []),
          senderReadStateMap: new Map(state?.senderReadStateMap || []),
        },
      ]),
    );
    this.targetNameToPositionTypeMap = new Map((snapshot.targetNameToPositionTypeMap as Array<[string, number]>) || []);
    this.positionTypeToCharacterMap = new Map(
      ((snapshot.positionTypeToCharacterMap as Array<[number, string]>) || []).map(([key, value]) => [
        Number(key),
        value,
      ]),
    );
    this.CurrentPlacedCharacterPositionTypes = (
      Array.isArray(clonePlain(snapshot.CurrentPlacedCharacterPositionTypes))
        ? clonePlain(snapshot.CurrentPlacedCharacterPositionTypes)
        : []
    ) as number[];
    this.choiceRecords = new Map((snapshot.choiceRecords as Array<[number, AdvChoiceRecord]>) || []);
    this.sePlayIds = [];
    this.currentVoicePlayIds = [];
    this.voicePlaybackScopeController.abort();
    this.voicePlaybackScopeController = new AbortController();
    this.voicePlaybackScopeVersion += 1;
    this.movieSoundVolume = Math.max(0, Math.min(1, finiteOr(snapshot.movieSoundVolume, 1)));
    this.FlowParameters.isClipVideoPlaying = false;
    this.FlowParameters.isClipVideoSkip = Boolean(
      (snapshot.FlowParameters as Record<string, unknown> | undefined)?.isClipVideoSkip,
    );
    this.DelayTokens.reset();
  }
}
