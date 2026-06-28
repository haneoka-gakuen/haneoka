-- Expand the v1 community into an auditable social system without inventing
-- pre-migration history. Existing content is captured once as a migration snapshot.
PRAGMA defer_foreign_keys = ON;
PRAGMA foreign_keys = ON;

CREATE TABLE auth_email_delivery_guard (
  recipient_hash TEXT NOT NULL CHECK (length(recipient_hash) = 64),
  purpose TEXT NOT NULL CHECK (purpose IN ('account-change', 'password-reset', 'signup-verification')),
  window_started_at INTEGER NOT NULL,
  sent_count INTEGER NOT NULL CHECK (sent_count BETWEEN 1 AND 10),
  last_sent_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recipient_hash, purpose),
  CHECK (last_sent_at >= window_started_at),
  CHECK (updated_at >= last_sent_at)
);

CREATE INDEX auth_email_delivery_guard_updated_idx
  ON auth_email_delivery_guard(updated_at);

-- Re-registering an unverified email requires the mailbox owner to choose the
-- final password. This durable gate outlives all stateless verification links;
-- an expired claim can be replaced without making an older link authoritative.
CREATE TABLE auth_signup_completion (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  required_at INTEGER NOT NULL CHECK (required_at >= 0),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 9007199254740991),
  claim_token_hash TEXT CHECK (claim_token_hash IS NULL OR length(claim_token_hash) = 64),
  claim_token_expires_at INTEGER CHECK (claim_token_expires_at IS NULL OR claim_token_expires_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= required_at),
  CHECK (
    (claim_token_hash IS NULL AND claim_token_expires_at IS NULL)
    OR (claim_token_hash IS NOT NULL AND claim_token_expires_at IS NOT NULL)
  )
);

CREATE TRIGGER auth_signup_completion_requires_unverified_email
BEFORE INSERT ON auth_signup_completion
WHEN NOT EXISTS (
  SELECT 1 FROM "user" WHERE id = NEW.user_id AND emailVerified = 0
)
BEGIN
  SELECT RAISE(ABORT, 'signup completion requires an unverified email');
END;

CREATE TRIGGER auth_signup_completion_invariant_before_update
BEFORE UPDATE ON auth_signup_completion
WHEN NEW.user_id IS NOT OLD.user_id
  OR NEW.required_at IS NOT OLD.required_at
  OR NEW.generation NOT IN (OLD.generation, OLD.generation + 1)
  OR (
    NEW.generation = OLD.generation + 1
    AND (NEW.claim_token_hash IS NOT NULL OR NEW.claim_token_expires_at IS NOT NULL)
  )
  OR NEW.updated_at < OLD.updated_at
  OR NOT EXISTS (
    SELECT 1 FROM "user" WHERE id = NEW.user_id AND emailVerified = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'signup completion identity is immutable and must remain unverified');
END;

-- Application code removes the matching completion row in the same D1 batch
-- immediately before the successful password-reset flow verifies the address.
-- This trigger closes the race between that flow and an older verification URL.
CREATE TRIGGER auth_signup_completion_blocks_email_verification
BEFORE UPDATE OF emailVerified ON "user"
WHEN OLD.emailVerified = 0
  AND NEW.emailVerified = 1
  AND EXISTS (
    SELECT 1 FROM auth_signup_completion WHERE user_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'final password setup is required before email verification');
END;

-- Existing likes predate activation tracking. They intentionally retain NULL so
-- retrying an already-active legacy relationship cannot manufacture an event.
ALTER TABLE community_reaction ADD COLUMN activation_id TEXT
  CHECK (activation_id IS NULL OR length(activation_id) = 36);

ALTER TABLE community_post ADD COLUMN published_at INTEGER;
ALTER TABLE community_post ADD COLUMN bookmark_count INTEGER NOT NULL DEFAULT 0 CHECK (bookmark_count >= 0);
ALTER TABLE community_post ADD COLUMN deleted_by_user_id TEXT REFERENCES "user"(id) ON DELETE RESTRICT;
ALTER TABLE community_post ADD COLUMN delete_reason_code TEXT
  CHECK (delete_reason_code IS NULL OR length(delete_reason_code) BETWEEN 1 AND 80);
ALTER TABLE community_post ADD COLUMN comments_locked_at INTEGER;
ALTER TABLE community_post ADD COLUMN comments_locked_by_user_id TEXT REFERENCES "user"(id) ON DELETE RESTRICT;
ALTER TABLE community_post ADD COLUMN ip_country_code TEXT CHECK (
  ip_country_code IS NULL OR (length(ip_country_code) = 2 AND ip_country_code = upper(ip_country_code))
);
ALTER TABLE community_post ADD COLUMN ip_region_code TEXT
  CHECK (ip_region_code IS NULL OR length(ip_region_code) BETWEEN 1 AND 32);
ALTER TABLE community_post ADD COLUMN ip_region_name TEXT
  CHECK (ip_region_name IS NULL OR length(ip_region_name) <= 120);
ALTER TABLE community_post ADD COLUMN ip_address TEXT
  CHECK (ip_address IS NULL OR length(ip_address) BETWEEN 3 AND 45);
ALTER TABLE community_post ADD COLUMN user_agent TEXT
  CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 1024);
ALTER TABLE community_post ADD COLUMN browser_family TEXT CHECK (
  browser_family IS NULL OR browser_family IN (
    'arc', 'bot', 'brave', 'chrome', 'chromium', 'duckduckgo', 'edge', 'electron',
    'firefox', 'floorp', 'helium', 'internet_explorer', 'librewolf', 'opera', 'opera_gx',
    'other', 'safari', 'samsung_internet', 'tor', 'unknown', 'vivaldi', 'webview', 'yandex', 'zen'
  )
);
ALTER TABLE community_post ADD COLUMN os_family TEXT CHECK (
  os_family IS NULL OR os_family IN (
    'alpine_linux', 'android', 'arch_linux', 'blackberry', 'centos', 'chromeos', 'debian',
    'elementary', 'fedora', 'freebsd', 'fuchsia', 'gentoo', 'grapheneos', 'haiku', 'harmonyos',
    'ios', 'kaios', 'kali_linux', 'lineageos', 'linux', 'linux_mint', 'macos', 'manjaro',
    'netbsd', 'openbsd', 'opensuse', 'other', 'sailfish', 'ubuntu', 'unknown', 'wear_os', 'windows'
  )
);

ALTER TABLE community_comment ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE community_comment ADD COLUMN moderation_revision INTEGER NOT NULL DEFAULT 1
  CHECK (moderation_revision >= 1);
ALTER TABLE community_comment ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0);
ALTER TABLE community_comment ADD COLUMN deleted_by_user_id TEXT REFERENCES "user"(id) ON DELETE RESTRICT;
ALTER TABLE community_comment ADD COLUMN delete_reason_code TEXT
  CHECK (delete_reason_code IS NULL OR length(delete_reason_code) BETWEEN 1 AND 80);
