CREATE TABLE IF NOT EXISTS account_game_tool_purge (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS account_game_tool_purges_after_profile_delete
AFTER UPDATE OF status ON community_profile
WHEN NEW.status = 'deleted'
BEGIN
  DELETE FROM account_game_tool_purge WHERE user_id = NEW.user_id;
END;
