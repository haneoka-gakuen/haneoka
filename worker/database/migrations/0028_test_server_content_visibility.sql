CREATE TABLE IF NOT EXISTS site_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  show_test_server_content INTEGER NOT NULL DEFAULT 0 CHECK (show_test_server_content IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO site_setting (id, show_test_server_content, version, updated_at)
VALUES (1, 0, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
