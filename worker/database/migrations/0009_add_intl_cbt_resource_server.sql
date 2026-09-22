-- Register the intl-cbt server slug for the freshly republished Global CBT
-- release (R2 prefix servers/intl-cbt, published by the renamed pipeline).
INSERT INTO resource_server
  (slug, display_name, region, status, resource_prefix, version,
   created_at, updated_at, created_by, updated_by)
VALUES ('intl-cbt', 'Global CBT', 'global', 'active', 'servers/intl-cbt', 1, 0, 0, NULL, NULL);