ALTER TABLE community_comment ADD COLUMN ip_country_code TEXT CHECK (
  ip_country_code IS NULL OR (length(ip_country_code) = 2 AND ip_country_code = upper(ip_country_code))
);
ALTER TABLE community_comment ADD COLUMN ip_region_code TEXT
  CHECK (ip_region_code IS NULL OR length(ip_region_code) BETWEEN 1 AND 32);
ALTER TABLE community_comment ADD COLUMN ip_region_name TEXT
  CHECK (ip_region_name IS NULL OR length(ip_region_name) <= 120);
ALTER TABLE community_comment ADD COLUMN ip_address TEXT
  CHECK (ip_address IS NULL OR length(ip_address) BETWEEN 3 AND 45);
ALTER TABLE community_comment ADD COLUMN user_agent TEXT
  CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 1024);
ALTER TABLE community_comment ADD COLUMN browser_family TEXT CHECK (
  browser_family IS NULL OR browser_family IN (
    'arc', 'bot', 'brave', 'chrome', 'chromium', 'duckduckgo', 'edge', 'electron',
    'firefox', 'floorp', 'helium', 'internet_explorer', 'librewolf', 'opera', 'opera_gx',
    'other', 'safari', 'samsung_internet', 'tor', 'unknown', 'vivaldi', 'webview', 'yandex', 'zen'
  )
);
ALTER TABLE community_comment ADD COLUMN os_family TEXT CHECK (
  os_family IS NULL OR os_family IN (
    'alpine_linux', 'android', 'arch_linux', 'blackberry', 'centos', 'chromeos', 'debian',
    'elementary', 'fedora', 'freebsd', 'fuchsia', 'gentoo', 'grapheneos', 'haiku', 'harmonyos',
    'ios', 'kaios', 'kali_linux', 'lineageos', 'linux', 'linux_mint', 'macos', 'manjaro',
    'netbsd', 'openbsd', 'opensuse', 'other', 'sailfish', 'ubuntu', 'unknown', 'wear_os', 'windows'
  )
);
ALTER TABLE community_comment ADD COLUMN hidden_at INTEGER;
ALTER TABLE community_comment ADD COLUMN hidden_by_user_id TEXT REFERENCES "user"(id) ON DELETE RESTRICT;

-- Reserve @<digits> for public UID mentions without rewriting or deleting any
-- legacy numeric-only handle. Existing values remain readable and can be
-- changed to a non-numeric handle; only new ambiguous assignments are blocked.
CREATE TRIGGER community_profile_numeric_handle_before_insert
BEFORE INSERT ON community_profile
WHEN NEW.handle IS NOT NULL AND NEW.handle NOT GLOB '*[^0-9]*'
BEGIN
  SELECT RAISE(ABORT, 'numeric-only community handles are reserved for public UIDs');
END;

CREATE TRIGGER community_profile_numeric_handle_before_update
BEFORE UPDATE OF handle ON community_profile
WHEN NEW.handle IS NOT OLD.handle
  AND NEW.handle IS NOT NULL
  AND NEW.handle NOT GLOB '*[^0-9]*'
BEGIN
  SELECT RAISE(ABORT, 'numeric-only community handles are reserved for public UIDs');
END;

UPDATE community_post
SET published_at = created_at
WHERE published_at IS NULL AND status IN ('published', 'hidden');

UPDATE community_post
SET bookmark_count = (
  SELECT COUNT(*) FROM community_bookmark WHERE community_bookmark.post_id = community_post.id
);

CREATE TABLE community_post_revision (
  post_id TEXT NOT NULL REFERENCES community_post(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  editor_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'protected', 'private')),
  edit_reason TEXT CHECK (edit_reason IS NULL OR length(edit_reason) <= 500),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('create', 'edit', 'migration_snapshot', 'restore_snapshot')),
  ip_country_code TEXT CHECK (
    ip_country_code IS NULL OR (length(ip_country_code) = 2 AND ip_country_code = upper(ip_country_code))
  ),
  ip_region_code TEXT CHECK (ip_region_code IS NULL OR length(ip_region_code) BETWEEN 1 AND 32),
  ip_region_name TEXT CHECK (ip_region_name IS NULL OR length(ip_region_name) <= 120),
  ip_address TEXT CHECK (ip_address IS NULL OR length(ip_address) BETWEEN 3 AND 45),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 1024),
  browser_family TEXT CHECK (
    browser_family IS NULL OR browser_family IN (
      'arc', 'bot', 'brave', 'chrome', 'chromium', 'duckduckgo', 'edge', 'electron',
      'firefox', 'floorp', 'helium', 'internet_explorer', 'librewolf', 'opera', 'opera_gx',
      'other', 'safari', 'samsung_internet', 'tor', 'unknown', 'vivaldi', 'webview', 'yandex', 'zen'
    )
  ),
  os_family TEXT CHECK (
    os_family IS NULL OR os_family IN (
      'alpine_linux', 'android', 'arch_linux', 'blackberry', 'centos', 'chromeos', 'debian',
      'elementary', 'fedora', 'freebsd', 'fuchsia', 'gentoo', 'grapheneos', 'haiku', 'harmonyos',
      'ios', 'kaios', 'kali_linux', 'lineageos', 'linux', 'linux_mint', 'macos', 'manjaro',
      'netbsd', 'openbsd', 'opensuse', 'other', 'sailfish', 'ubuntu', 'unknown', 'wear_os', 'windows'
    )
  ),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, revision_number)
);

CREATE INDEX community_post_revision_editor_idx
  ON community_post_revision(editor_user_id, created_at DESC, post_id, revision_number DESC);

INSERT INTO community_post_revision
  (post_id, revision_number, editor_user_id, title, body, visibility, edit_reason, source_kind,
   ip_country_code, ip_region_code, ip_region_name, ip_address,
   user_agent, browser_family, os_family, created_at)
SELECT id, moderation_revision, author_id, title, body, visibility, NULL, 'migration_snapshot',
       ip_country_code, ip_region_code, ip_region_name, ip_address,
       user_agent, browser_family, os_family, updated_at
FROM community_post;

