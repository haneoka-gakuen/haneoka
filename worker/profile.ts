import { getAuthSession } from "./auth";
import { inspectCommunityText, scheduleEntityModeration } from "./moderation";

const ACCOUNT_PROFILE_PATH = "/api/v1/account/profile";
const MAX_PROFILE_BODY_BYTES = 2 * 1024;
const MAX_DISPLAY_NAME_CODE_POINTS = 80;
const MAX_DISPLAY_NAME_BYTES = 320;
const MAX_HANDLE_CODE_POINTS = 32;
const MAX_BIO_CODE_POINTS = 500;
const MAX_BIO_BYTES = 2_000;
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])$/u;

type DisplayNameStatus = "allow" | "block" | "pending";
type ProfileStatus = "active" | "deleted" | "suspended";
type CommunityRole = "admin" | "member" | "moderator";

interface AccountProfileRow {
  accountName: string;
  avatarUrl: string | null;
  bio: string | null;
  displayName: string | null;
  displayNameRevision: number;
  displayNameStatus: DisplayNameStatus;
  handle: string | null;
  pendingDisplayName: string | null;
  profileStatus: ProfileStatus;
  profileVersion: number;
  publicUid: number;
  role: CommunityRole;
  userId: string;
  writeRestricted: number;
}

interface ProfileWriteAccess {
  profile: AccountProfileRow;
  userId: string;
}

interface ProfilePatch {
  bio: string | null;
  bioPresent: boolean;
  displayName: string | null;
  displayNamePresent: boolean;
  expectedVersion: number | null;
  handle: string | null;
  handlePresent: boolean;
}

type AccessResult = { ok: false; response: Response } | { ok: true; value: ProfileWriteAccess };
type BodyResult = { ok: false; response: Response } | { ok: true; value: ProfilePatch };
type JsonBodyResult = { ok: false; response: Response } | { ok: true; value: Record<string, unknown> };

const json = (request: Request, value: object, status = 200): Response =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });

const error = (request: Request, status: number, code: string, message: string): Response =>
  json(request, { error: { code, message } }, status);

const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("Origin");
  if (!origin) return request.headers.get("Sec-Fetch-Site") !== "cross-site";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

const readProfile = (env: Env, userId: string): Promise<AccountProfileRow | null> =>
  env.DB.prepare(
    `SELECT profile.user_id AS userId, account.name AS accountName, account.image AS avatarUrl,
            identity.uid AS publicUid,
            profile.handle, profile.bio, profile.role,
            profile.display_name AS displayName,
            profile.pending_display_name AS pendingDisplayName,
            profile.display_name_status AS displayNameStatus,
            profile.display_name_revision AS displayNameRevision,
            profile.status AS profileStatus, profile.version AS profileVersion,
            EXISTS(
              SELECT 1
              FROM community_user_restriction AS restriction
              WHERE restriction.user_id = profile.user_id
                AND restriction.kind = 'write'
                AND restriction.revoked_at IS NULL
                AND (restriction.expires_at IS NULL OR restriction.expires_at > ?)
            ) AS writeRestricted
     FROM community_profile AS profile
     JOIN "user" AS account ON account.id = profile.user_id
     JOIN community_identity AS identity ON identity.user_id = profile.user_id
     WHERE profile.user_id = ?
     LIMIT 1`,
  )
    .bind(Date.now(), userId)
    .first<AccountProfileRow>();

const profileValue = (profile: AccountProfileRow): object => ({
  accountName: profile.accountName,
  avatarSeed: profile.userId,
  avatarUrl: profile.avatarUrl,
  bio: profile.bio,
  candidateDisplayName: profile.pendingDisplayName,
  displayName: profile.displayName,
  displayNameRevision: profile.displayNameRevision,
  displayNameStatus: profile.displayNameStatus,
  handle: profile.handle,
  profileStatus: profile.profileStatus,
  publicUid: profile.publicUid,
  role: profile.role,
  version: profile.profileVersion,
});

