-- Administrator analytics indexes over existing records; no new data collection.
CREATE INDEX IF NOT EXISTS admin_operation_target_time_idx ON admin_operation(target_kind,target_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS community_post_created_time_idx ON community_post(created_at,id);
CREATE INDEX IF NOT EXISTS community_comment_created_time_idx ON community_comment(created_at,id);
CREATE INDEX IF NOT EXISTS community_attachment_created_time_idx ON community_attachment(created_at,id);
CREATE INDEX IF NOT EXISTS community_moderation_job_created_time_idx ON community_moderation_job(created_at,id);
CREATE INDEX IF NOT EXISTS community_moderation_event_created_time_idx ON community_moderation_event(created_at,id);
CREATE INDEX IF NOT EXISTS community_moderation_case_completed_time_idx ON community_moderation_case(completed_at,id);
CREATE INDEX IF NOT EXISTS community_user_last_visit_country_time_idx ON community_user_last_visit(ip_country_code,visited_at,user_id);
