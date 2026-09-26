-- Register the production Japanese server (jp) and align the resource server
-- rows with the settings page: intl reads as Global and jp as Japan. The daily
-- pipeline already publishes under servers/jp, but without this row the worker
-- answers /api/v1/servers/jp/* with server_not_found. The legacy gl-cbt slug
-- from before the 0009 rename still shows up in the registry; two historical
-- resource_run rows reference it under ON DELETE RESTRICT, so it is retired
-- instead of deleted to keep the audit trail intact.
INSERT OR IGNORE INTO resource_server
  (slug, display_name, region, status, resource_prefix, version,
   created_at, updated_at, created_by, updated_by)
VALUES ('jp', 'Japan', 'jp', 'active', 'servers/jp', 1, 0, 0, NULL, NULL);
UPDATE resource_server
   SET display_name = 'Global',
       updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
 WHERE slug = 'intl' AND display_name = 'Our Notes';
UPDATE resource_server
   SET status = 'retired',
       updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
 WHERE slug = 'gl-cbt' AND status = 'active';