export const normalizeProfileDisplayName = (value: string): string | null => {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const codePoints = [...normalized];
  if (!codePoints.length || codePoints.length > MAX_DISPLAY_NAME_CODE_POINTS) return null;
  if (new TextEncoder().encode(normalized).byteLength > MAX_DISPLAY_NAME_BYTES) return null;
  if (/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(normalized)) return null;
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(normalized)) return null;
  return normalized;
};

const normalizeProfileHandle = (value: string): string | null => {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("und");
  return [...normalized].length >= 3 &&
    [...normalized].length <= MAX_HANDLE_CODE_POINTS &&
    HANDLE_PATTERN.test(normalized) &&
    /[a-z_-]/u.test(normalized)
    ? normalized
    : null;
};

const normalizeProfileBio = (value: string): string | null => {
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return null;
  if ([...normalized].length > MAX_BIO_CODE_POINTS) return null;
  if (new TextEncoder().encode(normalized).byteLength > MAX_BIO_BYTES) return null;
  return normalized;
};

const readJsonObjectBody = async (request: Request): Promise<JsonBodyResult> => {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLocaleLowerCase("und");
  if (mediaType !== "application/json") {
    await request.body?.cancel();
    return { ok: false, response: error(request, 415, "content_type_required", "Use application/json") };
  }
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_PROFILE_BODY_BYTES) {
      await request.body?.cancel();
      return { ok: false, response: error(request, 413, "request_too_large", "Profile request is too large") };
    }
  }
  if (!request.body) return { ok: false, response: error(request, 400, "invalid_body", "A JSON body is required") };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_PROFILE_BODY_BYTES) {
      await reader.cancel();
      return { ok: false, response: error(request, 413, "request_too_large", "Profile request is too large") };
    }
    chunks.push(part.value);
  }
  if (!size) return { ok: false, response: error(request, 400, "invalid_body", "A JSON body is required") };
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return { ok: false, response: error(request, 400, "invalid_json", "The request body is not valid JSON") };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    return { ok: false, response: error(request, 422, "invalid_body", "A JSON object is required") };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
};

const readProfilePatchBody = async (request: Request): Promise<BodyResult> => {
  const body = await readJsonObjectBody(request);
  if (!body.ok) return body;
  const keys = Object.keys(body.value);
  if (
    !keys.length ||
    keys.some((key) => key !== "displayName" && key !== "handle" && key !== "bio" && key !== "version") ||
    !keys.some((key) => key === "displayName" || key === "handle" || key === "bio")
  ) {
    return {
      ok: false,
      response: error(request, 422, "invalid_profile", "Send displayName, handle, or bio, with an optional version"),
    };
  }

  const patch: ProfilePatch = {
    bio: null,
    bioPresent: Object.hasOwn(body.value, "bio"),
    displayName: null,
    displayNamePresent: Object.hasOwn(body.value, "displayName"),
    expectedVersion: null,
    handle: null,
    handlePresent: Object.hasOwn(body.value, "handle"),
  };

  if (Object.hasOwn(body.value, "version")) {
    const version = body.value.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      return { ok: false, response: error(request, 422, "invalid_version", "version must be a positive integer") };
    }
    patch.expectedVersion = version;
  }

  if (patch.displayNamePresent) {
    const rawDisplayName = body.value.displayName;
    if (typeof rawDisplayName !== "string") {
      return { ok: false, response: error(request, 422, "invalid_display_name", "displayName must be a string") };
    }
    const displayName = normalizeProfileDisplayName(rawDisplayName);
    if (!displayName) {
      return {
        ok: false,
        response: error(
          request,
          422,
          "invalid_display_name",
          `Display name must be 1-${MAX_DISPLAY_NAME_CODE_POINTS} visible characters`,
        ),
      };
    }
    patch.displayName = displayName;
  }

  if (patch.handlePresent) {
    const rawHandle = body.value.handle;
    if (rawHandle !== null && typeof rawHandle !== "string") {
      return { ok: false, response: error(request, 422, "invalid_handle", "handle must be a string or null") };
    }
    if (typeof rawHandle === "string") {
      const handle = normalizeProfileHandle(rawHandle);
      if (!handle) {
        return {
          ok: false,
          response: error(
            request,
            422,
            "invalid_handle",
            "handle must be 3-32 lowercase letters, numbers, underscores, or hyphens and cannot be numeric-only",
          ),
        };
      }
      if (inspectCommunityText(handle).verdict !== "allow") {
        return { ok: false, response: error(request, 422, "unsafe_handle", "The handle cannot be used") };
      }
      patch.handle = handle;
    }
  }

  if (patch.bioPresent) {
    const rawBio = body.value.bio;
    if (rawBio !== null && typeof rawBio !== "string") {
      return { ok: false, response: error(request, 422, "invalid_bio", "bio must be a string or null") };
    }
    if (typeof rawBio === "string" && rawBio.trim()) {
      const bio = normalizeProfileBio(rawBio);
      if (!bio) {
        return {
          ok: false,
          response: error(request, 422, "invalid_bio", `bio must be at most ${MAX_BIO_CODE_POINTS} characters`),
        };
      }
      if (inspectCommunityText(bio).verdict !== "allow") {
        return { ok: false, response: error(request, 422, "unsafe_bio", "The bio contains unsafe content") };
      }
      patch.bio = bio;
    }
  }
  return { ok: true, value: patch };
};

