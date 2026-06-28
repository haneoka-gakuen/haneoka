-- Complete D1 schema for a new empty database.
-- Existing databases are reconciled manually against an exported live schema.
PRAGMA foreign_keys = ON;

CREATE TABLE "user" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  email TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  emailVerified INTEGER NOT NULL DEFAULT 0 CHECK (emailVerified IN (0, 1)),
  image TEXT CHECK (image IS NULL OR (length(image) <= 2048 AND image GLOB 'https://*')),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE "session" (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX session_userId_idx ON "session"(userId);

CREATE INDEX session_expiresAt_idx ON "session"(expiresAt);

CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(providerId, accountId)
);

CREATE INDEX account_userId_idx ON account(userId);

CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX verification_identifier_idx ON verification(identifier);

CREATE INDEX verification_expiresAt_idx ON verification(expiresAt);

CREATE TABLE rateLimit (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL CHECK (count >= 0),
  lastRequest INTEGER NOT NULL
);

CREATE INDEX rateLimit_lastRequest_idx ON rateLimit(lastRequest);

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

CREATE INDEX user_createdAt_idx ON "user"(createdAt);

-- Public numeric identities are deliberately separate from Better Auth's opaque
-- text identifiers. Every account uses the same positive sequence; permissions
-- are derived only from the separately audited profile role.
CREATE TABLE community_identity (
  uid INTEGER PRIMARY KEY AUTOINCREMENT CHECK (uid BETWEEN 1 AND 9007199254740991),
  user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TRIGGER community_identity_immutable_before_update
BEFORE UPDATE ON community_identity
BEGIN
  SELECT RAISE(ABORT, 'community identities are immutable');
END;

CREATE TRIGGER community_identity_immutable_before_delete
BEFORE DELETE ON community_identity
BEGIN
  SELECT RAISE(ABORT, 'community identities cannot be deleted');
END;

CREATE TABLE community_profile (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  handle TEXT COLLATE NOCASE UNIQUE CHECK (
    handle IS NULL
    OR (
      length(handle) BETWEEN 3 AND 32
      AND handle = lower(handle)
      AND handle NOT GLOB '*[^a-z0-9_-]*'
      AND substr(handle, 1, 1) GLOB '[a-z0-9]'
      AND substr(handle, -1, 1) GLOB '[a-z0-9]'
    )
  ),
  bio TEXT CHECK (bio IS NULL OR length(bio) <= 500),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80),
  pending_display_name TEXT
    CHECK (pending_display_name IS NULL OR length(pending_display_name) BETWEEN 1 AND 80),
  display_name_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (display_name_status IN ('pending', 'allow', 'block')),
  display_name_revision INTEGER NOT NULL DEFAULT 1 CHECK (display_name_revision >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at >= created_at)
    OR (status <> 'deleted' AND deleted_at IS NULL)
  ),
  CHECK (
    (display_name_status = 'allow' AND display_name IS NOT NULL AND pending_display_name IS NULL)
    OR (display_name_status IN ('pending', 'block') AND pending_display_name IS NOT NULL)
  )
);

-- Numeric-only handles would collide with the public @UID mention namespace.
-- Existing databases may already contain one, so the migration safely
-- grandfathers stored values while preventing new ambiguous assignments.
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

CREATE INDEX community_profile_display_name_moderation_idx
  ON community_profile(status, display_name_status, updated_at, user_id)
  WHERE deleted_at IS NULL AND pending_display_name IS NOT NULL;

