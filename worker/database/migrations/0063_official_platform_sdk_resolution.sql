CREATE TRIGGER IF NOT EXISTS official_platform_sdk_owner_resolved
AFTER UPDATE OF account_id ON official_platform_sdk_owners
WHEN OLD.account_id IS NULL AND NEW.account_id IS NOT NULL
BEGIN
  UPDATE official_platform_accounts SET version=version+1 WHERE id IN (
    SELECT account_id FROM official_platform_sdk_identities
    WHERE identity_scope=NEW.identity_scope AND sdk_uid=NEW.sdk_uid
  );
  DELETE FROM official_platform_sdk_sessions WHERE account_id IN (
    SELECT account_id FROM official_platform_sdk_identities
    WHERE identity_scope=NEW.identity_scope AND sdk_uid=NEW.sdk_uid
  );
  UPDATE official_platform_roles SET credential_box=NULL,last_verified_at_ms=NULL,
    status=iif(account_id=NEW.account_id,iif(player_id IS NULL,'not_initialized','auth_required'),'failed'),
    last_error_code=iif(account_id=NEW.account_id,NULL,'duplicate_sdk_identity')
    WHERE account_id IN (SELECT account_id FROM official_platform_sdk_identities
      WHERE identity_scope=NEW.identity_scope AND sdk_uid=NEW.sdk_uid);
END;

UPDATE official_platform_accounts SET version=version+1 WHERE id IN (
  SELECT i.account_id FROM official_platform_sdk_identities AS i
  JOIN official_platform_sdk_owners AS o USING(identity_scope,sdk_uid)
  WHERE o.account_id IS NULL
) AND (EXISTS (SELECT 1 FROM official_platform_sdk_sessions AS s WHERE s.account_id=official_platform_accounts.id)
  OR EXISTS (SELECT 1 FROM official_platform_roles AS r WHERE r.account_id=official_platform_accounts.id
    AND (r.credential_box IS NOT NULL OR r.status IN ('ready','authenticating'))));

DELETE FROM official_platform_sdk_sessions WHERE account_id IN (
  SELECT i.account_id FROM official_platform_sdk_identities AS i
  JOIN official_platform_sdk_owners AS o USING(identity_scope,sdk_uid) WHERE o.account_id IS NULL
);

UPDATE official_platform_roles SET credential_box=NULL,last_verified_at_ms=NULL,
  status='failed',last_error_code='sdk_identity_conflict' WHERE account_id IN (
    SELECT i.account_id FROM official_platform_sdk_identities AS i
    JOIN official_platform_sdk_owners AS o USING(identity_scope,sdk_uid) WHERE o.account_id IS NULL
  );
