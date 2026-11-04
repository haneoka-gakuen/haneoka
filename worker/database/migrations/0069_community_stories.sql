CREATE TABLE IF NOT EXISTS community_story_blob (
  hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
  object_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK(byte_size>=0),
  state TEXT NOT NULL CHECK(state IN ('uploading','active','deleting')),
  moderation_status TEXT NOT NULL DEFAULT 'allow' CHECK(moderation_status IN ('allow','review','block')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS community_story_asset (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  blob_hash TEXT NOT NULL REFERENCES community_story_blob(hash) ON DELETE RESTRICT,
  media_type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('data','audio','image','video')),
  state TEXT NOT NULL CHECK(state IN ('reserved','processing','ready','rejected')),
  attachment_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id,blob_hash)
);
CREATE INDEX IF NOT EXISTS community_story_asset_owner_idx ON community_story_asset(owner_id,updated_at);
CREATE INDEX IF NOT EXISTS community_story_asset_attachment_idx ON community_story_asset(attachment_id) WHERE attachment_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS community_story (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  head INTEGER NOT NULL DEFAULT 0 CHECK(head>=0),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
  published_revision INTEGER,
  publishing_revision INTEGER,
  publish_token TEXT,
  publish_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS community_story_owner_idx ON community_story(owner_id,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS community_story_publishing_idx ON community_story(updated_at,id) WHERE publishing_revision IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS community_story_revision (
  story_id TEXT NOT NULL REFERENCES community_story(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>0),
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  write_version INTEGER NOT NULL CHECK(write_version>0),
  object_key TEXT NOT NULL UNIQUE,
  runtime_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  compile_error TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  summary TEXT NOT NULL CHECK(length(summary)<=2000),
  locales_json TEXT NOT NULL CHECK(json_valid(locales_json) AND json_type(locales_json)='array'),
  cover_path TEXT,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','unlisted')),
  remix INTEGER NOT NULL CHECK(remix IN (0,1)),
  upstream_id TEXT REFERENCES community_story(id) ON DELETE SET NULL,
  scene_count INTEGER NOT NULL CHECK(scene_count>=0),
  command_count INTEGER NOT NULL CHECK(command_count>=0),
  byte_size INTEGER NOT NULL CHECK(byte_size>=0),
  file_count INTEGER NOT NULL CHECK(file_count>0),
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  deleted_at INTEGER,
  PRIMARY KEY(story_id,revision),
  UNIQUE(story_id,request_id)
);
CREATE INDEX IF NOT EXISTS community_story_public_idx ON community_story_revision(published_at DESC,story_id) WHERE published_at IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS community_story_revision_asset (
  story_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  asset_id TEXT NOT NULL REFERENCES community_story_asset(id) ON DELETE RESTRICT,
  is_public INTEGER NOT NULL DEFAULT 1 CHECK(is_public IN (0,1)),
  PRIMARY KEY(story_id,revision,asset_id),
  FOREIGN KEY(story_id,revision) REFERENCES community_story_revision(story_id,revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS community_story_revision_asset_asset_idx ON community_story_revision_asset(asset_id);
CREATE TABLE IF NOT EXISTS community_story_like (
  story_id TEXT NOT NULL REFERENCES community_story(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(story_id,user_id)
);
CREATE TABLE IF NOT EXISTS community_story_gc (
  object_key TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS community_story_action (
  story_id TEXT NOT NULL REFERENCES community_story(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('publish','unpublish','delete')),
  payload_hash TEXT NOT NULL,
  applied_version INTEGER NOT NULL CHECK(applied_version>0),
  revision INTEGER NOT NULL CHECK(revision>0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(story_id,request_id)
);

CREATE TABLE IF NOT EXISTS community_story_remix_grant (
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  source_story_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision>0),
  source_title TEXT NOT NULL,
  source_owner_uid INTEGER NOT NULL,
  source_owner_name TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,source_story_id)
);
