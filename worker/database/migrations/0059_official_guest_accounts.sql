CREATE TABLE IF NOT EXISTS official_guest_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('queued','creating','created','verifying','ready','failed','uncertain')),
  run_id TEXT NOT NULL UNIQUE,
  deadline_ms INTEGER NOT NULL,
  player_id TEXT UNIQUE,
  profile_id TEXT,
  configuration_box TEXT,
  created_at_ms INTEGER NOT NULL,
  last_verified_at_ms INTEGER,
  last_error_code TEXT
);
