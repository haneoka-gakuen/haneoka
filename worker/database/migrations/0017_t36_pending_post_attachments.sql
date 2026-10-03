-- Accept completed uploads on a pending post; publication remains gated by all attachment verdicts.
DROP TRIGGER community_post_attachment_ready_before_insert;
CREATE TRIGGER community_post_attachment_ready_before_insert
BEFORE INSERT ON community_post_attachment
WHEN NOT EXISTS (
  SELECT 1 FROM community_attachment AS attachment
  JOIN community_post AS post ON post.id = NEW.post_id
  WHERE attachment.id = NEW.attachment_id
    AND attachment.purpose = 'post'
    AND attachment.deleted_at IS NULL
    AND attachment.byte_size = attachment.declared_size
    AND attachment.sha256 IS NOT NULL AND attachment.r2_etag IS NOT NULL
    AND attachment.r2_version IS NOT NULL
    AND (
      (attachment.status = 'ready' AND attachment.moderation_status = 'allow')
      OR (post.moderation_status = 'pending'
          AND attachment.status IN ('scanning', 'review')
          AND attachment.moderation_status IN ('pending', 'review'))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'attachment must be uploaded or ready and allowed');
END;

CREATE TRIGGER community_post_attachment_publication_before_allow
BEFORE UPDATE OF moderation_status ON community_post
WHEN NEW.moderation_status = 'allow' AND NOT (NOT EXISTS (
  SELECT 1 FROM community_post_attachment AS publication_link
  JOIN community_attachment AS publication_attachment ON publication_attachment.id = publication_link.attachment_id
  WHERE publication_link.post_id = NEW.id
    AND (publication_attachment.status <> 'ready' OR publication_attachment.moderation_status <> 'allow'
         OR publication_attachment.deleted_at IS NOT NULL OR publication_attachment.purpose <> 'post'
         OR publication_attachment.owner_user_id <> NEW.author_id
         OR publication_attachment.byte_size IS NULL
         OR publication_attachment.byte_size <> publication_attachment.declared_size
         OR publication_attachment.sha256 IS NULL OR publication_attachment.r2_etag IS NULL
         OR publication_attachment.r2_version IS NULL
         OR EXISTS (
           SELECT 1 FROM community_media_job AS publication_media
           WHERE publication_media.attachment_id = publication_attachment.id
             AND (publication_media.state <> 'ready' OR NOT EXISTS (
               SELECT 1 FROM community_attachment_variant AS publication_variant
               WHERE publication_variant.attachment_id = publication_attachment.id
                 AND publication_variant.kind = 'moderation'
             ))
         ))
))
BEGIN
  SELECT RAISE(ABORT, 'post attachments must be ready and allowed before publication');
END;
