import { validStickerToken } from "../src/lib/community-sticker-token";
import { isReleaseServer } from "../src/lib/resource-route";

/** Thread identity never includes a server, locale, build or presentation key. */
export interface CommunityEntityTarget {
  entityType: string;
  originalId: string;
}

export function canonicalEntityTarget(entityType: unknown, originalId: unknown): CommunityEntityTarget | null {
  if (typeof entityType !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(entityType)) return null;
  if (
    typeof originalId !== "string" ||
    !originalId ||
    [...originalId].length > 512 ||
    /[\p{Cc}\p{Cs}]/u.test(originalId)
  )
    return null;
  if (/^\d+$/u.test(originalId) && (!/^[1-9]\d{0,15}$/u.test(originalId) || !Number.isSafeInteger(Number(originalId))))
    return null;
  return { entityType, originalId };
}

export function entityThreadSql(postIdExpression: string): string {
  return `EXISTS (SELECT 1 FROM community_entity_thread AS entity_thread_guard WHERE entity_thread_guard.post_id=${postIdExpression})`;
}

/** Built-in stickers carry catalogue tokens, never user-supplied media URLs. */
function withoutBuiltInStickerTags(value: string): string | null {
  let open = false;
  let valid = true;
  const text = value.replace(/\[(\/?)sticker(?:=([^[\]\r\n]*))?\]/giu, (_tag, closing: string, token: string | undefined) => {
    if (closing) {
      if (!open || token !== undefined) valid = false;
      open = false;
    } else {
      if (open || token === undefined || !validStickerToken(token) || !isReleaseServer(token.split(":")[0])) valid = false;
      open = true;
    }
    return "";
  });
  return valid && !open ? text : null;
}

/** Reused by create/edit and the generic legacy endpoints, not just the detail widget. */
export function entityCommentTextOnly(payload: Record<string, unknown>, edit = false): boolean {
  const fields = edit ? ["body", "version", "editReason"] : ["body", "parentId"];
  if (Object.keys(payload).some((key) => !fields.includes(key)) || typeof payload.body !== "string") return false;
  const text = withoutBuiltInStickerTags(payload.body);
  if (text === null) return false;
  const body = text.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/gu, "");
  return (
    !/\[\/?sticker\b/iu.test(body) &&
    !/\[\/?(?:img|image|file|attachment|attach|sticker|stamp|video|audio|media|model|chart)(?:[\s=:/\]])/iu.test(
      body,
    ) &&
    !/!\[[^\]]*\]\s*\(/u.test(body) &&
    !/<\/?(?:img|image|svg|audio|video|iframe|object|embed|canvas|picture|source|attachment|model-viewer|chart-viewer|community-sticker)(?:\s|\/?>)/iu.test(
      body,
    ) &&
    !/\/api\/v1\/(?:community\/attachments|admin\/attachments)\/[a-f\d-]{36}(?:[\s/#?)]|$)/iu.test(body)
  );
}

export async function entityThreadForPost(env: Env, postId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM community_entity_thread WHERE post_id=?").bind(postId).first());
}
