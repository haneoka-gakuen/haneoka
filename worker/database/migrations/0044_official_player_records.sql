CREATE TABLE IF NOT EXISTS official_player_profiles (
  region TEXT NOT NULL CHECK (region IN ('jp', 'tw', 'en', 'kr')),
  profile_id TEXT NOT NULL,
  found INTEGER NOT NULL DEFAULT 1,
  profile_json TEXT,
  total_favorite TEXT,
  observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (region, profile_id)
);

CREATE TABLE IF NOT EXISTS official_song_rankings (
  region TEXT NOT NULL CHECK (region IN ('jp', 'tw', 'en', 'kr')),
  music_id TEXT NOT NULL,
  payload_key TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (region, music_id)
);
