import { forumReadSql } from "./community-forums";
import { postAttachmentsAllowedSql } from "./moderation";

type Row = Record<string, string | number | null>;
const prefix = "/api/v1/admin";
const json = (request: Request, value: unknown, status = 200): Response =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
const error = (request: Request, status: number, code: string, message: string) =>
  json(request, { error: { code, message } }, status);

// These helpers are called only after admin.ts's authoritative administrator check.
export async function readAdminPost(request: Request, env: Env, id: string): Promise<Response> {
  const post = await env.DB.prepare(
    `SELECT post.id, post.forum_id AS forumId, post.author_id AS authorId, post.title, post.body,
    post.status, post.visibility, post.moderation_status AS moderationStatus,
    post.moderation_revision AS moderationRevision, post.version,
    post.created_at AS createdAt, post.updated_at AS updatedAt, post.published_at AS publishedAt,
    post.deleted_at AS deletedAt, post.delete_reason_code AS deleteReasonCode,
    post.archived_at AS archivedAt, post.pinned_at AS pinnedAt, post.comments_locked_at AS commentsLockedAt,
    account.name AS authorAccountName, profile.display_name AS authorName, profile.status AS authorStatus,
    CASE WHEN post.status='published' AND post.visibility='public' AND post.moderation_status='allow'
      AND post.deleted_at IS NULL AND post.archived_at IS NULL
      AND profile.status <> 'deleted' AND profile.display_name IS NOT NULL
      AND EXISTS (SELECT 1 FROM community_identity AS identity WHERE identity.user_id=post.author_id)
      AND ${postAttachmentsAllowedSql} AND ${forumReadSql("post","NULL")} THEN 1 ELSE 0 END AS publicEligible
    FROM community_post AS post
    LEFT JOIN "user" AS account ON account.id=post.author_id
    LEFT JOIN community_profile AS profile ON profile.user_id=post.author_id
    WHERE post.id=?`,
  )
    .bind(id)
    .first<Row>();
  if (!post) return error(request, 404, "post_not_found", "Post does not exist");
  const [tags, attachments, variants, moderation] = await env.DB.batch<Row>([
    env.DB.prepare(
      `SELECT tag.normalized_name AS name, tag.status FROM community_post_tag AS link
      JOIN community_tag AS tag ON tag.id=link.tag_id WHERE link.post_id=? ORDER BY link.position`,
    ).bind(id),
    env.DB.prepare(
      `SELECT attachment.id, link.position, attachment.original_name AS fileName,
      attachment.media_type AS mediaType, attachment.status, attachment.moderation_status AS moderationStatus,
      attachment.byte_size AS byteSize, attachment.width, attachment.height, attachment.failure_code AS failureCode,
      attachment.deleted_at AS deletedAt, attachment.object_deleted_at AS objectDeletedAt,
      media.state AS processingState, media.progress AS processingProgress, media.error AS processingError
      FROM community_post_attachment AS link JOIN community_attachment AS attachment ON attachment.id=link.attachment_id
      LEFT JOIN community_media_job AS media ON media.attachment_id=attachment.id
      WHERE link.post_id=? ORDER BY link.position`,
    ).bind(id),
    env.DB.prepare(
      `SELECT variant.attachment_id AS attachmentId, variant.kind, variant.media_type AS mediaType,
      variant.byte_size AS byteSize, variant.width, variant.height, variant.duration_seconds AS durationSeconds
      FROM community_attachment_variant AS variant JOIN community_post_attachment AS link ON link.attachment_id=variant.attachment_id
      WHERE link.post_id=? ORDER BY link.position, variant.kind`,
    ).bind(id),
    env.DB.prepare(
      `SELECT id, status, source, reason_code AS reasonCode, model_id AS modelId,
      categories_json AS categoriesJson, policy_version AS policyVersion, completed_at AS completedAt
      FROM community_moderation_case WHERE entity_kind='post' AND entity_id=? AND entity_revision=?
      ORDER BY policy_generation DESC, updated_at DESC, id DESC LIMIT 1`,
    ).bind(id, post.moderationRevision),
  ]);
  if (!tags || !attachments || !variants || !moderation) throw new Error("Incomplete admin content batch");
  return json(request, {
    post: {
      ...post,
      publicEligible: post.publicEligible === 1,
      historyUrl: `${prefix}/posts/${encodeURIComponent(id)}/history`,
      commentsUrl: `${prefix}/posts/${encodeURIComponent(id)}/history?section=comments`,
      moderation: moderation.results[0] ?? null,
      tags: tags.results,
      attachments: attachments.results.map((row) => ({
        ...row,
        contentAvailability:
          row.objectDeletedAt !== null ? "removed" : row.byteSize === null ? "not_uploaded" : "unchecked",
        contentUrl:
          row.objectDeletedAt === null && row.byteSize !== null ? `${prefix}/attachments/${row.id}/content` : null,
        variants: variants.results
          .filter((variant) => variant.attachmentId === row.id)
          .map(({ attachmentId: _id, ...variant }) => ({
            ...variant,
            contentUrl:
              row.objectDeletedAt === null ? `${prefix}/attachments/${row.id}/content?variant=${variant.kind}` : null,
          })),
      })),
    },
  });
}

