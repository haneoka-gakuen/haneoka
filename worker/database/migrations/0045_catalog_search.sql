CREATE TABLE IF NOT EXISTS catalog_search_releases (
  server TEXT PRIMARY KEY CHECK (server IN ('jp', 'intl')),
  release_id TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_search_documents (
  rowid INTEGER PRIMARY KEY,
  server TEXT NOT NULL CHECK (server IN ('jp', 'intl')),
  release_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  section TEXT NOT NULL,
  path TEXT NOT NULL,
  image TEXT,
  titles_json TEXT NOT NULL,
  texts_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS catalog_search_documents_release_idx ON catalog_search_documents (server, release_id);

CREATE VIRTUAL TABLE IF NOT EXISTS catalog_search_fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');
