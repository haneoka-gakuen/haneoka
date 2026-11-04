// L3 — GEB
// Input: Administrator-validated filters and content identity from admin.ts.
// Output: Chart/playlist/story review records and version-checked soft removal.
// Pos: [Map](L2.md); administration of community creations.
// Effects/Dependencies: D1 only; caller owns authoritative access and operation reservation.
export type CreationKind = "charts" | "playlists" | "stories";
type Row = Record<string, string | number | null>;
export const creationTable = (kind: CreationKind) => kind === "charts" ? "community_chart" : kind === "stories" ? "community_story" : "community_playlist";

export async function listAdminCreations(env: Env, kind: CreationKind, options: {
  query: string; status: string; limit: number; cursor: { sort: number; id: string } | null; id?: string;
}) {
  const chart = kind === "charts";
  const versioned = chart || kind === "stories", revisionTable = chart ? "community_chart_revision" : "community_story_revision", revisionParent = chart ? "chart_id" : "story_id";
  const title = versioned ? "COALESCE(published.title, r.title)" : "c.title", body = versioned ? "COALESCE(published.summary, r.summary)" : "c.description";
  const state = `CASE WHEN c.deleted_at IS NOT NULL THEN 'deleted' WHEN ${versioned ? "c.published_revision" : "c.published_at"} IS NULL THEN 'draft' ELSE 'published' END`;
  const conditions: string[] = [], values: (string | number)[] = [];
  if (options.id) { conditions.push("c.id = ?"); values.push(options.id); }
  if (options.status !== "all") { conditions.push(`${state} = ?`); values.push(options.status); }
  if (options.query) {
    conditions.push(`(${title} LIKE ? ESCAPE '\\' OR ${body} LIKE ? ESCAPE '\\' OR c.id = ?${versioned ? " OR r.title LIKE ? ESCAPE '\\' OR r.summary LIKE ? ESCAPE '\\'" : ""})`);
    const pattern = `%${options.query.replace(/[\\%_]/gu, "\\$&")}%`;
    values.push(pattern, pattern, options.query);
    if (versioned) values.push(pattern, pattern);
  }
  if (options.cursor) {
    conditions.push("(c.created_at < ? OR (c.created_at = ? AND c.id < ?))");
    values.push(options.cursor.sort, options.cursor.sort, options.cursor.id);
  }
  return (await env.DB.prepare(`SELECT c.id, c.owner_id AS authorId, c.version, ${kind === "stories" ? "COALESCE(published.visibility,r.visibility)" : "c.visibility"} AS visibility,
    c.created_at AS createdAt, c.updated_at AS updatedAt, c.deleted_at AS deletedAt,
    ${title} AS title, ${body} AS body, ${state} AS status,
    p.display_name AS authorName, p.handle AS authorHandle, u.name AS authorAccountName,
    ${chart ? "c.head, c.published_revision AS publishedRevision, r.artist, r.charter, r.difficulty, r.level" : kind === "stories" ? "c.head, c.published_revision AS publishedRevision,c.publishing_revision AS publishingRevision,c.publish_error AS publishError,r.file_count AS fileCount,r.scene_count AS sceneCount,r.command_count AS commandCount" : "c.track_count AS trackCount, c.published_at AS publishedAt"}
    FROM ${creationTable(kind)} c
    ${versioned ? `LEFT JOIN ${revisionTable} r ON r.${revisionParent} = c.id AND r.revision = c.head
      LEFT JOIN ${revisionTable} published ON published.${revisionParent} = c.id AND published.revision = c.published_revision` : ""}
    LEFT JOIN community_profile p ON p.user_id = c.owner_id LEFT JOIN "user" u ON u.id = c.owner_id
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY c.created_at DESC, c.id DESC LIMIT ?`).bind(...values, options.limit).all<Row>()).results;
}

export async function readAdminCreation(env: Env, kind: CreationKind, id: string) {
  const current = (await listAdminCreations(env, kind, { id, query: "", status: "all", limit: 1, cursor: null }))[0];
  if (!current) return null;
  const details = kind === "charts"
    ? (await env.DB.prepare(`SELECT r.revision, r.title, r.artist, r.charter, r.difficulty, r.level, r.summary,
        r.remix, r.created_at AS createdAt, r.published_at AS publishedAt,
        CASE WHEN r.revision = c.head THEN 1 ELSE 0 END AS isHead,
        CASE WHEN r.revision = c.published_revision THEN 1 ELSE 0 END AS isPublished
        FROM community_chart_revision r JOIN community_chart c ON c.id = r.chart_id
        WHERE c.id = ? AND (r.revision = c.head OR r.revision = c.published_revision)
        ORDER BY r.revision DESC`).bind(id).all<Row>()).results
    : kind === "stories" ? (await env.DB.prepare(`SELECT r.revision,r.title,r.summary,r.remix,r.file_count AS fileCount,r.scene_count AS sceneCount,
        r.command_count AS commandCount,r.byte_size AS bytes,r.compile_error AS compilationError,
        r.created_at AS createdAt,r.published_at AS publishedAt,
        CASE WHEN r.revision=c.head THEN 1 ELSE 0 END AS isHead,
        CASE WHEN r.revision=c.published_revision THEN 1 ELSE 0 END AS isPublished,
        (SELECT count(*) FROM community_story_revision_asset ra JOIN community_story_asset a ON a.id=ra.asset_id
          JOIN community_story_blob b ON b.hash=a.blob_hash WHERE ra.story_id=r.story_id AND ra.revision=r.revision
          AND (a.state='rejected' OR b.moderation_status='block')) AS rejectedAssets,
        (SELECT count(*) FROM community_story_revision_asset ra JOIN community_story_asset a ON a.id=ra.asset_id
          JOIN community_story_blob b ON b.hash=a.blob_hash WHERE ra.story_id=r.story_id AND ra.revision=r.revision
          AND (a.state IN ('reserved','processing') OR b.state<>'active' OR b.moderation_status='review')) AS pendingAssets
        FROM community_story_revision r JOIN community_story c ON c.id=r.story_id
        WHERE c.id=? AND (r.revision=c.head OR r.revision=c.published_revision) ORDER BY r.revision DESC`).bind(id).all<Row>()).results
    : (await env.DB.prepare(`SELECT position, provider, server, music_id AS musicId
        FROM community_playlist_track WHERE playlist_id = ? ORDER BY position`).bind(id).all<Row>()).results;
  return { ...current, details };
}

export async function removeAdminCreation(env: Env, kind: CreationKind, id: string, version: number, operationId: string, reasonCode: string) {
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE ${creationTable(kind)} SET deleted_at = ?, updated_at = ?, version = version + 1
      ${kind === "charts" ? ", published_revision = NULL" : kind === "stories" ? ", published_revision=NULL,publishing_revision=NULL,publish_token=NULL,publish_error=NULL" : ""}
      WHERE id = ? AND version = ? AND deleted_at IS NULL`).bind(now, now, id, version),
    env.DB.prepare(`UPDATE admin_operation SET status = 'succeeded', external_ref = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND status = 'pending' AND changes() = 1`).bind(id, now, now, operationId),
    env.DB.prepare(`INSERT INTO admin_operation_event(id, operation_id, from_status, to_status, detail_json, created_at)
      SELECT ?, ?, 'pending', 'succeeded', ?, ? WHERE EXISTS (SELECT 1 FROM admin_operation WHERE id = ? AND status = 'succeeded')`)
      .bind(crypto.randomUUID(), operationId, JSON.stringify({ reasonCode, version: version + 1 }), now, operationId),
  ]);
  return Number(results[0]?.meta.changes || 0) > 0;
}