export async function readAdminAttachment(request: Request, env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, object_key AS objectKey, original_name AS fileName,
    media_type AS mediaType, byte_size AS byteSize, sha256, r2_etag AS etag, r2_version AS version
    FROM community_attachment WHERE id=? AND purpose='post'`,
  )
    .bind(id)
    .first<Row>();
  if (!row) return error(request, 404, "attachment_not_found", "Attachment does not exist");
  const variant = new URL(request.url).searchParams.get("variant");
  if (variant && !["media", "poster", "thumb", "moderation"].includes(variant))
    return error(request, 400, "invalid_variant", "Unknown attachment variant");
  let object = row;
  if (variant) {
    const found = await env.DB.prepare(
      `SELECT object_key AS objectKey, media_type AS mediaType,
      byte_size AS byteSize, sha256 FROM community_attachment_variant WHERE attachment_id=? AND kind=?`,
    )
      .bind(id, variant)
      .first<Row>();
    if (!found)
      return error(request, 409, "attachment_variant_unavailable", "This variant has not been retained or produced");
    object = found;
  }
  if (object.byteSize === null || Number(object.byteSize) <= 0)
    return error(request, 409, "attachment_not_uploaded", "Attachment upload is incomplete");
  if (!env.COMMUNITY_UPLOADS)
    return error(request, 503, "attachment_storage_unavailable", "Attachment storage is unavailable");
  try {
    const meta = await env.COMMUNITY_UPLOADS.head(String(object.objectKey));
    if (!meta) return error(request, 410, "attachment_content_gone", "Attachment content is no longer retained");
    const identityMatches = meta.customMetadata?.sha256
      ? meta.customMetadata.sha256 === object.sha256
      : !variant && meta.customMetadata?.attachmentId === id && meta.etag === row.etag && meta.version === row.version;
    if (meta.size !== object.byteSize || !identityMatches)
      return error(request, 409, "attachment_integrity_mismatch", "Stored attachment metadata does not match");
    const mediaType = String(object.mediaType);
    const variantExtension =
      mediaType === "image/webp"
        ? "webp"
        : mediaType === "image/jpeg"
          ? "jpg"
          : mediaType === "video/mp4"
            ? "mp4"
            : "png";
    const fileName = variant
      ? `${String(row.fileName).replace(/\.[^.]*$/u, "")}.${variantExtension}`
      : String(row.fileName);
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
      "Content-Type": mediaType,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Accept-Ranges": "bytes",
      ETag: meta.httpEtag,
      "Content-Disposition": `inline; filename="attachment"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    });
    if (mediaType === "text/plain") headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (
      ifNoneMatch
        ?.split(",")
        .map((s) => s.trim())
        .some((s) => s === "*" || s === meta.httpEtag)
    )
      return new Response(null, { status: 304, headers });
    let range: { offset: number; length: number } | undefined;
    const rangeValue = request.headers.get("Range");
    if (rangeValue) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeValue);
      const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, meta.size - Number(match[2])) : NaN;
      const end = match?.[1] && match[2] ? Math.min(meta.size - 1, Number(match[2])) : meta.size - 1;
      if (
        !match ||
        ![match[1], match[2]].every((value) => value === "" || Number.isSafeInteger(Number(value))) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= meta.size ||
        end < start
      ) {
        headers.set("Content-Range", `bytes */${meta.size}`);
        return new Response(null, { status: 416, headers });
      }
      range = { offset: start, length: end - start + 1 };
      headers.set("Content-Range", `bytes ${start}-${end}/${meta.size}`);
    }
    headers.set("Content-Length", String(range?.length ?? meta.size));
    if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
    const stored = await env.COMMUNITY_UPLOADS.get(String(object.objectKey), {
      onlyIf: { etagMatches: meta.etag },
      ...(range ? { range } : {}),
    });
    if (!stored) return error(request, 410, "attachment_content_gone", "Attachment content is no longer retained");
    if (!("body" in stored)) return error(request, 409, "attachment_changed", "Attachment changed during the read");
    return new Response(stored.body, { status: range ? 206 : 200, headers });
  } catch {
    return error(request, 503, "attachment_storage_unavailable", "Attachment storage is temporarily unavailable");
  }
}

