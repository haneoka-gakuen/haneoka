CREATE TABLE IF NOT EXISTS _player_profile_observations (
  region TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (region, profile_id),
  FOREIGN KEY (region, profile_id) REFERENCES official_player_profiles(region, profile_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) WITHOUT ROWID;
