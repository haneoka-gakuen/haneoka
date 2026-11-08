// L3 — GEB
// Input: The collector host's one-time requests during the move off Durable Objects.
// Output: The collector secrets and each regional object's frozen state.
// Pos: [Map](L2.md); temporary handover from the Durable Object collector to the collector host.
// Effects/Dependencies: Freezes the regional Durable Objects; returns secrets only to the host's bearer token.
import { authorizedHost } from "./official-host";

const SECRETS = ["OFFICIAL_RANKING_ENABLED_REGIONS", "OFFICIAL_RANKING_READ_REGIONS", "OFFICIAL_RANKING_JP_CONFIG", "OFFICIAL_RANKING_TW_CONFIG",
  "OFFICIAL_RANKING_EN_CONFIG", "OFFICIAL_RANKING_KR_CONFIG", "OFFICIAL_GLOBAL_LOGIN_CONFIG", "OFFICIAL_JP_GUEST_CONFIG", "OFFICIAL_ACCOUNT_ENCRYPTION_KEY"] as const;

export async function handleOfficialHostMigration(request: Request, env: Env, path: string): Promise<Response> {
  if (!authorizedHost(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (path === "migration/bootstrap" && request.method === "POST") {
    const values = env as unknown as Record<string, string | undefined>;
    return Response.json(Object.fromEntries(SECRETS.filter((name) => values[name]).map((name) => [name, values[name]])), { headers: { "Cache-Control": "no-store" } });
  }
  const exported = /^migration\/export\/(jp|tw|en|kr)$/u.exec(path);
  if (exported && request.method === "POST") {
    return Response.json(await env.OFFICIAL_RANKING_COLLECTOR.getByName(exported[1]!).exportForHost(), { headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}
