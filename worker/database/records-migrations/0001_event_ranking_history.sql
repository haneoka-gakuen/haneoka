-- Event ranking history moved out of haneoka-community. Full snapshots live
-- in R2 under event-history/{id}.json.gz; this table keeps what lists read.
CREATE TABLE IF NOT EXISTS game_event_ranking_history (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=64),
  region TEXT NOT NULL CHECK(region IN ('jp','tw','en','kr')),
  event_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL DEFAULT '',
  record_kind TEXT NOT NULL CHECK(record_kind IN ('snapshot','tier-history')),
  source_url TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
  first_source_at_ms INTEGER,
  last_source_at_ms INTEGER,
  last_server_time_ms INTEGER,
  first_observed_at_ms INTEGER NOT NULL,
  last_observed_at_ms INTEGER NOT NULL,
  rows_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS game_event_ranking_history_board_idx
  ON game_event_ranking_history (region, event_id, challenge_id, first_source_at_ms DESC, id DESC);
