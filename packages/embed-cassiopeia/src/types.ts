import type { ChartDocument, ChartMode, SessionSnapshot } from "@haneoka/cassiopeia";
import type { CassiopeiaSessionPort } from "@haneoka/cassiopeia/plugin";
import type { NativeChartPresentation } from "@haneoka/cassiopeia-renderer-three";
import type { EmbedEvent, EmbedLoader, EmbedLoaderOptions } from "@haneoka/embed-core";
import type {
  OurNotesAssetManifest,
  OurNotesNoteSkin,
  OurNotesNoteEffectSkin,
  OurNotesNoteSeGroup,
  RenderSettings,
  NativeChartVisualProfiles,
} from "@haneoka/cassiopeia-plugin-our-notes";

export interface ChartEmbedDocument {
  readonly chart: ChartDocument;
  /** Resource key, absolute URL, or local key resolved by embed-core. */
  readonly audio?: string;
  readonly background?: string;
  readonly bgmOffsetMs?: number;
  readonly assets?: OurNotesAssetManifest;
  /** Native visual-only profiles paired with this chart's numeric note/line IDs. */
  readonly visualProfiles?: NativeChartVisualProfiles;
}
export interface ChartSkin {
  readonly noteSkin?: OurNotesNoteSkin;
  readonly noteEffectSkin?: OurNotesNoteEffectSkin;
  readonly noteSeGroup?: OurNotesNoteSeGroup;
  readonly currentQuality?: 0 | 1 | 2;
}
export interface ChartPlaybackOptions {
  readonly mode?: ChartMode;
  readonly settings?: Partial<RenderSettings> & { judgementOffsetMs?: number };
  readonly volume?: number;
  readonly rate?: number;
  readonly loop?: boolean;
  readonly noteSoundEnabled?: boolean;
  readonly noteSoundVolume?: number;
}
export interface ChartUpdateOptions {
  readonly bgmOffsetMs?: number;
  /** Replaces the whole profile set; omitted clears profiles for the new chart epoch. */
  readonly visualProfiles?: NativeChartVisualProfiles;
}
export interface ChartThemeContext {
  readonly loader: EmbedLoader<ChartEmbedDocument>;
  readonly signal: AbortSignal;
  readonly skin: ChartSkin;
}
export type ChartTheme = (context: ChartThemeContext) => OurNotesAssetManifest | Promise<OurNotesAssetManifest>;

/** Own artwork can use a renderer without loading the Our Notes plugin, Three, or Vue. */
export interface ChartRendererAdapter {
  create(context: {
    readonly element: HTMLElement;
    readonly chart: ChartDocument;
    readonly loader: EmbedLoader<ChartEmbedDocument>;
    readonly signal: AbortSignal;
  }): ChartRenderer | Promise<ChartRenderer>;
}
export interface ChartRenderer {
  /** Snapshot is reused by the session; consume it during this call. */
  render(snapshot: SessionSnapshot, options: ChartPlaybackOptions): void;
  resize(width: number, height: number, pixelRatio: number): void;
  /** Optional play-mode hit mapping in continuous native lanes 0..23; outside = -1. */
  laneAtClientPoint?(x: number, y: number): number;
  dispose(): void;
}
export type ChartEmbedPhase = "loading" | "ready" | "cancelled" | "error" | "disposed";
export interface ChartEmbedSnapshot {
  readonly phase: ChartEmbedPhase;
  readonly playing: boolean;
  /** Presentation/media seconds; chart time subtracts bgmOffsetMs. */
  readonly time: number;
  readonly duration: number;
}
export type ChartEmbedEvent =
  | { readonly type: "load"; readonly event: EmbedEvent }
  | { readonly type: "state"; readonly snapshot: ChartEmbedSnapshot }
  | { readonly type: "player"; readonly name: string; readonly args: readonly unknown[] }
  | { readonly type: "error"; readonly error: unknown };
export type MountChartOptions = Omit<EmbedLoaderOptions<ChartEmbedDocument>, "source"> &
  ChartPlaybackOptions & {
    readonly source?: EmbedLoaderOptions<ChartEmbedDocument>["source"];
    readonly document?: ChartEmbedDocument;
    readonly theme?: ChartTheme;
    readonly skin?: ChartSkin;
    readonly rendererAdapter?: ChartRendererAdapter;
    /** Custom kernel rules can accompany an authored renderer. */
    readonly createSession?: (chart: ChartDocument, options: ChartPlaybackOptions) => CassiopeiaSessionPort;
    readonly signal?: AbortSignal;
    readonly loadTimeoutMs?: number;
    readonly labels?: { readonly player?: string; readonly pause?: string; readonly loading?: string };
    readonly onEvent?: (event: ChartEmbedEvent) => void;
  };
export interface ChartEmbedHandle {
  readonly ready: Promise<void>;
  readonly snapshot: ChartEmbedSnapshot;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setOptions(options: ChartPlaybackOptions): Promise<void>;
  /** Actual native renderer projection/picking; absent while loading/updating or after disposal. */
  getPresentation?(): NativeChartPresentation | undefined;
  /** Native-only chart replacement on the same renderer, paused at the clamped media position. */
  setChart?(chart: ChartDocument, options?: ChartUpdateOptions): Promise<void>;
  /** Rebuilds the default theme/player paused at the current media position. */
  setSkin(skin: ChartSkin): Promise<void>;
  subscribe(listener: (event: ChartEmbedEvent) => void): () => void;
  cancel(): void;
  dispose(): Promise<void>;
}
