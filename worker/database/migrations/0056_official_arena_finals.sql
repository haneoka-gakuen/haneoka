CREATE TABLE IF NOT EXISTS official_arena_finals (
  region TEXT NOT NULL,
  board_key TEXT NOT NULL,
  season_id TEXT NOT NULL,
  due_at_ms INTEGER NOT NULL,
  arena_json TEXT NOT NULL,
  catalog_observed_at_ms INTEGER NOT NULL,
  last_dispatch_at_ms INTEGER NOT NULL DEFAULT 0,
  last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  progress_json TEXT,
  snapshot_id TEXT,
  observed_at_ms INTEGER,
  payload_key TEXT,
  payload_hash TEXT,
  PRIMARY KEY (region, board_key)
);
CREATE INDEX IF NOT EXISTS official_arena_finals_pending
  ON official_arena_finals (region, last_dispatch_at_ms, due_at_ms) WHERE snapshot_id IS NULL;
CREATE INDEX IF NOT EXISTS official_arena_finals_payload ON official_arena_finals (payload_key);