const deleteProfile = async (request: Request, env: Env): Promise<Response> => {
  const session = await getAuthSession(request, env);
  if (!session?.user?.id) return error(request, 401, "authentication_required", "Sign in required");
  if (!session.user.emailVerified) {
    return error(request, 403, "email_verification_required", "Verify the account email first");
  }
  const profile = await readProfile(env, session.user.id);
  if (!profile) return error(request, 503, "profile_unavailable", "Account profile is unavailable");
  if (profile.profileStatus === "deleted") return error(request, 410, "account_deleted", "Account is unavailable");
  if (env.COMMUNITY_RATE_LIMITER) {
    const limited = await env.COMMUNITY_RATE_LIMITER.limit({ key: `profile-delete:${session.user.id}` });
    if (!limited.success) return error(request, 429, "rate_limit_exceeded", "Try again later");
  }
  const body = await readJsonObjectBody(request);
  if (!body.ok) return body.response;
  if (
    Object.keys(body.value).length !== 1 ||
    !Object.hasOwn(body.value, "confirmation") ||
    typeof body.value.confirmation !== "string" ||
    body.value.confirmation !== session.user.email
  ) {
    return error(request, 422, "invalid_confirmation", "Enter the current account email to confirm deletion");
  }
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE community_profile
       SET status = 'deleted', deleted_at = ?, version = version + 1, updated_at = ?
       WHERE user_id = ? AND status <> 'deleted' AND deleted_at IS NULL AND version = ?
         AND (
           role <> 'admin'
           OR EXISTS (
             SELECT 1
             FROM community_profile AS other
             JOIN "user" AS other_account ON other_account.id = other.user_id
             WHERE other.user_id <> community_profile.user_id
               AND other.role = 'admin'
               AND other.status = 'active'
               AND other.deleted_at IS NULL
               AND other_account.emailVerified = 1
               AND NOT EXISTS (
                 SELECT 1 FROM community_user_restriction AS restriction
                 WHERE restriction.user_id = other.user_id
                   AND restriction.kind = 'sign_in'
                   AND restriction.revoked_at IS NULL
                   AND (restriction.expires_at IS NULL OR restriction.expires_at > ?)
               )
           )
         )`,
    ).bind(now, now, session.user.id, profile.profileVersion, now),
    env.DB.prepare(
      `DELETE FROM "session"
       WHERE userId = ?
         AND EXISTS (
           SELECT 1 FROM community_profile
           WHERE user_id = ?
             AND status = 'deleted'
             AND deleted_at = ?
             AND version = ?
         )`,
    ).bind(session.user.id, session.user.id, now, profile.profileVersion + 1),
  ]);
  if (Number(results[0]?.meta.changes || 0) !== 1) {
    if (profile.role === "admin") {
      const available = await env.DB.prepare(
        `SELECT 1 AS present
         FROM community_profile AS other
         JOIN "user" AS other_account ON other_account.id = other.user_id
         WHERE other.user_id <> ?
           AND other.role = 'admin'
           AND other.status = 'active'
           AND other.deleted_at IS NULL
           AND other_account.emailVerified = 1
           AND NOT EXISTS (
             SELECT 1 FROM community_user_restriction AS restriction
             WHERE restriction.user_id = other.user_id
               AND restriction.kind = 'sign_in'
               AND restriction.revoked_at IS NULL
               AND (restriction.expires_at IS NULL OR restriction.expires_at > ?)
           )
         LIMIT 1`,
      )
        .bind(session.user.id, now)
        .first<{ present: 1 }>();
      if (!available) {
        return error(
          request,
          409,
          "last_administrator_required",
          "Transfer administrator access before deleting this account",
        );
      }
    }
    return error(request, 409, "profile_conflict", "The profile changed; refresh and try again");
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      "Clear-Site-Data": '"cookies"',
      "X-Content-Type-Options": "nosniff",
    },
  });
};

const requireProfileAccess = async (request: Request, env: Env, write: boolean): Promise<AccessResult> => {
  const session = await getAuthSession(request, env);
  if (!session?.user?.id) {
    return { ok: false, response: error(request, 401, "authentication_required", "Sign in required") };
  }
  if (write && !session.user.emailVerified) {
    return {
      ok: false,
      response: error(request, 403, "email_verification_required", "Verify the account email first"),
    };
  }
  const profile = await readProfile(env, session.user.id);
  if (!profile) {
    return { ok: false, response: error(request, 503, "profile_unavailable", "Account profile is unavailable") };
  }
  if (profile.profileStatus === "deleted" || (write && profile.profileStatus !== "active")) {
    return { ok: false, response: error(request, 403, "account_restricted", "This account cannot change its profile") };
  }
  if (write) {
    if (profile.writeRestricted === 1) {
      return { ok: false, response: error(request, 403, "profile_write_restricted", "Profile changes are restricted") };
    }
    if (env.COMMUNITY_RATE_LIMITER) {
      const limited = await env.COMMUNITY_RATE_LIMITER.limit({ key: `profile:${session.user.id}` });
      if (!limited.success) {
        return { ok: false, response: error(request, 429, "rate_limit_exceeded", "Try again later") };
      }
    }
  }
  return { ok: true, value: { profile, userId: session.user.id } };
};

const handleInUse = async (env: Env, handle: string, userId: string): Promise<boolean> => {
  const existing = await env.DB.prepare(
    `SELECT 1 AS present
     FROM community_profile
     WHERE handle = ? COLLATE NOCASE AND user_id <> ?
     LIMIT 1`,
  )
    .bind(handle, userId)
    .first<{ present: 1 }>();
  return existing?.present === 1;
};

const compensateProfileUpdate = async (
  env: Env,
  userId: string,
  before: AccountProfileRow,
  candidate: string,
  revision: number,
): Promise<void> => {
  const compensatedAt = Date.now();
  const compensatedRevision = revision + 1;
  if (!Number.isSafeInteger(compensatedRevision)) return;
  const writtenVersion = before.profileVersion + 1;
  const compensatedVersion = writtenVersion + 1;
  if (!Number.isSafeInteger(writtenVersion) || !Number.isSafeInteger(compensatedVersion)) return;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE community_profile
       SET display_name = ?, pending_display_name = ?, display_name_status = ?,
           display_name_revision = ?, handle = ?, bio = ?, version = version + 1, updated_at = ?
       WHERE user_id = ? AND display_name_revision = ? AND pending_display_name = ?
         AND version = ?`,
    ).bind(
      before.displayName,
      before.pendingDisplayName,
      before.displayNameStatus,
      compensatedRevision,
      before.handle,
      before.bio,
      compensatedAt,
      userId,
      revision,
      candidate,
      writtenVersion,
    ),
    env.DB.prepare(
      `DELETE FROM community_moderation_case
       WHERE entity_kind = 'profile-name' AND entity_id = ? AND entity_revision = ?
         AND EXISTS (
           SELECT 1 FROM community_profile
           WHERE user_id = ? AND display_name_revision = ? AND version = ?
             AND display_name = ? AND pending_display_name IS ? AND display_name_status = ?
         )`,
    ).bind(
      userId,
      revision,
      userId,
      compensatedRevision,
      compensatedVersion,
      before.displayName,
      before.pendingDisplayName,
      before.displayNameStatus,
    ),
    env.DB.prepare(
      `UPDATE "user"
       SET name = ?, updatedAt = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM community_profile
           WHERE user_id = ? AND display_name_revision = ?
             AND version = ? AND pending_display_name IS ? AND display_name_status = ?
         )`,
    ).bind(
      before.accountName,
      new Date(compensatedAt).toISOString(),
      userId,
      userId,
      compensatedRevision,
      compensatedVersion,
      before.pendingDisplayName,
      before.displayNameStatus,
    ),
  ]);
};