export async function readAdminStatistics(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const queries: Record<string, string> = {
    users: `SELECT 'total' AS key, COUNT(*) AS count FROM "user" UNION ALL SELECT 'verified',COUNT(*) FROM "user" WHERE emailVerified=1`,
    profiles: `SELECT status AS key,COUNT(*) AS count FROM community_profile GROUP BY status`,
    posts: `SELECT 'total' AS key,COUNT(*) AS count FROM community_post UNION ALL
      SELECT 'deleted',COUNT(*) FROM community_post WHERE deleted_at IS NOT NULL UNION ALL
      SELECT 'archived',COUNT(*) FROM community_post WHERE archived_at IS NOT NULL UNION ALL
      SELECT 'publicEligible',COUNT(*) FROM community_post AS post JOIN community_profile AS profile ON profile.user_id=post.author_id
      WHERE post.status='published' AND post.visibility='public' AND post.moderation_status='allow'
        AND post.deleted_at IS NULL AND post.archived_at IS NULL AND profile.status<>'deleted' AND profile.display_name IS NOT NULL
        AND EXISTS (SELECT 1 FROM community_identity AS identity WHERE identity.user_id=post.author_id)
        AND ${postAttachmentsAllowedSql}`,
    postStatus: `SELECT status AS key,COUNT(*) AS count FROM community_post GROUP BY status`,
    postModeration: `SELECT moderation_status AS key,COUNT(*) AS count FROM community_post GROUP BY moderation_status`,
    postVisibility: `SELECT visibility AS key,COUNT(*) AS count FROM community_post GROUP BY visibility`,
    comments: `SELECT 'total' AS key,COUNT(*) AS count FROM community_comment UNION ALL
      SELECT 'deleted',COUNT(*) FROM community_comment WHERE deleted_at IS NOT NULL UNION ALL
      SELECT 'hidden',COUNT(*) FROM community_comment WHERE hidden_at IS NOT NULL`,
    commentModeration: `SELECT moderation_status AS key,COUNT(*) AS count FROM community_comment GROUP BY moderation_status`,
    attachments: `SELECT status AS key,COUNT(*) AS count FROM community_attachment GROUP BY status`,
    attachmentModeration: `SELECT moderation_status AS key,COUNT(*) AS count FROM community_attachment GROUP BY moderation_status`,
    mediaJobs: `SELECT state AS key,COUNT(*) AS count FROM community_media_job GROUP BY state`,
    moderationCases: `SELECT status AS key,COUNT(*) AS count FROM community_moderation_case GROUP BY status`,
    moderationJobs: `SELECT status AS key,COUNT(*) AS count FROM community_moderation_job GROUP BY status`,
    moderationSources: `SELECT source AS key,COUNT(*) AS count FROM community_moderation_case GROUP BY source`,
    moderationFallback: `SELECT 'allowedAfterFailure' AS key,COUNT(*) AS count FROM community_moderation_case WHERE reason_code='system.moderation_unavailable_allow'`,
    appeals: `SELECT status AS key,COUNT(*) AS count FROM community_appeal GROUP BY status`,
    reports: `SELECT status AS key,COUNT(*) AS count FROM community_content_report GROUP BY status`,
    operations: `SELECT status AS key,COUNT(*) AS count FROM admin_operation GROUP BY status`,
  };
  const keys = Object.keys(queries);
  const results = await env.DB.batch<{ key: string; count: number }>(keys.map((key) => env.DB.prepare(queries[key]!)));
  const liveSessions = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM "session" WHERE julianday(expiresAt)>julianday(?)`,
  )
    .bind(new Date(now).toISOString())
    .first<{ count: number }>();
  if (!liveSessions) throw new Error("Admin session count returned no row");
  const statistics = Object.fromEntries(
    keys.map((key, index) => [key, Object.fromEntries(results[index]!.results.map((row) => [row.key, row.count]))]),
  );
  return json(request, { generatedAt: now, statistics, sessions: { active: liveSessions.count } });
}
