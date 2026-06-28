import { ensureMotionSyncCore } from "./CubismCoreRuntime";
import type { AdvVoiceMotionSyncPcmSnapshot } from "../../sound/AdvSoundManager";
import type { AdvMotionSyncSetting } from "../../types/AdvRuntime";
import { advMotionSyncNeutralValues } from "./AdvMotionSyncMath";

export {
  advMotionSyncNeutralValues,
  applyAdvMotionSyncOnCapturedBase,
  selectAdvMotionSyncSetting,
} from "./AdvMotionSyncMath";

// --- Minimal interfaces for the dynamically-loaded Live2D MotionSync WASM engine ---
// These cover only the fields actually accessed; opaque internals are left untyped.

/** Live2D Cubism core model, as accessed through the engine's parameter APIs */
interface CoreModel {
  getParameterCount(): number;
  getParameterId(index: number): unknown;
  getParameterValueByIndex(index: number): number;
}

/** MotionSync WASM engine (loaded dynamically from vendored pjsekai engine) */
interface MotionSyncCore {
  CubismMotionSyncEngine: {
    csmMotionSyncInitializeEngine(flag: number): number;
  };
  csmMotionSyncTrue: number;
  ToPointer: {
    Malloc(size: number): number;
    Free(ptr: number): void;
    ConvertContextConfigCriToInt32Array(arr: Int32Array, ptr: number, sampleRate: number, bitDepth: number): void;
    ConvertMappingInfoCriToFloat32Array(
      arr: Float32Array,
      ptr: number,
      audioId: string,
      paramIds: string[],
      values: number[],
      count: number,
      scale: number,
      enabled: number,
    ): Float32Array;
    AddValuePtrFloat(ptr: number, offset: number, value: number): void;
    AddValuePtrInt32(ptr: number, offset: number, value: number): void;
    GetProcessedSampleCountFromAnalysisResult(ptr: number): number;
    GetValuesFromAnalysisResult(ptr: number, count: number): number[];
    ConvertAnalysisResultToInt32Array(arr: Int32Array, ptr: number, count: number): Int32Array;
  };
  Context: new () => MotionSyncContext;
}

/** A MotionSync analysis context created by the engine */
interface MotionSyncContext {
  csmMotionSyncCreate(configPtr: number, mappingPtr: number, count: number): void;
  csmMotionSyncGetRequireSampleCount(): number;
  csmMotionSyncClear(): void;
  csmMotionSyncAnalyze(samplePtr: number, count: number, resultPtr: number, configPtr: number): number;
  csmMotionSyncDelete(): void;
}

// --- Constants ---

type MotionSyncParameter = {
  id: string;
  damper: number;
  smooth: number;
};

export type AdvMotionSyncOutput = {
  values: Record<string, number>;
  processedSampleCount: number;
};

export type AdvMotionSyncCoreStatus = "loading" | "ready" | "failed" | "released";

const MOTION_SYNC_MAPPING_INFO_SIZE = 6;
const MOTION_SYNC_CONTEXT_CONFIG_SIZE = 2;
const MOTION_SYNC_ANALYSIS_CONFIG_SIZE = 3;
const MOTION_SYNC_ANALYSIS_RESULT_SIZE = 3;
const MOTION_SYNC_BIT_DEPTH_FLOAT32 = 32;

let motionSyncCorePromise: Promise<MotionSyncCore> | null = null;
let motionSyncEngineInitialized = false;

function finite(value: number | undefined | null, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number | undefined | null, min = 0, max = 1): number {
  const next = finite(value, min);
  return Math.max(min, Math.min(max, next));
}

function parameterIdString(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const source = value as {
    getString?: () => string | { s?: string };
    s?: string;
    _id?: { s?: string };
  };
  const id = source.getString?.();
  if (typeof id === "string") return id;
  if (typeof id?.s === "string") return id.s;
  if (typeof source.s === "string") return source.s;
  if (typeof source._id?.s === "string") return source._id.s;
  return String(value || "");
}

