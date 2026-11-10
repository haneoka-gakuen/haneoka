CREATE TABLE IF NOT EXISTS community_comment_impression (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL REFERENCES community_comment(id) ON DELETE CASCADE,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  PRIMARY KEY (user_id, comment_id),
  CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX IF NOT EXISTS community_comment_impression_recent_idx
  ON community_comment_impression(user_id, last_seen_at DESC, comment_id);
