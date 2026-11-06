CREATE TABLE IF NOT EXISTS content_visibility_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  policy TEXT NOT NULL CHECK (json_valid(policy) AND json_type(policy) = 'object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO content_visibility_setting (id, policy, version, updated_at)
VALUES (1, '{"eventChallengeSongs":true,"types":{}}', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
