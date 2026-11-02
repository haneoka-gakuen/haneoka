CREATE TABLE IF NOT EXISTS official_guest_requests (
  guest_id TEXT PRIMARY KEY NOT NULL REFERENCES official_guest_accounts(id),
  run_id TEXT NOT NULL,
  request_box TEXT NOT NULL
);
