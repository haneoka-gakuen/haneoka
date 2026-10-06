import { adaptTeamBuilderData, objectRow, type TeamBuilderData } from "../data";
import { hydrateRuntimeDocuments } from "./complete";
import { withNativeRuleEvidence } from "./native-rule-evidence";

export interface CurrentTeamBuilderIdentity {
  server: string;
  releaseId: string;
  sourceId: string;
}
const validServer = (server: string) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(server)) throw new TypeError("Invalid resource server");
};
function responseIdentity(response: Response, server: string): CurrentTeamBuilderIdentity {
  const releaseId = response.headers.get("x-haneoka-release-id") || "";
  const sourceId = response.headers.get("x-haneoka-source-id") || "";
  if (!/^r-[a-f0-9]{20}$/u.test(releaseId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sourceId))
    throw new Error("Invalid team data release identity");
  return { server, releaseId, sourceId };
}

/** Observe current on each check; this never pins a build-time seed or a retained reference. */
export async function fetchCurrentTeamBuilderIdentity(
  server: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<CurrentTeamBuilderIdentity> {
  validServer(server);
  signal?.throwIfAborted();
  const response = await fetcher(`/api/v1/servers/${encodeURIComponent(server)}/release?projection=identity`, {
    method: "HEAD", cache: "no-store", signal,
  });
  if (!response.ok) throw new Error(`Team data release unavailable: ${response.status}`);
  const identity = responseIdentity(response, server);
  signal?.throwIfAborted();
  return identity;
}

/** Public catalog projections only; every request uses the one observed release. */
export async function fetchTeamBuilderData(
  server: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TeamBuilderData> {
  validServer(server);
  const prefix = `/api/v1/servers/${encodeURIComponent(server)}/`;
  signal?.throwIfAborted();
  // The DTO of a release never changes: ask which release is current, then
  // fetch the release-pinned URL, which the Worker marks immutable, so a repeat
  // visit is served from the browser cache.
  const current = await fetchCurrentTeamBuilderIdentity(server, signal, fetcher).catch(() => null);
  const compact = await fetcher(
    `/api/v1/team-builder/${encodeURIComponent(server)}${current ? `?release=${encodeURIComponent(current.releaseId)}` : ""}`,
    current ? { signal } : { cache: "no-store", signal },
  );
  if (compact.ok) {
    const identity = responseIdentity(compact, server);
    const data = (await compact.json()) as TeamBuilderData;
    if (
      data.schema !== "haneoka-team-builder-data-v1" ||
      data.identity?.server !== server ||
      data.identity.releaseId !== identity.releaseId ||
      data.identity.sourceId !== identity.sourceId
    )
      throw new Error("Team data DTO identity mismatch");
    data.identity = withNativeRuleEvidence(data.identity);
    signal?.throwIfAborted();
    return data;
  }
  if (compact.status !== 404) throw new Error(`Team data DTO unavailable: ${compact.status}`);
  const { releaseId, sourceId } = await fetchCurrentTeamBuilderIdentity(server, signal, fetcher);
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
  for (let start = 0; start < resources.length; start += 4) {
    signal?.throwIfAborted();
    const values = await Promise.all(
      resources.slice(start, start + 4).map(async (resource) => {
        const response = await fetcher(`${prefix}${resource}?release=${encodeURIComponent(releaseId)}`, {
          signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Team data collection unavailable: ${resource}/${response.status}`);
        if (
          response.headers.get("x-haneoka-release-id") !== releaseId ||
          response.headers.get("x-haneoka-source-id") !== sourceId
        )
          throw new Error("Team data release mismatch");
        const document: unknown = await response.json();
        signal?.throwIfAborted();
        return [resource, document] as const;
      }),
    );
    for (const [resource, document] of values) documents[resource] = document;
  }
  const events = { ...objectRow(documents.events) },
    ids = Object.keys(objectRow(objectRow(documents.events).entries));
  const entries = { ...objectRow(events.entries) };
  for (let start = 0; start < ids.length; start += 4) {
    const details = await Promise.all(
      ids.slice(start, start + 4).map(async (id) => {
        const response = await fetcher(
          `${prefix}events/${encodeURIComponent(id)}?release=${encodeURIComponent(releaseId)}`,
          { signal, cache: "no-store" },
        );
        if (!response.ok) throw new Error(`Team event detail unavailable:${id}/${response.status}`);
        if (
          response.headers.get("x-haneoka-release-id") !== releaseId ||
          response.headers.get("x-haneoka-source-id") !== sourceId
        )
          throw new Error("Team event detail release mismatch");
        const detail = await response.json();
        signal?.throwIfAborted();
        return [id, { ...objectRow(entries[id]), ...objectRow(detail) }] as const;
      }),
    );
    for (const [id, detail] of details) entries[id] = detail;
  }
  documents.events = { ...events, entries };
  const complete = await hydrateRuntimeDocuments(
    documents,
    async (resource, id) => {
      const response = await fetcher(
        `${prefix}${resource}/${encodeURIComponent(id)}?release=${encodeURIComponent(releaseId)}`,
        { signal, cache: "no-store" },
      );
      if (!response.ok) throw new Error(`Runtime entity unavailable:${resource}/${id}/${response.status}`);
      if (
        response.headers.get("x-haneoka-release-id") !== releaseId ||
        response.headers.get("x-haneoka-source-id") !== sourceId
      )
        throw new Error("Runtime entity release mismatch");
      return response.json();
    },
    signal,
  );
  return adaptTeamBuilderData({ server, releaseId, sourceId }, complete);
}
