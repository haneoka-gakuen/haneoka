export type EmbedFetcher = (request: Request) => Promise<Response>;
export type ResourceLocation = string | URL | Blob;

export interface LoadProgress {
  readonly loaded: number;
  /** Absent when the decoded response length is unknown. */
  readonly total?: number;
}

export interface DataContext {
  readonly server?: string;
  /** Author/consumer language, independent of the resource server. */
  readonly locale: string;
  readonly signal: AbortSignal;
  readonly fetcher: EmbedFetcher;
  readonly maxBytes: number;
  readonly progress: (value: LoadProgress) => void;
}

export type ResourceResolver = (
  key: string,
  context: DataContext,
) => ResourceLocation | undefined | Promise<ResourceLocation | undefined>;

export interface DataSource<T> {
  readonly assetsBase?: string;
  load(context: DataContext): T | Promise<T>;
  /** Called once when the owning loader is disposed. */
  dispose?(): void | Promise<void>;
}

/** A JSON document URL (relative to the host page) or a custom data source. */
export type DataSourceInput<T> = DataSource<T> | string | URL;

export type EmbedEvent =
  | { readonly type: "start" | "ready"; readonly operation: number; readonly key: string }
  | ({ readonly type: "progress"; readonly operation: number; readonly key: string } & LoadProgress)
  | { readonly type: "error" | "cancelled"; readonly operation: number; readonly key: string; readonly error: unknown }
  | { readonly type: "disposed" };

export interface EmbedLoaderOptions<T> {
  readonly source: DataSourceInput<T>;
  readonly server?: string;
  readonly locale?: string;
  /** Absolute directory URL; overrides the source's asset directory. */
  readonly assetsBase?: string;
  /** Resource keys in the document mapped to URLs or local files. */
  readonly resources?: Readonly<Record<string, ResourceLocation>>;
  readonly resolveResource?: ResourceResolver;
  readonly fetcher?: EmbedFetcher;
  readonly credentials?: RequestCredentials;
  readonly headers?: HeadersInit;
  /** Per document/resource decoded byte limit; defaults to 64 MiB. */
  readonly maxBytes?: number;
  readonly onListenerError?: (error: unknown) => void;
}

export interface EmbedLoader<T> {
  readonly locale: string;
  readonly server: string | undefined;
  readonly disposed: boolean;
  load(options?: { readonly signal?: AbortSignal }): Promise<T>;
  resourceUrl(key: string, options?: { readonly signal?: AbortSignal }): Promise<string>;
  resourceBytes(key: string, options?: { readonly signal?: AbortSignal }): Promise<Uint8Array>;
  resourceBlob(key: string, options?: { readonly signal?: AbortSignal }): Promise<Blob>;
  subscribe(listener: (event: EmbedEvent) => void): () => void;
  /** Cancel current operations while keeping the loader reusable. */
  cancel(): void;
  /** Abort operations, revoke owned Blob URLs, and dispose the data source. */
  dispose(): Promise<void>;
}
