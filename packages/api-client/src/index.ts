export type ApiQueryPrimitive = string | number | boolean | null | undefined;
export type ApiQuery = Readonly<Record<string, ApiQueryPrimitive | readonly ApiQueryPrimitive[]>>;
export type ApiTransport = (request: Request) => Promise<Response>;

export interface ApiErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly details?: unknown;
  };
  readonly code?: unknown;
  readonly message?: unknown;
}

export interface ApiRequestOptions<T> {
  readonly body?: BodyInit | null;
  readonly decode?: (value: unknown) => T;
  readonly headers?: HeadersInit;
  readonly method?: "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT";
  readonly query?: ApiQuery;
  readonly signal?: AbortSignal;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly headers?: HeadersInit;
  readonly transport?: ApiTransport;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly method: string;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly status: number;
  readonly url: string;

  constructor(options: {
    readonly cause?: unknown;
    readonly code: string;
    readonly details?: unknown;
    readonly message: string;
    readonly method: string;
    readonly requestId?: string;
    readonly retryable?: boolean;
    readonly status?: number;
    readonly url: string;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiClientError";
    this.code = options.code;
    this.details = options.details;
    this.method = options.method;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? 0;
    this.url = options.url;
  }
}

const retryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

const normalizedBase = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError("api baseUrl must not be empty");
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

const appendQuery = (url: URL, query: ApiQuery | undefined): void => {
  if (!query) return;
  const entries = Object.entries(query).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, raw] of entries) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
    }
  }
};

const errorPayload = (value: unknown): { code?: string; details?: unknown; message?: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const body = value as ApiErrorBody;
  const nested = body.error && typeof body.error === "object" ? body.error : undefined;
  const rawCode = nested?.code ?? body.code;
  const rawMessage = nested?.message ?? body.message;
  return {
    ...(typeof rawCode === "string" && rawCode ? { code: rawCode } : {}),
    ...(nested?.details !== undefined ? { details: nested.details } : {}),
    ...(typeof rawMessage === "string" && rawMessage ? { message: rawMessage } : {}),
  };
};

const readJson = async (response: Response, method: string, url: string): Promise<unknown> => {
  if (response.status === 204 || response.status === 205 || method === "HEAD") return undefined;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    throw new ApiClientError({
      code: "invalid_content_type",
      message: `Expected JSON but received ${contentType || "an unknown content type"}`,
      method,
      status: response.status,
      url,
    });
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new ApiClientError({
      cause,
      code: "invalid_json",
      message: "The server returned malformed JSON",
      method,
      status: response.status,
      url,
    });
  }
};

export interface ApiClient {
  get<T>(path: string, options?: Omit<ApiRequestOptions<T>, "method">): Promise<T>;
  request<T>(path: string, options?: ApiRequestOptions<T>): Promise<T>;
  response(path: string, options?: Omit<ApiRequestOptions<never>, "decode">): Promise<Response>;
  url(path: string, query?: ApiQuery): string;
}

export const createApiClient = (options: ApiClientOptions): ApiClient => {
  const baseUrl = normalizedBase(options.baseUrl);
  const transport = options.transport ?? fetch;

  const url = (path: string, query?: ApiQuery): string => {
    const absolute = /^https?:\/\//i.test(path) ? new URL(path) : new URL(path.replace(/^\/+/, ""), baseUrl);
    appendQuery(absolute, query);
    return absolute.toString();
  };

  const response = async (
    path: string,
    requestOptions: Omit<ApiRequestOptions<never>, "decode"> = {},
  ): Promise<Response> => {
    const method = requestOptions.method ?? "GET";
    const requestUrl = url(path, requestOptions.query);
    const headers = new Headers(options.headers);
    new Headers(requestOptions.headers).forEach((value, key) => headers.set(key, value));
    try {
      return await transport(
        new Request(requestUrl, {
          method,
          headers,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
          ...(requestOptions.body !== undefined ? { body: requestOptions.body } : {}),
        }),
      );
    } catch (cause) {
      if (cause instanceof ApiClientError) throw cause;
      throw new ApiClientError({
        cause,
        code: "network_error",
        message: "The server could not be reached",
        method,
        retryable: true,
        url: requestUrl,
      });
    }
  };

  const request = async <T>(path: string, requestOptions: ApiRequestOptions<T> = {}): Promise<T> => {
    const method = requestOptions.method ?? "GET";
    const requestUrl = url(path, requestOptions.query);
    const result = await response(path, requestOptions);
    const value = await readJson(result, method, requestUrl);
    if (!result.ok) {
      const payload = errorPayload(value);
      throw new ApiClientError({
        code: payload.code ?? `http_${result.status}`,
        details: payload.details,
        message: payload.message ?? `Request failed with HTTP ${result.status}`,
        method,
        ...(result.headers.get("x-request-id") ? { requestId: result.headers.get("x-request-id")! } : {}),
        retryable: retryableStatus(result.status),
        status: result.status,
        url: requestUrl,
      });
    }
    try {
      return requestOptions.decode ? requestOptions.decode(value) : (value as T);
    } catch (cause) {
      if (cause instanceof ApiClientError) throw cause;
      throw new ApiClientError({
        cause,
        code: "invalid_payload",
        message: "The response did not match the expected schema",
        method,
        status: result.status,
        url: requestUrl,
      });
    }
  };

  return {
    get: <T>(path: string, requestOptions?: Omit<ApiRequestOptions<T>, "method">) =>
      request<T>(path, { ...requestOptions, method: "GET" }),
    request,
    response,
    url,
  };
};
