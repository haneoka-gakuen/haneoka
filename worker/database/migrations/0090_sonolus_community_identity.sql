CREATE TABLE IF NOT EXISTS sonolus_account_link (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  sonolus_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sonolus_link_challenge (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  browser_session_id TEXT NOT NULL REFERENCES "session"(id) ON DELETE CASCADE,
  digest TEXT NOT NULL UNIQUE,
  endpoint TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  sonolus_id TEXT,
  display_name TEXT
);

CREATE TABLE IF NOT EXISTS sonolus_community_session (
  digest TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES sonolus_account_link(user_id) ON DELETE CASCADE,
  proof TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sonolus_community_session_expiry ON sonolus_community_session(expires_at);
CREATE INDEX IF NOT EXISTS sonolus_community_session_owner ON sonolus_community_session(user_id);
CREATE INDEX IF NOT EXISTS sonolus_link_challenge_expiry ON sonolus_link_challenge(expires_at);
CREATE INDEX IF NOT EXISTS sonolus_link_challenge_browser ON sonolus_link_challenge(browser_session_id);
