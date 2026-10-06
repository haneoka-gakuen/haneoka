import { teamBuilderDataResponse } from "../src/lib/team-builder/data/response";
import { readRuntimeRulesDocument, type RuntimeMasterReader } from "../src/lib/team-builder/data/runtime-rules";

export type TeamBuilderCatalogReader = (request: Request) => Promise<Response | null>;
export type TeamBuilderRuntimeMasterReader = RuntimeMasterReader;
export type TeamBuilderNativeRuleEvidenceReader = (identity: Parameters<RuntimeMasterReader>[0]) => Promise<unknown | null>;

/** Bump whenever data/response.ts changes the DTO, so edge copies built by older code are not served. */
const DTO_CACHE_VERSION = "1";
/** A release's DTO never changes; the edge keeps it a day so a cold colo rebuilds it at most daily. */
const EDGE_TTL_SECONDS = 86400;
const edgeCache = (): Cache | undefined => (typeof caches === "undefined" ? undefined : (caches as unknown as { default?: Cache }).default);
/** Public wrapper reuses the dispatcher's catalog handler, including its server/pin validation. */
export async function handleTeamBuilderData(
  request: Request,
  readCatalog: TeamBuilderCatalogReader,
  readRuntimeMaster?: TeamBuilderRuntimeMasterReader,
  readNativeRuleEvidence?: TeamBuilderNativeRuleEvidenceReader,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/api\/v1\/team-builder\/([^/]+)\/?$/u.exec(url.pathname);
  if (!match) return null;
  const error = (status: number, code: string) => Response.json({ error: { code } }, { status });
  if (!["GET", "HEAD"].includes(request.method)) return error(405, "method_not_allowed");
  let server: string;
  try {
    server = decodeURIComponent(match[1]!);
  } catch {
    return error(400, "invalid_server");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(server)) return error(400, "invalid_server");
  const releases = url.searchParams.getAll("release");
  if (releases.length > 1 || (releases[0] !== undefined && !/^r-[a-f0-9]{20}$/u.test(releases[0])))
    return error(400, "invalid_release");
  const prefix = `/api/v1/servers/${encodeURIComponent(server)}/`;
  const pinUrl = new URL(`${prefix}release`, url);
  pinUrl.searchParams.set("projection", "identity");
  if (releases[0]) pinUrl.searchParams.set("release", releases[0]);
  const pin = await readCatalog(new Request(pinUrl, { method: "HEAD", signal: request.signal }));
  if (!pin) return error(404, "resource_not_found");
  if (!pin.ok) return pin;
  const releaseId = pin.headers.get("x-haneoka-release-id") || "",
    sourceId = pin.headers.get("x-haneoka-source-id") || "";
  if (!/^r-[a-f0-9]{20}$/u.test(releaseId) || !sourceId || (releases[0] && releases[0] !== releaseId))
    return error(502, "release_identity_invalid");
  const read = async (path: string): Promise<unknown> => {
    const target = new URL(prefix + path, url);
    target.searchParams.set("release", releaseId);
    const response = await readCatalog(
      new Request(target, { signal: request.signal, headers: { accept: "application/json" } }),
    );
    if (!response?.ok) throw new Error(`team-data-catalog:${path}/${response?.status ?? 404}`);
    if (
      response.headers.get("x-haneoka-release-id") !== releaseId ||
      response.headers.get("x-haneoka-source-id") !== sourceId
    )
      throw new Error("team-data-release-mismatch");
    return response.json();
  };
  // Building the DTO reads every song and card entity of the release (seconds of
  // Worker time), but its content is fixed by (server, release, source): serve it
  // from the edge cache, and let a release-pinned URL live in the browser cache.
  const cacheKey = new Request(
    `https://team-builder.cache.invalid/v${DTO_CACHE_VERSION}/${encodeURIComponent(server)}/${releaseId}/${encodeURIComponent(sourceId)}`,
  );
  const clientCacheControl = releases[0] ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
  const toClient = (response: Response) => {
    const headers = new Headers(response.headers);
    headers.set("cache-control", clientCacheControl);
    headers.set("vary", "accept-encoding");
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
  };
  const cache = edgeCache();
  const hit = await cache?.match(cacheKey).catch(() => undefined);
  if (hit) return toClient(hit);
  try {
    const response = await teamBuilderDataResponse({
      identity: { server, releaseId, sourceId },
      readCollection: read,
      readEntity: (resource, id) => read(`${resource}/${encodeURIComponent(id)}`),
      ...(readRuntimeMaster
        ? { readRuntimeRules: () => readRuntimeRulesDocument({ server, releaseId, sourceId }, readRuntimeMaster) }
        : {}),
      ...(readNativeRuleEvidence
        ? { readNativeRuleEvidence: () => readNativeRuleEvidence({ server, releaseId, sourceId }) }
        : {}),
    });
    if (cache && response.ok) {
      const stored = new Response(response.clone().body, { status: response.status, headers: response.headers });
      stored.headers.set("cache-control", `public, max-age=${EDGE_TTL_SECONDS}`);
      const put = cache.put(cacheKey, stored).catch(() => undefined);
      if (waitUntil) waitUntil(put);
      else await put;
    }
    if (request.method === "HEAD") await response.body?.cancel();
    return toClient(response);
  } catch (errorValue) {
    if (request.signal.aborted) throw errorValue;
    return error(
      502,
      errorValue instanceof Error && errorValue.message === "team-data-release-mismatch"
        ? "release_identity_mismatch"
        : "team_data_unavailable",
    );
  }
}