CREATE TABLE community_post_state_event (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES community_post(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  event_kind TEXT NOT NULL CHECK (
    event_kind IN (
      'deleted', 'restored', 'hidden', 'unhidden', 'locked', 'unlocked',
      'pinned', 'unpinned', 'archived', 'unarchived'
    )
  ),
  revision_number INTEGER,
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
  ip_country_code TEXT CHECK (
    ip_country_code IS NULL OR (length(ip_country_code) = 2 AND ip_country_code = upper(ip_country_code))
  ),
  ip_region_code TEXT CHECK (ip_region_code IS NULL OR length(ip_region_code) BETWEEN 1 AND 32),
  ip_region_name TEXT CHECK (ip_region_name IS NULL OR length(ip_region_name) <= 120),
  ip_address TEXT CHECK (ip_address IS NULL OR length(ip_address) BETWEEN 3 AND 45),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (post_id, revision_number)
    REFERENCES community_post_revision(post_id, revision_number) ON DELETE RESTRICT
);

CREATE INDEX community_post_state_event_history_idx
  ON community_post_state_event(post_id, created_at DESC, id DESC);

INSERT INTO community_post_state_event
  (id, post_id, actor_user_id, event_kind, revision_number, reason_code,
   ip_country_code, ip_region_code, ip_region_name, ip_address, created_at)
SELECT 'migration_post_deleted_' || id, id, NULL, 'deleted', moderation_revision,
       'migration_snapshot', ip_country_code, ip_region_code, ip_region_name, ip_address, deleted_at
FROM community_post
WHERE deleted_at IS NOT NULL;

CREATE TABLE community_comment_revision (
  comment_id TEXT NOT NULL REFERENCES community_comment(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  editor_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  edit_reason TEXT CHECK (edit_reason IS NULL OR length(edit_reason) <= 500),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('create', 'edit', 'migration_snapshot', 'restore_snapshot')),
  ip_country_code TEXT CHECK (
    ip_country_code IS NULL OR (length(ip_country_code) = 2 AND ip_country_code = upper(ip_country_code))
  ),
  ip_region_code TEXT CHECK (ip_region_code IS NULL OR length(ip_region_code) BETWEEN 1 AND 32),
  ip_region_name TEXT CHECK (ip_region_name IS NULL OR length(ip_region_name) <= 120),
  ip_address TEXT CHECK (ip_address IS NULL OR length(ip_address) BETWEEN 3 AND 45),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 1024),
  browser_family TEXT CHECK (
    browser_family IS NULL OR browser_family IN (
      'arc', 'bot', 'brave', 'chrome', 'chromium', 'duckduckgo', 'edge', 'electron',
      'firefox', 'floorp', 'helium', 'internet_explorer', 'librewolf', 'opera', 'opera_gx',
      'other', 'safari', 'samsung_internet', 'tor', 'unknown', 'vivaldi', 'webview', 'yandex', 'zen'
    )
  ),
  os_family TEXT CHECK (
    os_family IS NULL OR os_family IN (
      'alpine_linux', 'android', 'arch_linux', 'blackberry', 'centos', 'chromeos', 'debian',
      'elementary', 'fedora', 'freebsd', 'fuchsia', 'gentoo', 'grapheneos', 'haiku', 'harmonyos',
      'ios', 'kaios', 'kali_linux', 'lineageos', 'linux', 'linux_mint', 'macos', 'manjaro',
      'netbsd', 'openbsd', 'opensuse', 'other', 'sailfish', 'ubuntu', 'unknown', 'wear_os', 'windows'
    )
  ),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, revision_number)
);

CREATE INDEX community_comment_revision_editor_idx
  ON community_comment_revision(editor_user_id, created_at DESC, comment_id, revision_number DESC);

INSERT INTO community_comment_revision
  (comment_id, revision_number, editor_user_id, body, edit_reason, source_kind,
   ip_country_code, ip_region_code, ip_region_name, ip_address,
   user_agent, browser_family, os_family, created_at)
SELECT id, moderation_revision, author_id, body, NULL, 'migration_snapshot',
       ip_country_code, ip_region_code, ip_region_name, ip_address,
       user_agent, browser_family, os_family, updated_at
FROM community_comment;

CREATE TABLE community_comment_state_event (
  id TEXT PRIMARY KEY NOT NULL,
  comment_id TEXT NOT NULL REFERENCES community_comment(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('deleted', 'restored', 'hidden', 'unhidden')),
  revision_number INTEGER,
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
  ip_country_code TEXT CHECK (
    ip_country_code IS NULL OR (length(ip_country_code) = 2 AND ip_country_code = upper(ip_country_code))
  ),
  ip_region_code TEXT CHECK (ip_region_code IS NULL OR length(ip_region_code) BETWEEN 1 AND 32),
  ip_region_name TEXT CHECK (ip_region_name IS NULL OR length(ip_region_name) <= 120),
  ip_address TEXT CHECK (ip_address IS NULL OR length(ip_address) BETWEEN 3 AND 45),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (comment_id, revision_number)
    REFERENCES community_comment_revision(comment_id, revision_number) ON DELETE RESTRICT
);

CREATE INDEX community_comment_state_event_history_idx
  ON community_comment_state_event(comment_id, created_at DESC, id DESC);

INSERT INTO community_comment_state_event
  (id, comment_id, actor_user_id, event_kind, revision_number, reason_code,
   ip_country_code, ip_region_code, ip_region_name, ip_address, created_at)
SELECT 'migration_comment_deleted_' || id, id, NULL, 'deleted', moderation_revision,
       'migration_snapshot', ip_country_code, ip_region_code, ip_region_name, ip_address, deleted_at
FROM community_comment
WHERE deleted_at IS NOT NULL;

CREATE TABLE community_comment_reaction (
  comment_id TEXT NOT NULL REFERENCES community_comment(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind = 'like'),
  created_at INTEGER NOT NULL,
  activation_id TEXT NOT NULL CHECK (length(activation_id) = 36),
  PRIMARY KEY (comment_id, user_id, kind)
);

CREATE INDEX community_comment_reaction_user_idx
  ON community_comment_reaction(user_id, created_at DESC, comment_id);

CREATE TABLE community_user_follow (
  follower_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  followed_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  notify_level TEXT NOT NULL DEFAULT 'normal' CHECK (notify_level IN ('none', 'normal', 'all')),
  created_at INTEGER NOT NULL,
  activation_id TEXT NOT NULL CHECK (length(activation_id) = 36),
  PRIMARY KEY (follower_user_id, followed_user_id),
  CHECK (follower_user_id <> followed_user_id)
);

CREATE INDEX community_user_follow_followed_idx
  ON community_user_follow(followed_user_id, created_at DESC, follower_user_id);

CREATE INDEX community_user_follow_follower_time_idx
  ON community_user_follow(follower_user_id, created_at DESC, followed_user_id);

CREATE TABLE community_user_block (
  blocker_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX community_user_block_blocked_idx
  ON community_user_block(blocked_user_id, created_at DESC, blocker_user_id);

CREATE TABLE community_user_mute (
  muter_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  muted_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (muter_user_id, muted_user_id),
  CHECK (muter_user_id <> muted_user_id)
);

CREATE INDEX community_user_mute_muted_idx
  ON community_user_mute(muted_user_id, muter_user_id);

CREATE TABLE _migration_0005_post_tag AS
SELECT post_id, tag, created_at FROM community_post_tag;

DROP TABLE community_post_tag;

CREATE TABLE community_tag (
  id TEXT PRIMARY KEY NOT NULL,
  normalized_name TEXT COLLATE NOCASE NOT NULL UNIQUE CHECK (
    length(normalized_name) BETWEEN 1 AND 32 AND instr(normalized_name, '#') = 0
  ),
  display_name TEXT NOT NULL CHECK (
    length(display_name) BETWEEN 1 AND 32 AND instr(display_name, '#') = 0
  ),
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'merged')),
  canonical_tag_id TEXT REFERENCES community_tag(id) ON DELETE RESTRICT,
  created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'merged' AND canonical_tag_id IS NOT NULL AND canonical_tag_id <> id)
    OR (status <> 'merged' AND canonical_tag_id IS NULL)
  )
);

CREATE INDEX community_tag_status_name_idx
  ON community_tag(status, normalized_name, id);

