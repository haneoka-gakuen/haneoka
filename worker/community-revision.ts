export const COMMENT_LAST_EDITED_AT_SELECT = `COALESCE((
  SELECT current_revision.created_at
  FROM community_comment_revision AS current_revision
  WHERE current_revision.comment_id = comment.id
    AND current_revision.revision_number = comment.moderation_revision
), comment.created_at)`;
