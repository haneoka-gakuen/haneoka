import type { DataSourceInput, EmbedEvent, EmbedLoaderOptions } from "@haneoka/embed-core";
import type {
  HaneokaHomeSpotPngOptions,
  HaneokaHomeSpotRuntimeModules,
  HaneokaHomeSpotSceneDescriptor,
} from "@haneoka/vega-plugin-haneoka";

export type HomeSpotDocument = HaneokaHomeSpotSceneDescriptor;
export type HomeSpotInput =
  | { readonly document: HomeSpotDocument; readonly source?: never }
  | { readonly source: DataSourceInput<HomeSpotDocument>; readonly document?: never };

export type HomeSpotEvent =
  | { readonly type: "resource"; readonly event: EmbedEvent }
  | { readonly type: "loading" | "ready" | "cancelled"; readonly generation: number }
  | { readonly type: "error"; readonly generation: number; readonly error: unknown }
  | { readonly type: "selection"; readonly characterId: number }
  | { readonly type: "contextlost" | "contextrestored" | "disposed" };

export interface HomeSpotHostOptions extends Omit<EmbedLoaderOptions<HomeSpotDocument>, "source"> {
  readonly signal?: AbortSignal;
  /** Canvas accessible name in the author's language. */
  readonly ariaLabel?: string;
  /** CSS color; defaults to the host's MD3 surface token or background. */
  readonly clearColor?: string;
  /** Reserve this aspect ratio before network/renderer initialization. Defaults to 16/9. */
  readonly aspectRatio?: number;
  readonly selectedCharacterId?: number;
  /** Supply the same Three/Spine module constructors used by your application. */
  readonly modules?: HaneokaHomeSpotRuntimeModules;
  readonly onEvent?: (event: HomeSpotEvent) => void;
}
export type MountHomeSpotOptions = HomeSpotHostOptions & HomeSpotInput;
export interface HomeSpotUpdate {
  readonly selectedCharacterId?: number;
  readonly replay?: boolean;
}
export type HomeSpotExportOptions = HaneokaHomeSpotPngOptions;
export interface HomeSpotHandle {
  /** Latest load; available immediately, including during initial loading. */
  readonly ready: Promise<void>;
  readonly state: "loading" | "ready" | "cancelled" | "error" | "disposed";
  readonly element: HTMLElement;
  readonly canvas: HTMLElement | undefined;
  readonly document: HomeSpotDocument | undefined;
  update(options: HomeSpotUpdate): void;
  /** Replace one scene; cancels the previous generation and owns the new source. */
  load(input: HomeSpotInput): Promise<void>;
  replay(): void;
  resize(): void;
  exportPng(options?: HomeSpotExportOptions): Promise<Blob>;
  subscribe(listener: (event: HomeSpotEvent) => void): () => void;
  cancel(): void;
  dispose(): Promise<void>;
}
