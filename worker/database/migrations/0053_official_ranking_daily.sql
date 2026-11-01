CREATE TABLE IF NOT EXISTS official_ranking_daily (
  region TEXT NOT NULL CHECK (region IN ('jp', 'tw', 'en', 'kr')),
  board_key TEXT NOT NULL,
  day INTEGER NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  snapshot_id TEXT NOT NULL,
  payload_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (region, board_key, day)
);
CREATE INDEX IF NOT EXISTS official_ranking_daily_payload
  ON official_ranking_daily (payload_key);


INSERT INTO official_ranking_daily
  (region, board_key, day, observed_at_ms, snapshot_id, payload_key, payload_hash)
SELECT region, board_key, day, observed_at_ms, snapshot_id, payload_key, payload_hash
FROM (
  SELECT candidates.*, ROW_NUMBER() OVER (
    PARTITION BY region, board_key, day ORDER BY observed_at_ms DESC, cursor DESC
  ) AS position
  FROM (
    SELECT region, 'event/' || event_id || '/' ||
      CASE WHEN board_kind = 'challenge' AND challenge_id = 'point' THEN 'point/'
        ELSE board_kind || '/' || challenge_id END AS board_key,
      CAST((observed_at_ms + 32400000) / 86400000 AS INTEGER) AS day,
      observed_at_ms, snapshot_id, payload_key, payload_hash, cursor
    FROM official_ranking_observations WHERE error IS NULL
    UNION ALL
    SELECT region, 'arena/' || season_id || '/' || band_id || '/' || start_rank,
      CAST((observed_at_ms + 32400000) / 86400000 AS INTEGER),
      observed_at_ms, snapshot_id, payload_key, payload_hash, cursor
    FROM official_arena_ranking_observations WHERE error IS NULL
    UNION ALL
    SELECT region, 'event-window/' || event_id || '/' || start_rank,
      CAST((observed_at_ms + 32400000) / 86400000 AS INTEGER),
      observed_at_ms, snapshot_id, payload_key, payload_hash, cursor
    FROM official_event_window_observations WHERE error IS NULL
    UNION ALL
    SELECT region, 'population/' || season_id || '/' || band_id,
      CAST((observed_at_ms + 32400000) / 86400000 AS INTEGER),
      observed_at_ms, snapshot_id, payload_key, payload_hash, cursor
    FROM official_arena_population_observations
  ) AS candidates
) WHERE position = 1
ON CONFLICT(region, board_key, day) DO NOTHING;
