CREATE TABLE IF NOT EXISTS community_story_upload (
  attachment_id TEXT PRIMARY KEY NOT NULL REFERENCES community_attachment(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO community_story_upload(attachment_id,created_at)
SELECT a.attachment_id,min(a.created_at) FROM community_story_asset a
WHERE a.attachment_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM community_attachment attachment WHERE attachment.id=a.attachment_id)
 AND NOT EXISTS(SELECT 1 FROM community_post_attachment link WHERE link.attachment_id=a.attachment_id)
GROUP BY a.attachment_id;
CREATE TRIGGER IF NOT EXISTS community_story_upload_post_insert_guard
BEFORE INSERT ON community_post_attachment
WHEN EXISTS(SELECT 1 FROM community_story_upload story WHERE story.attachment_id=NEW.attachment_id)
BEGIN SELECT RAISE(ABORT,'story_attachment_scope'); END;
CREATE TRIGGER IF NOT EXISTS community_story_upload_post_update_guard
BEFORE UPDATE OF attachment_id ON community_post_attachment
WHEN EXISTS(SELECT 1 FROM community_story_upload story WHERE story.attachment_id=NEW.attachment_id)
BEGIN SELECT RAISE(ABORT,'story_attachment_scope'); END;
