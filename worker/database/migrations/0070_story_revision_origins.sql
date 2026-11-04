CREATE TABLE IF NOT EXISTS community_story_remix_revision_grant (
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  source_story_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision>0),
  source_title TEXT NOT NULL,
  source_owner_uid INTEGER NOT NULL,
  source_owner_name TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,source_story_id,source_revision)
);
INSERT OR IGNORE INTO community_story_remix_revision_grant
  SELECT owner_id,source_story_id,source_revision,source_title,source_owner_uid,source_owner_name,granted_at
  FROM community_story_remix_grant;

CREATE TABLE IF NOT EXISTS community_story_revision_origin (
  story_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_story_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision>0),
  source_title TEXT NOT NULL,
  source_owner_uid INTEGER NOT NULL,
  source_owner_name TEXT NOT NULL,
  PRIMARY KEY(story_id,revision),
  FOREIGN KEY(story_id,revision) REFERENCES community_story_revision(story_id,revision) ON DELETE CASCADE
);
INSERT OR IGNORE INTO community_story_revision_origin
  SELECT r.story_id,r.revision,g.source_story_id,g.source_revision,g.source_title,g.source_owner_uid,g.source_owner_name
  FROM community_story_revision r
  JOIN community_story s ON s.id=r.story_id
  JOIN community_story_remix_grant g ON g.owner_id=s.owner_id AND g.source_story_id=r.upstream_id;
