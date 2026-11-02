CREATE TABLE IF NOT EXISTS official_platform_login_jobs (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES official_platform_accounts(id),
  region TEXT NOT NULL CHECK (region IN ('tw', 'en', 'kr')),
  run_id TEXT NOT NULL UNIQUE,
  account_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at_ms INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);
