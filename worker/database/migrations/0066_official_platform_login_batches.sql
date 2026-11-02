CREATE TABLE IF NOT EXISTS official_platform_login_batches (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES official_platform_accounts(id),
  batch_id TEXT NOT NULL UNIQUE,
  account_version INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS official_platform_login_batch_removed
BEFORE DELETE ON official_platform_accounts
BEGIN
  DELETE FROM official_platform_login_batches WHERE account_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS official_platform_devices (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES official_platform_accounts(id),
  device_id TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS official_platform_device_removed
BEFORE DELETE ON official_platform_accounts
BEGIN
  DELETE FROM official_platform_devices WHERE account_id=OLD.id;
END;
