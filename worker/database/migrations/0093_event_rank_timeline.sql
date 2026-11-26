CREATE INDEX IF NOT EXISTS official_event_window_rank_timeline
  ON official_event_window_observations (region, event_id, start_rank, observed_at_ms);
