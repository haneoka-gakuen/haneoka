import { avatarUrlSelect } from "./avatar-url";
import { readIpDetails } from "./ip-address";
type Row = Record<string, string | number | null>;
export async function readAdminUser(request: Request, env: Env, id: string): Promise<Response> {
  const user = await env.DB.prepare(
    `SELECT u.id, identity.uid AS publicUid, u.name AS accountName,u.email,
    u.emailVerified,u.createdAt,u.updatedAt,${avatarUrlSelect("u")} AS image,
    p.display_name AS publicDisplayName,p.pending_display_name AS candidateDisplayName,
    p.display_name_status AS displayNameStatus,p.handle,p.bio,p.role,p.status,p.version,
    p.created_at AS profileCreatedAt,p.updated_at AS profileUpdatedAt,p.deleted_at AS profileDeletedAt
    FROM "user" AS u LEFT JOIN community_profile AS p ON p.user_id=u.id
    LEFT JOIN community_identity AS identity ON identity.user_id=u.id WHERE u.id=?`,
  )
    .bind(id)
    .first<Row>();
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
    "X-Content-Type-Options": "nosniff",
  };
  if (!user)
    return new Response(
      request.method === "HEAD"
        ? null
        : JSON.stringify({ error: { code: "user_not_found", message: "Haneoka account does not exist" } }),
      { status: 404, headers },
    );
  const now = Date.now(),
    date = new Date(now).toISOString();
  const query: Record<string, D1PreparedStatement> = {
    providers: env.DB.prepare(
      `SELECT providerId,COUNT(*) AS bindingCount,MIN(createdAt) AS firstLinkedAt,
      MAX(updatedAt) AS lastUpdatedAt,MAX(CASE WHEN providerId='credential' AND password IS NOT NULL AND length(password)>0 THEN 1 ELSE 0 END) AS hasPasswordCredential
      FROM account WHERE userId=? GROUP BY providerId ORDER BY providerId`,
    ).bind(id),
    sessions: env.DB.prepare(
      `SELECT COUNT(*) AS stored,
      COALESCE(SUM(julianday(expiresAt)>julianday(?)),0) AS active,
      COALESCE(SUM(julianday(expiresAt)<=julianday(?)),0) AS expired,
      COALESCE(SUM(julianday(expiresAt) IS NULL),0) AS unknownExpiry,MAX(updatedAt) AS lastSessionUpdatedAt
      FROM "session" WHERE userId=?`,
    ).bind(date, date, id),
    posts: env.DB.prepare(
      `SELECT moderation_status AS state,COUNT(*) AS count FROM community_post WHERE author_id=? GROUP BY moderation_status`,
    ).bind(id),
    comments: env.DB.prepare(
      `SELECT moderation_status AS state,COUNT(*) AS count FROM community_comment WHERE author_id=? GROUP BY moderation_status`,
    ).bind(id),
    attachments: env.DB.prepare(
      `SELECT status AS state,COUNT(*) AS count FROM community_attachment WHERE owner_user_id=? GROUP BY status`,
    ).bind(id),
    restrictions: env.DB.prepare(
      `SELECT id,kind,reason_code AS reasonCode,actor_user_id AS actorUserId,expires_at AS expiresAt,
      revoked_at AS revokedAt,version,created_at AS createdAt,updated_at AS updatedAt,
      CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) THEN 1 ELSE 0 END AS active
      FROM community_user_restriction WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 51`,
    ).bind(now, id),
    restrictionCounts: env.DB.prepare(
      `SELECT COUNT(*) AS total,COALESCE(SUM(revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)),0) AS active
      FROM community_user_restriction WHERE user_id=?`,
    ).bind(now, id),
    operations: env.DB.prepare(
      `SELECT id,actor_user_id AS actorUserId,action,target_kind AS targetKind,target_id AS targetId,
      status,error_code AS errorCode,created_at AS createdAt,completed_at AS completedAt FROM admin_operation
      WHERE actor_user_id=? OR (target_kind='user' AND target_id=?) ORDER BY created_at DESC,id DESC LIMIT 51`,
    ).bind(id, id),
    operationCounts: env.DB.prepare(
      `SELECT COUNT(*) AS total FROM admin_operation WHERE actor_user_id=? OR (target_kind='user' AND target_id=?)`,
    ).bind(id, id),
    visit: env.DB.prepare(
      `SELECT visited_at AS visitedAt,ip_address AS ipAddress,ip_country_code AS countryCode,
      ip_region_code AS regionCode,ip_region_name AS regionName,ip_details_json AS details FROM community_user_last_visit WHERE user_id=?`,
    ).bind(id),
  };
  const keys = Object.keys(query),
    batch = await env.DB.batch<Row>(keys.map((k) => query[k]!));
  if (batch.length !== keys.length) throw new Error("Incomplete admin user detail batch");
  const rows = Object.fromEntries(keys.map((k, i) => [k, batch[i]!.results]));
  const aggregate = (key: string) => Object.fromEntries(rows[key]!.map((row) => [String(row.state), row.count]));
  const total = (key: string) => rows[key]!.reduce((n, row) => n + Number(row.count), 0);
  const v = rows.visit![0],
    details = readIpDetails(typeof v?.details === "string" ? v.details : null);
  const value = {
    generatedAt: now,
    user: { ...user, emailVerified: user.emailVerified === 1 },
    identity: { idKind: "haneoka-auth-account-id", publicUidKind: "haneoka-community-uid" },
    providers: rows.providers!.map((row) => ({ ...row, hasPasswordCredential: row.hasPasswordCredential === 1 })),
    sessions: rows.sessions![0],
    counts: {
      posts: { total: total("posts"), moderation: aggregate("posts") },
      comments: { total: total("comments"), moderation: aggregate("comments") },
      attachments: { total: total("attachments"), status: aggregate("attachments") },
    },
    restrictions: {
      ...rows.restrictionCounts![0],
      items: rows.restrictions!.slice(0, 50).map((row) => ({ ...row, active: row.active === 1 })),
      hasMore: rows.restrictions!.length > 50,
    },
    operations: {
      ...rows.operationCounts![0],
      items: rows.operations!.slice(0, 50),
      hasMore: rows.operations!.length > 50,
    },
    lastVisit: v
      ? {
          visitedAt: v.visitedAt,
          ipAddress: v.ipAddress,
          ipLocation: {
            countryCode: v.countryCode,
            regionCode: v.regionCode,
            regionName: v.regionName,
            city: details.city,
            continent: details.continent,
            latitude: details.latitude,
            longitude: details.longitude,
            postalCode: details.postalCode,
            timezone: details.timezone,
          },
          network: { asn: details.asn, organization: details.asOrganization },
        }
      : null,
  };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(value), { headers });
}
