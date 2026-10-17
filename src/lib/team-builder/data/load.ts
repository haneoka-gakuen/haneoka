// L3 — GEB
// Input: server 与可选取消信号。
// Output: 构建期组装的 TeamBuilderData。
// Pos: [Map](L2-2.md)；静态资料源到配队页面资料的加载入口。
// Effects/Dependencies: 静态目录调用可能读本地文件或 HTTP；不是浏览器直接下载 Master 的入口。
import { fetchStaticCatalog, fetchStaticCatalogBatch, staticCatalogRelease } from "../../static-catalog-source";
import type { ReleaseServer } from "../../release-server";
import { adaptTeamBuilderData, objectRow, type TeamBuilderData } from "../data";
import { hydrateRuntimeDocuments } from "./complete";

/** Build-time only. Browser UI receives the compact page payload rather than Master. */
export async function loadTeamBuilderData(server: ReleaseServer, signal?: AbortSignal): Promise<TeamBuilderData> {
  signal?.throwIfAborted();
  const identity = await staticCatalogRelease(server);
  const resources = [
    "cards",
    "support-cards",
    "characters",
    "bands",
    "band-items",
    "songs",
    "events",
    "progression",
    "leader-skills",
    "skills",
    "gekisou-skills",
    "support-skills",
    "gekisou-support-skills",
    "skill-reference",
    "live-tools",
    "gekisou",
  ];
  const documents: Record<string, unknown> = {};
  // Bounded request batches; every response is verified against the one pin.
  for (let start = 0; start < resources.length; start += 4) {
    signal?.throwIfAborted();
    const values = await Promise.all(
      resources
        .slice(start, start + 4)
        .map(async (resource) => [resource, await fetchStaticCatalog(resource, server, identity)] as const),
    );
    signal?.throwIfAborted();
    for (const [resource, value] of values) documents[resource] = value;
  }
  const events = { ...objectRow(documents.events) };
  const ids = Object.keys(objectRow(events.entries));
  if (ids.length) {
    const details = await fetchStaticCatalogBatch("events", ids, server, identity);
    events.entries = Object.fromEntries(
      ids.map((id) => [id, { ...objectRow(objectRow(events.entries)[id]), ...details.get(id) }]),
    );
  }
  documents.events = events;
  signal?.throwIfAborted();
  const complete = await hydrateRuntimeDocuments(
    documents,
    async (resource, id) => {
      const batch = await fetchStaticCatalogBatch(resource, [id], server, identity);
      return batch.get(id);
    },
    signal,
  );
  return adaptTeamBuilderData(identity, complete);
}
