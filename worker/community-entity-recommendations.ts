import { communitySearchTerms } from "./community-search-query";
import { forumDiscoveryPostSql, forumTagFilterSql } from "./community-forums";

/** Real comments share the recommendation ranking stream, never a public post record. */
export function entityRecommendationCandidates(options: {
  userId: string | null;
  forumId: string | null;
  q: string | null;
  tagSelection: Parameters<typeof forumTagFilterSql>[0];
}): { sql: string; values: Array<string | number | null> } {
  const tags = forumTagFilterSql(options.tagSelection, "post");
  const conditions = [
    "comment.deleted_at IS NULL",
    "comment.hidden_at IS NULL",
    "comment.moderation_status='allow'",
    forumDiscoveryPostSql("post", "feed_viewer.user_id").replaceAll(/\bpost\.author_id\b/gu, "comment.author_id"),
    "NOT EXISTS(SELECT 1 FROM community_user_mute WHERE muter_user_id=feed_viewer.user_id AND muted_user_id=comment.author_id)",
    tags.sql,
  ];
  const values: Array<string | number | null> = [options.userId, ...tags.values];
  if (options.forumId) {
    conditions.push("post.forum_id=?");
    values.push(options.forumId);
  }
  if (options.q) {
    for (const term of communitySearchTerms(options.q)) {
      conditions.push("comment.body LIKE ? ESCAPE '\\'");
      values.push(`%${term.replace(/[\\%_]/gu, "\\$&")}%`);
    }
  } else if (options.userId && !options.tagSelection.tags.length) {
    conditions.push(`NOT EXISTS(SELECT 1 FROM community_post_tag AS muted_post_tag
      JOIN community_tag_preference AS muted_tag ON muted_tag.tag_id=muted_post_tag.tag_id
      WHERE muted_post_tag.post_id=post.id AND muted_tag.user_id=feed_viewer.user_id AND muted_tag.kind='mute')`);
  }
  // Column order matches postListSelect. These are internal ranking rows; only
  // the canonical comment reader produces the public comment DTO.
  const columns = [
    "comment.id", "post.forum_id", "post.status", "comment.deleted_at", "''", "comment.body",
    "post.visibility", "comment.moderation_status", "NULL", "post.archived_at", "post.comments_locked_at",
    "comment.version", "comment.created_at", "comment.updated_at", "comment.ip_country_code",
    "comment.ip_region_code", "comment.ip_region_name", "comment.browser_family", "comment.os_family",
    "comment.updated_at", "0", "comment.like_count", "comment.author_id", "identity.uid",
    "author.display_name", "1", "NULL", "'entity-comment'", "entity.entity_type", "entity.original_id", "post.id",
  ];
  return {
    sql: `SELECT ${columns.join(",")}
      FROM community_comment AS comment
      JOIN community_entity_thread AS entity ON entity.post_id=comment.post_id
      JOIN community_post AS post ON post.id=comment.post_id
      JOIN community_profile AS author ON author.user_id=comment.author_id
      JOIN community_identity AS identity ON identity.user_id=comment.author_id
      CROSS JOIN (SELECT ? AS user_id) AS feed_viewer
      WHERE ${conditions.join(" AND ")}`,
    values,
  };
}
