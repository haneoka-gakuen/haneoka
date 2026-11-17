CREATE TABLE IF NOT EXISTS account_gacha_history_alias (
  user_id TEXT NOT NULL,
  alias_key TEXT NOT NULL CHECK (length(alias_key) = 64 AND alias_key NOT GLOB '*[^a-f0-9]*'),
  canonical_key TEXT NOT NULL,
  server TEXT NOT NULL CHECK (server IN ('jp', 'global-hmt', 'global-en', 'global-kr')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, alias_key),
  FOREIGN KEY (user_id, canonical_key) REFERENCES account_gacha_history(user_id, account_key) ON DELETE CASCADE,
  CHECK (alias_key <> canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_gacha_history_alias_target ON account_gacha_history_alias(user_id, canonical_key);

CREATE TABLE IF NOT EXISTS account_gacha_history_original (
  user_id TEXT NOT NULL,
  account_key TEXT NOT NULL,
  history_json TEXT NOT NULL CHECK (json_valid(history_json) AND length(CAST(history_json AS BLOB)) <= 1048576),
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, account_key),
  FOREIGN KEY (user_id, account_key) REFERENCES account_gacha_history(user_id, account_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_gacha_history_combine (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  sources_json TEXT NOT NULL CHECK (json_valid(sources_json) AND json_type(sources_json) = 'array' AND json_array_length(sources_json) BETWEEN 2 AND 64),
  history_json TEXT NOT NULL CHECK (json_valid(history_json) AND length(CAST(history_json AS BLOB)) <= 1048576),
  created_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS gacha_history_combine_guard
BEFORE INSERT ON account_gacha_history_combine
BEGIN
  SELECT CASE WHEN
    NOT EXISTS (SELECT 1 FROM account_gacha_history h JOIN json_each(NEW.sources_json) s
      ON h.account_key = json_extract(s.value, '$.accountKey') AND h.revision = json_extract(s.value, '$.revision')
      WHERE h.user_id = NEW.user_id AND h.account_key = NEW.canonical_key)
    OR EXISTS (SELECT 1 FROM account_gacha_history_alias WHERE user_id = NEW.user_id AND alias_key = NEW.canonical_key)
    OR (SELECT COUNT(DISTINCT json_extract(value, '$.accountKey')) FROM json_each(NEW.sources_json)) <> json_array_length(NEW.sources_json)
    OR EXISTS (SELECT 1 FROM json_each(NEW.sources_json) s
      LEFT JOIN account_gacha_history h ON h.user_id = NEW.user_id AND h.account_key = json_extract(s.value, '$.accountKey')
      WHERE (json_type(s.value, '$.revision') = 'null' AND h.account_key IS NOT NULL)
        OR (json_type(s.value, '$.revision') <> 'null' AND (h.account_key IS NULL OR h.revision <> json_extract(s.value, '$.revision')))
        OR (h.account_key IS NOT NULL AND h.server <> (SELECT server FROM account_gacha_history WHERE user_id = NEW.user_id AND account_key = NEW.canonical_key)))
    OR EXISTS (SELECT 1 FROM account_gacha_history_alias a JOIN json_each(NEW.sources_json) s ON a.alias_key = json_extract(s.value, '$.accountKey')
      WHERE a.user_id = NEW.user_id AND a.canonical_key NOT IN (SELECT json_extract(value, '$.accountKey') FROM json_each(NEW.sources_json)))
    THEN RAISE(ABORT, 'history_merge_conflict') END;
END;

CREATE TRIGGER IF NOT EXISTS gacha_history_combine_apply
AFTER INSERT ON account_gacha_history_combine
BEGIN
  INSERT OR IGNORE INTO account_gacha_history_original(user_id, account_key, history_json, revision, updated_at)
    SELECT user_id, account_key, history_json, revision, updated_at FROM account_gacha_history
    WHERE user_id = NEW.user_id AND account_key = NEW.canonical_key;
  UPDATE account_gacha_history SET history_json = NEW.history_json, revision = revision + 1, updated_at = NEW.created_at,
    refresh_requested = refresh_requested + COALESCE((SELECT SUM(h.refresh_requested - h.refresh_completed) FROM account_gacha_history h
      JOIN json_each(NEW.sources_json) s ON h.account_key = json_extract(s.value, '$.accountKey')
      WHERE h.user_id = NEW.user_id AND h.account_key <> NEW.canonical_key AND NOT EXISTS
        (SELECT 1 FROM account_gacha_history_alias a WHERE a.user_id = h.user_id AND a.alias_key = h.account_key)), 0)
    WHERE user_id = NEW.user_id AND account_key = NEW.canonical_key;
  UPDATE account_gacha_history_alias SET canonical_key = NEW.canonical_key WHERE user_id = NEW.user_id
    AND canonical_key IN (SELECT json_extract(value, '$.accountKey') FROM json_each(NEW.sources_json));
  INSERT INTO account_gacha_history_alias(user_id, alias_key, canonical_key, server, created_at)
    SELECT NEW.user_id, json_extract(s.value, '$.accountKey'), NEW.canonical_key, h.server, NEW.created_at
    FROM json_each(NEW.sources_json) s JOIN account_gacha_history h ON h.user_id = NEW.user_id AND h.account_key = NEW.canonical_key
    WHERE json_extract(s.value, '$.accountKey') <> NEW.canonical_key
    ON CONFLICT(user_id, alias_key) DO UPDATE SET canonical_key = excluded.canonical_key;
  DELETE FROM account_gacha_history_combine WHERE id = NEW.id;
END;
