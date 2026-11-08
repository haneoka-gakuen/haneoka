// L3 — GEB
// Input: R2 calls from the collector code for official payloads and card images.
// Output: The same calls made through the Worker's authenticated object endpoint.
// Pos: [Map](../../L2.md); the collector host's object storage.
// Effects/Dependencies: HTTPS to the site's internal endpoint; the Worker owns the bucket binding.

interface HttpMetadata { contentType?: string; contentEncoding?: string; cacheControl?: string }
interface ObjectMeta { key: string; size: number; etag: string; uploaded: string; httpMetadata?: HttpMetadata; customMetadata?: Record<string, string> }

class RemoteObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata: HttpMetadata;
  readonly customMetadata: Record<string, string>;
  constructor(meta: ObjectMeta) {
    this.key = meta.key;
    this.size = meta.size;
    this.etag = meta.etag;
    this.httpEtag = `"${meta.etag}"`;
    this.uploaded = new Date(meta.uploaded);
    this.httpMetadata = meta.httpMetadata ?? {};
    this.customMetadata = meta.customMetadata ?? {};
  }
}

class RemoteObjectBody extends RemoteObject {
  constructor(meta: ObjectMeta, private readonly bytes: ArrayBuffer) { super(meta); }
  get body(): ReadableStream<Uint8Array> { return new Blob([this.bytes]).stream(); }
  get bodyUsed(): boolean { return false; }
  async arrayBuffer(): Promise<ArrayBuffer> { return this.bytes; }
  async text(): Promise<string> { return new TextDecoder().decode(this.bytes); }
  async json<T>(): Promise<T> { return JSON.parse(await this.text()) as T; }
  async blob(): Promise<Blob> { return new Blob([this.bytes]); }
}

export class RemoteBucket {
  constructor(private readonly origin: string, private readonly token: string) {}

  private async call(operation: string, init: { query?: Record<string, string>; headers?: Record<string, string>; body?: BodyInit | null; method?: string } = {}) {
    const url = new URL(`/api/internal/official-host/r2/${operation}`, this.origin);
    for (const [name, item] of Object.entries(init.query ?? {})) url.searchParams.set(name, item);
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(url, {
          method: init.method ?? "POST",
          headers: { Authorization: `Bearer ${this.token}`, ...init.headers },
          body: init.body ?? null,
          signal: AbortSignal.timeout(60_000),
        });
        if (response.status >= 500 && attempt < 3) throw new Error(`r2_${response.status}`);
        return response;
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }

  private static meta(response: Response): ObjectMeta | null {
    const header = response.headers.get("X-Object-Meta");
    return header ? JSON.parse(decodeURIComponent(header)) as ObjectMeta : null;
  }

  async head(key: string): Promise<RemoteObject | null> {
    const response = await this.call("head", { query: { key } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`r2_head_${response.status}`);
    return new RemoteObject(await response.json() as ObjectMeta);
  }

  async get(key: string): Promise<RemoteObjectBody | null> {
    const response = await this.call("get", { query: { key }, method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`r2_get_${response.status}`);
    const meta = RemoteBucket.meta(response);
    if (!meta) throw new Error("r2_get_meta");
    return new RemoteObjectBody(meta, await response.arrayBuffer());
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string | Blob | ReadableStream | null,
    options: { httpMetadata?: HttpMetadata; customMetadata?: Record<string, string>; onlyIf?: { etagMatches?: string } } = {}): Promise<RemoteObject | null> {
    const body = value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value;
    const response = await this.call("put", {
      query: { key },
      method: "PUT",
      headers: { "X-Put-Options": encodeURIComponent(JSON.stringify({ httpMetadata: options.httpMetadata, customMetadata: options.customMetadata, etagMatches: options.onlyIf?.etagMatches })) },
      body: body as BodyInit,
    });
    if (response.status === 412) return null;
    if (!response.ok) throw new Error(`r2_put_${response.status}`);
    return new RemoteObject(await response.json() as ObjectMeta);
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (let offset = 0; offset < list.length; offset += 1000) {
      const response = await this.call("delete", { body: JSON.stringify({ keys: list.slice(offset, offset + 1000) }), headers: { "Content-Type": "application/json" } });
      if (!response.ok) throw new Error(`r2_delete_${response.status}`);
    }
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string; include?: string[] } = {}) {
    const response = await this.call("list", { body: JSON.stringify(options), headers: { "Content-Type": "application/json" } });
    if (!response.ok) throw new Error(`r2_list_${response.status}`);
    const page = await response.json() as { objects: ObjectMeta[]; truncated: boolean; cursor?: string; delimitedPrefixes: string[] };
    return { ...page, objects: page.objects.map((meta) => new RemoteObject(meta)) };
  }
}
