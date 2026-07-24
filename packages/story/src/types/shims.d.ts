declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module "*.png" {
  const value: string;
  export default value;
}

type GLint = number;
type GLuint = number;
type GLenum = number;
type GLboolean = boolean;

declare namespace Live2DCubismCore {
  type csmVersion = number;
  type csmMocVersion = number;
  type csmParameterType = number;
  type csmLogFunction = (message: string) => void;

  const AlignofMoc: number;
  const AlignofModel: number;
  const MocVersion_Unknown: number;
  const MocVersion_30: number;
  const MocVersion_33: number;
  const MocVersion_40: number;
  const MocVersion_42: number;
  const MocVersion_50: number;
  const ParameterType_Normal: number;
  const ParameterType_BlendShape: number;

  class Version {
    static csmGetVersion(): csmVersion;
    static csmGetLatestMocVersion(): csmMocVersion;
    static csmGetMocVersion(moc: Moc, mocBytes: ArrayBuffer): csmMocVersion;
  }

  class Logging {
    static csmSetLogFunction(handler: csmLogFunction): void;
    static csmGetLogFunction(): csmLogFunction;
  }

  class Moc {
    static fromArrayBuffer(buffer: ArrayBuffer): Moc | null;
    hasMocConsistency(mocBytes: ArrayBuffer): number;
    _release(): void;
    _ptr: number;
  }

  class Model {
    static fromMoc(moc: Moc): Model | null;
    parameters: Parameters;
    parts: Parts;
    drawables: Drawables;
    canvasinfo: CanvasInfo;
    update(): void;
    release(): void;
    _ptr: number;
  }

  class CanvasInfo {
    CanvasWidth: number;
    CanvasHeight: number;
    CanvasOriginX: number;
    CanvasOriginY: number;
    PixelsPerUnit: number;
  }

  class Parameters {
    count: number;
    ids: string[];
    minimumValues: Float32Array;
    maximumValues: Float32Array;
    defaultValues: Float32Array;
    values: Float32Array;
    types: Int32Array;
    repeats: Int32Array;
    keyCounts: Int32Array;
    keyValues: Float32Array[];
  }

  class Parts {
    count: number;
    ids: string[];
    opacities: Float32Array;
    parentIndices: Int32Array;
  }

  class Drawables {
    count: number;
    ids: string[];
    constantFlags: Uint8Array;
    dynamicFlags: Uint8Array;
    textureIndices: Int32Array;
    drawOrders: Int32Array;
    renderOrders: Int32Array;
    opacities: Float32Array;
    maskCounts: Int32Array;
    masks: Int32Array[];
    vertexCounts: Int32Array;
    vertexPositions: Float32Array[];
    vertexUvs: Float32Array[];
    indexCounts: Int32Array;
    indices: Uint16Array[];
    multiplyColors: Float32Array;
    screenColors: Float32Array;
    parentPartIndices: Int32Array;
    resetDynamicFlags(): void;
  }

  class Utils {
    static hasBlendAdditiveBit(bitfield: number): boolean;
    static hasBlendMultiplicativeBit(bitfield: number): boolean;
    static hasIsDoubleSidedBit(bitfield: number): boolean;
    static hasIsInvertedMaskBit(bitfield: number): boolean;
    static hasIsVisibleBit(bitfield: number): boolean;
    static hasVisibilityDidChangeBit(bitfield: number): boolean;
    static hasOpacityDidChangeBit(bitfield: number): boolean;
    static hasDrawOrderDidChangeBit(bitfield: number): boolean;
    static hasRenderOrderDidChangeBit(bitfield: number): boolean;
    static hasVertexPositionsDidChangeBit(bitfield: number): boolean;
    static hasBlendColorDidChangeBit(bitfield: number): boolean;
  }

  class Memory {
    static initializeAmountOfMemory(size: number): void;
  }
}

declare const Live2DCubismCore: typeof Live2DCubismCore;

interface Window {
  Live2DCubismCore?: typeof Live2DCubismCore;
  Live2DCubismMotionSyncCore?: unknown;
}