CREATE TRIGGER community_profile_display_name_revision_before_update
BEFORE UPDATE OF display_name, pending_display_name, display_name_status, display_name_revision
ON community_profile
WHEN NEW.display_name_revision < OLD.display_name_revision
  OR (
    NEW.display_name_revision = OLD.display_name_revision
    AND (
      NEW.display_name IS NOT OLD.display_name
      OR NEW.pending_display_name IS NOT OLD.pending_display_name
    )
    AND NOT (
      OLD.display_name_status IN ('pending', 'block')
      AND OLD.pending_display_name IS NOT NULL
      AND NEW.display_name_status = 'allow'
      AND NEW.display_name = OLD.pending_display_name
      AND NEW.pending_display_name IS NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'display name revisions are immutable and monotonic');
END;

CREATE TABLE community_post (
  id TEXT PRIMARY KEY NOT NULL,
  author_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'hidden')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  comment_count INTEGER NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'protected', 'private')),
  pinned_at INTEGER,
  archived_at INTEGER,
  moderation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending', 'allow', 'review', 'block')),
  moderation_revision INTEGER NOT NULL DEFAULT 1 CHECK (moderation_revision >= 1),
  published_at INTEGER,
  bookmark_count INTEGER NOT NULL DEFAULT 0 CHECK (bookmark_count >= 0),
  deleted_by_user_id TEXT REFERENCES "user"(id) ON DELETE RESTRICT,
  delete_reason_code TEXT CHECK (delete_reason_code IS NULL OR length(delete_reason_code) BETWEEN 1 AND 80),
  comments_locked_at INTEGER,
  comments_locked_by_user_id TEXT REFERENCES "user"(id) ON DELETE RESTRICT,
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
  )
);

CREATE INDEX community_post_feed_idx
  ON community_post(status, deleted_at, created_at DESC, id DESC);

CREATE INDEX community_post_author_idx
  ON community_post(author_id, created_at DESC);

CREATE TABLE community_comment (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  parent_id TEXT REFERENCES community_comment(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  moderation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending', 'allow', 'review', 'block')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  moderation_revision INTEGER NOT NULL DEFAULT 1 CHECK (moderation_revision >= 1),
  like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  deleted_by_user_id TEXT REFERENCES "user"(id) ON DELETE RESTRICT,
  delete_reason_code TEXT CHECK (delete_reason_code IS NULL OR length(delete_reason_code) BETWEEN 1 AND 80),
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
  hidden_at INTEGER,
  hidden_by_user_id TEXT REFERENCES "user"(id) ON DELETE RESTRICT
);

CREATE INDEX community_comment_post_idx
  ON community_comment(post_id, deleted_at, created_at, id);

CREATE INDEX community_comment_author_idx
  ON community_comment(author_id, created_at DESC);

CREATE INDEX community_comment_parent_idx
  ON community_comment(parent_id);

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

CREATE TABLE community_reaction (
  post_id TEXT NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind = 'like'),
  created_at INTEGER NOT NULL,
  activation_id TEXT CHECK (activation_id IS NULL OR length(activation_id) = 36),
  PRIMARY KEY (post_id, user_id, kind)
);

CREATE INDEX community_reaction_user_idx
  ON community_reaction(user_id, created_at DESC);

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

CREATE TABLE user_preference (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  locale TEXT CHECK (locale IS NULL OR locale IN ('ja', 'en', 'zh-TW', 'zh-CN', 'ko')),
  asset_server TEXT CHECK (asset_server IS NULL OR length(asset_server) BETWEEN 1 AND 32),
  settings_json TEXT CHECK (settings_json IS NULL OR json_valid(settings_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at INTEGER NOT NULL
);

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

CREATE TRIGGER community_user_deleted_profile_before_delete
BEFORE DELETE ON "user"
WHEN EXISTS (
  SELECT 1 FROM community_profile
  WHERE user_id = OLD.id AND status = 'deleted' AND deleted_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'soft-deleted users cannot be physically deleted');
END;

CREATE TRIGGER community_comment_parent_before_insert
BEFORE INSERT ON community_comment
WHEN NEW.parent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM community_comment AS parent
    WHERE parent.id = NEW.parent_id
      AND parent.post_id = NEW.post_id
      AND parent.deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'parent comment must be visible and belong to the same post');
END;

CREATE TRIGGER community_comment_parent_before_update
BEFORE UPDATE OF parent_id, post_id ON community_comment
WHEN NEW.parent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM community_comment AS parent
    WHERE parent.id = NEW.parent_id
      AND parent.post_id = NEW.post_id
      AND parent.deleted_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'parent comment must be visible and belong to the same post');
END;

CREATE TRIGGER community_comment_post_immutable
BEFORE UPDATE OF post_id ON community_comment
WHEN NEW.post_id <> OLD.post_id
BEGIN
  SELECT RAISE(ABORT, 'comment post_id is immutable');
END;

