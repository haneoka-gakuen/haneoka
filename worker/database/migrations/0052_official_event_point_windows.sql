-- Event point boards read in windows of 100, past the top 100 the point board keeps.
CREATE TABLE IF NOT EXISTS official_event_window_observations (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  region TEXT NOT NULL CHECK (region IN ('jp', 'tw', 'en', 'kr')),
  snapshot_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  start_rank INTEGER NOT NULL CHECK (start_rank >= 1),
  end_rank INTEGER NOT NULL,
  max_rank INTEGER,
  observed_at_ms INTEGER NOT NULL,
  payload_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  error TEXT,
  UNIQUE (region, snapshot_id),
  CHECK (end_rank >= start_rank AND end_rank - start_rank < 100)
);
CREATE INDEX IF NOT EXISTS official_event_window_observed
  ON official_event_window_observations (observed_at_ms);
CREATE TABLE IF NOT EXISTS official_event_window_metadata (
  region TEXT NOT NULL CHECK (region IN ('jp', 'tw', 'en', 'kr')),
  event_id TEXT NOT NULL,
  start_rank INTEGER NOT NULL,
  end_rank INTEGER NOT NULL,
  max_rank INTEGER,
  player_count INTEGER NOT NULL CHECK (player_count BETWEEN 0 AND 100),
  profile_index TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  payload_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (region, event_id, start_rank)
);
CREATE INDEX IF NOT EXISTS official_event_window_snapshot
  ON official_event_window_metadata (region, snapshot_id);
