CREATE TABLE IF NOT EXISTS account_api_token_scope (
  token_id TEXT NOT NULL REFERENCES account_api_token(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('profile:read', 'games:read', 'team:read', 'team:write', 'gacha:read')),
  PRIMARY KEY (token_id, scope)
);

INSERT OR IGNORE INTO account_api_token_scope (token_id, scope)
SELECT id, 'team:read' FROM account_api_token;
