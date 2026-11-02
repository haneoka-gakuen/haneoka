CREATE TABLE IF NOT EXISTS official_observation_payload_gc (
  payload_key TEXT PRIMARY KEY NOT NULL,
  region TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  queued_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS official_observation_payload_gc_due
  ON official_observation_payload_gc (queued_at_ms, payload_key);

CREATE TRIGGER IF NOT EXISTS official_ranking_observation_retired
AFTER DELETE ON official_ranking_observations
BEGIN
  INSERT INTO official_observation_payload_gc (payload_key, region, snapshot_id)
    VALUES (OLD.payload_key, OLD.region, OLD.snapshot_id) ON CONFLICT(payload_key) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS official_arena_observation_retired
AFTER DELETE ON official_arena_ranking_observations
BEGIN
  INSERT INTO official_observation_payload_gc (payload_key, region, snapshot_id)
    VALUES (OLD.payload_key, OLD.region, OLD.snapshot_id) ON CONFLICT(payload_key) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS official_event_window_retired
AFTER DELETE ON official_event_window_observations
BEGIN
  INSERT INTO official_observation_payload_gc (payload_key, region, snapshot_id)
    VALUES (OLD.payload_key, OLD.region, OLD.snapshot_id) ON CONFLICT(payload_key) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS official_arena_population_retired
AFTER DELETE ON official_arena_population_observations
BEGIN
  INSERT INTO official_observation_payload_gc (payload_key, region, snapshot_id)
    VALUES (OLD.payload_key, OLD.region, OLD.snapshot_id) ON CONFLICT(payload_key) DO NOTHING;
END;
