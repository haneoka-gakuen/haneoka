-- Community playlists: a member's ordered list of songs from either game.
-- Tracks are references (provider, server, musicId) resolved against the
-- catalogues on read, so a playlist never copies catalogue data.
CREATE TABLE IF NOT EXISTS community_playlist (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  description TEXT CHECK (description IS NULL OR length(description) <= 1000),
  cover_kind TEXT NOT NULL DEFAULT 'auto' CHECK (cover_kind IN ('auto', 'song', 'upload')),
  cover_song TEXT CHECK (cover_song IS NULL OR length(cover_song) <= 80),
  cover_attachment_id TEXT REFERENCES community_attachment(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  track_count INTEGER NOT NULL DEFAULT 0 CHECK (track_count BETWEEN 0 AND 500),
  like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  deleted_at INTEGER,
  CHECK (updated_at >= created_at),
  CHECK (cover_kind <> 'song' OR cover_song IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS community_playlist_owner_idx
  ON community_playlist (owner_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS community_playlist_public_new_idx
  ON community_playlist (visibility, deleted_at, published_at DESC);
CREATE INDEX IF NOT EXISTS community_playlist_public_popular_idx
  ON community_playlist (visibility, deleted_at, like_count DESC, published_at DESC);
CREATE INDEX IF NOT EXISTS community_playlist_cover_idx
  ON community_playlist (cover_attachment_id) WHERE cover_attachment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS community_playlist_track (
  playlist_id TEXT NOT NULL REFERENCES community_playlist(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 499),
  provider TEXT NOT NULL CHECK (provider IN ('our-notes', 'bestdori')),
  server TEXT NOT NULL CHECK (length(server) BETWEEN 1 AND 16),
  music_id TEXT NOT NULL CHECK (length(music_id) BETWEEN 1 AND 24),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position),
  UNIQUE (playlist_id, provider, server, music_id)
);

CREATE TABLE IF NOT EXISTS community_playlist_like (
  playlist_id TEXT NOT NULL REFERENCES community_playlist(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, user_id)
);

CREATE INDEX IF NOT EXISTS community_playlist_like_user_idx
  ON community_playlist_like (user_id, created_at DESC);