INSERT INTO community_tag
  (id, normalized_name, display_name, description, status, canonical_tag_id,
   created_by_user_id, created_at, updated_at)
SELECT 'tag_' || lower(hex(randomblob(16))), lower(trim(tag)), min(trim(tag)), NULL,
       'active', NULL, NULL, min(created_at), min(created_at)
FROM _migration_0005_post_tag
GROUP BY lower(trim(tag));

CREATE TABLE community_tag_alias (
  alias_normalized_name TEXT COLLATE NOCASE PRIMARY KEY NOT NULL CHECK (
    length(alias_normalized_name) BETWEEN 1 AND 32 AND instr(alias_normalized_name, '#') = 0
  ),
  tag_id TEXT NOT NULL REFERENCES community_tag(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX community_tag_alias_tag_idx
  ON community_tag_alias(tag_id, alias_normalized_name);

CREATE TABLE community_post_tag (
  post_id TEXT NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES community_tag(id) ON DELETE RESTRICT,
  added_by_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  UNIQUE(post_id, position)
);

CREATE INDEX community_post_tag_lookup_idx
  ON community_post_tag(tag_id, post_id);

WITH ranked_tags AS (
  SELECT legacy.post_id, tag.id AS tag_id, post.author_id AS added_by_user_id,
         row_number() OVER (PARTITION BY legacy.post_id ORDER BY tag.normalized_name, tag.id) - 1 AS position,
         legacy.created_at
  FROM _migration_0005_post_tag AS legacy
  JOIN community_tag AS tag ON tag.normalized_name = lower(trim(legacy.tag))
  JOIN community_post AS post ON post.id = legacy.post_id
)
INSERT INTO community_post_tag (post_id, tag_id, added_by_user_id, position, created_at)
SELECT post_id, tag_id, added_by_user_id, position, created_at
FROM ranked_tags
WHERE position BETWEEN 0 AND 9;

CREATE TABLE community_tag_preference (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES community_tag(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('follow', 'mute')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tag_id)
);

CREATE INDEX community_tag_preference_tag_idx
  ON community_tag_preference(tag_id, kind, created_at DESC, user_id);

CREATE TABLE community_post_revision_tag (
  post_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  tag_id TEXT NOT NULL REFERENCES community_tag(id) ON DELETE RESTRICT,
  normalized_name TEXT COLLATE NOCASE NOT NULL CHECK (
    length(normalized_name) BETWEEN 1 AND 32 AND instr(normalized_name, '#') = 0
  ),
  display_name TEXT NOT NULL CHECK (
    length(display_name) BETWEEN 1 AND 32 AND instr(display_name, '#') = 0
  ),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  PRIMARY KEY (post_id, revision_number, tag_id),
  UNIQUE(post_id, revision_number, position),
  FOREIGN KEY (post_id, revision_number)
    REFERENCES community_post_revision(post_id, revision_number) ON DELETE RESTRICT
);

CREATE INDEX community_post_revision_tag_lookup_idx
  ON community_post_revision_tag(tag_id, post_id, revision_number DESC);

INSERT INTO community_post_revision_tag
  (post_id, revision_number, tag_id, normalized_name, display_name, position)
SELECT post_tag.post_id, post.moderation_revision, post_tag.tag_id,
       tag.normalized_name, tag.display_name, post_tag.position
FROM community_post_tag AS post_tag
JOIN community_post AS post ON post.id = post_tag.post_id
JOIN community_tag AS tag ON tag.id = post_tag.tag_id;

DROP TABLE _migration_0005_post_tag;

CREATE TABLE community_post_revision_attachment (
  post_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES community_attachment(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  PRIMARY KEY (post_id, revision_number, attachment_id),
  UNIQUE(post_id, revision_number, position),
  FOREIGN KEY (post_id, revision_number)
    REFERENCES community_post_revision(post_id, revision_number) ON DELETE RESTRICT
);

CREATE INDEX community_post_revision_attachment_lookup_idx
  ON community_post_revision_attachment(attachment_id, post_id, revision_number DESC);

INSERT INTO community_post_revision_attachment (post_id, revision_number, attachment_id, position)
SELECT link.post_id, post.moderation_revision, link.attachment_id, link.position
FROM community_post_attachment AS link
JOIN community_post AS post ON post.id = link.post_id;

CREATE TABLE community_post_revision_seal (
  post_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  sealed_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, revision_number),
  FOREIGN KEY (post_id, revision_number)
    REFERENCES community_post_revision(post_id, revision_number) ON DELETE RESTRICT
);

INSERT INTO community_post_revision_seal (post_id, revision_number, sealed_at)
SELECT post_id, revision_number, created_at
FROM community_post_revision;

CREATE TABLE community_post_rank (
  post_id TEXT PRIMARY KEY NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  base_score REAL NOT NULL,
  algorithm_version TEXT NOT NULL CHECK (length(algorithm_version) BETWEEN 1 AND 80),
  calculated_at INTEGER NOT NULL
);

CREATE INDEX community_post_rank_score_idx
  ON community_post_rank(base_score DESC, calculated_at DESC, post_id DESC);

INSERT INTO community_post_rank (post_id, base_score, algorithm_version, calculated_at)
SELECT id,
       CAST(like_count * 4 + comment_count * 6 + bookmark_count * 5 AS REAL),
       'community-core-v1',
       updated_at
FROM community_post
WHERE status = 'published' AND deleted_at IS NULL;

CREATE TABLE community_feed_impression (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  PRIMARY KEY (user_id, post_id),
  CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX community_feed_impression_recent_idx
  ON community_feed_impression(user_id, last_seen_at DESC, post_id);

CREATE TABLE community_post_feedback (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('not_interested', 'hide')),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX community_post_feedback_post_idx
  ON community_post_feedback(post_id, kind, created_at DESC, user_id);

CREATE TABLE community_user_restriction_event (
  id TEXT PRIMARY KEY NOT NULL,
  restriction_id TEXT NOT NULL REFERENCES community_user_restriction(id) ON DELETE RESTRICT,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('issued', 'extended', 'revoked', 'expired')),
  actor_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  previous_expires_at INTEGER,
  next_expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX community_user_restriction_event_history_idx
  ON community_user_restriction_event(restriction_id, created_at DESC, id DESC);

INSERT INTO community_user_restriction_event
  (id, restriction_id, event_kind, actor_user_id, reason_code,
   previous_expires_at, next_expires_at, created_at)
SELECT 'migration_restriction_issued_' || id, id, 'issued', actor_user_id,
       reason_code, NULL, expires_at, created_at
FROM community_user_restriction;

CREATE TABLE _migration_0005_moderation_case AS SELECT * FROM community_moderation_case;
CREATE TABLE _migration_0005_moderation_job AS SELECT * FROM community_moderation_job;
CREATE TABLE _migration_0005_moderation_event AS SELECT * FROM community_moderation_event;
CREATE TABLE _migration_0005_appeal AS SELECT * FROM community_appeal;

DROP TABLE community_appeal;
DROP TABLE community_moderation_job;
DROP TABLE community_moderation_event;
DROP TABLE community_moderation_case;

CREATE TABLE community_moderation_case (
  id TEXT PRIMARY KEY NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('post', 'comment', 'attachment', 'profile-name')),
  entity_id TEXT NOT NULL,
  entity_revision INTEGER NOT NULL DEFAULT 1 CHECK (entity_revision >= 1),
  policy_generation INTEGER NOT NULL DEFAULT 1 CHECK (policy_generation >= 1),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'allow', 'review', 'block', 'superseded')),
  source TEXT NOT NULL DEFAULT 'system'
    CHECK (source IN ('deterministic', 'ai', 'appeal', 'manual', 'system')),
  categories_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(categories_json) AND json_type(categories_json) = 'array'),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) <= 80),
  model_id TEXT CHECK (model_id IS NULL OR length(model_id) <= 160),
  reviewer_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  decision_token TEXT NOT NULL CHECK (length(decision_token) = 36),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(entity_kind, entity_id, policy_generation, entity_revision),
  CHECK (entity_kind IN ('post', 'comment', 'profile-name') OR entity_revision = 1),
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status <> 'pending' AND completed_at IS NOT NULL AND completed_at >= created_at)
  )
);

