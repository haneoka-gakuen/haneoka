CREATE TABLE IF NOT EXISTS official_collector_removed_players (
  region TEXT NOT NULL,
  player_id TEXT NOT NULL,
  PRIMARY KEY (region, player_id)
);
CREATE TABLE IF NOT EXISTS official_collector_removed_guests (
  id TEXT PRIMARY KEY NOT NULL
);
CREATE TRIGGER IF NOT EXISTS official_guest_account_removed
BEFORE DELETE ON official_guest_accounts
BEGIN
  INSERT OR IGNORE INTO official_collector_removed_guests (id) VALUES (OLD.id);
  INSERT OR IGNORE INTO official_collector_removed_players (region, player_id)
    SELECT 'jp', OLD.player_id WHERE OLD.player_id IS NOT NULL;
  DELETE FROM official_guest_requests WHERE guest_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS official_platform_account_removed
BEFORE DELETE ON official_platform_accounts
BEGIN
  INSERT OR IGNORE INTO official_collector_removed_players (region, player_id)
    SELECT region, player_id FROM official_platform_roles
    WHERE account_id=OLD.id AND player_id IS NOT NULL;
  DELETE FROM official_platform_login_jobs WHERE account_id=OLD.id;
  DELETE FROM official_platform_sdk_sessions WHERE account_id=OLD.id;
  DELETE FROM official_platform_sdk_owners WHERE account_id=OLD.id;
  DELETE FROM official_platform_sdk_identities WHERE account_id=OLD.id;
  DELETE FROM official_platform_roles WHERE account_id=OLD.id;
END;
