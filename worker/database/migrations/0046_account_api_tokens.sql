CREATE TABLE IF NOT EXISTS account_api_token (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS account_api_token_user_idx ON account_api_token (user_id, expires_at);

CREATE TRIGGER IF NOT EXISTS account_api_token_after_profile_delete
AFTER UPDATE OF status ON community_profile
WHEN NEW.status = 'deleted'
BEGIN
  DELETE FROM account_api_token WHERE user_id = NEW.user_id;
END;
