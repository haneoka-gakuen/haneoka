CREATE TABLE IF NOT EXISTS official_platform_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_box TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS official_platform_roles (
  account_id TEXT NOT NULL REFERENCES official_platform_accounts(id),
  region TEXT NOT NULL CHECK (region IN ('tw', 'en', 'kr')),
  status TEXT NOT NULL DEFAULT 'not_initialized',
  player_id TEXT,
  credential_box TEXT,
  last_verified_at_ms INTEGER,
  last_error_code TEXT,
  PRIMARY KEY (account_id, region)
);
