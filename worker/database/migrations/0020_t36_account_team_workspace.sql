CREATE TABLE account_team_workspace (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  server TEXT NOT NULL REFERENCES resource_server(slug) ON DELETE CASCADE,
  workspace_json TEXT NOT NULL CHECK (
    json_valid(workspace_json)
    AND json_type(workspace_json) = 'object'
    AND COALESCE(json_extract(workspace_json, '$.schema'), '') = 'haneoka-team-workspace-v1'
    AND length(CAST(workspace_json AS BLOB)) <= 1048576
  ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (user_id, server)
);

CREATE TRIGGER account_team_workspace_after_profile_delete
AFTER UPDATE OF status ON community_profile
WHEN NEW.status = 'deleted'
BEGIN
  DELETE FROM account_team_workspace WHERE user_id = NEW.user_id;
END;
