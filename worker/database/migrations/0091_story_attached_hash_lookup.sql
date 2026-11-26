CREATE INDEX IF NOT EXISTS community_story_asset_linked_hash_idx
  ON community_story_asset(blob_hash) WHERE attachment_id IS NOT NULL;
