CREATE TABLE IF NOT EXISTS official_ranking_search_windows (
  region TEXT NOT NULL CHECK (region IN ('jp', 'tw', 'en', 'kr')),
  board_key TEXT NOT NULL,
  start_rank INTEGER NOT NULL CHECK (start_rank >= 1),
  snapshot_id TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  players_json TEXT NOT NULL,
  PRIMARY KEY (region, board_key, start_rank)
);
