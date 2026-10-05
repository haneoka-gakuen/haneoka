import { forumAdminSql } from "./community-forums";

export const COMMUNITY_RANKING_CRON = "*/5 * * * *";
const VERSION = "community-engagement-v3";
const published = (alias: string) => `${alias}.status='published' AND ${alias}.deleted_at IS NULL
  AND ${alias}.moderation_status='allow'
  AND NOT EXISTS(SELECT 1 FROM community_entity_thread AS ranking_entity WHERE ranking_entity.post_id=${alias}.id)`;

/** Refresh the existing materialized feature table outside the read path. Unchanged scores cause no writes. */
export async function refreshCommunityRanking(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO community_post_rank(post_id,base_score,algorithm_version,calculated_at)
      SELECT post.id, COALESCE(likes.total,0)*5 + COALESCE(comments.total,0)*8 + COALESCE(bookmarks.total,0)*3, ?, ?
      FROM community_post AS post
      LEFT JOIN (
        SELECT reaction.post_id, COUNT(*) AS total FROM community_reaction AS reaction
        JOIN community_profile AS owner ON owner.user_id=reaction.user_id
        WHERE reaction.kind='like' AND owner.status<>'deleted' AND owner.display_name IS NOT NULL
        GROUP BY reaction.post_id
      ) AS likes ON likes.post_id=post.id
      LEFT JOIN (
        SELECT comment.post_id, COUNT(*) AS total FROM community_comment AS comment
        JOIN community_profile AS owner ON owner.user_id=comment.author_id
        WHERE comment.deleted_at IS NULL AND comment.hidden_at IS NULL AND comment.moderation_status='allow'
          AND owner.status<>'deleted' AND owner.display_name IS NOT NULL GROUP BY comment.post_id
      ) AS comments ON comments.post_id=post.id
      LEFT JOIN (
        SELECT bookmark.post_id, COUNT(*) AS total FROM community_bookmark AS bookmark
        JOIN community_profile AS owner ON owner.user_id=bookmark.user_id
        WHERE owner.status<>'deleted' AND owner.display_name IS NOT NULL GROUP BY bookmark.post_id
      ) AS bookmarks ON bookmarks.post_id=post.id
      WHERE ${published("post")}
      ON CONFLICT(post_id) DO UPDATE SET base_score=excluded.base_score,
        algorithm_version=excluded.algorithm_version,calculated_at=excluded.calculated_at
      WHERE community_post_rank.base_score IS NOT excluded.base_score
         OR community_post_rank.algorithm_version<>excluded.algorithm_version`).bind(VERSION, Date.now()),
    env.DB.prepare(`DELETE FROM community_post_rank WHERE NOT EXISTS(
      SELECT 1 FROM community_post AS post WHERE post.id=community_post_rank.post_id AND ${published("post")}
    )`),
  ]);
}

interface Pool { sql: string; values: Array<string | number>; }

/** A bounded union of popular, fresh, followed, owned and exploratory candidates; it grants no access. */
export function recommendationPostPool(userId: string | null, seed: number): Pool {
  const branches = [
    `SELECT post_id AS id FROM (SELECT rank.post_id FROM community_post_rank AS rank
      JOIN community_post AS pool ON pool.id=rank.post_id WHERE rank.algorithm_version=? AND ${published("pool")}
      ORDER BY rank.base_score DESC,rank.post_id DESC LIMIT 192)`,
    `SELECT id FROM (SELECT pool.id FROM community_post AS pool WHERE ${published("pool")}
      ORDER BY pool.created_at DESC,pool.id DESC LIMIT 128)`,
  ];
  const values: Array<string | number> = [VERSION];
  if (userId) {
    branches.push(`SELECT id FROM (SELECT pool.id FROM community_post AS pool WHERE ${published("pool")}
      AND pool.author_id=? ORDER BY pool.created_at DESC,pool.id DESC LIMIT 64)`);
    branches.push(`SELECT id FROM (SELECT pool.id FROM community_user_follow AS followed
      JOIN community_post AS pool ON pool.author_id=followed.followed_user_id
      WHERE followed.follower_user_id=? AND ${published("pool")}
      ORDER BY pool.created_at DESC,pool.id DESC LIMIT 96)`);
    branches.push(`SELECT id FROM (SELECT DISTINCT pool.id,pool.created_at FROM community_tag_preference AS preference
      JOIN community_post_tag AS tag ON tag.tag_id=preference.tag_id
      JOIN community_post AS pool ON pool.id=tag.post_id
      WHERE preference.user_id=? AND preference.kind='follow' AND ${published("pool")}
      ORDER BY pool.created_at DESC,pool.id DESC LIMIT 96)`);
    branches.push(`SELECT id FROM (SELECT pool.id FROM community_post AS pool WHERE ${published("pool")}
      AND pool.visibility='private' AND ${forumAdminSql("?")}
      ORDER BY pool.created_at DESC,pool.id DESC LIMIT 64)`);
    values.push(userId, userId, userId, userId);
  }
  const pivot = (seed >>> 0).toString(16).padStart(8, "0");
  branches.push(`SELECT id FROM (SELECT pool.id FROM community_post AS pool WHERE ${published("pool")}
    AND pool.id>=? ORDER BY pool.id LIMIT 32)`);
  branches.push(`SELECT id FROM (SELECT pool.id FROM community_post AS pool WHERE ${published("pool")}
    AND pool.id<? ORDER BY pool.id LIMIT 32)`);
  values.push(pivot, pivot);
  // The first deployment works before the scheduler has populated the feature table.
  branches.push(`SELECT pool.id FROM community_post AS pool WHERE NOT EXISTS(
    SELECT 1 FROM community_post_rank WHERE algorithm_version=?
  )`);
  values.push(VERSION);
  return { sql: `post.id IN (${branches.join(" UNION ")})`, values };
}

/** Keep page membership and the rank cursor unchanged while reducing adjacent repeated authors/targets. */
export function diversifyRecommendationPage<T>(rows: readonly T[], author: (row: T) => string, target: (row: T) => string): T[] {
  const pending = [...rows], result: T[] = [];
  while (pending.length) {
    const previous = result.at(-1);
    let next = 0;
    if (previous) {
      const different = pending.slice(0, 6).findIndex((row) => author(row) !== author(previous) && target(row) !== target(previous));
      if (different >= 0) next = different;
    }
    result.push(pending.splice(next, 1)[0]!);
  }
  return result;
}
