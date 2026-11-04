CREATE TABLE IF NOT EXISTS community_story_resource_check (
 review_id TEXT PRIMARY KEY NOT NULL REFERENCES community_story_resource_review(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('queued','processing','succeeded','review')),
 attempts INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until INTEGER,
 dispatch_token TEXT,
 dispatched_at INTEGER,
 next_attempt_at INTEGER NOT NULL,
 policy_version TEXT NOT NULL,
 model_id TEXT,
 reason_code TEXT,
 categories_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(categories_json)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_story_resource_check_dispatch_idx
 ON community_story_resource_check(status,next_attempt_at,updated_at);
CREATE INDEX IF NOT EXISTS community_attachment_content_hash_idx
 ON community_attachment(sha256) WHERE sha256 IS NOT NULL;
