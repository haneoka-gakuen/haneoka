import type {
  AdvHarmonicMotionData,
  CubismLipSyncApplyContext,
  CubismLipSyncModelContext,
  CubismRuntimeAdapter,
} from "@haneoka/vega-plugin-cubism";

export interface HaneokaCubismRuntimeAdapterOptions {
  readonly id?: string;
  readonly runtime?: {
    readonly cubismCoreUrl?: string;
    readonly cubism2CoreUrl?: string;
    readonly motionSyncCoreUrl?: string;
  };
  readonly resourceCache?: {
    readonly imageEntryLimit?: number;
    readonly arrayBufferByteLimit?: number;
  };
}

export interface CubismModelViewerParameter {
  readonly id: string;
  readonly value: number;
  readonly defaultValue: number;
  readonly minimum: number;
  readonly maximum: number;
}

export interface CubismModelViewer {
  readonly ready: boolean;
  load(options: {
    readonly modelUrl: string;
    readonly harmonicMotion?: AdvHarmonicMotionData | null;
    readonly defaultMotionName?: string;
  }): Promise<void>;
  parameters(): CubismModelViewerParameter[];
  playMotion(name: string): boolean;
  playExpression(name: string): boolean;
  setSize(width: number, height: number): void;
  setPaused(paused: boolean): void;
  setBreathEnabled(enabled: boolean): void;
  setEyeBlinkEnabled(enabled: boolean): void;
  setLoopMotion(name: string | null): void;
  setParameterOverrides(values: Record<string, number>): void;
  setTransform(transform: { readonly scale?: number; readonly offsetX?: number; readonly offsetY?: number }): void;
  setLookPosition(position: { readonly x: number; readonly y: number } | null): void;
  setLookAtClientPosition(x: number, y: number, anchor?: { readonly x: number; readonly y: number } | null): void;
  destroy(): void;
}

export interface HaneokaCubismRuntimeProvision {
  readonly createCubismWebRuntimeAdapter: (options?: HaneokaCubismRuntimeAdapterOptions) => CubismRuntimeAdapter;
  readonly CubismModelViewer: {
    new (options: {
      readonly canvas: HTMLCanvasElement;
      readonly onFrame?: () => void;
      readonly onError?: (error: unknown) => void;
    }): CubismModelViewer;
  };
}

const CUBISM_RUNTIME_PROVISION_URL = "/cubism-runtime/vega-cubism-web-runtime.mjs";
let provisionPromise: Promise<HaneokaCubismRuntimeProvision> | undefined;

export const loadCubismRuntimeProvision = (): Promise<HaneokaCubismRuntimeProvision> => {
  provisionPromise ??= import(/* @vite-ignore */ CUBISM_RUNTIME_PROVISION_URL)
    .then((value) => value as HaneokaCubismRuntimeProvision)
    .catch((cause: unknown) => {
      provisionPromise = undefined;
      throw new Error(
        "Cubism runtime is not provisioned; run pnpm runtime:cubism:provision before using Cubism models",
        { cause },
      );
    });
  return provisionPromise;
};

export const createCubismWebRuntimeAdapter = (
  options: HaneokaCubismRuntimeAdapterOptions = {},
): CubismRuntimeAdapter => {
  let adapterPromise: Promise<CubismRuntimeAdapter> | undefined;
  let resolvedAdapter: CubismRuntimeAdapter | undefined;
  const adapter = async (): Promise<CubismRuntimeAdapter> => {
    adapterPromise ??= loadCubismRuntimeProvision().then((provision) => {
      resolvedAdapter = provision.createCubismWebRuntimeAdapter(options);
      return resolvedAdapter;
    });
    return adapterPromise;
  };
  return {
    id: options.id?.trim() || "haneoka.web-cubism-runtime",
    async prepare(version, signal) {
      await (await adapter()).prepare?.(version, signal);
    },
    async create(context) {
      return (await adapter()).create(context);
    },
    async createForRenderer(context) {
      const runtime = await adapter();
      if (!runtime.createForRenderer) {
        throw new Error(`Provisioned Cubism runtime does not support renderer ${context.renderer}`);
      }
      return runtime.createForRenderer(context);
    },
    async disposeRendererModel(model, context) {
      const runtime = await adapter();
      if (runtime.disposeRendererModel) {
        await runtime.disposeRendererModel(model, context);
        return;
      }
      const candidate = model as {
        dispose?: () => void | Promise<void>;
        destroy?: () => void | Promise<void>;
        release?: () => void | Promise<void>;
      };
      if (typeof candidate.dispose === "function") await candidate.dispose();
      else if (typeof candidate.destroy === "function") await candidate.destroy();
      else if (typeof candidate.release === "function") await candidate.release();
    },
    getMouthParameterProfile(context: CubismLipSyncModelContext) {
      return resolvedAdapter?.getMouthParameterProfile?.(context) ?? null;
    },
    applyLipSync(context: CubismLipSyncApplyContext) {
      const apply = resolvedAdapter?.applyLipSync;
      if (!apply) {
        throw new Error("Provisioned Cubism runtime has no lip-sync adapter");
      }
      apply(context);
    },
  };
};
