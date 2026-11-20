CREATE TABLE IF NOT EXISTS account_game_tool (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  tool TEXT NOT NULL CHECK (tool IN ('team', 'songs', 'history')),
  server TEXT NOT NULL REFERENCES resource_server(slug),
  uid TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(CAST(metadata_json AS BLOB)) <= 8192),
  source_time INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT CHECK (settings_json IS NULL OR json_valid(settings_json) AND length(CAST(settings_json AS BLOB)) <= 512),
  settings_time INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, tool, server, uid)
);

CREATE TABLE IF NOT EXISTS account_game_tool_box (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  box_json TEXT NOT NULL CHECK (
    json_valid(box_json) AND json_type(box_json) = 'object'
    AND COALESCE(json_extract(box_json, '$.schema'), '') = 'haneoka-team-box-v1'
    AND length(CAST(box_json AS BLOB)) <= 1048576
  ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (user_id, account_id),
  FOREIGN KEY (user_id, account_id) REFERENCES account_game_tool(user_id, id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS account_game_tool_after_profile_delete
AFTER UPDATE OF status ON community_profile
WHEN NEW.status = 'deleted'
BEGIN
  DELETE FROM account_game_tool WHERE user_id = NEW.user_id;
END;
