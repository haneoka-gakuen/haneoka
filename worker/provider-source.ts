// L3 — GEB
// Input: RequestInfo／URL、Fetch 选项与读取器实现。
// Output: ProviderSourceReader 类型及默认 fetch／edge-cache 适配。
// Pos: [Map](L2.md)；Worker 与静态构建共享的供应方传输边界。
// Effects/Dependencies: 调用 providerFetch 会联网，providerEdgeCache 依赖 Worker caches；接口本身不保证离线。
/** Provider projections share standard HTTP input across edge and static builds. */
export interface ProviderSourceReader {
  response(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  json(url: string, init?: RequestInit): Promise<unknown>;
  text(url: string, init?: RequestInit): Promise<string>;
}
export interface ProviderExecutionContext { waitUntil(task: Promise<unknown>): void }
export interface ProviderFetchInit extends RequestInit {
  cf?: { cacheTtl?: number; cacheEverything?: boolean };
}
/** Edge cache options are ignored by standard HTTP clients and retained on Workers. */
export const providerFetch = (input: RequestInfo | URL, init?: ProviderFetchInit): Promise<Response> => fetch(input, init);
export const providerEdgeCache = (): Cache => (caches as CacheStorage & { default: Cache }).default;
