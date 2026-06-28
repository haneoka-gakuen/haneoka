export const BESTDORI_SERVERS = ["jp", "en", "tw", "cn", "kr"] as const;

export type BestdoriServer = (typeof BESTDORI_SERVERS)[number];
export type BestdoriResponseType = "json" | "text" | "bytes";

export const isBestdoriServer = (value: unknown): value is BestdoriServer =>
  typeof value === "string" && (BESTDORI_SERVERS as readonly string[]).includes(value);

export interface BestdoriTransportRequest {
  /** Asset/API path relative to the transport's configured Bestdori origin. */
  path: string;
  responseType: BestdoriResponseType;
  server?: BestdoriServer;
  headers?: Readonly<Record<string, string>>;
}

export interface BestdoriTransportResponse<T> {
  data: T;
  status: number;
  server?: BestdoriServer;
  url?: string;
  headers?: Readonly<Record<string, string>>;
}

/** Implemented by the host: fetch/cache/retry policy never leaks into converters. */
export interface BestdoriTransport {
  request<T = unknown>(request: Readonly<BestdoriTransportRequest>): Promise<BestdoriTransportResponse<T>>;
}

export interface BestdoriTransportErrorOptions {
  status?: number;
  server?: BestdoriServer;
  retryable?: boolean;
  cause?: unknown;
}

export class BestdoriTransportError extends Error {
  readonly status?: number;
  readonly server?: BestdoriServer;
  readonly retryable: boolean;

  constructor(message: string, options: BestdoriTransportErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BestdoriTransportError";
    if (options.status !== undefined) this.status = options.status;
    if (options.server !== undefined) this.server = options.server;
    this.retryable = options.retryable ?? false;
  }
}
