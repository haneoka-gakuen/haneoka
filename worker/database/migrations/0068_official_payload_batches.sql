CREATE TABLE IF NOT EXISTS official_observation_batches (
  payload_key TEXT PRIMARY KEY NOT NULL,
  region TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  byte_size INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS official_observation_batches_due
  ON official_observation_batches (region, created_at_ms);

CREATE TABLE IF NOT EXISTS official_observation_payloads (
  payload_key TEXT NOT NULL REFERENCES official_observation_batches(payload_key),
  payload_hash TEXT NOT NULL,
  body_json TEXT NOT NULL,
  PRIMARY KEY (payload_key, payload_hash)
);

CREATE INDEX IF NOT EXISTS official_ranking_observation_payload
  ON official_ranking_observations (payload_key);
CREATE INDEX IF NOT EXISTS official_arena_observation_payload
  ON official_arena_ranking_observations (payload_key);
CREATE INDEX IF NOT EXISTS official_event_window_payload
  ON official_event_window_observations (payload_key);
CREATE INDEX IF NOT EXISTS official_arena_population_payload
  ON official_arena_population_observations (payload_key);
CREATE INDEX IF NOT EXISTS official_ranking_daily_snapshot
  ON official_ranking_daily (region, snapshot_id);
CREATE INDEX IF NOT EXISTS official_ranking_final_snapshot
  ON official_ranking_finals (region, snapshot_id) WHERE snapshot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS official_arena_final_snapshot
  ON official_arena_finals (region, snapshot_id) WHERE snapshot_id IS NOT NULL;
