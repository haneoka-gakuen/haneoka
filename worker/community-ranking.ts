// L3 — GEB
// Input: published community candidates, viewer, ranking time and seed.
// Output: shared recommendation scores, candidate pools and diversified content order.
// Pos: [Map](L2.md); community recommendation ranking owner.
// Effects/Dependencies: D1 feature refresh; score construction and diversification are pure.
import { forumAdminSql } from "./community-forums";

export const COMMUNITY_RANKING_CRON = "*/5 * * * *";
const VERSION = "community-engagement-v3";
const WEIGHTS = {
  like: 5,
  comment: 8,
  bookmark: 3,
  hour: 80,
  day: 50,
  week: 20,
  author: 120,
  tag: 70,
  seen: 90,
} as const;

export function recommendationScoreSql(options: {
  kind: "post" | "chart";
  userId: string | null;
  asOf: number;
  seed: number;
  includeEntityComments?: boolean;
}): { sql: string; values: Array<string | number> } {
  const chart = options.kind === "chart";
  const author = chart ? "candidate.ownerId" : "candidate.authorId";
  const created = chart ? "candidate.rankingCreatedAt" : "candidate.createdAt";
  const likes = chart ? "candidate.rankingLikeCount" : "candidate.likeCount";
  const post = chart ? "candidate.threadId" : "candidate.id";
  const impression = chart ? "community_chart_impression" : "community_feed_impression";
  const impressionId = chart ? "chart_id" : "post_id";
  const values: Array<string | number> = [
    options.asOf - 3_600_000,
    options.asOf - 86_400_000,
    options.asOf - 7 * 86_400_000,
    options.seed,
  ];
  let personal = "";
  if (options.userId) {
    const seen = (table: string, id: string) => `EXISTS(SELECT 1 FROM ${table} AS score_impression
      WHERE score_impression.user_id=? AND score_impression.${id}=candidate.id AND score_impression.first_seen_at<?)`;
    const seenSql =
      options.includeEntityComments && !chart
        ? `CASE WHEN candidate.kind='entity-comment' THEN ${seen("community_comment_impression", "comment_id")}
          ELSE ${seen(impression, impressionId)} END`
        : seen(impression, impressionId);
    personal = `
      + CASE WHEN EXISTS(SELECT 1 FROM community_user_follow AS score_follow
          WHERE score_follow.follower_user_id=? AND score_follow.followed_user_id=${author}) THEN ${WEIGHTS.author} ELSE 0 END
      + CASE WHEN EXISTS(SELECT 1 FROM community_post_tag AS score_post_tag
          JOIN community_tag_preference AS score_tag_preference ON score_tag_preference.tag_id=score_post_tag.tag_id
          AND score_tag_preference.user_id=? AND score_tag_preference.kind='follow'
          WHERE score_post_tag.post_id=${post}) THEN ${WEIGHTS.tag} ELSE 0 END
      - CASE WHEN ${seenSql} THEN ${WEIGHTS.seen} ELSE 0 END`;
    values.push(options.userId, options.userId);
    if (options.includeEntityComments && !chart) values.push(options.userId, options.asOf);
    values.push(options.userId, options.asOf);
  }
  return {
    sql: `(${likes}*${WEIGHTS.like} + candidate.commentCount*${WEIGHTS.comment}
      + (SELECT COUNT(*) FROM community_bookmark AS rank_bookmark
          JOIN community_profile AS rank_bookmark_owner ON rank_bookmark_owner.user_id=rank_bookmark.user_id
          AND rank_bookmark_owner.status<>'deleted' AND rank_bookmark_owner.display_name IS NOT NULL
          WHERE rank_bookmark.post_id=${post})*${WEIGHTS.bookmark}
      + CASE WHEN ${created}>=? THEN ${WEIGHTS.hour} WHEN ${created}>=? THEN ${WEIGHTS.day}
          WHEN ${created}>=? THEN ${WEIGHTS.week} ELSE 0 END
      + (((?*1103515245 + unicode(substr(candidate.id,1,1))*104729
          + unicode(substr(candidate.id,2,1))*13007 + unicode(substr(candidate.id,3,1))*1543
          + unicode(substr(candidate.id,4,1))*193)&2147483647)%13) ${personal})`,
    values,
  };
}
const published = (alias: string) => `${alias}.status='published' AND ${alias}.deleted_at IS NULL
  AND ${alias}.moderation_status='allow'
  AND NOT EXISTS(SELECT 1 FROM community_entity_thread AS ranking_entity WHERE ranking_entity.post_id=${alias}.id)`;

/** Refresh the existing materialized feature table outside the read path. Unchanged scores cause no writes. */
export async function refreshCommunityRanking(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_post_rank(post_id,base_score,algorithm_version,calculated_at)
      SELECT post.id, COALESCE(likes.total,0)*${WEIGHTS.like} + COALESCE(comments.total,0)*${WEIGHTS.comment} + COALESCE(bookmarks.total,0)*${WEIGHTS.bookmark}, ?, ?
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
         OR community_post_rank.algorithm_version<>excluded.algorithm_version`,
    ).bind(VERSION, Date.now()),
    env.DB.prepare(`DELETE FROM community_post_rank WHERE NOT EXISTS(
      SELECT 1 FROM community_post AS post WHERE post.id=community_post_rank.post_id AND ${published("post")}
    )`),
  ]);
}

interface Pool {
  sql: string;
  values: Array<string | number>;
}

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
  return { sql: `(${branches.map((branch) => `post.id IN (${branch})`).join(" OR ")})`, values };
}

/** Keep page membership and the rank cursor unchanged while reducing adjacent repeated authors/targets. */
export function diversifyRecommendationPage<T>(
  rows: readonly T[],
  author: (row: T) => string,
  target: (row: T) => string,
  kind?: (row: T) => string,
): T[] {
  const pending = [...rows],
    result: T[] = [];
  while (pending.length) {
    const previous = result.at(-1);
    let next = 0;
    if (previous) {
      const candidates = pending.slice(0, 6);
      const distinct = (row: T) => author(row) !== author(previous) && target(row) !== target(previous);
      let different = kind ? candidates.findIndex((row) => distinct(row) && kind(row) !== kind(previous)) : -1;
      if (different < 0) different = candidates.findIndex(distinct);
      if (different >= 0) next = different;
    }
    result.push(pending.splice(next, 1)[0]!);
  }
  return result;
}
