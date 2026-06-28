export type CommunityRestrictionKind = "sign_in" | "upload" | "write";

export interface CommunityAccessState {
  restriction: CommunityRestrictionKind | null;
  role: "admin" | "member" | "moderator";
  status: "active" | "deleted" | "suspended";
}

export const communityAccessState = async (
  env: Env,
  userId: string,
  kinds: readonly CommunityRestrictionKind[],
): Promise<CommunityAccessState | null> => {
  const restrictionSelect = kinds.length
    ? `(SELECT restriction.kind
        FROM community_user_restriction AS restriction
        WHERE restriction.user_id = profile.user_id
          AND restriction.kind IN (${kinds.map(() => "?").join(", ")})
          AND restriction.revoked_at IS NULL
          AND (restriction.expires_at IS NULL OR restriction.expires_at > ?)
        ORDER BY CASE restriction.kind WHEN 'sign_in' THEN 0 WHEN 'write' THEN 1 ELSE 2 END
        LIMIT 1)`
    : "NULL";
  return env.DB.prepare(
    `SELECT profile.role, profile.status, ${restrictionSelect} AS restriction
     FROM community_profile AS profile
     WHERE profile.user_id = ?
     LIMIT 1`,
  )
    .bind(...kinds, ...(kinds.length ? [Date.now()] : []), userId)
    .first<CommunityAccessState>();
};
