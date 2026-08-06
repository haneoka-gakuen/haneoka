-- Add the bilibili Global CBT (gl-cbt) resource server alongside the Japan CBT baseline
-- introduced in 0004_reset_v1.sql. Idempotent so it is safe against a row already
-- created through the admin API.
INSERT OR IGNORE INTO resource_server
  (slug, display_name, region, status, resource_prefix, version,
   created_at, updated_at, created_by, updated_by)
VALUES ('gl-cbt', 'Global CBT', 'global', 'active', 'servers/gl-cbt', 1, 0, 0, NULL, NULL);
