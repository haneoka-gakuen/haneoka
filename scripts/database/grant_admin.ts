import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runWrangler } from "./wrangler.ts";

const databaseName = "haneoka-community";
const repositoryRoot = resolve(import.meta.dirname, "../..");
const safePublicUid = /^[1-9]\d{0,15}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface AdminBootstrapSqlOptions {
  now?: number;
  randomUUID?: () => string;
}

export const buildAdminBootstrapSql = (publicUid: number, options: AdminBootstrapSqlOptions = {}): string => {
  if (!Number.isSafeInteger(publicUid) || publicUid < 1) throw new Error("The public UID is invalid");
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("The bootstrap timestamp is invalid");
  const createUuid = options.randomUUID ?? randomUUID;
  const nextUuid = (kind: string): string => {
    const value = createUuid();
    if (!uuidPattern.test(value)) throw new Error(`The generated ${kind} UUID is invalid`);
    return value.toLowerCase();
  };
  const roleEventId = nextUuid("role event");
  const operationId = nextUuid("operation");
  const idempotencyKey = `admin-bootstrap:${nextUuid("idempotency key")}`;
  const requestId = `operator-bootstrap:${nextUuid("request")}`;

  return `
INSERT INTO community_role_event
  (id, user_id, from_role, to_role, actor_user_id, reason_code, created_at)
SELECT
  '${roleEventId}', profile.user_id, profile.role, 'admin', profile.user_id,
  'operator.bootstrap', ${now}
FROM community_profile AS profile
JOIN community_identity AS identity ON identity.user_id = profile.user_id
JOIN "user" AS account ON account.id = profile.user_id
WHERE identity.uid = ${publicUid}
  AND profile.role <> 'admin'
  AND profile.status = 'active'
  AND profile.deleted_at IS NULL
  AND account.emailVerified = 1;

UPDATE community_profile
SET role = 'admin', version = version + 1, updated_at = ${now}
WHERE user_id = (SELECT user_id FROM community_identity WHERE uid = ${publicUid})
  AND role <> 'admin'
  AND status = 'active'
  AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM community_role_event AS role_event
    WHERE role_event.id = '${roleEventId}'
      AND role_event.user_id = community_profile.user_id
      AND role_event.from_role = community_profile.role
      AND role_event.to_role = 'admin'
  )
  AND EXISTS (
    SELECT 1 FROM "user"
    WHERE "user".id = community_profile.user_id
      AND "user".emailVerified = 1
  );

INSERT INTO admin_operation
  (id, actor_user_id, action, target_kind, target_id, status, idempotency_key,
   request_id, external_ref, created_at, updated_at, completed_at)
SELECT
  '${operationId}', profile.user_id, 'user.role.bootstrap', 'user', profile.user_id,
  'succeeded', '${idempotencyKey}', '${requestId}', '${roleEventId}', ${now}, ${now}, ${now}
FROM community_profile AS profile
JOIN community_identity AS identity ON identity.user_id = profile.user_id
JOIN "user" AS account ON account.id = profile.user_id
WHERE identity.uid = ${publicUid}
  AND profile.role = 'admin'
  AND profile.status = 'active'
  AND profile.deleted_at IS NULL
  AND account.emailVerified = 1
  AND EXISTS (
    SELECT 1
    FROM community_role_event AS role_event
    WHERE role_event.id = '${roleEventId}'
      AND role_event.user_id = profile.user_id
      AND role_event.to_role = 'admin'
  );

SELECT CASE
  WHEN EXISTS (
    SELECT 1
    FROM community_profile
    JOIN community_identity ON community_identity.user_id = community_profile.user_id
    JOIN "user" ON "user".id = community_profile.user_id
    WHERE community_identity.uid = ${publicUid}
      AND community_profile.role = 'admin'
      AND community_profile.status = 'active'
      AND community_profile.deleted_at IS NULL
      AND "user".emailVerified = 1
  )
  AND (
    NOT EXISTS (
      SELECT 1 FROM community_role_event WHERE id = '${roleEventId}'
    )
    OR EXISTS (
      SELECT 1
      FROM community_role_event AS role_event
      JOIN admin_operation AS operation ON operation.external_ref = role_event.id
      WHERE role_event.id = '${roleEventId}'
        AND role_event.user_id = (SELECT user_id FROM community_identity WHERE uid = ${publicUid})
        AND role_event.to_role = 'admin'
        AND operation.id = '${operationId}'
        AND operation.actor_user_id = (SELECT user_id FROM community_identity WHERE uid = ${publicUid})
        AND operation.action = 'user.role.bootstrap'
        AND operation.target_kind = 'user'
        AND operation.target_id = (SELECT user_id FROM community_identity WHERE uid = ${publicUid})
        AND operation.status = 'succeeded'
        AND operation.idempotency_key = '${idempotencyKey}'
    )
  ) THEN 1
  ELSE json_extract('', '$')
END AS administrator_ready;
`.trim();
};

const main = (): void => {
  const mode = process.argv[2];
  const uidArgument = process.argv[3] ?? "";
  const confirmation = process.argv[4];

  if (mode !== "--local" && mode !== "--remote") {
    throw new Error("Choose exactly one target: --local or --remote");
  }
  if (mode === "--remote" && (process.env.CI || !process.stdin.isTTY)) {
    throw new Error("Remote administrator bootstrap must run in an interactive terminal outside CI");
  }
  if (!uidArgument.startsWith("--uid=")) {
    throw new Error("Pass the positive public account UID as --uid=<integer>");
  }
  const uidValue = uidArgument.slice("--uid=".length);
  if (!safePublicUid.test(uidValue)) throw new Error("The public UID is invalid");
  const publicUid = Number(uidValue);
  if (!Number.isSafeInteger(publicUid)) throw new Error("The public UID is invalid");
  if (mode === "--remote" && confirmation !== `--confirm-remote=${databaseName}`) {
    throw new Error(`Remote bootstrap requires --confirm-remote=${databaseName}`);
  }
  if (mode === "--local" && confirmation) throw new Error("The local command does not accept a confirmation flag");
  if (process.argv.length > (mode === "--remote" ? 5 : 4)) throw new Error("Unexpected command arguments");

  const sql = buildAdminBootstrapSql(publicUid);
  runWrangler(["d1", "execute", databaseName, mode, `--command=${sql}`], repositoryRoot);
  console.log(`Administrator role is ready for public UID ${publicUid} in ${mode.slice(2)} D1.`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