CREATE TRIGGER community_reaction_post_immutable
BEFORE UPDATE OF post_id ON community_reaction
WHEN NEW.post_id <> OLD.post_id
BEGIN
  SELECT RAISE(ABORT, 'reaction post_id is immutable');
END;

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

CREATE TRIGGER community_reaction_after_insert
AFTER INSERT ON community_reaction
WHEN NEW.kind = 'like'
BEGIN
  UPDATE community_post SET like_count = like_count + 1 WHERE id = NEW.post_id;
END;

CREATE TRIGGER community_reaction_after_delete
AFTER DELETE ON community_reaction
WHEN OLD.kind = 'like'
BEGIN
  UPDATE community_post SET like_count = max(0, like_count - 1) WHERE id = OLD.post_id;
END;

CREATE INDEX community_post_feed_v2_idx
  ON community_post(status, deleted_at, archived_at, visibility, created_at DESC, id DESC);

CREATE INDEX community_post_author_state_idx
  ON community_post(author_id, archived_at, created_at DESC, id DESC);

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

CREATE TABLE community_bookmark (
  post_id TEXT NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX community_bookmark_post_idx
  ON community_bookmark(post_id, user_id);

CREATE INDEX community_bookmark_user_time_idx
  ON community_bookmark(user_id, created_at DESC, post_id);

CREATE TABLE community_post_rank (
  post_id TEXT PRIMARY KEY NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  base_score REAL NOT NULL,
  algorithm_version TEXT NOT NULL CHECK (length(algorithm_version) BETWEEN 1 AND 80),
  calculated_at INTEGER NOT NULL
);

CREATE INDEX community_post_rank_score_idx
  ON community_post_rank(base_score DESC, calculated_at DESC, post_id DESC);

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

CREATE INDEX community_post_moderation_idx
  ON community_post(moderation_status, status, deleted_at, created_at DESC, id DESC);

CREATE INDEX community_comment_moderation_idx
  ON community_comment(post_id, moderation_status, deleted_at, created_at, id);

CREATE INDEX community_comment_latest_idx
  ON community_comment(post_id, parent_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND hidden_at IS NULL AND moderation_status = 'allow';

CREATE INDEX community_comment_hot_idx
  ON community_comment(post_id, parent_id, like_count DESC, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND hidden_at IS NULL AND moderation_status = 'allow';

CREATE TABLE community_attachment (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'post' CHECK (purpose IN ('avatar', 'post', 'work-cover')),
  idempotency_key TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 160),
  media_type TEXT NOT NULL
    CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp', 'text/plain')),
  declared_size INTEGER NOT NULL CHECK (declared_size BETWEEN 1 AND 10485760),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size = declared_size),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  r2_etag TEXT,
  r2_version TEXT,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'scanning', 'ready', 'review', 'rejected', 'deleted')),
  moderation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending', 'allow', 'review', 'block')),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) <= 80),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  object_deleted_at INTEGER,
  UNIQUE(owner_user_id, idempotency_key),
  CHECK (media_type <> 'text/plain' OR declared_size <= 65536),
  CHECK (deleted_at IS NULL OR status = 'deleted'),
  CHECK (object_deleted_at IS NULL OR deleted_at IS NOT NULL)
);

CREATE INDEX community_attachment_owner_idx
  ON community_attachment(owner_user_id, status, created_at DESC, id DESC);

CREATE INDEX community_attachment_cleanup_idx
  ON community_attachment(status, expires_at, updated_at, id);