const updateProfile = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireProfileAccess(request, env, true);
  if (!access.ok) return access.response;
  const body = await readProfilePatchBody(request);
  if (!body.ok) return body.response;
  const { profile, userId } = access.value;
  const patch = body.value;
  if (patch.expectedVersion !== null && patch.expectedVersion !== profile.profileVersion) {
    return error(request, 409, "profile_conflict", "The profile changed; refresh and try again");
  }
  const candidate = patch.displayName;
  const displayNameAlreadyCurrent =
    patch.displayNamePresent &&
    ((profile.displayNameStatus === "allow" && profile.displayName === candidate) ||
      (profile.displayNameStatus === "pending" && profile.pendingDisplayName === candidate));
  const displayNameNeedsRevision = patch.displayNamePresent && !displayNameAlreadyCurrent;
  const metadataChanged =
    (patch.handlePresent && profile.handle !== patch.handle) || (patch.bioPresent && profile.bio !== patch.bio);

  if (patch.handlePresent && patch.handle !== null && profile.handle !== patch.handle) {
    if (await handleInUse(env, patch.handle, userId)) {
      return error(request, 409, "handle_unavailable", "That handle is already in use");
    }
  }

  if (!displayNameNeedsRevision) {
    if (!metadataChanged) {
      return json(
        request,
        { profile: await profileValue(profile) },
        profile.displayNameStatus === "pending" ? 202 : 200,
      );
    }
    const now = Date.now();
    let result: D1Result;
    try {
      result = await env.DB.prepare(
        `UPDATE community_profile
         SET handle = CASE WHEN ? = 1 THEN ? ELSE handle END,
             bio = CASE WHEN ? = 1 THEN ? ELSE bio END,
             version = version + 1, updated_at = ?
         WHERE user_id = ? AND status = 'active' AND version = ?`,
      )
        .bind(
          patch.handlePresent ? 1 : 0,
          patch.handle,
          patch.bioPresent ? 1 : 0,
          patch.bio,
          now,
          userId,
          profile.profileVersion,
        )
        .run();
    } catch {
      if (patch.handle !== null && (await handleInUse(env, patch.handle, userId))) {
        return error(request, 409, "handle_unavailable", "That handle is already in use");
      }
      return error(request, 409, "profile_conflict", "The profile changed; refresh and try again");
    }
    if (Number(result.meta.changes || 0) !== 1) {
      return error(request, 409, "profile_conflict", "The profile changed; refresh and try again");
    }
    const updated = await readProfile(env, userId);
    if (!updated) return error(request, 503, "profile_unavailable", "Account profile is unavailable");
    return json(request, { profile: await profileValue(updated) }, updated.displayNameStatus === "pending" ? 202 : 200);
  }

  if (candidate === null) {
    return error(request, 422, "invalid_display_name", "displayName must be a string");
  }
  const revision = profile.displayNameRevision + 1;
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(revision + 1)) {
    return error(request, 409, "profile_revision_exhausted", "The profile cannot be updated");
  }
  const inspection = inspectCommunityText(candidate);
  const initialStatus: DisplayNameStatus = inspection.verdict === "allow" ? "pending" : "block";
  const now = Date.now();
  const accountNow = new Date(now).toISOString();

  let writeResults: D1Result<Record<string, never>>[];
  try {
    writeResults = await env.DB.batch<Record<string, never>>([
      env.DB.prepare(
        `UPDATE community_profile
         SET pending_display_name = ?, display_name_status = ?, display_name_revision = ?,
             handle = CASE WHEN ? = 1 THEN ? ELSE handle END,
             bio = CASE WHEN ? = 1 THEN ? ELSE bio END,
             version = version + 1, updated_at = ?
         WHERE user_id = ? AND status = 'active' AND display_name_revision = ? AND version = ?`,
      ).bind(
        candidate,
        initialStatus,
        revision,
        patch.handlePresent ? 1 : 0,
        patch.handle,
        patch.bioPresent ? 1 : 0,
        patch.bio,
        now,
        userId,
        profile.displayNameRevision,
        profile.profileVersion,
      ),
      env.DB.prepare(
        `UPDATE "user"
         SET name = ?, updatedAt = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM community_profile
             WHERE user_id = ? AND display_name_revision = ? AND pending_display_name = ?
           )`,
      ).bind(candidate, accountNow, userId, userId, revision, candidate),
      env.DB.prepare(
        `SELECT CASE
           WHEN EXISTS (
             SELECT 1 FROM community_profile
             WHERE user_id = ? AND display_name_revision = ? AND pending_display_name = ?
           ) AND EXISTS (SELECT 1 FROM "user" WHERE id = ? AND name = ?)
           THEN 1 ELSE json_extract('', '$') END AS valid`,
      ).bind(userId, revision, candidate, userId, candidate),
    ]);
  } catch {
    if (patch.handle !== null && (await handleInUse(env, patch.handle, userId))) {
      return error(request, 409, "handle_unavailable", "That handle is already in use");
    }
    return error(request, 409, "profile_conflict", "The profile changed; refresh and try again");
  }
  if (Number(writeResults[0]?.meta.changes || 0) !== 1 || Number(writeResults[1]?.meta.changes || 0) !== 1) {
    return error(request, 409, "profile_conflict", "The profile changed; refresh and try again");
  }

  try {
    await scheduleEntityModeration(env, "profile-name", userId, inspection, revision);
  } catch (schedulingError) {
    try {
      await compensateProfileUpdate(env, userId, profile, candidate, revision);
    } catch (compensationError) {
      console.error(
        JSON.stringify({
          compensationErrorName:
            compensationError instanceof Error ? compensationError.name : "ProfileCompensationError",
          event: "profile.moderation_compensation_failed",
          schedulingErrorName: schedulingError instanceof Error ? schedulingError.name : "ProfileModerationError",
          userId,
        }),
      );
    }
    return error(request, 503, "profile_moderation_unavailable", "The display name could not be reviewed");
  }

  const updated = await readProfile(env, userId);
  if (!updated) return error(request, 503, "profile_unavailable", "Account profile is unavailable");
  return json(request, { profile: await profileValue(updated) }, updated.displayNameStatus === "pending" ? 202 : 200);
};

export const handleProfileRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== ACCOUNT_PROFILE_PATH) return null;
  if (!env.DB) return error(request, 503, "profile_unavailable", "Account profiles are unavailable");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, PATCH, DELETE, OPTIONS" } });
  }
  if (!sameOrigin(request)) {
    return error(request, 403, "cross_origin_request", "Cross-origin profile requests are not allowed");
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const access = await requireProfileAccess(request, env, false);
    return access.ok ? json(request, { profile: await profileValue(access.value.profile) }) : access.response;
  }
  if (request.method === "PATCH") return updateProfile(request, env);
  if (request.method === "DELETE") return deleteProfile(request, env);
  return error(request, 405, "method_not_allowed", "Method not allowed");
};
