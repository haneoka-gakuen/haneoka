import { adaptTeamBuilderData, objectRow, type TeamBuilderData } from "../data";
import { hydrateRuntimeDocuments } from "./complete";
import { withNativeRuleEvidence } from "./native-rule-evidence";

export interface TeamDataCatalog {
  identity: TeamBuilderData["identity"] & { sourceId: string };
  readCollection(resource: string): unknown | Promise<unknown>;
  readEntity?(resource: string, id: string): unknown | Promise<unknown>;
  readRuntimeRules?(): unknown | Promise<unknown>;
  readNativeRuleEvidence?(): unknown | null | Promise<unknown | null>;
}
/** The dispatcher supplies its already pinned catalog; no new R2/auth implementation. */
export async function teamBuilderDataResponse(catalog: TeamDataCatalog): Promise<Response> {
  const observed = catalog.readNativeRuleEvidence ? await catalog.readNativeRuleEvidence() : undefined;
  const identity = withNativeRuleEvidence(catalog.identity, observed ?? catalog.identity.nativeRuleEvidence);
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
    "options",
    "gekisou",
  ];
  const documents: Record<string, unknown> = {};
  for (let start = 0; start < resources.length; start += 4) {
    const values = await Promise.all(
      resources
        .slice(start, start + 4)
        .map(async (resource) => [resource, await catalog.readCollection(resource)] as const),
    );
    for (const [resource, value] of values) documents[resource] = value;
  }
  const events = { ...objectRow(documents.events) };
  const ids = Object.keys(objectRow(events.entries));
  if (ids.length && catalog.readEntity) {
    const details: Record<string, unknown> = {};
    for (let start = 0; start < ids.length; start += 4) {
      const values = await Promise.all(
        ids.slice(start, start + 4).map(async (id) => [id, await catalog.readEntity!("events", id)] as const),
      );
      for (const [id, value] of values) {
        if (!value) throw new Error(`Team event detail missing:${id}`);
        details[id] = value;
      }
    }
    events.entries = Object.fromEntries(
      ids.map((id) => [id, { ...objectRow(objectRow(events.entries)[id]), ...objectRow(details[id]) }]),
    );
  }
  documents.events = events;
  if (catalog.readRuntimeRules) documents["runtime-rules"] = await catalog.readRuntimeRules();
  const complete = catalog.readEntity
    ? await hydrateRuntimeDocuments(documents, async (resource, id) => catalog.readEntity!(resource, id))
    : documents;
  const data = adaptTeamBuilderData(identity, complete);
  return Response.json(data, {
    headers: {
      "x-haneoka-release-id": catalog.identity.releaseId,
      ...(catalog.identity.sourceId ? { "x-haneoka-source-id": catalog.identity.sourceId } : {}),
      "x-content-type-options": "nosniff",
    },
  });
}
