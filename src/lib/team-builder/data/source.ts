// L3 — GEB
// Input: 配队资料、条目归属及不可变资源身份。
// Output: 条目来源身份、固定谱面资源 URL 与响应身份校验。
// Pos: [Map](L2-2.md)；浏览器、WASM Worker 与保留 TS 求解共用的纯身份边界。
// Effects/Dependencies: 仅解析属性和 URL，不执行网络请求。
import type { TeamBuilderData } from "../data";

/** Assets keep the immutable release of the row selected during the union. */
export function teamBuilderSourceIdentity(data: TeamBuilderData, collection: string, id: number): TeamBuilderData["identity"] {
  const server = data.crossServer?.owners[collection]?.[String(id)];
  return (server && data.crossServer?.identities[server]) || data.identity;
}

/** The DTO observes current once; all of its chart requests keep that identity. */
export function pinnedSongAssetUrl(identity: TeamBuilderData["identity"], file: string): string {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(identity.server) ||
    !/^r-[a-f0-9]{20}$/u.test(identity.releaseId) ||
    !identity.sourceId
  )
    throw new Error("chart-release-identity-missing");
  if (!file.startsWith(`/assets/${identity.server}/`)) throw new Error("chart-asset-server-mismatch");
  const url = new URL(file, "https://release.invalid");
  if (!url.pathname.startsWith(`/assets/${identity.server}/`)) throw new Error("chart-asset-server-mismatch");
  url.searchParams.set("release", identity.releaseId);
  return url.pathname + url.search;
}

export function verifySongAssetIdentity(response: Response, identity: TeamBuilderData["identity"]): void {
  if (
    response.headers.get("x-haneoka-release-id") !== identity.releaseId ||
    !identity.sourceId ||
    response.headers.get("x-haneoka-source-id") !== identity.sourceId
  )
    throw new Error("chart-release-identity-mismatch");
}
