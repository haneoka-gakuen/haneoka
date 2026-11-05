CREATE TABLE IF NOT EXISTS official_ranking_search_backfills (
  region TEXT NOT NULL CHECK (region IN ('jp', 'tw', 'en', 'kr')),
  board_key TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  PRIMARY KEY (region, board_key)
);
