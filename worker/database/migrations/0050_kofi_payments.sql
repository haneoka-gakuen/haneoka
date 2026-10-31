CREATE TABLE IF NOT EXISTS kofi_payment (
  message_id TEXT PRIMARY KEY,
  supporter TEXT NOT NULL,
  from_name TEXT NOT NULL,
  is_public INTEGER NOT NULL CHECK (is_public IN (0, 1)),
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  tier_name TEXT,
  is_subscription INTEGER NOT NULL CHECK (is_subscription IN (0, 1)),
  paid_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS kofi_payment_supporter_idx ON kofi_payment (supporter, paid_at DESC);
