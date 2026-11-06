CREATE TABLE IF NOT EXISTS spoiler_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  roles TEXT NOT NULL DEFAULT '["admin"]' CHECK (json_valid(roles) AND json_type(roles) = 'array'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO spoiler_setting (id, roles, version, updated_at)
VALUES (1, '["admin"]', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE IF NOT EXISTS account_spoiler_preference (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
);
