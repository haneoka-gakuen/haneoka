CREATE TABLE IF NOT EXISTS account_private_game_save (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  snapshot_time INTEGER NOT NULL,
  digest TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(CAST(metadata_json AS BLOB)) <= 4096),
  PRIMARY KEY (user_id, id)
);

CREATE TRIGGER IF NOT EXISTS private_game_save_after_profile_delete
AFTER UPDATE OF status ON community_profile
WHEN NEW.status = 'deleted'
BEGIN
  DELETE FROM account_private_game_save WHERE user_id = NEW.user_id;
END;
