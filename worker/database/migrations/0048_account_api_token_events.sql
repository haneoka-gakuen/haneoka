CREATE TABLE IF NOT EXISTS account_api_token_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token_name TEXT NOT NULL,
  server TEXT NOT NULL,
  changed INTEGER NOT NULL CHECK (changed > 0),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS account_api_token_event_user_idx ON account_api_token_event (user_id, id DESC);

CREATE TRIGGER IF NOT EXISTS account_api_token_event_after_profile_delete
AFTER UPDATE OF status ON community_profile
WHEN NEW.status = 'deleted'
BEGIN
  DELETE FROM account_api_token_event WHERE user_id = NEW.user_id;
END;
