CREATE TABLE IF NOT EXISTS official_storage_sweeps (
  region TEXT PRIMARY KEY NOT NULL,
  initialized_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  format_version INTEGER NOT NULL DEFAULT 2,
  cursor TEXT,
  next_scan_at_ms INTEGER NOT NULL DEFAULT 0,
  last_completed_at_ms INTEGER,
  first_run_at_ms INTEGER,
  lease_id TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  scanned_objects INTEGER NOT NULL DEFAULT 0,
  orphan_candidates INTEGER NOT NULL DEFAULT 0,
  deleted_objects INTEGER NOT NULL DEFAULT 0,
  known_deleted_bytes INTEGER NOT NULL DEFAULT 0,
  rewritten_objects INTEGER NOT NULL DEFAULT 0,
  saved_bytes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO official_storage_sweeps (region) VALUES ('jp'),('tw'),('en'),('kr') ON CONFLICT(region) DO NOTHING;

CREATE TABLE IF NOT EXISTS official_payload_maintenance (
  payload_key TEXT PRIMARY KEY NOT NULL,
  region TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_at_ms INTEGER NOT NULL,
  orphan_at_ms INTEGER,
  compressed_at_ms INTEGER,
  checked_gc_at_ms INTEGER NOT NULL DEFAULT 0,
  retry_at_ms INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS official_payload_maintenance_due
  ON official_payload_maintenance (region, retry_at_ms, size_bytes DESC);
CREATE INDEX IF NOT EXISTS official_arena_window_payload ON official_arena_window_metadata (payload_key);
CREATE INDEX IF NOT EXISTS official_event_window_metadata_payload ON official_event_window_metadata (payload_key);

CREATE TRIGGER IF NOT EXISTS official_ranking_payload_retirement_clock
AFTER DELETE ON official_ranking_observations
BEGIN
  INSERT INTO official_observation_payload_gc (payload_key,region,snapshot_id)
    VALUES (OLD.payload_key,OLD.region,OLD.snapshot_id) ON CONFLICT(payload_key)
    DO UPDATE SET queued_at_ms=excluded.queued_at_ms WHERE excluded.queued_at_ms>official_observation_payload_gc.queued_at_ms;
END;
CREATE TRIGGER IF NOT EXISTS official_arena_payload_retirement_clock
AFTER DELETE ON official_arena_ranking_observations
BEGIN
  INSERT INTO official_observation_payload_gc (payload_key,region,snapshot_id)
    VALUES (OLD.payload_key,OLD.region,OLD.snapshot_id) ON CONFLICT(payload_key)
    DO UPDATE SET queued_at_ms=excluded.queued_at_ms WHERE excluded.queued_at_ms>official_observation_payload_gc.queued_at_ms;
END;
CREATE TRIGGER IF NOT EXISTS official_event_window_payload_retirement_clock
AFTER DELETE ON official_event_window_observations
BEGIN
  INSERT INTO official_observation_payload_gc (payload_key,region,snapshot_id)
    VALUES (OLD.payload_key,OLD.region,OLD.snapshot_id) ON CONFLICT(payload_key)
    DO UPDATE SET queued_at_ms=excluded.queued_at_ms WHERE excluded.queued_at_ms>official_observation_payload_gc.queued_at_ms;
END;
CREATE TRIGGER IF NOT EXISTS official_population_payload_retirement_clock
AFTER DELETE ON official_arena_population_observations
BEGIN
  INSERT INTO official_observation_payload_gc (payload_key,region,snapshot_id)
    VALUES (OLD.payload_key,OLD.region,OLD.snapshot_id) ON CONFLICT(payload_key)
    DO UPDATE SET queued_at_ms=excluded.queued_at_ms WHERE excluded.queued_at_ms>official_observation_payload_gc.queued_at_ms;
END;

UPDATE official_observation_payload_gc
  SET queued_at_ms=MAX(queued_at_ms,(SELECT initialized_at_ms FROM official_storage_sweeps WHERE region=official_observation_payload_gc.region))
  WHERE region IN ('jp','tw','en','kr');
