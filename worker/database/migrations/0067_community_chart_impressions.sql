CREATE TABLE IF NOT EXISTS community_chart_impression (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chart_id TEXT NOT NULL REFERENCES community_chart(id) ON DELETE CASCADE,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  PRIMARY KEY (user_id, chart_id),
  CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX IF NOT EXISTS community_chart_impression_recent_idx
  ON community_chart_impression(user_id, last_seen_at DESC, chart_id);
