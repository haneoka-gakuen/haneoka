CREATE TABLE IF NOT EXISTS event_ranking_archive (
  region TEXT NOT NULL CHECK (region IN ('jp', 'tw', 'en', 'kr')),
  event_id TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (region, event_id)
);

CREATE TABLE IF NOT EXISTS event_ranking_archive_boards (
  region TEXT NOT NULL CHECK (region IN ('jp', 'tw', 'en', 'kr')),
  event_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (region, event_id, challenge_id)
);
