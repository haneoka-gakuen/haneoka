CREATE TABLE IF NOT EXISTS sponsor_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  tiers_version INTEGER NOT NULL DEFAULT 1 CHECK (tiers_version >= 1),
  source_updated_at TEXT,
  write_token TEXT,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO sponsor_state (id, revision, tiers_version, source_updated_at, updated_at)
VALUES (1, 1, 1, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE IF NOT EXISTS sponsor_tier (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 32),
  labels TEXT NOT NULL CHECK (json_valid(labels) AND json_type(labels) = 'object'),
  sort_order INTEGER NOT NULL,
  cny REAL NOT NULL DEFAULT 0 CHECK (cny >= 0),
  usd REAL NOT NULL DEFAULT 0 CHECK (usd >= 0),
  card TEXT
);
INSERT OR IGNORE INTO sponsor_tier (id, labels, sort_order, cny, usd, card) VALUES
  ('black', '{"en":"T.G.W CARD Black","ja":"T.G.W CARD Black","ko":"T.G.W CARD Black","zh-CN":"T.G.W CARD Black","zh-TW":"T.G.W CARD Black"}', 0, 100, 20, 'tgwcard_black_small'),
  ('platinum', '{"en":"T.G.W CARD Platinum","ja":"T.G.W CARD Platinum","ko":"T.G.W CARD Platinum","zh-CN":"T.G.W CARD Platinum","zh-TW":"T.G.W CARD Platinum"}', 1, 50, 10, 'tgwcard_platinum_small'),
  ('gold', '{"en":"T.G.W CARD Gold","ja":"T.G.W CARD Gold","ko":"T.G.W CARD Gold","zh-CN":"T.G.W CARD Gold","zh-TW":"T.G.W CARD Gold"}', 2, 20, 5, 'tgwcard_gold_small'),
  ('normal', '{"en":"T.G.W CARD Normal","ja":"T.G.W CARD Normal","ko":"T.G.W CARD Normal","zh-CN":"T.G.W CARD Normal","zh-TW":"T.G.W CARD Normal"}', 3, 10, 2, 'tgwcard_normal_small'),
  ('custom', '{"en":"Flexible support","ja":"お気持ちの支援","ko":"자유 후원","zh-CN":"随心支持","zh-TW":"隨心支持"}', 4, 0, 0, NULL);

CREATE TABLE IF NOT EXISTS sponsor_source (
  source_key TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('afdian', 'patreon')),
  name TEXT NOT NULL,
  avatar TEXT,
  tier TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  first_at INTEGER NOT NULL,
  last_at INTEGER,
  synced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sponsor_source_channel_idx ON sponsor_source (channel, synced_at);

CREATE TABLE IF NOT EXISTS sponsor_entry (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  source_key TEXT UNIQUE,
  channel TEXT CHECK (channel IS NULL OR channel IN ('afdian', 'patreon', 'kofi', 'alipay', 'wechat', 'other')),
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 40),
  avatar TEXT CHECK (avatar IS NULL OR length(avatar) <= 512),
  message TEXT CHECK (message IS NULL OR length(message) <= 280),
  tier TEXT,
  status TEXT CHECK (status IS NULL OR status IN ('active', 'past')),
  first_at INTEGER,
  last_at INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (source_key IS NOT NULL OR (channel IS NOT NULL AND name IS NOT NULL AND first_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS kofi_payment_message (
  message_id TEXT PRIMARY KEY REFERENCES kofi_payment(message_id) ON DELETE CASCADE,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 280)
);

-- An administrator's amount for one supporter. No row follows the source; NULL amount and currency publish none.
CREATE TABLE IF NOT EXISTS sponsor_amount (
  entry_id TEXT PRIMARY KEY REFERENCES sponsor_entry(id) ON DELETE CASCADE,
  amount TEXT CHECK (amount IS NULL OR (length(amount) BETWEEN 1 AND 16 AND CAST(amount AS REAL) > 0)),
  currency TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency = upper(currency))),
  updated_at INTEGER NOT NULL,
  CHECK ((amount IS NULL) = (currency IS NULL))
);

INSERT OR IGNORE INTO sponsor_entry (id, source_key, created_at, updated_at)
SELECT lower(hex(randomblob(16))), 'kofi:' || supporter,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM kofi_payment
GROUP BY supporter;
