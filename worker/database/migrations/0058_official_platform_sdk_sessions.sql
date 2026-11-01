CREATE TABLE IF NOT EXISTS official_platform_sdk_sessions (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES official_platform_accounts(id),
  profile_scope TEXT NOT NULL,
  session_box TEXT NOT NULL,
  stored_at_ms INTEGER NOT NULL
);
