-- Add the production international server (intl) for the 2026-09-24 launch.
-- Content is served from the shared asset CDN prefix below; release objects
-- appear under servers/intl/ once the first production release is published.
INSERT INTO resource_server
  (slug, display_name, region, status, resource_prefix, version,
   created_at, updated_at, created_by, updated_by)
VALUES ('intl', 'Our Notes', 'global', 'active', 'servers/intl', 1, 0, 0, NULL, NULL);