CREATE TABLE community_profile_avatar (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES community_profile(user_id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL UNIQUE REFERENCES community_attachment(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at INTEGER NOT NULL
);

CREATE TRIGGER community_profile_avatar_before_insert
BEFORE INSERT ON community_profile_avatar
WHEN NOT EXISTS (
  SELECT 1
  FROM community_attachment AS attachment
  WHERE attachment.id = NEW.attachment_id
    AND attachment.owner_user_id = NEW.user_id
    AND attachment.purpose = 'avatar'
    AND attachment.status = 'ready'
    AND attachment.moderation_status = 'allow'
    AND attachment.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'avatar must be an allowed avatar attachment owned by the user');
END;

CREATE TRIGGER community_profile_avatar_before_update
BEFORE UPDATE OF user_id, attachment_id ON community_profile_avatar
WHEN NOT EXISTS (
  SELECT 1
  FROM community_attachment AS attachment
  WHERE attachment.id = NEW.attachment_id
    AND attachment.owner_user_id = NEW.user_id
    AND attachment.purpose = 'avatar'
    AND attachment.status = 'ready'
    AND attachment.moderation_status = 'allow'
    AND attachment.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'avatar must be an allowed avatar attachment owned by the user');
END;

CREATE TABLE community_post_attachment (
  post_id TEXT NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL UNIQUE REFERENCES community_attachment(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, attachment_id),
  UNIQUE(post_id, position)
);

CREATE INDEX community_post_attachment_post_idx
  ON community_post_attachment(post_id, position, attachment_id);

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

CREATE TABLE community_post_revision_seal (
  post_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  sealed_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, revision_number),
  FOREIGN KEY (post_id, revision_number)
    REFERENCES community_post_revision(post_id, revision_number) ON DELETE RESTRICT
);

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

CREATE TABLE community_role_event (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  from_role TEXT NOT NULL CHECK (from_role IN ('member', 'moderator', 'admin')),
  to_role TEXT NOT NULL CHECK (to_role IN ('member', 'moderator', 'admin')),
  actor_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL,
  CHECK (from_role <> to_role)
);

CREATE INDEX community_role_event_user_idx
  ON community_role_event(user_id, created_at DESC, id DESC);

CREATE TABLE community_user_restriction (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('sign_in', 'write', 'upload')),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  actor_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by_user_id TEXT REFERENCES "user"(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);

CREATE UNIQUE INDEX community_user_restriction_active_idx
  ON community_user_restriction(user_id, kind)
  WHERE revoked_at IS NULL;

CREATE INDEX community_user_restriction_user_idx
  ON community_user_restriction(user_id, created_at DESC, id DESC);

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

CREATE TABLE admin_operation (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  target_kind TEXT NOT NULL CHECK (length(target_kind) BETWEEN 1 AND 40),
  target_id TEXT CHECK (target_id IS NULL OR length(target_id) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  external_ref TEXT CHECK (external_ref IS NULL OR length(external_ref) <= 500),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 80),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(actor_user_id, idempotency_key),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX admin_operation_status_idx
  ON admin_operation(status, updated_at, id);

CREATE INDEX admin_operation_actor_idx
  ON admin_operation(actor_user_id, created_at DESC, id DESC);

CREATE TABLE admin_operation_event (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL REFERENCES admin_operation(id) ON DELETE CASCADE,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('pending', 'running', 'succeeded', 'failed')),
  to_status TEXT NOT NULL CHECK (to_status IN ('pending', 'running', 'succeeded', 'failed')),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  created_at INTEGER NOT NULL
);

CREATE INDEX admin_operation_event_operation_idx
  ON admin_operation_event(operation_id, created_at, id);

CREATE TABLE resource_server (
  slug TEXT PRIMARY KEY NOT NULL CHECK (
    length(slug) BETWEEN 1 AND 32
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND substr(slug, 1, 1) GLOB '[a-z0-9]'
    AND substr(slug, -1, 1) GLOB '[a-z0-9]'
  ),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  region TEXT NOT NULL CHECK (region IN ('global', 'jp', 'kr', 'tw', 'cn', 'en')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  resource_prefix TEXT NOT NULL UNIQUE CHECK (resource_prefix = 'servers/' || slug),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT REFERENCES "user"(id) ON DELETE RESTRICT,
  updated_by TEXT REFERENCES "user"(id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE INDEX resource_server_status_idx
  ON resource_server(status, region, display_name, slug);

-- Built-in bootstrap rows have no actor because a fresh database has no users
-- yet. All later admin mutations record both operator fields.
INSERT INTO resource_server
  (slug, display_name, region, status, resource_prefix, version,
   created_at, updated_at, created_by, updated_by)
VALUES ('jp-cbt', 'Japan CBT', 'jp', 'active', 'servers/jp-cbt', 1, 0, 0, NULL, NULL);

CREATE TABLE resource_package_upload (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  server TEXT NOT NULL REFERENCES resource_server(slug) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  r2_upload_id TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 160),
  media_type TEXT NOT NULL CHECK (media_type = 'application/zip'),
  declared_size INTEGER NOT NULL CHECK (declared_size BETWEEN 1 AND 2147483648),
  expected_sha256 TEXT NOT NULL CHECK (
    length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  verified_sha256 TEXT CHECK (
    verified_sha256 IS NULL OR (length(verified_sha256) = 64 AND verified_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'uploading', 'uploaded', 'verifying', 'ready', 'processing', 'succeeded', 'failed', 'expired')
  ),
  expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX resource_package_upload_status_idx
  ON resource_package_upload(status, updated_at, id);

CREATE TABLE resource_package_part (
  upload_id TEXT NOT NULL REFERENCES resource_package_upload(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL CHECK (length(etag) BETWEEN 1 AND 200),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 1),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE resource_run (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE REFERENCES admin_operation(id) ON DELETE RESTRICT,
  server TEXT NOT NULL REFERENCES resource_server(slug) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('github', 'package')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 500),
  github_run_id INTEGER,
  github_run_url TEXT CHECK (github_run_url IS NULL OR github_run_url GLOB 'https://github.com/*'),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed')),
  conclusion TEXT CHECK (conclusion IS NULL OR length(conclusion) BETWEEN 1 AND 40),
  release_id TEXT CHECK (release_id IS NULL OR length(release_id) BETWEEN 1 AND 160),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX resource_run_status_idx
  ON resource_run(status, updated_at, id);

CREATE TRIGGER community_post_attachment_ready_before_insert
BEFORE INSERT ON community_post_attachment
WHEN NOT EXISTS (
  SELECT 1
  FROM community_attachment AS attachment
  WHERE attachment.id = NEW.attachment_id
    AND attachment.purpose = 'post'
    AND attachment.status = 'ready'
    AND attachment.moderation_status = 'allow'
    AND attachment.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'attachment must be ready and allowed');
END;

CREATE TRIGGER community_post_attachment_owner_before_insert
BEFORE INSERT ON community_post_attachment
WHEN NOT EXISTS (
  SELECT 1
  FROM community_attachment AS attachment
  JOIN community_post AS post ON post.id = NEW.post_id
  WHERE attachment.id = NEW.attachment_id
    AND attachment.owner_user_id = post.author_id
    AND post.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'attachment and post must share an owner');
END;

CREATE TRIGGER community_post_attachment_immutable
BEFORE UPDATE OF post_id, attachment_id ON community_post_attachment
WHEN NEW.post_id <> OLD.post_id OR NEW.attachment_id <> OLD.attachment_id
BEGIN
  SELECT RAISE(ABORT, 'attachment link identity is immutable');
END;

-- User-authored stories and charts keep only searchable metadata in D1. The
-- actual document/chart payload is versioned in R2 and addressed by key + hash.
CREATE TABLE community_work (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('story', 'chart')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 1000),
  cover_attachment_id TEXT REFERENCES community_attachment(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('public', 'protected', 'private')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  moderation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending', 'allow', 'review', 'block')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  archived_at INTEGER,
  deleted_at INTEGER,
  CHECK (updated_at >= created_at),
  CHECK (published_at IS NULL OR published_at >= created_at),
  CHECK (archived_at IS NULL OR archived_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR (status IN ('published', 'archived') AND published_at IS NOT NULL)
  ),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE INDEX community_work_owner_idx
  ON community_work(owner_user_id, status, updated_at DESC, id DESC);

CREATE INDEX community_work_public_idx
  ON community_work(kind, visibility, status, moderation_status, published_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE community_work_revision (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL REFERENCES community_work(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  editor_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  payload_object_key TEXT NOT NULL UNIQUE CHECK (length(payload_object_key) BETWEEN 1 AND 1024),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_byte_size INTEGER NOT NULL CHECK (payload_byte_size BETWEEN 1 AND 1073741824),
  payload_media_type TEXT NOT NULL
    CHECK (payload_media_type IN ('application/json', 'application/octet-stream', 'application/zip')),
  schema_version TEXT NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 80),
  change_summary TEXT CHECK (change_summary IS NULL OR length(change_summary) <= 500),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review', 'published', 'rejected', 'superseded')),
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE(work_id, revision_number),
  CHECK (
    (status IN ('published', 'superseded') AND published_at IS NOT NULL AND published_at >= created_at)
    OR (status IN ('draft', 'review', 'rejected') AND published_at IS NULL)
  )
);

CREATE INDEX community_work_revision_history_idx
  ON community_work_revision(work_id, revision_number DESC, id DESC);

CREATE UNIQUE INDEX community_work_revision_published_idx
  ON community_work_revision(work_id)
  WHERE status = 'published';

CREATE TRIGGER community_work_revision_payload_immutable_before_update
BEFORE UPDATE OF work_id, revision_number, editor_user_id, payload_object_key,
  payload_sha256, payload_byte_size, payload_media_type, schema_version, created_at
ON community_work_revision
WHEN NEW.work_id <> OLD.work_id
  OR NEW.revision_number <> OLD.revision_number
  OR NEW.editor_user_id <> OLD.editor_user_id
  OR NEW.payload_object_key <> OLD.payload_object_key
  OR NEW.payload_sha256 <> OLD.payload_sha256
  OR NEW.payload_byte_size <> OLD.payload_byte_size
  OR NEW.payload_media_type <> OLD.payload_media_type
  OR NEW.schema_version <> OLD.schema_version
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'work revision payload metadata is immutable');
END;

CREATE TABLE community_work_collaborator (
  work_id TEXT NOT NULL REFERENCES community_work(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('coauthor', 'editor', 'viewer')),
  invited_by_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (work_id, user_id),
  CHECK (updated_at >= created_at)
);

CREATE INDEX community_work_collaborator_user_idx
  ON community_work_collaborator(user_id, updated_at DESC, work_id);

CREATE TABLE community_post_work (
  post_id TEXT PRIMARY KEY NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES community_work(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
);

CREATE INDEX community_post_work_work_idx
  ON community_post_work(work_id, created_at DESC, post_id);

-- Linked game accounts contain only public identifiers and sync state. Provider
-- credentials/tokens must remain in secret storage and never enter D1.
CREATE TABLE community_game_account (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 40),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 24),
  external_account_id TEXT NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 80),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'revoked')),
  verified_at INTEGER,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(provider, region, external_account_id),
  CHECK (updated_at >= created_at),
  CHECK (
    (verification_status = 'verified' AND verified_at IS NOT NULL)
    OR (verification_status IN ('unverified', 'pending') AND verified_at IS NULL)
    OR verification_status = 'revoked'
  ),
  CHECK (last_synced_at IS NULL OR last_synced_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE INDEX community_game_account_user_idx
  ON community_game_account(user_id, visibility, updated_at DESC, id DESC);

CREATE TABLE community_game_account_snapshot (
  id TEXT PRIMARY KEY NOT NULL,
  game_account_id TEXT NOT NULL REFERENCES community_game_account(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(summary_json) AND json_type(summary_json) = 'object' AND length(summary_json) <= 8192),
  payload_object_key TEXT UNIQUE CHECK (
    payload_object_key IS NULL OR length(payload_object_key) BETWEEN 1 AND 1024
  ),
  payload_sha256 TEXT CHECK (
    payload_sha256 IS NULL
    OR (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  payload_byte_size INTEGER CHECK (payload_byte_size IS NULL OR payload_byte_size BETWEEN 1 AND 1073741824),
  schema_version TEXT NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL,
  UNIQUE(game_account_id, captured_at),
  CHECK (
    (payload_object_key IS NULL AND payload_sha256 IS NULL AND payload_byte_size IS NULL)
    OR (payload_object_key IS NOT NULL AND payload_sha256 IS NOT NULL AND payload_byte_size IS NOT NULL)
  )
);

CREATE INDEX community_game_account_snapshot_history_idx
  ON community_game_account_snapshot(game_account_id, captured_at DESC, id DESC);

CREATE TRIGGER community_game_account_snapshot_immutable_before_update
BEFORE UPDATE ON community_game_account_snapshot
BEGIN
  SELECT RAISE(ABORT, 'game account snapshots are immutable');
END;

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
