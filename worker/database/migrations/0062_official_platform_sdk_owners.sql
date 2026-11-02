CREATE TABLE IF NOT EXISTS official_platform_sdk_owners (
  identity_scope TEXT NOT NULL,
  sdk_uid TEXT NOT NULL,
  account_id TEXT REFERENCES official_platform_accounts(id),
  bound_at_ms INTEGER NOT NULL,
  PRIMARY KEY (identity_scope, sdk_uid)
);

INSERT INTO official_platform_sdk_owners (identity_scope,sdk_uid,account_id,bound_at_ms)
SELECT identity_scope,sdk_uid,CASE WHEN COUNT(*)=1 THEN MIN(account_id) ELSE NULL END,MIN(bound_at_ms)
FROM official_platform_sdk_identities GROUP BY identity_scope,sdk_uid
ON CONFLICT(identity_scope,sdk_uid) DO NOTHING;