function normalizeParamId(value: unknown) {
  return parameterIdString(value)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function exactParameterIndex(coreModel: CoreModel, id: string): number {
  const wanted = normalizeParamId(id);
  const count = Math.max(0, Math.trunc(finite(coreModel?.getParameterCount?.(), 0)));
  for (let index = 0; index < count; index += 1) {
    if (normalizeParamId(coreModel?.getParameterId?.(index)) === wanted) return index;
  }
  return -1;
}

function settingParameters(setting: AdvMotionSyncSetting): MotionSyncParameter[] {
  return (Array.isArray(setting?.parameters) ? setting.parameters : [])
    .map((parameter) => ({
      id: String(parameter?.id || ""),
      damper: Math.max(0, finite(parameter?.damper, 0)),
      smooth: clamp(parameter?.smooth, 0, 100),
    }))
    .filter((parameter: MotionSyncParameter) => parameter.id);
}

function settingAudioParameters(setting: AdvMotionSyncSetting) {
  return (Array.isArray(setting?.audioParameters) ? setting.audioParameters : [])
    .map((parameter) => ({
      id: String(parameter?.id || parameter?.name || ""),
      scale: finite(parameter?.scale, 1),
      enabled: parameter?.enabled !== false,
    }))
    .filter((parameter) => parameter.id);
}

function mappingTargetValue(setting: AdvMotionSyncSetting, audioParameterId: string, parameterId: string) {
  const mapping = (Array.isArray(setting?.mappings) ? setting.mappings : []).find(
    (row) => String(row?.audioParameterId || "") === audioParameterId,
  );
  const target = (Array.isArray(mapping?.targets) ? mapping.targets : []).find(
    (row) => String(row?.id || "") === parameterId,
  );
  const value = Number(target?.value);
  return Number.isFinite(value) ? value : 0;
}

export function prepareAdvMotionSyncCore() {
  if (!motionSyncCorePromise) {
    motionSyncCorePromise = (ensureMotionSyncCore() as Promise<MotionSyncCore>)
      .then((core) => {
        if (!motionSyncEngineInitialized) {
          const ok = core?.CubismMotionSyncEngine?.csmMotionSyncInitializeEngine?.(0);
          if (ok !== core?.csmMotionSyncTrue) throw new Error("Live2D MotionSync Core initialization failed");
          motionSyncEngineInitialized = true;
        }
        return core;
      })
      .catch((err: unknown) => {
        motionSyncCorePromise = null;
        throw err;
      });
  }
  return motionSyncCorePromise;
}

export class AdvMotionSyncCoreAdapter {
  private readonly setting: AdvMotionSyncSetting;
  private readonly parameters: MotionSyncParameter[];
  private readonly neutralValues: Readonly<Record<string, number>>;
  private readonly preparation: Promise<boolean>;
  private core: MotionSyncCore | null = null;
  private ready = false;
  private failed = false;
  private released = false;
  private sampleRate = 0;
  private sourceKey: number | string | null = null;
  private previousSamplePosition = 0;
  private sampleBuffer = new Float32Array(0);
  private sampleBufferStart = 0;
  private sampleBufferLength = 0;
  private currentRemainTime = 0;
  private lastTotalProcessedCount = 0;
  private lastSmoothed: number[] = [];
  private lastDamped: number[] = [];
  private readonly nextOutputValues: Float64Array;
  private readonly nextOutputValid: Uint8Array;
  private readonly lastOutput: Record<string, number> = {};
  private lastOutputCount = 0;
  private readonly reusableOutput: AdvMotionSyncOutput = {
    values: this.lastOutput,
    processedSampleCount: 0,
  };
  private context: MotionSyncContext | null = null;
  private contextConfigPtr = 0;
  private mappingInfoListPtr = 0;
  private mappingInfoBuffers: Array<{ ptr: number; native: Float32Array }> = [];
  private analysisConfigPtr = 0;
  private analysisResultPtr = 0;
  private analysisResultNative: Int32Array | null = null;
  private samplePtr = 0;
  private samplePtrCapacity = 0;
  private requireSampleCount = 0;

  constructor(setting: AdvMotionSyncSetting) {
    this.setting = setting;
    this.parameters = settingParameters(setting);
    this.nextOutputValues = new Float64Array(this.parameters.length);
    this.nextOutputValid = new Uint8Array(this.parameters.length);
    this.neutralValues = advMotionSyncNeutralValues(setting);
    this.preparation = prepareAdvMotionSyncCore()
      .then((core) => {
        if (this.released) return false;
        this.core = core;
        this.ready = true;
        return true;
      })
      .catch(() => {
        this.failed = true;
        return false;
      });
  }

  get status(): AdvMotionSyncCoreStatus {
    if (this.released) return "released";
    if (this.failed) return "failed";
    return this.ready ? "ready" : "loading";
  }

  prepare(): Promise<boolean> {
    return this.preparation;
  }

  neutralValue(parameterId: string): number {
    return finite(this.neutralValues[parameterId], 0);
  }

  reset(): void {
    this.sourceKey = null;
    this.previousSamplePosition = 0;
    this.sampleBufferStart = 0;
    this.sampleBufferLength = 0;
    this.currentRemainTime = 0;
    this.lastTotalProcessedCount = 0;
    this.lastSmoothed = [];
    this.lastDamped = [];
    this.clearLastOutput();
    try {
      this.context?.csmMotionSyncClear?.();
    } catch {}
  }

  release(): void {
    this.released = true;
    this.ready = false;
    this.releaseContext();
  }

  private releaseContext(): void {
    const core = this.core;
    if (core) {
      try {
        this.context?.csmMotionSyncDelete?.();
      } catch {}
      for (const info of this.mappingInfoBuffers) {
        try {
          core.ToPointer.Free(info.native[0]);
          core.ToPointer.Free(info.native[1]);
          core.ToPointer.Free(info.native[2]);
          core.ToPointer.Free(info.ptr);
        } catch {}
      }
      try {
        if (this.mappingInfoListPtr) core.ToPointer.Free(this.mappingInfoListPtr);
      } catch {}
      try {
        if (this.contextConfigPtr) core.ToPointer.Free(this.contextConfigPtr);
      } catch {}
      try {
        if (this.analysisResultNative?.[0]) core.ToPointer.Free(this.analysisResultNative[0]);
      } catch {}
      try {
        if (this.analysisResultPtr) core.ToPointer.Free(this.analysisResultPtr);
      } catch {}
      try {
        if (this.analysisConfigPtr) core.ToPointer.Free(this.analysisConfigPtr);
      } catch {}
      try {
        if (this.samplePtr) core.ToPointer.Free(this.samplePtr);
      } catch {}
    }
    this.context = null;
    this.mappingInfoBuffers = [];
    this.mappingInfoListPtr = 0;
    this.contextConfigPtr = 0;
    this.analysisResultPtr = 0;
    this.analysisResultNative = null;
    this.analysisConfigPtr = 0;
    this.samplePtr = 0;
    this.samplePtrCapacity = 0;
    this.sampleBuffer = new Float32Array(0);
    this.sampleBufferStart = 0;
    this.sampleBufferLength = 0;
    this.requireSampleCount = 0;
  }

  update(
    coreModel: CoreModel,
    source: AdvVoiceMotionSyncPcmSnapshot | null,
    deltaSeconds: number,
  ): AdvMotionSyncOutput | null {
    const output = this.updateReusable(coreModel, source, deltaSeconds);
    return output ? { values: { ...output.values }, processedSampleCount: output.processedSampleCount } : null;
  }

  /** Allocation-free render-loop variant; its result is overwritten by the next call. */
  updateReusable(
    coreModel: CoreModel,
    source: AdvVoiceMotionSyncPcmSnapshot | null,
    deltaSeconds: number,
  ): AdvMotionSyncOutput | null {
    if (!this.ready || this.failed || this.released || !this.core || !source || !this.parameters.length) return null;
    if (!source.channelData?.length || !source.sampleRate) return null;
    if (this.sampleRate !== source.sampleRate) {
      this.resetForSampleRate(coreModel, source.sampleRate);
    }
    if (!this.context) return null;
    if (this.sourceKey !== source.sourceKey || source.samplePosition < this.previousSamplePosition) {
      this.resetPlayback(coreModel, source.sourceKey, source.samplePosition);
    }
    this.appendPlayedSamples(source);

    const frameRate = Math.max(1, finite(this.setting?.postProcessing?.sampleRate, 30));
    const processorDeltaTime = 1 / frameRate;
    this.currentRemainTime += Math.max(0, finite(deltaSeconds, 0));
    this.lastTotalProcessedCount = 0;
    if (this.currentRemainTime >= processorDeltaTime) {
      this.analyzeAvailableSamples();
      this.currentRemainTime %= processorDeltaTime;
    }
    if (!this.lastOutputCount) return null;
    this.reusableOutput.processedSampleCount = this.lastTotalProcessedCount;
    return this.reusableOutput;
  }

  private resetForSampleRate(coreModel: CoreModel, sampleRate: number) {
    this.releaseContext();
    this.sampleRate = Math.max(1, Math.trunc(sampleRate));
    this.sourceKey = null;
    this.previousSamplePosition = 0;
    this.currentRemainTime = 0;
    this.lastTotalProcessedCount = 0;
    this.clearLastOutput();
    this.resetParameterHistory(coreModel);
    this.createContext();
  }

  private resetPlayback(coreModel: CoreModel, sourceKey: number | string, samplePosition: number) {
    this.sourceKey = sourceKey;
    this.previousSamplePosition = Math.max(0, Math.trunc(samplePosition));
    this.sampleBufferStart = 0;
    this.sampleBufferLength = 0;
    this.currentRemainTime = 0;
    this.lastTotalProcessedCount = 0;
    this.clearLastOutput();
    this.resetParameterHistory(coreModel);
    try {
      this.context?.csmMotionSyncClear?.();
    } catch {}
  }

  private resetParameterHistory(coreModel: CoreModel): void {
    this.lastSmoothed = this.parameters.map((parameter) => {
      const index = exactParameterIndex(coreModel, parameter.id);
      return index >= 0 ? finite(coreModel?.getParameterValueByIndex?.(index), 0) : 0;
    });
    this.lastDamped = [...this.lastSmoothed];
  }

  private createContext() {
    const core = this.core;
    if (!core) return;
    const audioParameters = settingAudioParameters(this.setting);
    if (!audioParameters.length) return;
    const parameterIds = this.parameters.map((parameter) => parameter.id);

    this.contextConfigPtr = core.ToPointer.Malloc(MOTION_SYNC_CONTEXT_CONFIG_SIZE * Int32Array.BYTES_PER_ELEMENT);
    core.ToPointer.ConvertContextConfigCriToInt32Array(
      new Int32Array(MOTION_SYNC_CONTEXT_CONFIG_SIZE),
      this.contextConfigPtr,
      this.sampleRate,
      MOTION_SYNC_BIT_DEPTH_FLOAT32,
    );

    const structBytes = MOTION_SYNC_MAPPING_INFO_SIZE * Float32Array.BYTES_PER_ELEMENT;
    this.mappingInfoListPtr = core.ToPointer.Malloc(structBytes * audioParameters.length);
    for (let index = 0; index < audioParameters.length; index += 1) {
      const audio = audioParameters[index];
      const modelParameterValues = parameterIds.map((parameterId) =>
        mappingTargetValue(this.setting, audio.id, parameterId),
      );
      const infoPtr = core.ToPointer.Malloc(structBytes);
      const native = core.ToPointer.ConvertMappingInfoCriToFloat32Array(
        new Float32Array(MOTION_SYNC_MAPPING_INFO_SIZE),
        infoPtr,
        audio.id,
        parameterIds,
        modelParameterValues,
        parameterIds.length,
        audio.scale,
        audio.enabled ? 1 : 0,
      );
      this.mappingInfoBuffers.push({ ptr: infoPtr, native });
      const base = this.mappingInfoListPtr + index * structBytes;
      for (let field = 0; field < MOTION_SYNC_MAPPING_INFO_SIZE; field += 1) {
        if (field === 4) core.ToPointer.AddValuePtrFloat(base, field * 4, native[field]);
        else core.ToPointer.AddValuePtrInt32(base, field * 4, native[field]);
      }
    }

    this.context = new core.Context();
    this.context.csmMotionSyncCreate(this.contextConfigPtr, this.mappingInfoListPtr, audioParameters.length);
    this.requireSampleCount = Math.max(1, Math.trunc(this.context.csmMotionSyncGetRequireSampleCount() || 0));

    this.analysisConfigPtr = core.ToPointer.Malloc(MOTION_SYNC_ANALYSIS_CONFIG_SIZE * Float32Array.BYTES_PER_ELEMENT);
    core.ToPointer.AddValuePtrFloat(this.analysisConfigPtr, 0, clamp(this.setting?.postProcessing?.blendRatio, 0, 1));
    core.ToPointer.AddValuePtrInt32(
      this.analysisConfigPtr,
      4,
      Math.max(1, Math.min(100, Math.trunc(finite(this.setting?.postProcessing?.smoothing, 100)))),
    );
    core.ToPointer.AddValuePtrFloat(this.analysisConfigPtr, 8, clamp(this.setting?.emphasisLevel, 0, 1));

    this.analysisResultPtr = core.ToPointer.Malloc(MOTION_SYNC_ANALYSIS_RESULT_SIZE * Int32Array.BYTES_PER_ELEMENT);
    this.analysisResultNative = core.ToPointer.ConvertAnalysisResultToInt32Array(
      new Int32Array(MOTION_SYNC_ANALYSIS_RESULT_SIZE),
      this.analysisResultPtr,
      this.parameters.length,
    );
  }

  private appendPlayedSamples(source: AdvVoiceMotionSyncPcmSnapshot) {
    const next = Math.max(0, Math.min(source.channelData.length, Math.trunc(source.samplePosition)));
    const start = Math.max(0, Math.min(source.channelData.length, this.previousSamplePosition));
    const maxBuffered = Math.max(this.requireSampleCount * 4, Math.trunc(this.sampleRate * 0.5));
    this.ensureSampleBufferCapacity(maxBuffered);
    if (next > start) {
      const capacity = this.sampleBuffer.length;
      for (let index = start; index < next; index += 1) {
        if (this.sampleBufferLength < capacity) {
          const writeIndex = (this.sampleBufferStart + this.sampleBufferLength) % capacity;
          this.sampleBuffer[writeIndex] = source.channelData[index];
          this.sampleBufferLength += 1;
        } else {
          this.sampleBuffer[this.sampleBufferStart] = source.channelData[index];
          this.sampleBufferStart = (this.sampleBufferStart + 1) % capacity;
        }
      }
    }
    this.previousSamplePosition = next;
  }

  private ensureSampleBufferCapacity(capacity: number): void {
    const normalized = Math.max(1, Math.trunc(capacity));
    if (this.sampleBuffer.length === normalized) return;
    const previous = this.sampleBuffer;
    const previousLength = Math.min(this.sampleBufferLength, normalized);
    const next = new Float32Array(normalized);
    const dropped = this.sampleBufferLength - previousLength;
    for (let index = 0; index < previousLength; index += 1) {
      next[index] = previous.length ? previous[(this.sampleBufferStart + dropped + index) % previous.length] : 0;
    }
    this.sampleBuffer = next;
    this.sampleBufferStart = 0;
    this.sampleBufferLength = previousLength;
  }

  private ensureSamplePtr(count: number) {
    const core = this.core;
    if (!core || count <= this.samplePtrCapacity) return;
    if (this.samplePtr) core.ToPointer.Free(this.samplePtr);
    this.samplePtrCapacity = Math.max(count, this.requireSampleCount);
    this.samplePtr = core.ToPointer.Malloc(this.samplePtrCapacity * Float32Array.BYTES_PER_ELEMENT);
  }

  private analyzeAvailableSamples() {
    const core = this.core;
    if (!core || !this.context || !this.analysisResultPtr || this.sampleBufferLength < this.requireSampleCount) return;
    const maxIterations = Math.max(1, Math.ceil(this.sampleBufferLength / Math.max(1, this.requireSampleCount)) + 1);
    for (
      let iteration = 0;
      iteration < maxIterations && this.sampleBufferLength >= this.requireSampleCount;
      iteration += 1
    ) {
      const analyzeCount = this.sampleBufferLength;
      this.ensureSamplePtr(analyzeCount);
      for (let index = 0; index < analyzeCount; index += 1) {
        const readIndex = (this.sampleBufferStart + index) % this.sampleBuffer.length;
        core.ToPointer.AddValuePtrFloat(this.samplePtr, index * 4, this.sampleBuffer[readIndex]);
      }
      const ok = this.context.csmMotionSyncAnalyze(
        this.samplePtr,
        analyzeCount,
        this.analysisResultPtr,
        this.analysisConfigPtr,
      );
      if (ok !== core.csmMotionSyncTrue) break;
      const processed = Math.max(
        0,
        Math.trunc(core.ToPointer.GetProcessedSampleCountFromAnalysisResult(this.analysisResultPtr + 8) || 0),
      );
      if (processed <= 0) break;
      const consumed = Math.min(processed, this.sampleBufferLength);
      this.sampleBufferStart = (this.sampleBufferStart + consumed) % this.sampleBuffer.length;
      this.sampleBufferLength -= consumed;
      this.lastTotalProcessedCount += processed;
      const rawValues = core.ToPointer.GetValuesFromAnalysisResult(
        this.analysisResultNative?.[0] ?? 0,
        this.parameters.length,
      );
      this.postProcess(rawValues);
    }
  }

  private clearLastOutput(): void {
    for (const parameter of this.parameters) delete this.lastOutput[parameter.id];
    this.lastOutputCount = 0;
    this.reusableOutput.processedSampleCount = 0;
  }

  private postProcess(rawValues: number[]) {
    let outputCount = 0;
    this.nextOutputValid.fill(0);
    for (let index = 0; index < this.parameters.length; index += 1) {
      const parameter = this.parameters[index];
      let value = Number(rawValues?.[index]);
      if (!Number.isFinite(value)) continue;
      const smooth = clamp(parameter.smooth, 0, 100);
      const damper = Math.max(0, finite(parameter.damper, 0));
      value = ((100 - smooth) * value + finite(this.lastSmoothed[index], 0) * smooth) / 100;
      this.lastSmoothed[index] = value;
      if (Math.abs(value - finite(this.lastDamped[index], 0)) < damper) {
        value = finite(this.lastDamped[index], 0);
      }
      this.lastDamped[index] = value;
      this.nextOutputValues[index] = value;
      this.nextOutputValid[index] = 1;
      outputCount += 1;
    }
    // Match the native adapter's hold-last behavior when an analysis result
    // contains no valid parameter values at all.
    if (!outputCount) return;
    for (const parameter of this.parameters) delete this.lastOutput[parameter.id];
    for (let index = 0; index < this.parameters.length; index += 1) {
      if (this.nextOutputValid[index]) {
        this.lastOutput[this.parameters[index].id] = this.nextOutputValues[index];
      }
    }
    this.lastOutputCount = outputCount;
  }
}
