CREATE TABLE IF NOT EXISTS account_api_token_resource_scope (
  token_id TEXT PRIMARY KEY REFERENCES account_api_token(id) ON DELETE CASCADE
);
