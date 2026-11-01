CREATE TABLE IF NOT EXISTS official_platform_sdk_identities (
  account_id TEXT NOT NULL REFERENCES official_platform_accounts(id),
  identity_scope TEXT NOT NULL,
  sdk_uid TEXT NOT NULL,
  bound_at_ms INTEGER NOT NULL,
  PRIMARY KEY (account_id, identity_scope)
);