CREATE INDEX community_moderation_case_queue_idx
  ON community_moderation_case(status, updated_at, id);

CREATE INDEX community_moderation_case_entity_idx
  ON community_moderation_case(entity_kind, entity_id, entity_revision DESC, created_at DESC);

CREATE INDEX community_moderation_case_generation_idx
  ON community_moderation_case(entity_kind, entity_id, entity_revision, policy_generation DESC);

CREATE TABLE community_moderation_job (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES community_moderation_case(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token TEXT UNIQUE CHECK (lease_token IS NULL OR length(lease_token) = 36),
  lease_until INTEGER,
  dispatch_token TEXT UNIQUE CHECK (dispatch_token IS NULL OR length(dispatch_token) = 36),
  dispatched_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (dispatched_at IS NULL OR dispatched_at >= created_at),
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'processing' AND lease_token IS NULL AND lease_until IS NULL)
  ),
  CHECK (dispatch_token IS NULL OR status = 'queued')
);

CREATE TRIGGER community_moderation_job_pending_case_before_insert
BEFORE INSERT ON community_moderation_job
WHEN NOT EXISTS (
  SELECT 1 FROM community_moderation_case AS pending_case
  WHERE pending_case.id = NEW.case_id
    AND pending_case.status = 'pending'
    AND pending_case.source NOT IN ('appeal', 'manual')
)
BEGIN
  SELECT RAISE(ABORT, 'moderation jobs require an automated pending case');
END;

CREATE INDEX community_moderation_job_status_idx
  ON community_moderation_job(status, next_attempt_at, updated_at, id);

CREATE UNIQUE INDEX community_moderation_job_case_idx
  ON community_moderation_job(case_id);

CREATE INDEX community_moderation_job_lease_idx
  ON community_moderation_job(status, lease_until, id);

CREATE INDEX community_moderation_job_outbox_idx
  ON community_moderation_job(status, next_attempt_at, dispatched_at, updated_at, id);

CREATE TABLE community_moderation_event (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES community_moderation_case(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'model', 'moderator')),
  actor_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  from_status TEXT CHECK (
    from_status IS NULL OR from_status IN ('pending', 'allow', 'review', 'block', 'superseded')
  ),
  to_status TEXT NOT NULL CHECK (to_status IN ('pending', 'allow', 'review', 'block', 'superseded')),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  categories_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(categories_json) AND json_type(categories_json) = 'array'),
  model_id TEXT CHECK (model_id IS NULL OR length(model_id) <= 160),
  decision_token TEXT NOT NULL CHECK (length(decision_token) = 36),
  created_at INTEGER NOT NULL
);

CREATE INDEX community_moderation_event_case_idx
  ON community_moderation_event(case_id, created_at, id);

CREATE UNIQUE INDEX community_moderation_event_decision_idx
  ON community_moderation_event(case_id, decision_token);

