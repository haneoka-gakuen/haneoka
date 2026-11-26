import type {
  DataSource,
  DataSourceInput,
  EmbedEvent,
  EmbedLoaderOptions,
  ResourceLocation,
} from "@haneoka/embed-core";
import type { AdvStory, VegaPlayerHandle, VegaPlayerShellOptions } from "@haneoka/vega/web";
import type { VegaPlugin } from "@haneoka/vega/plugin";
import type { ThreeRendererPluginOptions } from "@haneoka/vega-renderer-three";
import type { CubismEmbedOptions } from "./haneoka.js";

type CharacterModel = NonNullable<AdvStory["characterModels"]>[string];

export type StoryEmbedPhase = "loading" | "ready" | "cancelled" | "error" | "disposed";
export interface StoryEmbedSnapshot {
  readonly phase: StoryEmbedPhase;
  readonly playing: boolean;
  readonly paused: boolean;
  readonly finished: boolean;
  readonly seeking: boolean;
  readonly commandIndex: number;
  readonly commandCount: number;
  readonly progress: number;
}
export type StoryEmbedEvent =
  | { readonly type: "load"; readonly event: EmbedEvent }
  | { readonly type: "state"; readonly snapshot: StoryEmbedSnapshot }
  | { readonly type: "seek"; readonly commandIndex: number }
  | { readonly type: "error"; readonly error: unknown };

type StoryInput =
  | { readonly document: AdvStory; readonly source?: never }
  | { readonly source: DataSourceInput<AdvStory>; readonly document?: never };
export type MountStoryOptions = StoryInput &
  Omit<EmbedLoaderOptions<AdvStory>, "source"> & {
    /** Existing portable UI by default; Haneoka requires plugins from the ./theme entry. */
    readonly theme?: "portable" | "haneoka";
    /** Attribution always remains visible in a reserved corner outside the scene. */
    readonly brandingCorner?: "top-left" | "top-right";
    readonly shell?: false | VegaPlayerShellOptions;
    /** Additional model/command providers use Vega's existing plugin contract. */
    readonly plugins?: readonly VegaPlugin[];
    /** Existing sound/cue IDs mapped to playable source URLs or local audio files. */
    readonly sounds?: Readonly<Record<string, ResourceLocation>>;
    /** Character references mapped to Cubism 3 JSON/ZIP URLs or portable descriptors. */
    readonly models?: Readonly<Record<string, string | URL | CharacterModel>>;
    readonly cubism?: CubismEmbedOptions;
    readonly runtimeManifestUrl?: string | URL;
    readonly renderer?: ThreeRendererPluginOptions;
    /** Total deadline per resource adapter load; defaults to 30 seconds. */
    readonly resourceTimeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly onEvent?: (event: StoryEmbedEvent) => void;
    readonly resolveLocalizedText?: VegaPlayerHandle["player"]["resolveLocalizedText"];
  };
export interface StoryEmbedHandle {
  /** Resolves after renderer, resources, fonts and seek index boot. */
  readonly ready: Promise<void>;
  readonly snapshot: StoryEmbedSnapshot;
  readonly player: VegaPlayerHandle | undefined;
  /** Start/resume the interpreter; completion arrives through state events. */
  play(): void;
  pause(): void;
  next(): void;
  /** Ratio 0..1 on Vega's reachable path. Preserves pause/play intent. */
  seek(ratio: number): Promise<number>;
  subscribe(listener: (event: StoryEmbedEvent) => void): () => void;
  /** Cancels boot and releases the partial player; recreate to retry. */
  cancel(): void;
  /** Idempotent; await before mounting again in the same container. */
  dispose(): Promise<void>;
}
export type { AdvStory, DataSource };
