-- Pruning reads raw observations by age and finds each Arena window's latest snapshot.
CREATE INDEX IF NOT EXISTS official_ranking_observed
  ON official_ranking_observations (observed_at_ms);
CREATE INDEX IF NOT EXISTS official_arena_ranking_observed
  ON official_arena_ranking_observations (observed_at_ms);
CREATE INDEX IF NOT EXISTS official_arena_population_observed
  ON official_arena_population_observations (observed_at_ms);
CREATE INDEX IF NOT EXISTS official_arena_window_snapshot
  ON official_arena_window_metadata (region, snapshot_id);
CREATE INDEX IF NOT EXISTS official_ranking_board_observed
  ON official_ranking_observations (region, event_id, board_kind, challenge_id, observed_at_ms, cursor);
