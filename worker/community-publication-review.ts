// L3 — GEB
// Input: 内部 SQL 中的附件或故事素材身份。
// Output: 只有提交公开的内容才进入审核的 SQL 条件。
// Pos: [Map](L2.md)；社区审核的发布门槛。
// Effects/Dependencies: 复用故事修订、帖子附件、谱面和歌单的关系；不修改记录。

export const storySubmissionSql = (assetCondition: string) => `EXISTS (
  SELECT 1 FROM community_story_asset asset
  JOIN community_story_revision_asset ra ON ra.asset_id=asset.id AND ra.is_public=1
  JOIN community_story story ON story.id=ra.story_id AND story.deleted_at IS NULL
  JOIN community_story_revision revision ON revision.story_id=ra.story_id AND revision.revision=ra.revision AND revision.deleted_at IS NULL
  WHERE (${assetCondition}) AND ra.revision IN (story.publishing_revision,story.published_revision)
)`;

export const attachmentSubmissionSql = (attachment: string) => `(
  ${attachment}.purpose<>'post'
  OR EXISTS (SELECT 1 FROM community_post_attachment link JOIN community_post post ON post.id=link.post_id
      WHERE link.attachment_id=${attachment}.id AND post.status='published' AND post.deleted_at IS NULL AND post.archived_at IS NULL
        AND post.moderation_status<>'block')
  OR EXISTS (SELECT 1 FROM community_chart_revision revision JOIN community_chart chart
      ON chart.id=revision.chart_id AND chart.deleted_at IS NULL
      LEFT JOIN community_chart_publication pending ON pending.chart_id=revision.chart_id AND pending.revision=revision.revision
      WHERE revision.cover_attachment_id=${attachment}.id AND (chart.published_revision=revision.revision OR pending.revision IS NOT NULL))
  OR EXISTS (SELECT 1 FROM community_playlist playlist WHERE playlist.cover_attachment_id=${attachment}.id
      AND playlist.visibility='public' AND playlist.deleted_at IS NULL)
  OR ${storySubmissionSql(`asset.attachment_id=${attachment}.id`)}
)`;
