CREATE TABLE IF NOT EXISTS community_story_resource_review (
  id TEXT PRIMARY KEY NOT NULL,
  blob_hash TEXT NOT NULL UNIQUE REFERENCES community_story_blob(hash) ON DELETE CASCADE,
  media_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('review','allow','block')),
  source TEXT NOT NULL CHECK(source IN ('upload','trusted','legacy','manual')),
  reviewer_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  decision_operation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS community_story_resource_review_pending_idx
 ON community_story_resource_review(created_at DESC,id) WHERE status='review';
INSERT OR IGNORE INTO community_story_resource_review(id,blob_hash,media_type,file_name,status,source,created_at,updated_at)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
 b.hash,min(a.media_type),b.hash,b.moderation_status,'legacy',b.created_at,b.updated_at
FROM community_story_blob b JOIN community_story_asset a ON a.blob_hash=b.hash
WHERE b.state='active' AND (a.kind='audio' OR a.media_type='image/svg+xml') GROUP BY b.hash;
