import type { EntityComment, EntityDescriptor } from "./entity-comments";

type RecordValue = Record<string, unknown>;
export interface EntityCommentRecommendation extends RecordValue {
  kind: "entity-comment";
  id: string;
  comment: EntityComment;
  entityRef: EntityDescriptor;
  focusedCommentId: string;
  rootId: string;
  deepLink: string;
  adminOnlyContext?: boolean;
}
export function isEntityCommentRecommendation(value: RecordValue): value is EntityCommentRecommendation {
  return value.kind === "entity-comment" && !!value.comment && typeof value.comment === "object" && !!value.entityRef && typeof value.entityRef === "object";
}
/** Preserve the service's one ranking/cursor stream; ordinary post DTOs remain ordinary posts. */
export function communityRecommendationItems(data: RecordValue): RecordValue[] {
  if (Array.isArray(data.entries)) return data.entries.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const entry = value as RecordValue;
    if (entry.kind === "post" && entry.post && typeof entry.post === "object") return [entry.post as RecordValue];
    return isEntityCommentRecommendation(entry) ? [entry] : [];
  });
  return Array.isArray(data.posts) ? data.posts as RecordValue[] : [];
}
/** A peer is used only for explicit absence; an unknown current server is not an absent object. */
export function entityCommentRecommendationHref(entry: EntityCommentRecommendation, server: string, returnTo = "", reply = false): string {
  const descriptor = entry.entityRef;
  const present = (candidate: string) => descriptor.availability?.[candidate] === "present" && typeof descriptor.detailPaths?.[candidate] === "string";
  const chosen = present(server) ? server : descriptor.availability?.[server] === "absent"
    ? ["jp", "intl"].find((candidate) => candidate !== server && present(candidate)) : undefined;
  if (!chosen) return "";
  const path = descriptor.detailPaths[chosen];
  if (!path || !path.startsWith("/") || path.startsWith("//")) return "";
  const url = new URL(path, "https://community.invalid");
  if (url.origin !== "https://community.invalid") return "";
  const commentId = entry.focusedCommentId || String(entry.comment.id || "");
  url.searchParams.set("commentId", commentId);
  if (reply) url.searchParams.set("replyTo", String(entry.comment.id));
  if (returnTo) url.searchParams.set("return", returnTo);
  if (descriptor.type === "stories") url.searchParams.set("playback", "text");
  url.hash = "entity-comments";
  return url.pathname + url.search + url.hash;
}