CREATE TABLE community_appeal (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES community_moderation_case(id) ON DELETE CASCADE,
  appellant_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
  reviewer_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  resolution_reason_code TEXT CHECK (
    resolution_reason_code IS NULL OR length(resolution_reason_code) BETWEEN 1 AND 80
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  resolution_id TEXT UNIQUE CHECK (resolution_id IS NULL OR length(resolution_id) = 36),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE(case_id, appellant_user_id),
  CHECK (
    (status = 'pending' AND reviewer_user_id IS NULL AND resolution_reason_code IS NULL
      AND resolution_id IS NULL AND resolved_at IS NULL)
    OR
    (status IN ('accepted', 'rejected') AND reviewer_user_id IS NOT NULL
      AND resolution_reason_code IS NOT NULL AND resolution_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR
    (status = 'superseded' AND reviewer_user_id IS NULL
      AND resolution_reason_code = 'system.entity_revision_superseded'
      AND resolution_id IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX community_appeal_status_idx
  ON community_appeal(status, created_at, id);

CREATE INDEX community_appeal_user_idx
  ON community_appeal(appellant_user_id, created_at DESC, id DESC);

INSERT INTO community_moderation_case SELECT * FROM _migration_0005_moderation_case;
INSERT INTO community_moderation_job SELECT * FROM _migration_0005_moderation_job;
INSERT INTO community_moderation_event SELECT * FROM _migration_0005_moderation_event;
INSERT INTO community_appeal SELECT * FROM _migration_0005_appeal;

DROP TABLE _migration_0005_appeal;
DROP TABLE _migration_0005_moderation_job;
DROP TABLE _migration_0005_moderation_event;
DROP TABLE _migration_0005_moderation_case;

CREATE TABLE _migration_0005_notification AS
SELECT notification.id,
       notification.recipient_user_id,
       notification.actor_user_id,
       CASE
         WHEN notification.kind = 'reaction' THEN 'post_reaction'
         WHEN comment.parent_id IS NOT NULL THEN 'reply'
         ELSE 'comment'
       END AS kind,
       notification.post_id,
       notification.comment_id,
       CAST(NULL AS TEXT) AS moderation_case_id,
       CAST(NULL AS TEXT) AS activation_id,
       notification.created_at,
       notification.read_at
FROM community_notification AS notification
LEFT JOIN community_comment AS comment ON comment.id = notification.comment_id;

DROP TABLE community_notification;

CREATE TABLE community_notification (
  id TEXT PRIMARY KEY NOT NULL,
  recipient_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('comment', 'reply', 'post_reaction', 'comment_reaction', 'follow', 'mention', 'moderation')
  ),
  post_id TEXT REFERENCES community_post(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES community_comment(id) ON DELETE CASCADE,
  moderation_case_id TEXT REFERENCES community_moderation_case(id) ON DELETE CASCADE,
  activation_id TEXT CHECK (activation_id IS NULL OR length(activation_id) = 36),
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  CHECK (
    (kind IN ('comment', 'reply') AND post_id IS NOT NULL AND comment_id IS NOT NULL
      AND moderation_case_id IS NULL)
    OR (kind = 'post_reaction' AND post_id IS NOT NULL AND comment_id IS NULL
      AND moderation_case_id IS NULL)
    OR (kind = 'comment_reaction' AND post_id IS NOT NULL AND comment_id IS NOT NULL
      AND moderation_case_id IS NULL)
    OR (kind = 'follow' AND post_id IS NULL AND comment_id IS NULL AND moderation_case_id IS NULL)
    OR (kind = 'mention' AND post_id IS NOT NULL AND moderation_case_id IS NULL)
    OR (kind = 'moderation' AND post_id IS NULL AND comment_id IS NULL
      AND moderation_case_id IS NOT NULL)
  ),
  CHECK (
    activation_id IS NULL OR kind IN ('post_reaction', 'comment_reaction', 'follow')
  ),
  CHECK (read_at IS NULL OR read_at >= created_at)
);

CREATE INDEX community_notification_inbox_idx
  ON community_notification(recipient_user_id, created_at DESC, id DESC);

CREATE INDEX community_notification_unread_idx
  ON community_notification(recipient_user_id, read_at, created_at DESC, id DESC);

CREATE UNIQUE INDEX community_notification_comment_unique_idx
  ON community_notification(recipient_user_id, comment_id, kind)
  WHERE kind IN ('comment', 'reply');

CREATE UNIQUE INDEX community_notification_activation_unique_idx
  ON community_notification(activation_id)
  WHERE activation_id IS NOT NULL;

CREATE UNIQUE INDEX community_notification_post_mention_unique_idx
  ON community_notification(recipient_user_id, post_id)
  WHERE kind = 'mention' AND comment_id IS NULL;

CREATE UNIQUE INDEX community_notification_comment_mention_unique_idx
  ON community_notification(recipient_user_id, comment_id)
  WHERE kind = 'mention' AND comment_id IS NOT NULL;

CREATE UNIQUE INDEX community_notification_moderation_unique_idx
  ON community_notification(recipient_user_id, moderation_case_id)
  WHERE kind = 'moderation';

INSERT INTO community_notification
  (id, recipient_user_id, actor_user_id, kind, post_id, comment_id,
   moderation_case_id, activation_id, created_at, read_at)
SELECT id, recipient_user_id, actor_user_id, kind, post_id, comment_id,
       moderation_case_id, activation_id, created_at, read_at
FROM _migration_0005_notification;

DROP TABLE _migration_0005_notification;

CREATE TABLE community_content_report (
  id TEXT PRIMARY KEY NOT NULL,
  reporter_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  post_id TEXT REFERENCES community_post(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES community_comment(id) ON DELETE CASCADE,
  reported_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  target_revision INTEGER CHECK (target_revision IS NULL OR target_revision >= 1),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN (
      'spam', 'harassment', 'hate', 'sexual', 'violence', 'privacy',
      'copyright', 'misinformation', 'other'
    )
  ),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 2000),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  reviewer_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  resolution_reason_code TEXT CHECK (
    resolution_reason_code IS NULL OR length(resolution_reason_code) BETWEEN 1 AND 80
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  FOREIGN KEY (post_id, target_revision)
    REFERENCES community_post_revision(post_id, revision_number) ON DELETE RESTRICT,
  FOREIGN KEY (comment_id, target_revision)
    REFERENCES community_comment_revision(comment_id, revision_number) ON DELETE RESTRICT,
  CHECK (
    (post_id IS NOT NULL) + (comment_id IS NOT NULL) + (reported_user_id IS NOT NULL) = 1
  ),
  CHECK (
    ((post_id IS NOT NULL OR comment_id IS NOT NULL) AND target_revision IS NOT NULL)
    OR (reported_user_id IS NOT NULL AND target_revision IS NULL)
  ),
  CHECK (updated_at >= created_at),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at),
  CHECK (
    (status = 'pending' AND reviewer_user_id IS NULL
      AND resolution_reason_code IS NULL AND resolved_at IS NULL)
    OR (status = 'reviewing' AND reviewer_user_id IS NOT NULL
      AND resolution_reason_code IS NULL AND resolved_at IS NULL)
    OR (status IN ('resolved', 'dismissed') AND reviewer_user_id IS NOT NULL
      AND resolution_reason_code IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX community_content_report_queue_idx
  ON community_content_report(status, updated_at, id);

CREATE INDEX community_content_report_reporter_idx
  ON community_content_report(reporter_user_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX community_content_report_active_post_idx
  ON community_content_report(reporter_user_id, post_id)
  WHERE post_id IS NOT NULL AND status IN ('pending', 'reviewing');

CREATE UNIQUE INDEX community_content_report_active_comment_idx
  ON community_content_report(reporter_user_id, comment_id)
  WHERE comment_id IS NOT NULL AND status IN ('pending', 'reviewing');

CREATE UNIQUE INDEX community_content_report_active_user_idx
  ON community_content_report(reporter_user_id, reported_user_id)
  WHERE reported_user_id IS NOT NULL AND status IN ('pending', 'reviewing');

CREATE INDEX community_comment_latest_idx
  ON community_comment(post_id, parent_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND hidden_at IS NULL AND moderation_status = 'allow';

CREATE INDEX community_comment_hot_idx
  ON community_comment(post_id, parent_id, like_count DESC, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND hidden_at IS NULL AND moderation_status = 'allow';

CREATE TRIGGER community_post_revision_owner_before_insert
BEFORE INSERT ON community_post_revision
WHEN NOT EXISTS (
  SELECT 1 FROM community_post
  WHERE id = NEW.post_id AND author_id = NEW.editor_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'post revisions must be authored by the post owner');
END;

CREATE TRIGGER community_post_revision_sequence_before_insert
BEFORE INSERT ON community_post_revision
WHEN NEW.source_kind <> 'migration_snapshot'
  AND NEW.revision_number <> COALESCE(
    (SELECT max(revision_number) + 1 FROM community_post_revision WHERE post_id = NEW.post_id),
    1
  )
BEGIN
  SELECT RAISE(ABORT, 'post revisions must be sequential');
END;

CREATE TRIGGER community_post_revision_immutable_before_update
BEFORE UPDATE ON community_post_revision
BEGIN
  SELECT RAISE(ABORT, 'post revisions are immutable');
END;

CREATE TRIGGER community_post_revision_immutable_before_delete
BEFORE DELETE ON community_post_revision
BEGIN
  SELECT RAISE(ABORT, 'post revisions cannot be deleted');
END;

CREATE TRIGGER community_post_revision_tag_sealed_before_insert
BEFORE INSERT ON community_post_revision_tag
WHEN EXISTS (
  SELECT 1 FROM community_post_revision_seal
  WHERE post_id = NEW.post_id AND revision_number = NEW.revision_number
)
BEGIN
  SELECT RAISE(ABORT, 'sealed post revision tag snapshots cannot be extended');
END;

CREATE TRIGGER community_post_revision_tag_immutable_before_update
BEFORE UPDATE ON community_post_revision_tag
BEGIN
  SELECT RAISE(ABORT, 'post revision tag snapshots are immutable');
END;

CREATE TRIGGER community_post_revision_tag_immutable_before_delete
BEFORE DELETE ON community_post_revision_tag
BEGIN
  SELECT RAISE(ABORT, 'post revision tag snapshots cannot be deleted');
END;

CREATE TRIGGER community_post_revision_attachment_sealed_before_insert
BEFORE INSERT ON community_post_revision_attachment
WHEN EXISTS (
  SELECT 1 FROM community_post_revision_seal
  WHERE post_id = NEW.post_id AND revision_number = NEW.revision_number
)
BEGIN
  SELECT RAISE(ABORT, 'sealed post revision attachment snapshots cannot be extended');
END;

CREATE TRIGGER community_post_revision_attachment_immutable_before_update
BEFORE UPDATE ON community_post_revision_attachment
BEGIN
  SELECT RAISE(ABORT, 'post revision attachment snapshots are immutable');
END;

CREATE TRIGGER community_post_revision_attachment_immutable_before_delete
BEFORE DELETE ON community_post_revision_attachment
BEGIN
  SELECT RAISE(ABORT, 'post revision attachment snapshots cannot be deleted');
END;

CREATE TRIGGER community_post_revision_seal_immutable_before_update
BEFORE UPDATE ON community_post_revision_seal
BEGIN
  SELECT RAISE(ABORT, 'post revision seals are immutable');
END;

CREATE TRIGGER community_post_revision_seal_duplicate_before_insert
BEFORE INSERT ON community_post_revision_seal
WHEN EXISTS (
  SELECT 1 FROM community_post_revision_seal
  WHERE post_id = NEW.post_id AND revision_number = NEW.revision_number
)
BEGIN
  SELECT RAISE(ABORT, 'post revision seals cannot be replaced');
END;

CREATE TRIGGER community_post_revision_seal_immutable_before_delete
BEFORE DELETE ON community_post_revision_seal
BEGIN
  SELECT RAISE(ABORT, 'post revision seals cannot be deleted');
END;

CREATE TRIGGER community_post_content_revision_before_update
BEFORE UPDATE OF title, body, visibility, moderation_revision ON community_post
WHEN (
    NEW.title IS NOT OLD.title
    OR NEW.body IS NOT OLD.body
    OR NEW.visibility <> OLD.visibility
    OR NEW.moderation_revision <> OLD.moderation_revision
  )
  AND NOT EXISTS (
    SELECT 1 FROM community_post_revision AS revision
    WHERE revision.post_id = NEW.id
      AND revision.revision_number = NEW.moderation_revision
      AND revision.title = NEW.title
      AND revision.body = NEW.body
      AND revision.visibility = NEW.visibility
  )
BEGIN
  SELECT RAISE(ABORT, 'post content updates require a matching immutable revision');
END;

CREATE TRIGGER community_post_state_event_immutable_before_update
BEFORE UPDATE ON community_post_state_event
BEGIN
  SELECT RAISE(ABORT, 'post state events are immutable');
END;

CREATE TRIGGER community_post_state_event_immutable_before_delete
BEFORE DELETE ON community_post_state_event
BEGIN
  SELECT RAISE(ABORT, 'post state events cannot be deleted');
END;

CREATE TRIGGER community_post_no_hard_delete
BEFORE DELETE ON community_post
BEGIN
  SELECT RAISE(ABORT, 'posts must be soft deleted');
END;

CREATE TRIGGER community_comment_revision_owner_before_insert
BEFORE INSERT ON community_comment_revision
WHEN NOT EXISTS (
  SELECT 1 FROM community_comment
  WHERE id = NEW.comment_id AND author_id = NEW.editor_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'comment revisions must be authored by the comment owner');
END;

CREATE TRIGGER community_comment_revision_sequence_before_insert
BEFORE INSERT ON community_comment_revision
WHEN NEW.source_kind <> 'migration_snapshot'
  AND NEW.revision_number <> COALESCE(
    (SELECT max(revision_number) + 1 FROM community_comment_revision WHERE comment_id = NEW.comment_id),
    1
  )
BEGIN
  SELECT RAISE(ABORT, 'comment revisions must be sequential');
END;

CREATE TRIGGER community_comment_revision_immutable_before_update
BEFORE UPDATE ON community_comment_revision
BEGIN
  SELECT RAISE(ABORT, 'comment revisions are immutable');
END;

CREATE TRIGGER community_comment_revision_immutable_before_delete
BEFORE DELETE ON community_comment_revision
BEGIN
  SELECT RAISE(ABORT, 'comment revisions cannot be deleted');
END;

CREATE TRIGGER community_comment_content_revision_before_update
BEFORE UPDATE OF body, moderation_revision ON community_comment
WHEN (NEW.body IS NOT OLD.body OR NEW.moderation_revision <> OLD.moderation_revision)
  AND NOT EXISTS (
    SELECT 1 FROM community_comment_revision AS revision
    WHERE revision.comment_id = NEW.id
      AND revision.revision_number = NEW.moderation_revision
      AND revision.body = NEW.body
  )
BEGIN
  SELECT RAISE(ABORT, 'comment content updates require a matching immutable revision');
END;

CREATE TRIGGER community_comment_state_event_immutable_before_update
BEFORE UPDATE ON community_comment_state_event
BEGIN
  SELECT RAISE(ABORT, 'comment state events are immutable');
END;

CREATE TRIGGER community_comment_state_event_immutable_before_delete
BEFORE DELETE ON community_comment_state_event
BEGIN
  SELECT RAISE(ABORT, 'comment state events cannot be deleted');
END;

CREATE TRIGGER community_comment_no_hard_delete
BEFORE DELETE ON community_comment
BEGIN
  SELECT RAISE(ABORT, 'comments must be soft deleted');
END;

CREATE TRIGGER community_comment_reaction_comment_immutable
BEFORE UPDATE OF comment_id ON community_comment_reaction
WHEN NEW.comment_id <> OLD.comment_id
BEGIN
  SELECT RAISE(ABORT, 'comment reaction comment_id is immutable');
END;

CREATE TRIGGER community_comment_reaction_after_insert
AFTER INSERT ON community_comment_reaction
WHEN NEW.kind = 'like'
BEGIN
  UPDATE community_comment SET like_count = like_count + 1 WHERE id = NEW.comment_id;
END;

CREATE TRIGGER community_comment_reaction_after_delete
AFTER DELETE ON community_comment_reaction
WHEN OLD.kind = 'like'
BEGIN
  UPDATE community_comment SET like_count = max(0, like_count - 1) WHERE id = OLD.comment_id;
END;

CREATE TRIGGER community_bookmark_after_insert
AFTER INSERT ON community_bookmark
BEGIN
  UPDATE community_post SET bookmark_count = bookmark_count + 1 WHERE id = NEW.post_id;
END;

CREATE TRIGGER community_bookmark_after_delete
AFTER DELETE ON community_bookmark
BEGIN
  UPDATE community_post SET bookmark_count = max(0, bookmark_count - 1) WHERE id = OLD.post_id;
END;

CREATE TRIGGER community_user_follow_block_before_insert
BEFORE INSERT ON community_user_follow
WHEN EXISTS (
  SELECT 1 FROM community_user_block
  WHERE (blocker_user_id = NEW.follower_user_id AND blocked_user_id = NEW.followed_user_id)
     OR (blocker_user_id = NEW.followed_user_id AND blocked_user_id = NEW.follower_user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'blocked users cannot follow each other');
END;

CREATE TRIGGER community_user_block_after_insert
AFTER INSERT ON community_user_block
BEGIN
  DELETE FROM community_user_follow
  WHERE (follower_user_id = NEW.blocker_user_id AND followed_user_id = NEW.blocked_user_id)
     OR (follower_user_id = NEW.blocked_user_id AND followed_user_id = NEW.blocker_user_id);
END;

CREATE TRIGGER community_user_restriction_event_immutable_before_update
BEFORE UPDATE ON community_user_restriction_event
BEGIN
  SELECT RAISE(ABORT, 'restriction events are immutable');
END;

CREATE TRIGGER community_user_restriction_event_immutable_before_delete
BEFORE DELETE ON community_user_restriction_event
BEGIN
  SELECT RAISE(ABORT, 'restriction events cannot be deleted');
END;

-- Public numeric UIDs are allocated only after an email becomes verified.
-- Existing identities remain immutable; this changes allocation for new users.
DROP TRIGGER IF EXISTS community_profile_after_user_insert;
DROP TRIGGER IF EXISTS community_identity_after_email_verification;

CREATE TRIGGER community_profile_after_user_insert
AFTER INSERT ON "user"
BEGIN
  INSERT INTO community_identity (user_id, created_at)
  SELECT
    NEW.id,
    CASE
      WHEN typeof(NEW.createdAt) IN ('integer', 'real') THEN NEW.createdAt
      ELSE CAST(unixepoch(NEW.createdAt) * 1000 AS INTEGER)
    END
  WHERE NEW.emailVerified = 1;

  INSERT OR IGNORE INTO community_profile
    (user_id, pending_display_name, display_name_status, display_name_revision, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.name,
    'pending',
    1,
    CASE
      WHEN typeof(NEW.createdAt) IN ('integer', 'real') THEN NEW.createdAt
      ELSE CAST(unixepoch(NEW.createdAt) * 1000 AS INTEGER)
    END,
    CASE
      WHEN typeof(NEW.updatedAt) IN ('integer', 'real') THEN NEW.updatedAt
      ELSE CAST(unixepoch(NEW.updatedAt) * 1000 AS INTEGER)
    END
  );
END;

CREATE TRIGGER community_identity_after_email_verification
AFTER UPDATE OF emailVerified ON "user"
WHEN OLD.emailVerified = 0
  AND NEW.emailVerified = 1
  AND NOT EXISTS (SELECT 1 FROM community_identity WHERE user_id = NEW.id)
BEGIN
  INSERT OR IGNORE INTO community_identity (user_id, created_at)
  VALUES (
    NEW.id,
    CASE
      WHEN typeof(NEW.updatedAt) IN ('integer', 'real') THEN NEW.updatedAt
      ELSE CAST(unixepoch(NEW.updatedAt) * 1000 AS INTEGER)
    END
  );
END;

-- A post author's own legacy reactions are invalid. Recompute the denormalized
-- counter after cleanup so databases with previously drifted counters converge.
DELETE FROM community_reaction
WHERE kind = 'like'
  AND EXISTS (
    SELECT 1 FROM community_post
    WHERE community_post.id = community_reaction.post_id
      AND community_post.author_id = community_reaction.user_id
  );

UPDATE community_post
SET like_count = (
  SELECT COUNT(*)
  FROM community_reaction
  WHERE community_reaction.post_id = community_post.id
    AND community_reaction.kind = 'like'
);

CREATE TRIGGER community_reaction_no_self_like_before_insert
BEFORE INSERT ON community_reaction
WHEN NEW.kind = 'like'
  AND EXISTS (
    SELECT 1 FROM community_post
    WHERE community_post.id = NEW.post_id
      AND community_post.author_id = NEW.user_id
  )
BEGIN
  SELECT RAISE(ABORT, 'post authors cannot like their own posts');
END;

CREATE TRIGGER community_reaction_no_self_like_before_update
BEFORE UPDATE OF post_id, user_id, kind ON community_reaction
WHEN NEW.kind = 'like'
  AND EXISTS (
    SELECT 1 FROM community_post
    WHERE community_post.id = NEW.post_id
      AND community_post.author_id = NEW.user_id
  )
BEGIN
  SELECT RAISE(ABORT, 'post authors cannot like their own posts');
END;

-- comment_count tracks only comments visible in the normal thread. A single
-- before/after visibility transition prevents an admin hide that also changes
-- moderation_status from decrementing the counter twice.
DROP TRIGGER IF EXISTS community_comment_after_insert;
DROP TRIGGER IF EXISTS community_comment_after_delete;
DROP TRIGGER IF EXISTS community_comment_after_soft_delete;
DROP TRIGGER IF EXISTS community_comment_after_restore;
DROP TRIGGER IF EXISTS community_comment_after_moderation_allow;
DROP TRIGGER IF EXISTS community_comment_after_moderation_disallow;

CREATE TRIGGER community_comment_after_insert
AFTER INSERT ON community_comment
WHEN NEW.deleted_at IS NULL AND NEW.hidden_at IS NULL AND NEW.moderation_status = 'allow'
BEGIN
  UPDATE community_post SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
END;

CREATE TRIGGER community_comment_after_delete
AFTER DELETE ON community_comment
WHEN OLD.deleted_at IS NULL AND OLD.hidden_at IS NULL AND OLD.moderation_status = 'allow'
BEGIN
  UPDATE community_post SET comment_count = max(0, comment_count - 1) WHERE id = OLD.post_id;
END;

CREATE TRIGGER community_comment_after_stops_being_counted
AFTER UPDATE OF deleted_at, hidden_at, moderation_status ON community_comment
WHEN OLD.deleted_at IS NULL
  AND OLD.hidden_at IS NULL
  AND OLD.moderation_status = 'allow'
  AND NOT (
    NEW.deleted_at IS NULL
    AND NEW.hidden_at IS NULL
    AND NEW.moderation_status = 'allow'
  )
BEGIN
  UPDATE community_post SET comment_count = max(0, comment_count - 1) WHERE id = NEW.post_id;
END;

CREATE TRIGGER community_comment_after_becomes_counted
AFTER UPDATE OF deleted_at, hidden_at, moderation_status ON community_comment
WHEN NOT (
    OLD.deleted_at IS NULL
    AND OLD.hidden_at IS NULL
    AND OLD.moderation_status = 'allow'
  )
  AND NEW.deleted_at IS NULL
  AND NEW.hidden_at IS NULL
  AND NEW.moderation_status = 'allow'
BEGIN
  UPDATE community_post SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
END;

UPDATE community_post
SET comment_count = (
  SELECT COUNT(*)
  FROM community_comment
  WHERE community_comment.post_id = community_post.id
    AND community_comment.deleted_at IS NULL
    AND community_comment.hidden_at IS NULL
    AND community_comment.moderation_status = 'allow'
);
