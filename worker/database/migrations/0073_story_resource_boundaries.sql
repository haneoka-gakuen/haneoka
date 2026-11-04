CREATE TRIGGER IF NOT EXISTS community_story_upload_playlist_insert_guard
BEFORE INSERT ON community_playlist
WHEN EXISTS(SELECT 1 FROM community_story_upload story WHERE story.attachment_id=NEW.cover_attachment_id)
BEGIN SELECT RAISE(ABORT,'story_attachment_scope'); END;
CREATE TRIGGER IF NOT EXISTS community_story_upload_playlist_update_guard
BEFORE UPDATE OF cover_attachment_id ON community_playlist
WHEN EXISTS(SELECT 1 FROM community_story_upload story WHERE story.attachment_id=NEW.cover_attachment_id)
BEGIN SELECT RAISE(ABORT,'story_attachment_scope'); END;
CREATE TRIGGER IF NOT EXISTS community_story_upload_chart_insert_guard
BEFORE INSERT ON community_chart_revision
WHEN EXISTS(SELECT 1 FROM community_story_upload story WHERE story.attachment_id=NEW.cover_attachment_id)
BEGIN SELECT RAISE(ABORT,'story_attachment_scope'); END;
CREATE TRIGGER IF NOT EXISTS community_story_upload_chart_update_guard
BEFORE UPDATE OF cover_attachment_id ON community_chart_revision
WHEN EXISTS(SELECT 1 FROM community_story_upload story WHERE story.attachment_id=NEW.cover_attachment_id)
BEGIN SELECT RAISE(ABORT,'story_attachment_scope'); END;
CREATE TRIGGER IF NOT EXISTS community_story_upload_scope_insert_guard
BEFORE INSERT ON community_story_upload
WHEN EXISTS(SELECT 1 FROM community_post_attachment link WHERE link.attachment_id=NEW.attachment_id)
 OR EXISTS(SELECT 1 FROM community_playlist cover WHERE cover.cover_attachment_id=NEW.attachment_id)
 OR EXISTS(SELECT 1 FROM community_chart_revision cover WHERE cover.cover_attachment_id=NEW.attachment_id)
BEGIN SELECT RAISE(ABORT,'story_attachment_scope'); END;
CREATE TRIGGER IF NOT EXISTS community_story_upload_scope_update_guard
BEFORE UPDATE OF attachment_id ON community_story_upload
WHEN EXISTS(SELECT 1 FROM community_post_attachment link WHERE link.attachment_id=NEW.attachment_id)
 OR EXISTS(SELECT 1 FROM community_playlist cover WHERE cover.cover_attachment_id=NEW.attachment_id)
 OR EXISTS(SELECT 1 FROM community_chart_revision cover WHERE cover.cover_attachment_id=NEW.attachment_id)
BEGIN SELECT RAISE(ABORT,'story_attachment_scope'); END;
