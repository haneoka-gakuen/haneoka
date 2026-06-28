import { getAuthSession } from "./auth";
import { requestIpMetadata } from "./ip-address";
import { resolveModerationAppeal } from "./moderation";

const ADMIN_PREFIX = "/api/v1/admin";
const JSON_BODY_LIMIT = 64 * 1024;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PACKAGE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const PACKAGE_PART_BYTES = 16 * 1024 * 1024;
const PACKAGE_MIN_PART_BYTES = 5 * 1024 * 1024;
const PACKAGE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
const RESOURCE_OWNER = "haneoka-gakuen";
const RESOURCE_REPOSITORY = "haneoka";
const RESOURCE_WORKFLOW = "resource-pipeline.yml";
const RESOURCE_REF = "main";
const CAS_PREFIX = "cas/v1/sha256";
const PACKAGE_LEASE_PREFIX = "private/v1/package-leases";
const RESOURCE_SOURCE_LIST_PAGE_LIMIT = 1_000;
const RESOURCE_SOURCE_LIST_MAX_PAGES = 5;
const RESOURCE_SOURCE_OPTION_LIMIT = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const REASON_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RELEASE_ID_PATTERN = /^r-[a-f0-9]{20}$/u;
const RESOURCE_SERVER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const RESOURCE_PREFIX_PATTERN = /^[a-z0-9](?:[a-z0-9/_-]{0,198}[a-z0-9])?$/u;
const PACKAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(["application/zip"]);
const PACKAGE_EXTENSIONS: ReadonlySet<string> = new Set(["apk", "apks", "xapk"]);
const RESOURCE_SERVER_REGIONS: ReadonlySet<ResourceServerRegion> = new Set(["global", "jp", "kr", "tw", "cn", "en"]);
const RESOURCE_SERVER_STATUSES: ReadonlySet<ResourceServerStatus> = new Set(["draft", "active", "retired"]);
const REQUEST_IDS = new WeakMap<Request, string>();

type AdminRole = "admin" | "member" | "moderator";
type StaffRequirement = "admin" | "staff";
type BindValue = null | number | string;
type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type OperationStatus = "failed" | "pending" | "running" | "succeeded";
type TerminalOperationStatus = "failed" | "succeeded";
type RestrictionKind = "sign_in" | "upload" | "write";
type ResourceServerRegion = "cn" | "en" | "global" | "jp" | "kr" | "tw";
type ResourceServerStatus = "active" | "draft" | "retired";
type PackageStatus =
  "expired" | "failed" | "processing" | "ready" | "reserved" | "succeeded" | "uploaded" | "uploading" | "verifying";

interface AccessRow {
  emailVerified: number;
  role: AdminRole;
  signInRestricted: number;
  status: "active" | "deleted" | "suspended";
  version: number;
}

interface StaffAccess {
  avatarSeed: string;
  avatarUrl: string | null;
  email: string;
  name: string;
  profileVersion: number;
  role: Exclude<AdminRole, "member">;
  userId: string;
}

interface TextCursor {
  id: string;
  sort: string;
}

interface NumericCursor {
  id: string;
  sort: number;
}

interface OverviewRow {
  activeUsers: number;
  blockedPosts: number;
  pendingAppeals: number;
  pendingOperations: number;
  pendingReports: number;
  publishedPosts: number;
  readyPackages: number;
  resourceRuns: number;
  suspendedUsers: number;
  totalUsers: number;
}

interface UserListRow {
  accountName: string;
  candidateDisplayName: string | null;
  createdAt: string;
  displayNameStatus: "allow" | "block" | "pending";
  email: string;
  emailVerified: number;
  handle: string | null;
  id: string;
  image: string | null;
  publicDisplayName: string | null;
  role: AdminRole;
  status: "active" | "deleted" | "suspended";
  signInRestricted: number;
  updatedAt: string;
  uploadRestricted: number;
  version: number;
  writeRestricted: number;
}

interface IpAuditRow {
  browserFamily: string | null;
  ipAddress: string | null;
  ipCountryCode: string | null;
  ipRegionCode: string | null;
  ipRegionName: string | null;
  osFamily: string | null;
  userAgent: string | null;
}

interface PostHistoryHeadRow extends IpAuditRow {
  archivedAt: number | null;
  authorAccountName: string;
  authorDisplayName: string | null;
  authorHandle: string | null;
  authorId: string;
  commentsLockedAt: number | null;
  createdAt: number;
  deletedAt: number | null;
  id: string;
  moderationRevision: number;
  moderationStatus: "allow" | "block" | "pending" | "review";
  pinnedAt: number | null;
  status: "draft" | "hidden" | "published";
  updatedAt: number;
  version: number;
  visibility: "private" | "protected" | "public";
}

interface PostRevisionHistoryRow extends IpAuditRow {
  body: string;
  createdAt: number;
  editReason: string | null;
  editorAccountName: string;
  editorDisplayName: string | null;
  editorHandle: string | null;
  editorUserId: string;
  revisionNumber: number;
  sourceKind: "create" | "edit" | "migration_snapshot" | "restore_snapshot";
  title: string;
  visibility: "private" | "protected" | "public";
}

interface PostRevisionTagRow {
  displayName: string;
  normalizedName: string;
  position: number;
  revisionNumber: number;
  tagId: string;
}

interface PostRevisionAttachmentRow {
  attachmentId: string;
  byteSize: number | null;
  declaredSize: number;
  mediaType: string;
  originalName: string;
  position: number;
  revisionNumber: number;
  sha256: string | null;
  status: "deleted" | "ready" | "rejected" | "reserved" | "review" | "scanning";
}

interface PostStateEventRow extends IpAuditRow {
  actorAccountName: string | null;
  actorDisplayName: string | null;
  actorHandle: string | null;
  actorUserId: string | null;
  createdAt: number;
  eventKind:
    | "archived"
    | "deleted"
    | "hidden"
    | "locked"
    | "pinned"
    | "restored"
    | "unarchived"
    | "unhidden"
    | "unlocked"
    | "unpinned";
  id: string;
  reasonCode: string | null;
  revisionNumber: number | null;
}

interface CommentHistoryHeadRow extends IpAuditRow {
  authorAccountName: string;
  authorDisplayName: string | null;
  authorHandle: string | null;
  authorId: string;
  createdAt: number;
  deletedAt: number | null;
  hiddenAt: number | null;
  id: string;
  moderationRevision: number;
  moderationStatus: "allow" | "block" | "pending" | "review";
  parentId: string | null;
  postId: string;
  updatedAt: number;
  version: number;
}

interface CommentRevisionHistoryRow extends IpAuditRow {
  body: string;
  createdAt: number;
  editReason: string | null;
  editorAccountName: string;
  editorDisplayName: string | null;
  editorHandle: string | null;
  editorUserId: string;
  revisionNumber: number;
  sourceKind: "create" | "edit" | "migration_snapshot" | "restore_snapshot";
}

interface CommentStateEventRow extends IpAuditRow {
  actorAccountName: string | null;
  actorDisplayName: string | null;
  actorHandle: string | null;
  actorUserId: string | null;
  createdAt: number;
  eventKind: "deleted" | "hidden" | "restored" | "unhidden";
  id: string;
  reasonCode: string | null;
  revisionNumber: number | null;
}

type ContentReportStatus = "dismissed" | "pending" | "resolved" | "reviewing";

interface ContentReportRow {
  commentBody: string | null;
  commentId: string | null;
  commentPostId: string | null;
  createdAt: number;
  detail: string | null;
  id: string;
  postId: string | null;
  postTitle: string | null;
  reasonCode: string;
  reportedUserAccountName: string | null;
  reportedUserDisplayName: string | null;
  reportedUserHandle: string | null;
  reportedUserId: string | null;
  reportedUserPublicUid: number | null;
  reporterAccountName: string;
  reporterDisplayName: string | null;
  reporterHandle: string | null;
  reporterUserId: string;
  resolutionReasonCode: string | null;
  resolvedAt: number | null;
  reviewerAccountName: string | null;
  reviewerUserId: string | null;
  status: ContentReportStatus;
  targetRevision: number | null;
  updatedAt: number;
  version: number;
}

interface UserStateRow {
  email: string;
  emailVerified: number;
  id: string;
  role: AdminRole;
  status: "active" | "deleted" | "suspended";
  version: number;
}

interface PostListRow {
  archivedAt: number | null;
  authorAccountName: string;
  authorHandle: string | null;
  authorId: string;
  authorName: string | null;
  body: string;
  commentCount: number;
  createdAt: number;
  deletedAt: number | null;
  id: string;
  likeCount: number;
  moderationRevision: number;
  moderationStatus: "allow" | "block" | "pending" | "review";
  pinnedAt: number | null;
  status: "draft" | "hidden" | "published";
  title: string;
  updatedAt: number;
  version: number;
  visibility: "private" | "protected" | "public";
}

interface AppealListRow {
  appellantHandle: string | null;
  appellantName: string;
  appellantUserId: string;
  caseId: string;
  caseStatus: "allow" | "block" | "pending" | "review" | "superseded";
  createdAt: number;
  entityId: string;
  entityKind: "attachment" | "comment" | "post" | "profile-name";
  entityRevision: number;
  id: string;
  resolutionReasonCode: string | null;
  resolvedAt: number | null;
  reviewerName: string | null;
  reviewerUserId: string | null;
  statement: string;
  status: "accepted" | "pending" | "rejected" | "superseded";
  updatedAt: number;
  version: number;
}

interface OperationRow {
  action: string;
  actorUserId: string;
  completedAt: number | null;
  createdAt: number;
  errorCode: string | null;
  externalRef: string | null;
  id: string;
  idempotencyKey: string;
  requestId: string;
  status: OperationStatus;
  targetId: string;
  targetKind: string;
  updatedAt: number;
}

interface OperationListRow extends OperationRow {
  actorName: string;
}

interface RestrictionRow {
  actorUserId: string;
  createdAt: number;
  expiresAt: number | null;
  id: string;
  kind: RestrictionKind;
  reasonCode: string;
  revokedAt: number | null;
  revokedByUserId: string | null;
  updatedAt: number;
  userId: string;
  version: number;
}

interface PackageUploadRow {
  completedAt: number | null;
  createdAt: number;
  declaredSize: number;
  expectedSha256: string;
  expiresAt: number;
  fileName: string;
  id: string;
  mediaType: string;
  objectKey: string;
  ownerUserId: string;
  r2UploadId: string;
  server: string;
  status: PackageStatus;
  updatedAt: number;
  verifiedSha256: string | null;
  version: number;
}

interface PackagePartRow {
  byteSize: number;
  etag: string;
  partNumber: number;
}

interface ResourceRunRow {
  completedAt: number | null;
  conclusion: string | null;
  createdAt: number;
  githubRunId: number | null;
  githubRunUrl: string | null;
  id: string;
  operationId: string;
  releaseId: string | null;
  server: string;
  sourceKind: "github" | "package";
  sourceRef: string;
  status: "completed" | "queued" | "running";
  updatedAt: number;
}

interface ResourceServerRow {
  createdAt: number;
  displayName: string;
  region: ResourceServerRegion;
  resourcePrefix: string;
  slug: string;
  status: ResourceServerStatus;
  updatedAt: number;
  version: number;
}

interface GitHubDispatchResponse {
  htmlUrl: string | null;
  runUrl: string | null;
  workflowRunId: number | null;
}

const appealValue = (row: AppealListRow): JsonObject => ({
  appellantHandle: row.appellantHandle,
  appellantName: row.appellantName,
  appellantUserId: row.appellantUserId,
  caseId: row.caseId,
  caseStatus: row.caseStatus,
  createdAt: row.createdAt,
  entityId: row.entityId,
  entityKind: row.entityKind,
  entityRevision: row.entityRevision,
  id: row.id,
  resolutionReasonCode: row.resolutionReasonCode,
  resolvedAt: row.resolvedAt,
  reviewerName: row.reviewerName,
  reviewerUserId: row.reviewerUserId,
  statement: row.statement,
  status: row.status,
  updatedAt: row.updatedAt,
  version: row.version,
});

const ipAuditValue = (row: IpAuditRow): JsonObject => ({
  browserFamily: row.browserFamily,
  ipAddress: row.ipAddress,
  ipLocation:
    row.ipCountryCode || row.ipRegionCode || row.ipRegionName
      ? {
          countryCode: row.ipCountryCode,
          regionCode: row.ipRegionCode,
          regionName: row.ipRegionName,
        }
      : null,
  osFamily: row.osFamily,
  userAgent: row.userAgent,
});

const reportValue = (row: ContentReportRow): JsonObject => ({
  id: row.id,
  reporter: {
    id: row.reporterUserId,
    accountName: row.reporterAccountName,
    displayName: row.reporterDisplayName,
    handle: row.reporterHandle,
  },
  target: row.postId
    ? { kind: "post", id: row.postId, revision: row.targetRevision, title: row.postTitle }
    : row.commentId
      ? {
          kind: "comment",
          id: row.commentId,
          postId: row.commentPostId,
          revision: row.targetRevision,
          body: row.commentBody,
        }
      : {
          kind: "user",
          id: row.reportedUserId,
          publicUid: row.reportedUserPublicUid,
          accountName: row.reportedUserAccountName,
          displayName: row.reportedUserDisplayName,
          handle: row.reportedUserHandle,
        },
  reasonCode: row.reasonCode,
  detail: row.detail,
  status: row.status,
  reviewer: row.reviewerUserId ? { id: row.reviewerUserId, accountName: row.reviewerAccountName } : null,
  resolutionReasonCode: row.resolutionReasonCode,
  resolvedAt: row.resolvedAt,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

type OperationStart =
  | { kind: "existing"; operation: OperationRow }
  | { kind: "new"; operationId: string }
  | { kind: "response"; response: Response };

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requestId = (request: Request): string => {
  const existing = REQUEST_IDS.get(request);
  if (existing) return existing;
  const created = request.headers.get("cf-ray") || crypto.randomUUID();
  REQUEST_IDS.set(request, created);
  return created;
};

const json = (request: Request, value: JsonValue, status = 200, extraHeaders: HeadersInit = {}): Response => {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Request-Id", requestId(request));
  return new Response(request.method === "HEAD" ? null : JSON.stringify(value), { status, headers });
};

const error = (request: Request, status: number, code: string, message: string): Response =>
  json(request, { error: { code, message } }, status);

const sameOrigin = (request: Request): boolean => {
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "none" && fetchSite !== "same-origin") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return fetchSite === "none" || fetchSite === "same-origin";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

const readJsonBody = async (request: Request): Promise<JsonObject | null> => {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") || !request.body) return null;
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > JSON_BODY_LIMIT) {
    await request.body.cancel();
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > JSON_BODY_LIMIT) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return isJsonValue(parsed) && isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const expectedVersion = (body: JsonObject): number | null => {
  const value = body.expectedVersion;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const parseLimit = (url: URL, maximum = MAX_PAGE_SIZE): number | null => {
  const raw = url.searchParams.get("limit");
  if (raw === null) return Math.min(DEFAULT_PAGE_SIZE, maximum);
  if (!/^\d{1,3}$/u.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= maximum ? value : null;
};

const encodeCursor = (cursor: TextCursor | NumericCursor): string => btoa(JSON.stringify(cursor));

const decodeCursor = (value: string | null): TextCursor | NumericCursor | null => {
  if (!value || value.length > 512) return null;
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (!isJsonValue(parsed) || !isJsonObject(parsed)) return null;
    if (typeof parsed.id !== "string" || !SAFE_ID_PATTERN.test(parsed.id)) return null;
    if (typeof parsed.sort !== "number" && typeof parsed.sort !== "string") return null;
    if (typeof parsed.sort === "number" && (!Number.isSafeInteger(parsed.sort) || parsed.sort < 0)) return null;
    return typeof parsed.sort === "number"
      ? { id: parsed.id, sort: parsed.sort }
      : { id: parsed.id, sort: parsed.sort };
  } catch {
    return null;
  }
};

const escapeLike = (value: string): string => value.replace(/[\\%_]/gu, (character) => `\\${character}`);

const isRole = (value: JsonValue | undefined): value is AdminRole =>
  value === "admin" || value === "member" || value === "moderator";

const isRestrictionKind = (value: JsonValue | undefined): value is RestrictionKind =>
  value === "sign_in" || value === "upload" || value === "write";

const isResourceServerRegion = (value: JsonValue | undefined): value is ResourceServerRegion =>
  typeof value === "string" && RESOURCE_SERVER_REGIONS.has(value as ResourceServerRegion);

const isResourceServerStatus = (value: JsonValue | undefined): value is ResourceServerStatus =>
  typeof value === "string" && RESOURCE_SERVER_STATUSES.has(value as ResourceServerStatus);

const normalizeResourceServerSlug = (value: JsonValue | undefined): string | null => {
  if (typeof value !== "string") return null;
  const slug = value.normalize("NFKC").trim();
  return RESOURCE_SERVER_SLUG_PATTERN.test(slug) ? slug : null;
};

const normalizeResourceServerName = (value: JsonValue | undefined): string | null => {
  if (typeof value !== "string") return null;
  const displayName = value.normalize("NFC").trim();
  return displayName.length >= 1 && displayName.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(displayName)
    ? displayName
    : null;
};

const normalizeResourcePrefix = (value: JsonValue | undefined): string | null => {
  if (typeof value !== "string") return null;
  const prefix = value.normalize("NFKC").trim();
  if (!RESOURCE_PREFIX_PATTERN.test(prefix) || prefix.includes("..") || prefix.includes("//")) return null;
  return prefix.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    ? prefix
    : null;
};

const requireStaff = async (
  request: Request,
  env: Env,
  requirement: StaffRequirement,
): Promise<StaffAccess | Response> => {
  const session = await getAuthSession(request, env, { authoritative: true });
  if (!session?.user?.id) return error(request, 401, "authentication_required", "Sign in required");
  const now = Date.now();
  const profile = await env.DB.prepare(
    `SELECT profile.role, profile.status, profile.version, account.emailVerified AS emailVerified,
            EXISTS(
              SELECT 1
              FROM community_user_restriction AS restriction
              WHERE restriction.user_id = profile.user_id
                AND restriction.kind = 'sign_in'
                AND restriction.revoked_at IS NULL
                AND (restriction.expires_at IS NULL OR restriction.expires_at > ?)
            ) AS signInRestricted
     FROM community_profile AS profile
     JOIN "user" AS account ON account.id = profile.user_id
     WHERE profile.user_id = ?
     LIMIT 1`,
  )
    .bind(now, session.user.id)
    .first<AccessRow>();
  if (!profile) return error(request, 503, "profile_unavailable", "The community profile is unavailable");
  if (profile.emailVerified !== 1)
    return error(request, 403, "verified_email_required", "A verified email is required");
  if (profile.status !== "active" || profile.signInRestricted === 1) {
    return error(request, 403, "account_restricted", "This account cannot use administration APIs");
  }
  if (profile.role !== "admin" && profile.role !== "moderator") {
    return error(request, 403, "staff_required", "Staff access required");
  }
  if (requirement === "admin" && profile.role !== "admin") {
    return error(request, 403, "admin_required", "Administrator access required");
  }
  return {
    avatarSeed: session.user.id,
    avatarUrl: session.user.image || null,
    email: session.user.email,
    name: session.user.name,
    profileVersion: profile.version,
    role: profile.role,
    userId: session.user.id,
  };
};

const staffValue = (access: StaffAccess): JsonObject => ({
  user: {
    id: access.userId,
    name: access.name,
    email: access.email,
    avatarSeed: access.avatarSeed,
    avatarUrl: access.avatarUrl,
  },
  role: access.role,
  profileVersion: access.profileVersion,
  capabilities:
    access.role === "admin"
      ? [
          "appeals.read",
          "content-history.read",
          "operations.read",
          "packages.write",
          "reports.read",
          "reports.write",
          "resources.dispatch",
          "resources.manage",
          "users.write",
        ]
      : ["appeals.read"],
});

const getSession = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireStaff(request, env, "staff");
  return access instanceof Response ? access : json(request, { session: staffValue(access) });
};

const getOverview = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM "user") AS totalUsers,
       (SELECT COUNT(*) FROM community_profile WHERE status = 'active') AS activeUsers,
       (SELECT COUNT(*) FROM community_profile WHERE status = 'suspended') AS suspendedUsers,
       (SELECT COUNT(*) FROM community_post WHERE status = 'published' AND deleted_at IS NULL) AS publishedPosts,
       (SELECT COUNT(*) FROM community_post WHERE moderation_status = 'block' AND deleted_at IS NULL) AS blockedPosts,
       (SELECT COUNT(*) FROM community_appeal WHERE status = 'pending') AS pendingAppeals,
       (SELECT COUNT(*) FROM admin_operation WHERE status IN ('pending', 'running')) AS pendingOperations,
       (SELECT COUNT(*) FROM community_content_report WHERE status IN ('pending', 'reviewing')) AS pendingReports,
       (SELECT COUNT(*) FROM resource_package_upload WHERE status = 'ready') AS readyPackages,
       (SELECT COUNT(*) FROM resource_run) AS resourceRuns`,
  ).first<OverviewRow>();
  if (!counts) throw new Error("Admin overview query returned no row");
  return json(request, {
    overview: {
      activeUsers: counts.activeUsers,
      blockedPosts: counts.blockedPosts,
      pendingAppeals: counts.pendingAppeals,
      pendingOperations: counts.pendingOperations,
      pendingReports: counts.pendingReports,
      publishedPosts: counts.publishedPosts,
      readyPackages: counts.readyPackages,
      resourceRuns: counts.resourceRuns,
      suspendedUsers: counts.suspendedUsers,
      totalUsers: counts.totalUsers,
    },
    session: staffValue(access),
  });
};

const getUsers = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const limit = parseLimit(url);
  if (!limit) return error(request, 400, "invalid_limit", "limit must be between 1 and 100");
  const role = url.searchParams.get("role");
  const status = url.searchParams.get("status");
  if (role && role !== "admin" && role !== "member" && role !== "moderator") {
    return error(request, 400, "invalid_role", "role must be member, moderator, or admin");
  }
  if (status && status !== "active" && status !== "deleted" && status !== "suspended") {
    return error(request, 400, "invalid_status", "status must be active, suspended, or deleted");
  }
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && (!cursor || typeof cursor.sort !== "string")) {
    return error(request, 400, "invalid_cursor", "cursor is invalid");
  }
  const query = (url.searchParams.get("q") || "").normalize("NFKC").trim();
  if (query.length > 100) return error(request, 400, "invalid_query", "q must not exceed 100 characters");

  const conditions: string[] = [];
  const values: BindValue[] = [];
  if (role) {
    conditions.push("profile.role = ?");
    values.push(role);
  }
  if (status) {
    conditions.push("profile.status = ?");
    values.push(status);
  }
  if (query) {
    conditions.push(
      `(account.id = ?
        OR account.email = ? COLLATE NOCASE
        OR account.name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR profile.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR profile.pending_display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR profile.handle LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
    );
    const pattern = `${escapeLike(query)}%`;
    values.push(query, query, pattern, pattern, pattern, pattern);
  }
  if (cursor && typeof cursor.sort === "string") {
    conditions.push("(account.createdAt < ? OR (account.createdAt = ? AND account.id < ?))");
    values.push(cursor.sort, cursor.sort, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const now = Date.now();
  values.push(now, now, now, limit);
  const result = await env.DB.prepare(
    `SELECT account.id, account.name AS accountName, account.email, account.emailVerified AS emailVerified,
            account.image,
            account.createdAt AS createdAt, account.updatedAt AS updatedAt,
            profile.display_name AS publicDisplayName,
            profile.pending_display_name AS candidateDisplayName,
            profile.display_name_status AS displayNameStatus,
            profile.handle, profile.role, profile.status, profile.version,
            EXISTS(
              SELECT 1 FROM community_user_restriction AS restriction
              WHERE restriction.user_id = account.id AND restriction.kind = 'write'
                AND restriction.revoked_at IS NULL
                AND (restriction.expires_at IS NULL OR restriction.expires_at > ?)
            ) AS writeRestricted,
            EXISTS(
              SELECT 1 FROM community_user_restriction AS restriction
              WHERE restriction.user_id = account.id AND restriction.kind = 'sign_in'
                AND restriction.revoked_at IS NULL
                AND (restriction.expires_at IS NULL OR restriction.expires_at > ?)
            ) AS signInRestricted,
            EXISTS(
              SELECT 1 FROM community_user_restriction AS restriction
              WHERE restriction.user_id = account.id AND restriction.kind = 'upload'
                AND restriction.revoked_at IS NULL
                AND (restriction.expires_at IS NULL OR restriction.expires_at > ?)
            ) AS uploadRestricted
     FROM "user" AS account
     JOIN community_profile AS profile ON profile.user_id = account.id
     ${where}
     ORDER BY account.createdAt DESC, account.id DESC
     LIMIT ?`,
  )
    .bind(...values)
    .all<UserListRow>();
  const activeRestrictionsByUser = new Map<string, JsonObject[]>();
  if (result.results.length > 0) {
    const userIds = result.results.map((row) => row.id);
    const placeholders = userIds.map(() => "?").join(", ");
    const activeRestrictions = await env.DB.prepare(
      `SELECT id, user_id AS userId, kind, reason_code AS reasonCode, actor_user_id AS actorUserId,
              expires_at AS expiresAt, revoked_at AS revokedAt, revoked_by_user_id AS revokedByUserId,
              version, created_at AS createdAt, updated_at AS updatedAt
       FROM community_user_restriction
       WHERE user_id IN (${placeholders})
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC, id DESC`,
    )
      .bind(...userIds, now)
      .all<RestrictionRow>();
    for (const restriction of activeRestrictions.results) {
      const valuesForUser = activeRestrictionsByUser.get(restriction.userId) || [];
      valuesForUser.push(restrictionValue(restriction));
      activeRestrictionsByUser.set(restriction.userId, valuesForUser);
    }
  }
  const users = result.results.map((row) => ({
    id: row.id,
    accountName: row.accountName,
    candidateDisplayName: row.candidateDisplayName,
    displayNameStatus: row.displayNameStatus,
    email: row.email,
    emailVerified: row.emailVerified === 1,
    image: row.image,
    publicDisplayName: row.publicDisplayName,
    handle: row.handle,
    role: row.role,
    status: row.status,
    version: row.version,
    restrictions: {
      signIn: row.signInRestricted === 1,
      upload: row.uploadRestricted === 1,
      write: row.writeRestricted === 1,
    },
    activeRestrictions: activeRestrictionsByUser.get(row.id) || [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  const last = result.results.at(-1);
  return json(request, {
    users,
    nextCursor: last && result.results.length === limit ? encodeCursor({ sort: last.createdAt, id: last.id }) : null,
  });
};

const getPosts = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const limit = parseLimit(url, 50);
  if (!limit) return error(request, 400, "invalid_limit", "limit must be between 1 and 50");
  const moderationStatus = url.searchParams.get("moderationStatus");
  const postStatus = url.searchParams.get("status");
  if (moderationStatus && !new Set(["allow", "block", "pending", "review"]).has(moderationStatus)) {
    return error(request, 400, "invalid_moderation_status", "Invalid moderationStatus");
  }
  if (postStatus && !new Set(["draft", "hidden", "published"]).has(postStatus)) {
    return error(request, 400, "invalid_status", "Invalid post status");
  }
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && (!cursor || typeof cursor.sort !== "number")) {
    return error(request, 400, "invalid_cursor", "cursor is invalid");
  }
  const query = (url.searchParams.get("q") || "").normalize("NFKC").trim();
  if (query.length > 100) return error(request, 400, "invalid_query", "q must not exceed 100 characters");
  const authorId = url.searchParams.get("authorId");
  if (authorId && !SAFE_ID_PATTERN.test(authorId)) return error(request, 400, "invalid_author", "authorId is invalid");

  const conditions: string[] = [];
  const values: BindValue[] = [];
  if (moderationStatus) {
    conditions.push("post.moderation_status = ?");
    values.push(moderationStatus);
  }
  if (postStatus) {
    conditions.push("post.status = ?");
    values.push(postStatus);
  }
  if (authorId) {
    conditions.push("post.author_id = ?");
    values.push(authorId);
  }
  if (query) {
    conditions.push("(post.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR post.body LIKE ? ESCAPE '\\' COLLATE NOCASE)");
    const pattern = `%${escapeLike(query)}%`;
    values.push(pattern, pattern);
  }
  if (cursor && typeof cursor.sort === "number") {
    conditions.push("(post.created_at < ? OR (post.created_at = ? AND post.id < ?))");
    values.push(cursor.sort, cursor.sort, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(limit);
  const result = await env.DB.prepare(
    `SELECT post.id, post.author_id AS authorId, account.name AS authorAccountName,
            profile.display_name AS authorName, profile.handle AS authorHandle,
            post.title, post.body, post.status, post.visibility, post.version,
            post.moderation_status AS moderationStatus, post.moderation_revision AS moderationRevision,
            post.comment_count AS commentCount, post.like_count AS likeCount,
            post.pinned_at AS pinnedAt, post.archived_at AS archivedAt, post.deleted_at AS deletedAt,
            post.created_at AS createdAt, post.updated_at AS updatedAt
     FROM community_post AS post
     JOIN "user" AS account ON account.id = post.author_id
     JOIN community_profile AS profile ON profile.user_id = post.author_id
     ${where}
     ORDER BY post.created_at DESC, post.id DESC
     LIMIT ?`,
  )
    .bind(...values)
    .all<PostListRow>();
  const last = result.results.at(-1);
  const posts = result.results.map((row) => ({
    archivedAt: row.archivedAt,
    authorAccountName: row.authorAccountName,
    authorHandle: row.authorHandle,
    authorId: row.authorId,
    authorName: row.authorName,
    body: row.body,
    commentCount: row.commentCount,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
    id: row.id,
    likeCount: row.likeCount,
    moderationRevision: row.moderationRevision,
    moderationStatus: row.moderationStatus,
    pinnedAt: row.pinnedAt,
    status: row.status,
    title: row.title,
    updatedAt: row.updatedAt,
    version: row.version,
    visibility: row.visibility,
  }));
  return json(request, {
    posts,
    nextCursor: last && result.results.length === limit ? encodeCursor({ sort: last.createdAt, id: last.id }) : null,
  });
};

const postRevisionHistoryValue = (
  revision: PostRevisionHistoryRow,
  tags: JsonObject[],
  attachments: JsonObject[],
): JsonObject => ({
  revisionNumber: revision.revisionNumber,
  editor: {
    id: revision.editorUserId,
    accountName: revision.editorAccountName,
    displayName: revision.editorDisplayName,
    handle: revision.editorHandle,
  },
  title: revision.title,
  body: revision.body,
  visibility: revision.visibility,
  editReason: revision.editReason,
  sourceKind: revision.sourceKind,
  tags,
  attachments,
  createdAt: revision.createdAt,
  ...ipAuditValue(revision),
});

const postStateEventValue = (event: PostStateEventRow): JsonObject => ({
  id: event.id,
  actor: event.actorUserId
    ? {
        id: event.actorUserId,
        accountName: event.actorAccountName,
        displayName: event.actorDisplayName,
        handle: event.actorHandle,
      }
    : null,
  eventKind: event.eventKind,
  revisionNumber: event.revisionNumber,
  reasonCode: event.reasonCode,
  createdAt: event.createdAt,
  ...ipAuditValue(event),
});

const commentHistoryHeadValue = (comment: CommentHistoryHeadRow): JsonObject => ({
  id: comment.id,
  postId: comment.postId,
  parentId: comment.parentId,
  author: {
    id: comment.authorId,
    accountName: comment.authorAccountName,
    displayName: comment.authorDisplayName,
    handle: comment.authorHandle,
  },
  version: comment.version,
  moderationStatus: comment.moderationStatus,
  moderationRevision: comment.moderationRevision,
  deletedAt: comment.deletedAt,
  hiddenAt: comment.hiddenAt,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  ...ipAuditValue(comment),
});

const commentRevisionHistoryValue = (revision: CommentRevisionHistoryRow): JsonObject => ({
  revisionNumber: revision.revisionNumber,
  editor: {
    id: revision.editorUserId,
    accountName: revision.editorAccountName,
    displayName: revision.editorDisplayName,
    handle: revision.editorHandle,
  },
  body: revision.body,
  editReason: revision.editReason,
  sourceKind: revision.sourceKind,
  createdAt: revision.createdAt,
  ...ipAuditValue(revision),
});

const commentStateEventValue = (event: CommentStateEventRow): JsonObject => ({
  id: event.id,
  actor: event.actorUserId
    ? {
        id: event.actorUserId,
        accountName: event.actorAccountName,
        displayName: event.actorDisplayName,
        handle: event.actorHandle,
      }
    : null,
  eventKind: event.eventKind,
  revisionNumber: event.revisionNumber,
  reasonCode: event.reasonCode,
  createdAt: event.createdAt,
  ...ipAuditValue(event),
});

const getPostRevisionHistoryPage = async (
  env: Env,
  postId: string,
  limit: number,
  cursor: NumericCursor | null,
): Promise<{ nextCursor: string | null; revisions: JsonObject[] }> => {
  const values: BindValue[] = [postId];
  const after = cursor ? "AND revision.revision_number < ?" : "";
  if (cursor) values.push(cursor.sort);
  values.push(limit + 1);
  const result = await env.DB.prepare(
    `SELECT revision.revision_number AS revisionNumber, revision.editor_user_id AS editorUserId,
            editor.name AS editorAccountName, editor_profile.display_name AS editorDisplayName,
            editor_profile.handle AS editorHandle,
            revision.title, revision.body, revision.visibility,
            revision.edit_reason AS editReason, revision.source_kind AS sourceKind,
            revision.ip_country_code AS ipCountryCode, revision.ip_region_code AS ipRegionCode,
            revision.ip_region_name AS ipRegionName, revision.ip_address AS ipAddress,
            revision.user_agent AS userAgent, revision.browser_family AS browserFamily,
            revision.os_family AS osFamily, revision.created_at AS createdAt
     FROM community_post_revision AS revision
     JOIN "user" AS editor ON editor.id = revision.editor_user_id
     JOIN community_profile AS editor_profile ON editor_profile.user_id = revision.editor_user_id
     WHERE revision.post_id = ? ${after}
     ORDER BY revision.revision_number DESC
     LIMIT ?`,
  )
    .bind(...values)
    .all<PostRevisionHistoryRow>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const tagsByRevision = new Map<number, JsonObject[]>();
  const attachmentsByRevision = new Map<number, JsonObject[]>();
  if (rows.length) {
    const revisionNumbers = rows.map((row) => row.revisionNumber);
    const placeholders = revisionNumbers.map(() => "?").join(", ");
    const [tagResult, attachmentResult] = await Promise.all([
      env.DB.prepare(
        `SELECT revision_tag.revision_number AS revisionNumber, revision_tag.position,
                revision_tag.tag_id AS tagId,
                revision_tag.normalized_name AS normalizedName,
                revision_tag.display_name AS displayName
         FROM community_post_revision_tag AS revision_tag
         WHERE revision_tag.post_id = ? AND revision_tag.revision_number IN (${placeholders})
         ORDER BY revision_tag.revision_number DESC, revision_tag.position ASC`,
      )
        .bind(postId, ...revisionNumbers)
        .all<PostRevisionTagRow>(),
      env.DB.prepare(
        `SELECT revision_attachment.revision_number AS revisionNumber, revision_attachment.position,
                attachment.id AS attachmentId, attachment.original_name AS originalName,
                attachment.media_type AS mediaType, attachment.declared_size AS declaredSize,
                attachment.byte_size AS byteSize, attachment.sha256, attachment.status
         FROM community_post_revision_attachment AS revision_attachment
         JOIN community_attachment AS attachment ON attachment.id = revision_attachment.attachment_id
         WHERE revision_attachment.post_id = ? AND revision_attachment.revision_number IN (${placeholders})
         ORDER BY revision_attachment.revision_number DESC, revision_attachment.position ASC`,
      )
        .bind(postId, ...revisionNumbers)
        .all<PostRevisionAttachmentRow>(),
    ]);
    for (const tag of tagResult.results) {
      const tags = tagsByRevision.get(tag.revisionNumber) || [];
      tags.push({
        id: tag.tagId,
        normalizedName: tag.normalizedName,
        displayName: tag.displayName,
        position: tag.position,
      });
      tagsByRevision.set(tag.revisionNumber, tags);
    }
    for (const attachment of attachmentResult.results) {
      const attachments = attachmentsByRevision.get(attachment.revisionNumber) || [];
      attachments.push({
        id: attachment.attachmentId,
        originalName: attachment.originalName,
        mediaType: attachment.mediaType,
        declaredSize: attachment.declaredSize,
        byteSize: attachment.byteSize,
        sha256: attachment.sha256,
        status: attachment.status,
        position: attachment.position,
      });
      attachmentsByRevision.set(attachment.revisionNumber, attachments);
    }
  }
  const last = rows.at(-1);
  return {
    revisions: rows.map((row) =>
      postRevisionHistoryValue(
        row,
        tagsByRevision.get(row.revisionNumber) || [],
        attachmentsByRevision.get(row.revisionNumber) || [],
      ),
    ),
    nextCursor: hasMore && last ? encodeCursor({ sort: last.revisionNumber, id: String(last.revisionNumber) }) : null,
  };
};

const getPostStateEventHistoryPage = async (
  env: Env,
  postId: string,
  limit: number,
  cursor: NumericCursor | null,
): Promise<{ nextCursor: string | null; stateEvents: JsonObject[] }> => {
  const values: BindValue[] = [postId];
  const after = cursor ? "AND (event.created_at < ? OR (event.created_at = ? AND event.id < ?))" : "";
  if (cursor) values.push(cursor.sort, cursor.sort, cursor.id);
  values.push(limit + 1);
  const result = await env.DB.prepare(
    `SELECT event.id, event.actor_user_id AS actorUserId,
            actor.name AS actorAccountName, actor_profile.display_name AS actorDisplayName,
            actor_profile.handle AS actorHandle, event.event_kind AS eventKind,
            event.revision_number AS revisionNumber, event.reason_code AS reasonCode,
            event.ip_country_code AS ipCountryCode, event.ip_region_code AS ipRegionCode,
            event.ip_region_name AS ipRegionName, event.ip_address AS ipAddress,
            NULL AS userAgent, NULL AS browserFamily, NULL AS osFamily,
            event.created_at AS createdAt
     FROM community_post_state_event AS event
     LEFT JOIN "user" AS actor ON actor.id = event.actor_user_id
     LEFT JOIN community_profile AS actor_profile ON actor_profile.user_id = event.actor_user_id
     WHERE event.post_id = ? ${after}
     ORDER BY event.created_at DESC, event.id DESC
     LIMIT ?`,
  )
    .bind(...values)
    .all<PostStateEventRow>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    stateEvents: rows.map(postStateEventValue),
    nextCursor: hasMore && last ? encodeCursor({ sort: last.createdAt, id: last.id }) : null,
  };
};

const getPostCommentHistoryPage = async (
  env: Env,
  postId: string,
  limit: number,
  cursor: NumericCursor | null,
): Promise<{ comments: JsonObject[]; nextCursor: string | null }> => {
  const values: BindValue[] = [postId];
  const after = cursor ? "AND (comment.created_at > ? OR (comment.created_at = ? AND comment.id > ?))" : "";
  if (cursor) values.push(cursor.sort, cursor.sort, cursor.id);
  values.push(limit + 1);
  const result = await env.DB.prepare(
    `SELECT comment.id, comment.post_id AS postId, comment.parent_id AS parentId,
            comment.author_id AS authorId, author.name AS authorAccountName,
            author_profile.display_name AS authorDisplayName, author_profile.handle AS authorHandle,
            comment.version, comment.moderation_status AS moderationStatus,
            comment.moderation_revision AS moderationRevision,
            comment.deleted_at AS deletedAt, comment.hidden_at AS hiddenAt,
            comment.ip_country_code AS ipCountryCode, comment.ip_region_code AS ipRegionCode,
            comment.ip_region_name AS ipRegionName, comment.ip_address AS ipAddress,
            comment.user_agent AS userAgent, comment.browser_family AS browserFamily,
            comment.os_family AS osFamily,
            comment.created_at AS createdAt, comment.updated_at AS updatedAt
     FROM community_comment AS comment
     JOIN "user" AS author ON author.id = comment.author_id
     JOIN community_profile AS author_profile ON author_profile.user_id = comment.author_id
     WHERE comment.post_id = ? ${after}
     ORDER BY comment.created_at ASC, comment.id ASC
     LIMIT ?`,
  )
    .bind(...values)
    .all<CommentHistoryHeadRow>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    comments: rows.map(commentHistoryHeadValue),
    nextCursor: hasMore && last ? encodeCursor({ sort: last.createdAt, id: last.id }) : null,
  };
};

const getCommentRevisionHistoryPage = async (
  env: Env,
  commentId: string,
  limit: number,
  cursor: NumericCursor | null,
): Promise<{ nextCursor: string | null; revisions: JsonObject[] }> => {
  const values: BindValue[] = [commentId];
  const after = cursor ? "AND revision.revision_number < ?" : "";
  if (cursor) values.push(cursor.sort);
  values.push(limit + 1);
  const result = await env.DB.prepare(
    `SELECT revision.revision_number AS revisionNumber, revision.editor_user_id AS editorUserId,
            editor.name AS editorAccountName, editor_profile.display_name AS editorDisplayName,
            editor_profile.handle AS editorHandle, revision.body,
            revision.edit_reason AS editReason, revision.source_kind AS sourceKind,
            revision.ip_country_code AS ipCountryCode, revision.ip_region_code AS ipRegionCode,
            revision.ip_region_name AS ipRegionName, revision.ip_address AS ipAddress,
            revision.user_agent AS userAgent, revision.browser_family AS browserFamily,
            revision.os_family AS osFamily, revision.created_at AS createdAt
     FROM community_comment_revision AS revision
     JOIN "user" AS editor ON editor.id = revision.editor_user_id
     JOIN community_profile AS editor_profile ON editor_profile.user_id = revision.editor_user_id
     WHERE revision.comment_id = ? ${after}
     ORDER BY revision.revision_number DESC
     LIMIT ?`,
  )
    .bind(...values)
    .all<CommentRevisionHistoryRow>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    revisions: rows.map(commentRevisionHistoryValue),
    nextCursor: hasMore && last ? encodeCursor({ sort: last.revisionNumber, id: String(last.revisionNumber) }) : null,
  };
};

const getCommentStateEventHistoryPage = async (
  env: Env,
  commentId: string,
  limit: number,
  cursor: NumericCursor | null,
): Promise<{ nextCursor: string | null; stateEvents: JsonObject[] }> => {
  const values: BindValue[] = [commentId];
  const after = cursor ? "AND (event.created_at < ? OR (event.created_at = ? AND event.id < ?))" : "";
  if (cursor) values.push(cursor.sort, cursor.sort, cursor.id);
  values.push(limit + 1);
  const result = await env.DB.prepare(
    `SELECT event.id, event.actor_user_id AS actorUserId,
            actor.name AS actorAccountName, actor_profile.display_name AS actorDisplayName,
            actor_profile.handle AS actorHandle, event.event_kind AS eventKind,
            event.revision_number AS revisionNumber, event.reason_code AS reasonCode,
            event.ip_country_code AS ipCountryCode, event.ip_region_code AS ipRegionCode,
            event.ip_region_name AS ipRegionName, event.ip_address AS ipAddress,
            NULL AS userAgent, NULL AS browserFamily, NULL AS osFamily,
            event.created_at AS createdAt
     FROM community_comment_state_event AS event
     LEFT JOIN "user" AS actor ON actor.id = event.actor_user_id
     LEFT JOIN community_profile AS actor_profile ON actor_profile.user_id = event.actor_user_id
     WHERE event.comment_id = ? ${after}
     ORDER BY event.created_at DESC, event.id DESC
     LIMIT ?`,
  )
    .bind(...values)
    .all<CommentStateEventRow>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    stateEvents: rows.map(commentStateEventValue),
    nextCursor: hasMore && last ? encodeCursor({ sort: last.createdAt, id: last.id }) : null,
  };
};

const historyCursor = (url: URL, section: string | null): NumericCursor | null | "invalid" => {
  const raw = url.searchParams.get("cursor");
  if (!raw) return null;
  if (!section) return "invalid";
  const cursor = decodeCursor(raw);
  if (!cursor || typeof cursor.sort !== "number") return "invalid";
  if (section === "revisions" && cursor.id !== String(cursor.sort)) return "invalid";
  if (section !== "revisions" && !UUID_PATTERN.test(cursor.id)) return "invalid";
  return { id: cursor.id, sort: cursor.sort };
};

const getPostHistory = async (request: Request, env: Env, postId: string, url: URL): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const limit = parseLimit(url, 50);
  if (!limit) return error(request, 400, "invalid_limit", "limit must be between 1 and 50");
  const section = url.searchParams.get("section");
  if (section && section !== "revisions" && section !== "stateEvents" && section !== "comments") {
    return error(request, 400, "invalid_history_section", "section must be revisions, stateEvents, or comments");
  }
  const cursor = historyCursor(url, section);
  if (cursor === "invalid") return error(request, 400, "invalid_cursor", "cursor is invalid");
  const post = await env.DB.prepare(
    `SELECT post.id, post.author_id AS authorId, author.name AS authorAccountName,
            author_profile.display_name AS authorDisplayName, author_profile.handle AS authorHandle,
            post.status, post.visibility, post.version,
            post.moderation_status AS moderationStatus, post.moderation_revision AS moderationRevision,
            post.deleted_at AS deletedAt, post.comments_locked_at AS commentsLockedAt,
            post.pinned_at AS pinnedAt, post.archived_at AS archivedAt,
            post.ip_country_code AS ipCountryCode, post.ip_region_code AS ipRegionCode,
            post.ip_region_name AS ipRegionName, post.ip_address AS ipAddress,
            post.user_agent AS userAgent, post.browser_family AS browserFamily,
            post.os_family AS osFamily, post.created_at AS createdAt, post.updated_at AS updatedAt
     FROM community_post AS post
     JOIN "user" AS author ON author.id = post.author_id
     JOIN community_profile AS author_profile ON author_profile.user_id = post.author_id
     WHERE post.id = ?
     LIMIT 1`,
  )
    .bind(postId)
    .first<PostHistoryHeadRow>();
  if (!post) return error(request, 404, "post_not_found", "Post not found");
  if (section === "revisions") return json(request, await getPostRevisionHistoryPage(env, postId, limit, cursor));
  if (section === "stateEvents") return json(request, await getPostStateEventHistoryPage(env, postId, limit, cursor));
  if (section === "comments") return json(request, await getPostCommentHistoryPage(env, postId, limit, cursor));

  const [revisionPage, eventPage, commentPage] = await Promise.all([
    getPostRevisionHistoryPage(env, postId, limit, null),
    getPostStateEventHistoryPage(env, postId, limit, null),
    getPostCommentHistoryPage(env, postId, limit, null),
  ]);
  return json(request, {
    post: {
      id: post.id,
      author: {
        id: post.authorId,
        accountName: post.authorAccountName,
        displayName: post.authorDisplayName,
        handle: post.authorHandle,
      },
      status: post.status,
      visibility: post.visibility,
      version: post.version,
      moderationStatus: post.moderationStatus,
      moderationRevision: post.moderationRevision,
      deletedAt: post.deletedAt,
      commentsLockedAt: post.commentsLockedAt,
      pinnedAt: post.pinnedAt,
      archivedAt: post.archivedAt,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      ...ipAuditValue(post),
    },
    revisions: revisionPage.revisions,
    stateEvents: eventPage.stateEvents,
    comments: commentPage.comments,
    nextCursors: {
      revisions: revisionPage.nextCursor,
      stateEvents: eventPage.nextCursor,
      comments: commentPage.nextCursor,
    },
  });
};

const getCommentHistory = async (request: Request, env: Env, commentId: string, url: URL): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const limit = parseLimit(url, 50);
  if (!limit) return error(request, 400, "invalid_limit", "limit must be between 1 and 50");
  const section = url.searchParams.get("section");
  if (section && section !== "revisions" && section !== "stateEvents") {
    return error(request, 400, "invalid_history_section", "section must be revisions or stateEvents");
  }
  const cursor = historyCursor(url, section);
  if (cursor === "invalid") return error(request, 400, "invalid_cursor", "cursor is invalid");
  const comment = await env.DB.prepare(
    `SELECT comment.id, comment.post_id AS postId, comment.parent_id AS parentId,
            comment.author_id AS authorId, author.name AS authorAccountName,
            author_profile.display_name AS authorDisplayName, author_profile.handle AS authorHandle,
            comment.version, comment.moderation_status AS moderationStatus,
            comment.moderation_revision AS moderationRevision,
            comment.deleted_at AS deletedAt, comment.hidden_at AS hiddenAt,
            comment.ip_country_code AS ipCountryCode, comment.ip_region_code AS ipRegionCode,
            comment.ip_region_name AS ipRegionName, comment.ip_address AS ipAddress,
            comment.user_agent AS userAgent, comment.browser_family AS browserFamily,
            comment.os_family AS osFamily,
            comment.created_at AS createdAt, comment.updated_at AS updatedAt
     FROM community_comment AS comment
     JOIN "user" AS author ON author.id = comment.author_id
     JOIN community_profile AS author_profile ON author_profile.user_id = comment.author_id
     WHERE comment.id = ?
     LIMIT 1`,
  )
    .bind(commentId)
    .first<CommentHistoryHeadRow>();
  if (!comment) return error(request, 404, "comment_not_found", "Comment not found");
  if (section === "revisions") return json(request, await getCommentRevisionHistoryPage(env, commentId, limit, cursor));
  if (section === "stateEvents") {
    return json(request, await getCommentStateEventHistoryPage(env, commentId, limit, cursor));
  }
  const [revisionPage, eventPage] = await Promise.all([
    getCommentRevisionHistoryPage(env, commentId, limit, null),
    getCommentStateEventHistoryPage(env, commentId, limit, null),
  ]);
  return json(request, {
    comment: commentHistoryHeadValue(comment),
    revisions: revisionPage.revisions,
    stateEvents: eventPage.stateEvents,
    nextCursors: {
      revisions: revisionPage.nextCursor,
      stateEvents: eventPage.nextCursor,
    },
  });
};

const putPostState = async (request: Request, env: Env, postId: string): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const action = body.action;
  const version = expectedVersion(body);
  const reasonCode = body.reasonCode;
  if (
    (action !== "hide" && action !== "unhide" && action !== "lock" && action !== "unlock") ||
    version === null ||
    typeof reasonCode !== "string" ||
    !REASON_PATTERN.test(reasonCode)
  ) {
    return error(request, 422, "invalid_post_state", "action, reasonCode, and expectedVersion are required");
  }
  const started = await startOperation(request, env, access, "post.state.set", "post", postId);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);
  const current = await env.DB.prepare(
    `SELECT status, version, moderation_revision AS moderationRevision,
            deleted_at AS deletedAt, comments_locked_at AS commentsLockedAt
     FROM community_post WHERE id = ? LIMIT 1`,
  )
    .bind(postId)
    .first<{
      commentsLockedAt: number | null;
      deletedAt: number | null;
      moderationRevision: number;
      status: "draft" | "hidden" | "published";
      version: number;
    }>();
  if (!current || current.deletedAt !== null) {
    await failOperation(env, started.operationId, "post_not_found");
    return error(request, 404, "post_not_found", "Post not found");
  }
  if (current.version !== version) {
    await failOperation(env, started.operationId, "version_conflict", { actualVersion: current.version });
    return error(request, 409, "version_conflict", "The post changed; refresh and try again");
  }
  const alreadyApplied =
    (action === "hide" && current.status === "hidden") ||
    (action === "unhide" && current.status === "published") ||
    (action === "lock" && current.commentsLockedAt !== null) ||
    (action === "unlock" && current.commentsLockedAt === null);
  if (alreadyApplied || ((action === "hide" || action === "unhide") && current.status === "draft")) {
    await failOperation(env, started.operationId, "post_state_unchanged");
    return error(request, 409, "post_state_unchanged", "The post already has this state");
  }
  const now = Date.now();
  const ip = requestIpMetadata(request);
  const eventKind =
    action === "hide" ? "hidden" : action === "unhide" ? "unhidden" : action === "lock" ? "locked" : "unlocked";
  const eventId = crypto.randomUUID();
  const eventPrefix = `INSERT INTO community_post_state_event
     (id, post_id, actor_user_id, event_kind, revision_number, reason_code,
      ip_country_code, ip_region_code, ip_region_name, ip_address, created_at)
   SELECT ?, id, ?, ?, moderation_revision, ?, ?, ?, ?, ?, ?
   FROM community_post
   WHERE id = ? AND version = ? AND deleted_at IS NULL`;
  const event =
    action === "hide" || action === "unhide"
      ? env.DB.prepare(`${eventPrefix} AND status = ?`).bind(
          eventId,
          access.userId,
          eventKind,
          reasonCode,
          ip.countryCode,
          ip.regionCode,
          ip.regionName,
          ip.ipAddress,
          now,
          postId,
          version,
          action === "hide" ? "published" : "hidden",
        )
      : env.DB.prepare(
          `${eventPrefix}
           AND ((? = 1 AND comments_locked_at IS NULL) OR (? = 0 AND comments_locked_at IS NOT NULL))`,
        ).bind(
          eventId,
          access.userId,
          eventKind,
          reasonCode,
          ip.countryCode,
          ip.regionCode,
          ip.regionName,
          ip.ipAddress,
          now,
          postId,
          version,
          action === "lock" ? 1 : 0,
          action === "lock" ? 1 : 0,
        );
  const update =
    action === "hide" || action === "unhide"
      ? env.DB.prepare(
          `UPDATE community_post
           SET status = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL AND status = ?
             AND EXISTS (
               SELECT 1 FROM community_post_state_event
               WHERE id = ? AND post_id = community_post.id AND event_kind = ?
             )`,
        ).bind(
          action === "hide" ? "hidden" : "published",
          now,
          postId,
          version,
          action === "hide" ? "published" : "hidden",
          eventId,
          eventKind,
        )
      : env.DB.prepare(
          `UPDATE community_post
           SET comments_locked_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL
             AND ((? = 1 AND comments_locked_at IS NULL) OR (? = 0 AND comments_locked_at IS NOT NULL))
             AND EXISTS (
               SELECT 1 FROM community_post_state_event
               WHERE id = ? AND post_id = community_post.id AND event_kind = ?
             )`,
        ).bind(
          action === "lock" ? now : null,
          now,
          postId,
          version,
          action === "lock" ? 1 : 0,
          action === "lock" ? 1 : 0,
          eventId,
          eventKind,
        );
  const results = await env.DB.batch([event, update]);
  if (Number(results[0]?.meta.changes || 0) < 1 || Number(results[1]?.meta.changes || 0) < 1) {
    await failOperation(env, started.operationId, "post_state_conflict");
    return error(request, 409, "post_state_conflict", "The post state could not be updated safely");
  }
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { action, reasonCode, version: version + 1 },
    postId,
    null,
  );
  return json(request, { action, operation: operationValue(operation), version: version + 1 });
};

const putCommentState = async (request: Request, env: Env, commentId: string): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const action = body.action;
  const version = expectedVersion(body);
  const reasonCode = body.reasonCode;
  if (
    (action !== "hide" && action !== "unhide") ||
    version === null ||
    typeof reasonCode !== "string" ||
    !REASON_PATTERN.test(reasonCode)
  ) {
    return error(request, 422, "invalid_comment_state", "action, reasonCode, and expectedVersion are required");
  }
  const started = await startOperation(request, env, access, "comment.state.set", "comment", commentId);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);
  const current = await env.DB.prepare(
    `SELECT version, moderation_revision AS moderationRevision,
            deleted_at AS deletedAt, hidden_at AS hiddenAt
     FROM community_comment WHERE id = ? LIMIT 1`,
  )
    .bind(commentId)
    .first<{
      deletedAt: number | null;
      hiddenAt: number | null;
      moderationRevision: number;
      version: number;
    }>();
  if (!current || current.deletedAt !== null) {
    await failOperation(env, started.operationId, "comment_not_found");
    return error(request, 404, "comment_not_found", "Comment not found");
  }
  if (current.version !== version) {
    await failOperation(env, started.operationId, "version_conflict", { actualVersion: current.version });
    return error(request, 409, "version_conflict", "The comment changed; refresh and try again");
  }
  if ((action === "hide" && current.hiddenAt !== null) || (action === "unhide" && current.hiddenAt === null)) {
    await failOperation(env, started.operationId, "comment_state_unchanged");
    return error(request, 409, "comment_state_unchanged", "The comment already has this state");
  }
  const now = Date.now();
  const ip = requestIpMetadata(request);
  const eventId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_comment_state_event
         (id, comment_id, actor_user_id, event_kind, revision_number, reason_code,
          ip_country_code, ip_region_code, ip_region_name, ip_address, created_at)
       SELECT ?, id, ?, ?, moderation_revision, ?, ?, ?, ?, ?, ?
       FROM community_comment
       WHERE id = ? AND version = ? AND deleted_at IS NULL
         AND ((? = 1 AND hidden_at IS NULL) OR (? = 0 AND hidden_at IS NOT NULL))`,
    ).bind(
      eventId,
      access.userId,
      action === "hide" ? "hidden" : "unhidden",
      reasonCode,
      ip.countryCode,
      ip.regionCode,
      ip.regionName,
      ip.ipAddress,
      now,
      commentId,
      version,
      action === "hide" ? 1 : 0,
      action === "hide" ? 1 : 0,
    ),
    env.DB.prepare(
      `UPDATE community_comment
       SET hidden_at = ?, hidden_by_user_id = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL
         AND ((? = 1 AND hidden_at IS NULL) OR (? = 0 AND hidden_at IS NOT NULL))
         AND EXISTS (
           SELECT 1 FROM community_comment_state_event
           WHERE id = ? AND comment_id = community_comment.id AND event_kind = ?
         )`,
    ).bind(
      action === "hide" ? now : null,
      action === "hide" ? access.userId : null,
      now,
      commentId,
      version,
      action === "hide" ? 1 : 0,
      action === "hide" ? 1 : 0,
      eventId,
      action === "hide" ? "hidden" : "unhidden",
    ),
  ]);
  if (Number(results[0]?.meta.changes || 0) < 1 || Number(results[1]?.meta.changes || 0) < 1) {
    await failOperation(env, started.operationId, "comment_state_conflict");
    return error(request, 409, "comment_state_conflict", "The comment state could not be updated safely");
  }
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { action, reasonCode, version: version + 1 },
    commentId,
    null,
  );
  return json(request, { action, operation: operationValue(operation), version: version + 1 });
};

const getAppeals = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const access = await requireStaff(request, env, "staff");
  if (access instanceof Response) return access;
  const limit = parseLimit(url, 50);
  if (!limit) return error(request, 400, "invalid_limit", "limit must be between 1 and 50");
  const status = url.searchParams.get("status") || "pending";
  if (!new Set(["accepted", "all", "pending", "rejected", "superseded"]).has(status)) {
    return error(request, 400, "invalid_status", "Invalid appeal status");
  }
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && (!cursor || typeof cursor.sort !== "number")) {
    return error(request, 400, "invalid_cursor", "cursor is invalid");
  }
  const conditions: string[] = [];
  const values: BindValue[] = [];
  if (status !== "all") {
    conditions.push("appeal.status = ?");
    values.push(status);
  }
  if (cursor && typeof cursor.sort === "number") {
    conditions.push("(appeal.created_at > ? OR (appeal.created_at = ? AND appeal.id > ?))");
    values.push(cursor.sort, cursor.sort, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(limit);
  const result = await env.DB.prepare(
    `SELECT appeal.id, appeal.case_id AS caseId, appeal.appellant_user_id AS appellantUserId,
            appellant.name AS appellantName, appellant_profile.handle AS appellantHandle,
            appeal.statement, appeal.status, appeal.reviewer_user_id AS reviewerUserId,
            reviewer.name AS reviewerName, appeal.resolution_reason_code AS resolutionReasonCode,
            appeal.version, appeal.created_at AS createdAt, appeal.updated_at AS updatedAt,
            appeal.resolved_at AS resolvedAt,
            moderation.entity_kind AS entityKind, moderation.entity_id AS entityId,
            moderation.entity_revision AS entityRevision, moderation.status AS caseStatus
     FROM community_appeal AS appeal
     JOIN community_moderation_case AS moderation ON moderation.id = appeal.case_id
     JOIN "user" AS appellant ON appellant.id = appeal.appellant_user_id
     JOIN community_profile AS appellant_profile ON appellant_profile.user_id = appeal.appellant_user_id
     LEFT JOIN "user" AS reviewer ON reviewer.id = appeal.reviewer_user_id
     ${where}
     ORDER BY appeal.created_at ASC, appeal.id ASC
     LIMIT ?`,
  )
    .bind(...values)
    .all<AppealListRow>();
  const last = result.results.at(-1);
  const appeals = result.results.map(appealValue);
  return json(request, {
    appeals,
    nextCursor: last && result.results.length === limit ? encodeCursor({ sort: last.createdAt, id: last.id }) : null,
  });
};

const findAppealForAdmin = async (env: Env, appealId: string): Promise<AppealListRow | null> =>
  env.DB.prepare(
    `SELECT appeal.id, appeal.case_id AS caseId, appeal.appellant_user_id AS appellantUserId,
            appellant.name AS appellantName, appellant_profile.handle AS appellantHandle,
            appeal.statement, appeal.status, appeal.reviewer_user_id AS reviewerUserId,
            reviewer.name AS reviewerName, appeal.resolution_reason_code AS resolutionReasonCode,
            appeal.version, appeal.created_at AS createdAt, appeal.updated_at AS updatedAt,
            appeal.resolved_at AS resolvedAt,
            moderation.entity_kind AS entityKind, moderation.entity_id AS entityId,
            moderation.entity_revision AS entityRevision, moderation.status AS caseStatus
     FROM community_appeal AS appeal
     JOIN community_moderation_case AS moderation ON moderation.id = appeal.case_id
     JOIN "user" AS appellant ON appellant.id = appeal.appellant_user_id
     JOIN community_profile AS appellant_profile ON appellant_profile.user_id = appeal.appellant_user_id
     LEFT JOIN "user" AS reviewer ON reviewer.id = appeal.reviewer_user_id
     WHERE appeal.id = ?
     LIMIT 1`,
  )
    .bind(appealId)
    .first<AppealListRow>();

const decideAppeal = async (request: Request, env: Env, appealId: string): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const decision = body.decision;
  const reasonCode = body.reasonCode;
  const version = expectedVersion(body);
  if (
    (decision !== "accepted" && decision !== "rejected") ||
    typeof reasonCode !== "string" ||
    !REASON_PATTERN.test(reasonCode) ||
    version === null
  ) {
    return error(request, 422, "invalid_appeal_decision", "decision, reasonCode, and expectedVersion are required");
  }
  const started = await startOperation(request, env, access, "appeal.decision", "appeal", appealId);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);

  let result: Awaited<ReturnType<typeof resolveModerationAppeal>>;
  try {
    result = await resolveModerationAppeal(env, {
      appealId,
      decision,
      expectedVersion: version,
      reasonCode,
      reviewerUserId: access.userId,
    });
  } catch (failure) {
    await failOperation(env, started.operationId, "appeal_decision_failed");
    throw failure;
  }
  if (!result.ok) {
    await failOperation(env, started.operationId, result.code, { appealId, decision });
    if (result.code === "not_found") return error(request, 404, result.code, "Appeal not found");
    if (result.code === "version_conflict") {
      return error(request, 409, result.code, "The appeal changed; refresh and try again");
    }
    if (result.code === "already_resolved") {
      return error(request, 409, result.code, "The appeal has already been resolved");
    }
    return error(request, 409, result.code, "The moderated entity is no longer in an appealable state");
  }
  const appeal = await findAppealForAdmin(env, appealId);
  if (!appeal) throw new Error("Resolved appeal disappeared");
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { appealId, decision, reasonCode, version: appeal.version },
    appealId,
    null,
  );
  return json(request, { appeal: appealValue(appeal), operation: operationValue(operation) });
};

const findReportForAdmin = async (env: Env, reportId: string): Promise<ContentReportRow | null> =>
  env.DB.prepare(
    `SELECT report.id, report.reporter_user_id AS reporterUserId,
            reporter.name AS reporterAccountName, reporter_profile.display_name AS reporterDisplayName,
            reporter_profile.handle AS reporterHandle,
            report.post_id AS postId, post_revision.title AS postTitle,
            report.comment_id AS commentId, comment.post_id AS commentPostId,
            comment_revision.body AS commentBody,
            report.target_revision AS targetRevision,
            report.reported_user_id AS reportedUserId,
            reported_identity.uid AS reportedUserPublicUid,
            reported_user.name AS reportedUserAccountName,
            reported_profile.display_name AS reportedUserDisplayName,
            reported_profile.handle AS reportedUserHandle,
            report.reason_code AS reasonCode, report.detail, report.status,
            report.reviewer_user_id AS reviewerUserId, reviewer.name AS reviewerAccountName,
            report.resolution_reason_code AS resolutionReasonCode,
            report.resolved_at AS resolvedAt, report.version,
            report.created_at AS createdAt, report.updated_at AS updatedAt
     FROM community_content_report AS report
     JOIN "user" AS reporter ON reporter.id = report.reporter_user_id
     JOIN community_profile AS reporter_profile ON reporter_profile.user_id = report.reporter_user_id
     LEFT JOIN community_post AS post ON post.id = report.post_id
     LEFT JOIN community_post_revision AS post_revision
       ON post_revision.post_id = report.post_id
      AND post_revision.revision_number = report.target_revision
     LEFT JOIN community_comment AS comment ON comment.id = report.comment_id
     LEFT JOIN community_comment_revision AS comment_revision
       ON comment_revision.comment_id = report.comment_id
      AND comment_revision.revision_number = report.target_revision
     LEFT JOIN "user" AS reported_user ON reported_user.id = report.reported_user_id
     LEFT JOIN community_profile AS reported_profile ON reported_profile.user_id = report.reported_user_id
     LEFT JOIN community_identity AS reported_identity ON reported_identity.user_id = report.reported_user_id
     LEFT JOIN "user" AS reviewer ON reviewer.id = report.reviewer_user_id
     WHERE report.id = ?
     LIMIT 1`,
  )
    .bind(reportId)
    .first<ContentReportRow>();

const getReports = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const limit = parseLimit(url, 50);
  if (!limit) return error(request, 400, "invalid_limit", "limit must be between 1 and 50");
  const status = url.searchParams.get("status") || "pending";
  if (!new Set(["all", "dismissed", "pending", "resolved", "reviewing"]).has(status)) {
    return error(request, 400, "invalid_status", "Invalid report status");
  }
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && (!cursor || typeof cursor.sort !== "number")) {
    return error(request, 400, "invalid_cursor", "cursor is invalid");
  }
  const conditions: string[] = [];
  const values: BindValue[] = [];
  if (status !== "all") {
    conditions.push("report.status = ?");
    values.push(status);
  }
  if (cursor && typeof cursor.sort === "number") {
    conditions.push("(report.created_at < ? OR (report.created_at = ? AND report.id < ?))");
    values.push(cursor.sort, cursor.sort, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(limit);
  const result = await env.DB.prepare(
    `SELECT report.id, report.reporter_user_id AS reporterUserId,
            reporter.name AS reporterAccountName, reporter_profile.display_name AS reporterDisplayName,
            reporter_profile.handle AS reporterHandle,
            report.post_id AS postId, post_revision.title AS postTitle,
            report.comment_id AS commentId, comment.post_id AS commentPostId,
            comment_revision.body AS commentBody,
            report.target_revision AS targetRevision,
            report.reported_user_id AS reportedUserId,
            reported_identity.uid AS reportedUserPublicUid,
            reported_user.name AS reportedUserAccountName,
            reported_profile.display_name AS reportedUserDisplayName,
            reported_profile.handle AS reportedUserHandle,
            report.reason_code AS reasonCode, report.detail, report.status,
            report.reviewer_user_id AS reviewerUserId, reviewer.name AS reviewerAccountName,
            report.resolution_reason_code AS resolutionReasonCode,
            report.resolved_at AS resolvedAt, report.version,
            report.created_at AS createdAt, report.updated_at AS updatedAt
     FROM community_content_report AS report
     JOIN "user" AS reporter ON reporter.id = report.reporter_user_id
     JOIN community_profile AS reporter_profile ON reporter_profile.user_id = report.reporter_user_id
     LEFT JOIN community_post AS post ON post.id = report.post_id
     LEFT JOIN community_post_revision AS post_revision
       ON post_revision.post_id = report.post_id
      AND post_revision.revision_number = report.target_revision
     LEFT JOIN community_comment AS comment ON comment.id = report.comment_id
     LEFT JOIN community_comment_revision AS comment_revision
       ON comment_revision.comment_id = report.comment_id
      AND comment_revision.revision_number = report.target_revision
     LEFT JOIN "user" AS reported_user ON reported_user.id = report.reported_user_id
     LEFT JOIN community_profile AS reported_profile ON reported_profile.user_id = report.reported_user_id
     LEFT JOIN community_identity AS reported_identity ON reported_identity.user_id = report.reported_user_id
     LEFT JOIN "user" AS reviewer ON reviewer.id = report.reviewer_user_id
     ${where}
     ORDER BY report.created_at DESC, report.id DESC
     LIMIT ?`,
  )
    .bind(...values)
    .all<ContentReportRow>();
  const last = result.results.at(-1);
  return json(request, {
    reports: result.results.map(reportValue),
    nextCursor: last && result.results.length === limit ? encodeCursor({ sort: last.createdAt, id: last.id }) : null,
  });
};

const putReportStatus = async (request: Request, env: Env, reportId: string): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const status = body.status;
  const reasonCode = body.resolutionReasonCode;
  const version = expectedVersion(body);
  if (
    (status !== "reviewing" && status !== "resolved" && status !== "dismissed") ||
    version === null ||
    (status === "reviewing" && reasonCode !== undefined && reasonCode !== null) ||
    (status !== "reviewing" && (typeof reasonCode !== "string" || !REASON_PATTERN.test(reasonCode)))
  ) {
    return error(
      request,
      422,
      "invalid_report_status",
      "status, expectedVersion, and a terminal resolutionReasonCode are required",
    );
  }
  const started = await startOperation(request, env, access, "report.status.set", "report", reportId);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);
  const report = await findReportForAdmin(env, reportId);
  if (!report) {
    await failOperation(env, started.operationId, "report_not_found");
    return error(request, 404, "report_not_found", "Report not found");
  }
  if (report.version !== version) {
    await failOperation(env, started.operationId, "version_conflict", { actualVersion: report.version });
    return error(request, 409, "version_conflict", "The report changed; refresh and try again");
  }
  if (report.status === "resolved" || report.status === "dismissed") {
    await failOperation(env, started.operationId, "report_already_resolved");
    return error(request, 409, "report_already_resolved", "The report has already been resolved");
  }
  const now = Date.now();
  const terminal = status === "resolved" || status === "dismissed";
  const updatedResult = await env.DB.prepare(
    `UPDATE community_content_report
     SET status = ?, reviewer_user_id = ?, resolution_reason_code = ?, resolved_at = ?,
         updated_at = ?, version = version + 1
     WHERE id = ? AND version = ? AND status IN ('pending', 'reviewing')`,
  )
    .bind(status, access.userId, terminal ? reasonCode : null, terminal ? now : null, now, reportId, version)
    .run();
  if (Number(updatedResult.meta.changes || 0) !== 1) {
    await failOperation(env, started.operationId, "report_status_conflict");
    return error(request, 409, "report_status_conflict", "The report status could not be updated safely");
  }
  const updated = await findReportForAdmin(env, reportId);
  if (!updated) throw new Error("Updated report disappeared");
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { fromStatus: report.status, resolutionReasonCode: terminal ? (reasonCode as string) : null, toStatus: status },
    reportId,
    null,
  );
  return json(request, { operation: operationValue(operation), report: reportValue(updated) });
};

const operationValue = (row: OperationRow): JsonObject => ({
  id: row.id,
  action: row.action,
  targetKind: row.targetKind,
  targetId: row.targetId,
  status: row.status,
  requestId: row.requestId,
  externalRef: row.externalRef,
  errorCode: row.errorCode,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt,
});

const getOperations = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const limit = parseLimit(url, 50);
  if (!limit) return error(request, 400, "invalid_limit", "limit must be between 1 and 50");
  const status = url.searchParams.get("status");
  if (status && status !== "failed" && status !== "pending" && status !== "running" && status !== "succeeded") {
    return error(request, 400, "invalid_status", "status must be pending, running, succeeded, or failed");
  }
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && (!cursor || typeof cursor.sort !== "number")) {
    return error(request, 400, "invalid_cursor", "cursor is invalid");
  }
  const conditions: string[] = [];
  const values: BindValue[] = [];
  if (status) {
    conditions.push("operation.status = ?");
    values.push(status);
  }
  if (cursor && typeof cursor.sort === "number") {
    conditions.push("(operation.created_at < ? OR (operation.created_at = ? AND operation.id < ?))");
    values.push(cursor.sort, cursor.sort, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(limit);
  const result = await env.DB.prepare(
    `SELECT operation.id, operation.actor_user_id AS actorUserId, actor.name AS actorName,
            operation.action, operation.target_kind AS targetKind, operation.target_id AS targetId,
            operation.status, operation.idempotency_key AS idempotencyKey, operation.request_id AS requestId,
            operation.external_ref AS externalRef, operation.error_code AS errorCode,
            operation.created_at AS createdAt, operation.updated_at AS updatedAt,
            operation.completed_at AS completedAt
     FROM admin_operation AS operation
     JOIN "user" AS actor ON actor.id = operation.actor_user_id
     ${where}
     ORDER BY operation.created_at DESC, operation.id DESC
     LIMIT ?`,
  )
    .bind(...values)
    .all<OperationListRow>();
  const operations = result.results.map((row) => ({ ...operationValue(row), actorName: row.actorName }));
  const last = result.results.at(-1);
  return json(request, {
    operations,
    nextCursor: last && result.results.length === limit ? encodeCursor({ sort: last.createdAt, id: last.id }) : null,
  });
};

const findOperation = async (env: Env, actorUserId: string, idempotencyKey: string): Promise<OperationRow | null> =>
  env.DB.prepare(
    `SELECT id, actor_user_id AS actorUserId, action, target_kind AS targetKind, target_id AS targetId,
            status, idempotency_key AS idempotencyKey, request_id AS requestId,
            external_ref AS externalRef, error_code AS errorCode,
            created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
     FROM admin_operation
     WHERE actor_user_id = ? AND idempotency_key = ?
     LIMIT 1`,
  )
    .bind(actorUserId, idempotencyKey)
    .first<OperationRow>();

const startOperation = async (
  request: Request,
  env: Env,
  access: StaffAccess,
  action: string,
  targetKind: string,
  targetId: string,
  flexibleExistingTarget = false,
): Promise<OperationStart> => {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || "";
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    return {
      kind: "response",
      response: error(request, 422, "invalid_idempotency_key", "Idempotency-Key must contain 16-128 safe characters"),
    };
  }
  const existing = await findOperation(env, access.userId, idempotencyKey);
  if (existing) {
    if (
      existing.action !== action ||
      existing.targetKind !== targetKind ||
      (!flexibleExistingTarget && existing.targetId !== targetId)
    ) {
      return {
        kind: "response",
        response: error(request, 409, "idempotency_conflict", "This Idempotency-Key was used for another operation"),
      };
    }
    return { kind: "existing", operation: existing };
  }
  const now = Date.now();
  const operationId = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO admin_operation
       (id, actor_user_id, action, target_kind, target_id, status, idempotency_key,
        request_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  )
    .bind(operationId, access.userId, action, targetKind, targetId, idempotencyKey, requestId(request), now, now)
    .run();
  if (Number(inserted.meta.changes || 0) === 0) {
    const raced = await findOperation(env, access.userId, idempotencyKey);
    if (!raced) throw new Error("Admin operation reservation was lost");
    if (
      raced.action !== action ||
      raced.targetKind !== targetKind ||
      (!flexibleExistingTarget && raced.targetId !== targetId)
    ) {
      return {
        kind: "response",
        response: error(request, 409, "idempotency_conflict", "This Idempotency-Key was used for another operation"),
      };
    }
    return { kind: "existing", operation: raced };
  }
  await env.DB.prepare(
    `INSERT INTO admin_operation_event (id, operation_id, from_status, to_status, detail_json, created_at)
     VALUES (?, ?, NULL, 'pending', ?, ?)`,
  )
    .bind(crypto.randomUUID(), operationId, JSON.stringify({ action, targetKind, targetId }), now)
    .run();
  return { kind: "new", operationId };
};

const existingOperationResponse = (request: Request, operation: OperationRow): Response =>
  operation.status === "succeeded"
    ? json(request, { operation: operationValue(operation), replayed: true })
    : error(
        request,
        409,
        operation.status === "pending" || operation.status === "running" ? "operation_in_progress" : "operation_failed",
        operation.status === "pending" || operation.status === "running"
          ? "An operation with this Idempotency-Key is still in progress"
          : "The previous operation failed; retry with a new Idempotency-Key",
      );

const transitionOperation = async (
  env: Env,
  operationId: string,
  status: TerminalOperationStatus,
  detail: JsonObject,
  externalRef: string | null,
  errorCode: string | null,
): Promise<OperationRow> => {
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE admin_operation
       SET status = ?, external_ref = ?, error_code = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).bind(status, externalRef, errorCode, now, now, operationId),
    env.DB.prepare(
      `INSERT INTO admin_operation_event (id, operation_id, from_status, to_status, detail_json, created_at)
       SELECT ?, ?, 'pending', ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM admin_operation WHERE id = ? AND status = ?)`,
    ).bind(crypto.randomUUID(), operationId, status, JSON.stringify(detail), now, operationId, status),
  ]);
  if (Number(results[0]?.meta.changes || 0) !== 1) throw new Error(`Admin operation ${operationId} was not pending`);
  const operation = await env.DB.prepare(
    `SELECT id, actor_user_id AS actorUserId, action, target_kind AS targetKind, target_id AS targetId,
            status, idempotency_key AS idempotencyKey, request_id AS requestId,
            external_ref AS externalRef, error_code AS errorCode,
            created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
     FROM admin_operation WHERE id = ? LIMIT 1`,
  )
    .bind(operationId)
    .first<OperationRow>();
  if (!operation) throw new Error(`Admin operation ${operationId} disappeared`);
  return operation;
};

const failOperation = async (env: Env, operationId: string, code: string, detail: JsonObject = {}): Promise<void> => {
  try {
    await transitionOperation(env, operationId, "failed", detail, null, code);
  } catch (failure) {
    console.error(
      JSON.stringify({
        event: "admin.operation.audit_failure",
        operationId,
        error: failure instanceof Error ? failure.name : "UnknownError",
      }),
    );
  }
};

const userStateValue = (row: UserStateRow): JsonObject => ({
  id: row.id,
  email: row.email,
  emailVerified: row.emailVerified === 1,
  role: row.role,
  status: row.status,
  version: row.version,
});

const findUserState = async (env: Env, userId: string): Promise<UserStateRow | null> =>
  env.DB.prepare(
    `SELECT account.id, account.email, account.emailVerified AS emailVerified,
            profile.role, profile.status, profile.version
     FROM "user" AS account
     JOIN community_profile AS profile ON profile.user_id = account.id
     WHERE account.id = ?
     LIMIT 1`,
  )
    .bind(userId)
    .first<UserStateRow>();

const putUserRole = async (request: Request, env: Env, userId: string): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  if (userId === access.userId)
    return error(request, 409, "self_modification_forbidden", "You cannot change your own role");
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const role = body.role;
  const reasonCode = body.reasonCode;
  const version = expectedVersion(body);
  if (!isRole(role) || typeof reasonCode !== "string" || !REASON_PATTERN.test(reasonCode) || version === null) {
    return error(request, 422, "invalid_role_change", "role, reasonCode, and expectedVersion are required");
  }
  const started = await startOperation(request, env, access, "user.role.set", "user", userId);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);
  const target = await findUserState(env, userId);
  if (!target) {
    await failOperation(env, started.operationId, "user_not_found");
    return error(request, 404, "user_not_found", "User not found");
  }
  if (target.version !== version) {
    await failOperation(env, started.operationId, "version_conflict", { actualVersion: target.version });
    return error(request, 409, "version_conflict", "The user profile changed; refresh and try again");
  }
  if ((role === "admin" || role === "moderator") && target.emailVerified !== 1) {
    await failOperation(env, started.operationId, "verified_email_required");
    return error(request, 409, "verified_email_required", "Staff roles require a verified email");
  }
  if (target.role === role) {
    const operation = await transitionOperation(
      env,
      started.operationId,
      "succeeded",
      { changed: false, role, reasonCode },
      userId,
      null,
    );
    return json(request, { operation: operationValue(operation), user: userStateValue(target) });
  }
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE community_profile
       SET role = ?, version = version + 1, updated_at = ?
       WHERE user_id = ? AND version = ?
         AND (
           role <> 'admin'
           OR ? = 'admin'
           OR EXISTS (
             SELECT 1
             FROM community_profile AS other
             JOIN "user" AS other_account ON other_account.id = other.user_id
             WHERE other.user_id <> community_profile.user_id
               AND other.role = 'admin'
               AND other.status = 'active'
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
    ).bind(role, now, userId, version, role, now),
    env.DB.prepare(
      `INSERT INTO community_role_event
         (id, user_id, from_role, to_role, actor_user_id, reason_code, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM community_profile WHERE user_id = ? AND role = ? AND version = ?
       )`,
    ).bind(crypto.randomUUID(), userId, target.role, role, access.userId, reasonCode, now, userId, role, version + 1),
  ]);
  if (Number(results[0]?.meta.changes || 0) !== 1 || Number(results[1]?.meta.changes || 0) !== 1) {
    await failOperation(env, started.operationId, "role_change_conflict");
    return error(request, 409, "role_change_conflict", "The role could not be changed safely");
  }
  const updated = await findUserState(env, userId);
  if (!updated) throw new Error("Updated user disappeared");
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { fromRole: target.role, reasonCode, toRole: role },
    userId,
    null,
  );
  return json(request, { operation: operationValue(operation), user: userStateValue(updated) });
};

const restrictionValue = (row: RestrictionRow): JsonObject => ({
  id: row.id,
  userId: row.userId,
  kind: row.kind,
  reasonCode: row.reasonCode,
  actorUserId: row.actorUserId,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
  revokedByUserId: row.revokedByUserId,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const findRestriction = async (env: Env, restrictionId: string): Promise<RestrictionRow | null> =>
  env.DB.prepare(
    `SELECT id, user_id AS userId, kind, reason_code AS reasonCode, actor_user_id AS actorUserId,
            expires_at AS expiresAt, revoked_at AS revokedAt, revoked_by_user_id AS revokedByUserId,
            version, created_at AS createdAt, updated_at AS updatedAt
     FROM community_user_restriction WHERE id = ? LIMIT 1`,
  )
    .bind(restrictionId)
    .first<RestrictionRow>();

const createRestriction = async (request: Request, env: Env, userId: string): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  if (userId === access.userId)
    return error(request, 409, "self_modification_forbidden", "You cannot restrict yourself");
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const kind = body.kind;
  const reasonCode = body.reasonCode;
  const version = expectedVersion(body);
  const expiresAtValue = body.expiresAt;
  const expiresAt = expiresAtValue === null || expiresAtValue === undefined ? null : expiresAtValue;
  const now = Date.now();
  if (
    !isRestrictionKind(kind) ||
    typeof reasonCode !== "string" ||
    !REASON_PATTERN.test(reasonCode) ||
    version === null ||
    (expiresAt !== null &&
      (typeof expiresAt !== "number" ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now ||
        expiresAt > now + 366 * 24 * 60 * 60 * 1_000))
  ) {
    return error(request, 422, "invalid_restriction", "kind, reasonCode, expectedVersion, and expiresAt are invalid");
  }
  const proposedRestrictionId = crypto.randomUUID();
  const started = await startOperation(
    request,
    env,
    access,
    "user.restriction.create",
    "restriction",
    proposedRestrictionId,
    true,
  );
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);

  const target = await findUserState(env, userId);
  if (!target) {
    await failOperation(env, started.operationId, "user_not_found");
    return error(request, 404, "user_not_found", "User not found");
  }
  if (target.version !== version) {
    await failOperation(env, started.operationId, "version_conflict", { actualVersion: target.version });
    return error(request, 409, "version_conflict", "The user profile changed; refresh and try again");
  }
  const existing = await env.DB.prepare(
    `SELECT id, expires_at AS expiresAt
     FROM community_user_restriction
     WHERE user_id = ? AND kind = ? AND revoked_at IS NULL
     LIMIT 1`,
  )
    .bind(userId, kind)
    .first<{ expiresAt: number | null; id: string }>();
  if (existing) {
    if (existing.expiresAt === null || existing.expiresAt > now) {
      await failOperation(env, started.operationId, "restriction_already_active", { restrictionId: existing.id });
      return error(request, 409, "restriction_already_active", "This restriction is already active");
    }
    const expired = await env.DB.batch([
      env.DB.prepare(
        `UPDATE community_user_restriction
         SET revoked_at = ?, revoked_by_user_id = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND revoked_at IS NULL AND expires_at <= ?`,
      ).bind(now, access.userId, now, existing.id, now),
      env.DB.prepare(
        `INSERT INTO community_user_restriction_event
           (id, restriction_id, event_kind, actor_user_id, reason_code,
            previous_expires_at, next_expires_at, created_at)
         SELECT ?, id, 'expired', ?, 'automatic_expiry', expires_at, NULL, ?
         FROM community_user_restriction
         WHERE id = ? AND revoked_at = ? AND revoked_by_user_id = ?`,
      ).bind(crypto.randomUUID(), access.userId, now, existing.id, now, access.userId),
    ]);
    if (Number(expired[0]?.meta.changes || 0) !== 1 || Number(expired[1]?.meta.changes || 0) !== 1) {
      await failOperation(env, started.operationId, "restriction_expiry_conflict", { restrictionId: existing.id });
      return error(request, 409, "restriction_expiry_conflict", "The previous restriction changed; try again");
    }
  }

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE community_profile
       SET version = version + 1, updated_at = ?
       WHERE user_id = ? AND version = ?
         AND (
           ? <> 'sign_in'
           OR role <> 'admin'
           OR EXISTS (
             SELECT 1
             FROM community_profile AS other
             JOIN "user" AS other_account ON other_account.id = other.user_id
             WHERE other.user_id <> community_profile.user_id
               AND other.role = 'admin'
               AND other.status = 'active'
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
    ).bind(now, userId, version, kind, now),
    env.DB.prepare(
      `INSERT INTO community_user_restriction
         (id, user_id, kind, reason_code, actor_user_id, expires_at,
          created_at, updated_at, version)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1
       WHERE EXISTS (
         SELECT 1 FROM community_profile WHERE user_id = ? AND version = ?
       )`,
    ).bind(proposedRestrictionId, userId, kind, reasonCode, access.userId, expiresAt, now, now, userId, version + 1),
    env.DB.prepare(
      `INSERT INTO community_user_restriction_event
         (id, restriction_id, event_kind, actor_user_id, reason_code,
          previous_expires_at, next_expires_at, created_at)
       SELECT ?, id, 'issued', ?, ?, NULL, expires_at, ?
       FROM community_user_restriction
       WHERE id = ? AND user_id = ? AND version = 1 AND revoked_at IS NULL`,
    ).bind(crypto.randomUUID(), access.userId, reasonCode, now, proposedRestrictionId, userId),
  ]);
  if (
    Number(results[0]?.meta.changes || 0) !== 1 ||
    Number(results[1]?.meta.changes || 0) !== 1 ||
    Number(results[2]?.meta.changes || 0) !== 1
  ) {
    await failOperation(env, started.operationId, "restriction_conflict");
    return error(request, 409, "restriction_conflict", "The restriction could not be created safely");
  }
  if (kind === "sign_in") {
    await env.DB.prepare(
      `DELETE FROM "session"
       WHERE userId = ?
         AND EXISTS (
           SELECT 1 FROM community_profile
           WHERE community_profile.user_id = "session".userId
             AND community_profile.status <> 'deleted'
         )`,
    )
      .bind(userId)
      .run();
  }
  const restriction = await findRestriction(env, proposedRestrictionId);
  if (!restriction) throw new Error("Created restriction disappeared");
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { kind, reasonCode, userId },
    restriction.id,
    null,
  );
  return json(request, { operation: operationValue(operation), restriction: restrictionValue(restriction) }, 201);
};

const revokeRestriction = async (
  request: Request,
  env: Env,
  userId: string,
  restrictionId: string,
): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  if (userId === access.userId) return error(request, 409, "self_modification_forbidden", "You cannot modify yourself");
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const version = expectedVersion(body);
  const reasonCode = body.reasonCode;
  if (version === null || typeof reasonCode !== "string" || !REASON_PATTERN.test(reasonCode)) {
    return error(request, 422, "invalid_revocation", "reasonCode and expectedVersion are required");
  }
  const started = await startOperation(request, env, access, "user.restriction.revoke", "restriction", restrictionId);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);
  const restriction = await findRestriction(env, restrictionId);
  if (!restriction || restriction.userId !== userId) {
    await failOperation(env, started.operationId, "restriction_not_found");
    return error(request, 404, "restriction_not_found", "Restriction not found");
  }
  if (restriction.revokedAt !== null) {
    await failOperation(env, started.operationId, "restriction_already_revoked");
    return error(request, 409, "restriction_already_revoked", "Restriction is already revoked");
  }
  if (restriction.version !== version) {
    await failOperation(env, started.operationId, "version_conflict", { actualVersion: restriction.version });
    return error(request, 409, "version_conflict", "The restriction changed; refresh and try again");
  }
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE community_user_restriction
       SET revoked_at = ?, revoked_by_user_id = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND user_id = ? AND version = ? AND revoked_at IS NULL`,
    ).bind(now, access.userId, now, restrictionId, userId, version),
    env.DB.prepare(
      `UPDATE community_profile
       SET version = version + 1, updated_at = ?
       WHERE user_id = ?
         AND EXISTS (
           SELECT 1 FROM community_user_restriction
           WHERE id = ? AND version = ? AND revoked_at = ?
         )`,
    ).bind(now, userId, restrictionId, version + 1, now),
    env.DB.prepare(
      `INSERT INTO community_user_restriction_event
         (id, restriction_id, event_kind, actor_user_id, reason_code,
          previous_expires_at, next_expires_at, created_at)
       SELECT ?, id, 'revoked', ?, ?, expires_at, NULL, ?
       FROM community_user_restriction
       WHERE id = ? AND user_id = ? AND version = ? AND revoked_at = ?`,
    ).bind(crypto.randomUUID(), access.userId, reasonCode, now, restrictionId, userId, version + 1, now),
  ]);
  if (
    Number(results[0]?.meta.changes || 0) !== 1 ||
    Number(results[1]?.meta.changes || 0) !== 1 ||
    Number(results[2]?.meta.changes || 0) !== 1
  ) {
    await failOperation(env, started.operationId, "restriction_revocation_conflict");
    return error(request, 409, "restriction_revocation_conflict", "The restriction could not be revoked safely");
  }
  const updated = await findRestriction(env, restrictionId);
  if (!updated) throw new Error("Revoked restriction disappeared");
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { kind: restriction.kind, reasonCode, userId },
    restrictionId,
    null,
  );
  return json(request, { operation: operationValue(operation), restriction: restrictionValue(updated) });
};

const revokeUserSessions = async (request: Request, env: Env, userId: string): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  if (userId === access.userId)
    return error(request, 409, "self_modification_forbidden", "You cannot revoke your own session here");
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const version = expectedVersion(body);
  const reasonCode = body.reasonCode;
  if (version === null || typeof reasonCode !== "string" || !REASON_PATTERN.test(reasonCode)) {
    return error(request, 422, "invalid_session_revocation", "reasonCode and expectedVersion are required");
  }
  const started = await startOperation(request, env, access, "user.sessions.revoke", "user", userId);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);
  const target = await findUserState(env, userId);
  if (!target) {
    await failOperation(env, started.operationId, "user_not_found");
    return error(request, 404, "user_not_found", "User not found");
  }
  if (target.version !== version) {
    await failOperation(env, started.operationId, "version_conflict", { actualVersion: target.version });
    return error(request, 409, "version_conflict", "The user profile changed; refresh and try again");
  }
  const result = await env.DB.prepare(
    `DELETE FROM "session"
     WHERE userId = ?
       AND EXISTS (
         SELECT 1 FROM community_profile
         WHERE community_profile.user_id = "session".userId
           AND community_profile.status <> 'deleted'
       )`,
  )
    .bind(userId)
    .run();
  const revokedSessions = Number(result.meta.changes || 0);
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { reasonCode, revokedSessions, userId },
    userId,
    null,
  );
  return json(request, { operation: operationValue(operation), revokedSessions });
};

const resourceServerValue = (row: ResourceServerRow): JsonObject => ({
  id: row.slug,
  slug: row.slug,
  displayName: row.displayName,
  region: row.region,
  status: row.status,
  resourcePrefix: row.resourcePrefix,
  version: row.version,
  builtIn: row.slug === "jp-cbt",
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const findResourceServer = async (env: Env, slug: string): Promise<ResourceServerRow | null> =>
  env.DB.prepare(
    `SELECT slug, display_name AS displayName, region, status, resource_prefix AS resourcePrefix,
            version, created_at AS createdAt, updated_at AS updatedAt
     FROM resource_server
     WHERE slug = ?
     LIMIT 1`,
  )
    .bind(slug)
    .first<ResourceServerRow>();

const findActiveResourceServer = async (env: Env, slug: string): Promise<ResourceServerRow | null> =>
  env.DB.prepare(
    `SELECT slug, display_name AS displayName, region, status, resource_prefix AS resourcePrefix,
            version, created_at AS createdAt, updated_at AS updatedAt
     FROM resource_server
     WHERE slug = ? AND status = 'active'
     LIMIT 1`,
  )
    .bind(slug)
    .first<ResourceServerRow>();

const getResourceServers = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const result = await env.DB.prepare(
    `SELECT slug, display_name AS displayName, region, status, resource_prefix AS resourcePrefix,
            version, created_at AS createdAt, updated_at AS updatedAt
     FROM resource_server
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
              region, display_name, slug`,
  ).all<ResourceServerRow>();
  return json(request, { resourceServers: result.results.map(resourceServerValue) });
};

const readCurrentResourcePointer = async (
  env: Env,
  server: ResourceServerRow,
): Promise<{ kind: "invalid" } | { kind: "missing" } | { kind: "valid"; releaseId: string; sourceId: string }> => {
  const key = `${server.resourcePrefix}/current.json`;
  const object = await env.ASSET_BUCKET.get(key);
  if (!object?.body) return { kind: "missing" };
  if (object.size > JSON_BODY_LIMIT) {
    await object.body.cancel();
    return { kind: "invalid" };
  }
  try {
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength > JSON_BODY_LIMIT) return { kind: "invalid" };
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!isJsonValue(parsed) || !isJsonObject(parsed)) return { kind: "invalid" };
    const releaseId = parsed.releaseId;
    const sourceId = parsed.sourceId;
    if (
      parsed.schema !== "haneoka-resource-pointer-v1" ||
      parsed.server !== server.slug ||
      typeof releaseId !== "string" ||
      !RELEASE_ID_PATTERN.test(releaseId) ||
      typeof sourceId !== "string" ||
      !SOURCE_ID_PATTERN.test(sourceId) ||
      parsed.releaseManifest !== `${server.resourcePrefix}/releases/${releaseId}/release.json`
    ) {
      return { kind: "invalid" };
    }
    return { kind: "valid", releaseId, sourceId };
  } catch {
    return { kind: "invalid" };
  }
};

const getResourceSources = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const serverSlug = url.searchParams.get("server");
  if (!serverSlug || normalizeResourceServerSlug(serverSlug) !== serverSlug) {
    return error(request, 422, "invalid_resource_server", "A valid server query parameter is required");
  }
  const server = await findActiveResourceServer(env, serverSlug);
  if (!server) return error(request, 404, "resource_server_not_found", "Active resource server not found");

  const pointer = await readCurrentResourcePointer(env, server);
  if (pointer.kind === "invalid") {
    return error(request, 502, "invalid_resource_pointer", "The current resource pointer is invalid");
  }

  const sourcePrefix = `${server.resourcePrefix}/sources/`;
  const sourceObjects = new Map<string, number>();
  let cursor: string | undefined;
  let listTruncated = false;
  for (let page = 0; page < RESOURCE_SOURCE_LIST_MAX_PAGES; page += 1) {
    const listed = await env.ASSET_BUCKET.list({
      ...(cursor ? { cursor } : {}),
      limit: RESOURCE_SOURCE_LIST_PAGE_LIMIT,
      prefix: sourcePrefix,
    });
    for (const object of listed.objects) {
      const relativeKey = object.key.slice(sourcePrefix.length);
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/source\.json$/u.exec(relativeKey);
      if (match?.[1]) sourceObjects.set(match[1], object.uploaded.getTime());
    }
    if (!listed.truncated) {
      listTruncated = false;
      break;
    }
    listTruncated = true;
    cursor = listed.cursor;
  }

  const currentSourceId = pointer.kind === "valid" ? pointer.sourceId : null;
  const currentReleaseId = pointer.kind === "valid" ? pointer.releaseId : null;
  if (currentSourceId && !sourceObjects.has(currentSourceId)) {
    const currentManifest = await env.ASSET_BUCKET.head(`${sourcePrefix}${currentSourceId}/source.json`);
    if (!currentManifest) {
      return error(request, 502, "current_resource_source_missing", "The current resource source is missing");
    }
    sourceObjects.set(currentSourceId, currentManifest.uploaded.getTime());
  }

  const sources = [...sourceObjects.entries()]
    .map(([id, uploadedAt]) => ({ current: id === currentSourceId, id, uploadedAt }))
    .sort((left, right) => Number(right.current) - Number(left.current) || right.uploadedAt - left.uploadedAt);
  return json(request, {
    currentReleaseId,
    currentSourceId,
    resourceSources: sources.slice(0, RESOURCE_SOURCE_OPTION_LIMIT),
    truncated: listTruncated || sources.length > RESOURCE_SOURCE_OPTION_LIMIT,
  });
};

const createResourceServer = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const slugInput = body.slug ?? body.id;
  const slug = normalizeResourceServerSlug(slugInput);
  const displayName = normalizeResourceServerName(body.displayName);
  const resourcePrefix = slug ? `servers/${slug}` : null;
  const requestedResourcePrefix =
    body.resourcePrefix === undefined ? resourcePrefix : normalizeResourcePrefix(body.resourcePrefix);
  const reasonCode = body.reasonCode;
  const createVersion = body.expectedVersion === undefined ? 0 : expectedVersion(body);
  if (
    !slug ||
    (body.slug !== undefined && body.id !== undefined && body.slug !== body.id) ||
    !displayName ||
    !isResourceServerRegion(body.region) ||
    !resourcePrefix ||
    requestedResourcePrefix !== resourcePrefix ||
    (body.status !== undefined && body.status !== "draft") ||
    createVersion !== 0 ||
    typeof reasonCode !== "string" ||
    !REASON_PATTERN.test(reasonCode)
  ) {
    return error(request, 422, "invalid_resource_server", "The resource server definition is invalid");
  }

  const started = await startOperation(request, env, access, "resource.server.create", "resource_server", slug);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);
  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO resource_server
       (slug, display_name, region, status, resource_prefix, version,
        created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, 'draft', ?, 1, ?, ?, ?, ?)`,
  )
    .bind(slug, displayName, body.region, resourcePrefix, now, now, access.userId, access.userId)
    .run();
  if (Number(inserted.meta.changes || 0) !== 1) {
    await failOperation(env, started.operationId, "resource_server_conflict", { resourcePrefix, slug });
    return error(request, 409, "resource_server_conflict", "The resource server slug or prefix is already in use");
  }
  const created = await findResourceServer(env, slug);
  if (!created) throw new Error("Created resource server disappeared");
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { displayName, reasonCode, region: created.region, resourcePrefix, slug, status: "draft" },
    slug,
    null,
  );
  return json(request, { operation: operationValue(operation), resourceServer: resourceServerValue(created) }, 201, {
    Location: `${ADMIN_PREFIX}/resource-servers/${encodeURIComponent(slug)}`,
  });
};

const putResourceServer = async (request: Request, env: Env, slug: string): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const version = expectedVersion(body);
  const reasonCode = body.reasonCode;
  const hasDisplayName = body.displayName !== undefined;
  const hasRegion = body.region !== undefined;
  const hasResourcePrefix = body.resourcePrefix !== undefined;
  const hasStatus = body.status !== undefined;
  const displayName = hasDisplayName ? normalizeResourceServerName(body.displayName) : undefined;
  const resourcePrefix = hasResourcePrefix ? normalizeResourcePrefix(body.resourcePrefix) : undefined;
  const requestedSlug = body.slug ?? body.id;
  if (
    version === null ||
    typeof reasonCode !== "string" ||
    !REASON_PATTERN.test(reasonCode) ||
    (!hasDisplayName && !hasRegion && !hasResourcePrefix && !hasStatus) ||
    (hasDisplayName && !displayName) ||
    (hasRegion && !isResourceServerRegion(body.region)) ||
    (hasResourcePrefix && !resourcePrefix) ||
    (hasStatus && !isResourceServerStatus(body.status))
  ) {
    return error(request, 422, "invalid_resource_server_update", "The resource server update is invalid");
  }
  if (
    (body.slug !== undefined && body.id !== undefined && body.slug !== body.id) ||
    (requestedSlug !== undefined && normalizeResourceServerSlug(requestedSlug) !== slug)
  ) {
    return error(request, 422, "resource_server_slug_immutable", "Resource server slugs cannot be renamed");
  }
  if (hasResourcePrefix && resourcePrefix !== `servers/${slug}`) {
    return error(request, 422, "resource_server_prefix_immutable", "Resource prefixes are fixed to servers/<slug>");
  }

  const started = await startOperation(request, env, access, "resource.server.update", "resource_server", slug);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);
  const current = await findResourceServer(env, slug);
  if (!current) {
    await failOperation(env, started.operationId, "resource_server_not_found", { slug });
    return error(request, 404, "resource_server_not_found", "Resource server not found");
  }
  if (current.version !== version) {
    await failOperation(env, started.operationId, "version_conflict", { actualVersion: current.version });
    return error(request, 409, "version_conflict", "The resource server changed; refresh and try again");
  }

  const nextDisplayName = displayName ?? current.displayName;
  const nextRegion = hasRegion ? (body.region as ResourceServerRegion) : current.region;
  const nextResourcePrefix = current.resourcePrefix;
  const nextStatus = hasStatus ? (body.status as ResourceServerStatus) : current.status;
  const changes: JsonObject = {};
  if (nextDisplayName !== current.displayName) changes.displayName = { from: current.displayName, to: nextDisplayName };
  if (nextRegion !== current.region) changes.region = { from: current.region, to: nextRegion };
  if (nextStatus !== current.status) changes.status = { from: current.status, to: nextStatus };
  if (Object.keys(changes).length === 0) {
    await failOperation(env, started.operationId, "no_changes", { slug });
    return error(request, 409, "no_changes", "The resource server already has these values");
  }

  const now = Date.now();
  const updatedResult = await env.DB.prepare(
    `UPDATE OR IGNORE resource_server
     SET display_name = ?, region = ?, resource_prefix = ?, status = ?,
         version = version + 1, updated_at = ?, updated_by = ?
     WHERE slug = ? AND version = ?`,
  )
    .bind(nextDisplayName, nextRegion, nextResourcePrefix, nextStatus, now, access.userId, slug, current.version)
    .run();
  if (Number(updatedResult.meta.changes || 0) !== 1) {
    const latest = await findResourceServer(env, slug);
    const code = !latest || latest.version !== current.version ? "version_conflict" : "resource_prefix_conflict";
    await failOperation(env, started.operationId, code, { actualVersion: latest?.version ?? null, slug });
    return code === "version_conflict"
      ? error(request, 409, code, "The resource server changed; refresh and try again")
      : error(request, 409, code, "The resource prefix is already in use");
  }
  const updated = await findResourceServer(env, slug);
  if (!updated) throw new Error("Updated resource server disappeared");
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { changes, reasonCode, slug },
    slug,
    null,
  );
  return json(request, { operation: operationValue(operation), resourceServer: resourceServerValue(updated) });
};

const packageMaxBytes = (env: Env): number => {
  const configured = env.ADMIN_PACKAGE_MAX_BYTES;
  if (!configured || !/^\d{1,13}$/u.test(configured)) return DEFAULT_PACKAGE_MAX_BYTES;
  const value = Number(configured);
  return Number.isSafeInteger(value) && value >= PACKAGE_MIN_PART_BYTES && value <= DEFAULT_PACKAGE_MAX_BYTES
    ? value
    : DEFAULT_PACKAGE_MAX_BYTES;
};

const normalizePackageFileName = (value: JsonValue | undefined): string | null => {
  if (typeof value !== "string") return null;
  const fileName = value.normalize("NFC").trim();
  if (
    fileName.length < 1 ||
    fileName.length > 160 ||
    fileName === "." ||
    fileName === ".." ||
    /[\u0000-\u001f\u007f/\\]/u.test(fileName)
  ) {
    return null;
  }
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase() : "";
  return PACKAGE_EXTENSIONS.has(extension) ? fileName : null;
};

const parseExpectedVersionHeader = (request: Request, url: URL): number | null => {
  const queryValue = url.searchParams.get("expectedVersion");
  const headerValue = request.headers.get("X-Expected-Version");
  if (queryValue !== null && headerValue !== null && queryValue !== headerValue) return null;
  const raw = queryValue ?? headerValue;
  if (!raw || !/^\d{1,10}$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const hexBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const packageLeaseKey = (server: string, digest: string): string => `${PACKAGE_LEASE_PREFIX}/${server}/${digest}.json`;

const ensurePackageLease = async (env: Env, upload: PackageUploadRow): Promise<void> => {
  const body = JSON.stringify({
    schema: "haneoka-r2-package-lease-v1",
    server: upload.server,
    sha256: upload.expectedSha256,
    uploadId: upload.id,
  });
  await env.ASSET_BUCKET.put(packageLeaseKey(upload.server, upload.expectedSha256), body, {
    httpMetadata: {
      cacheControl: "no-store",
      contentType: "application/json; charset=utf-8",
    },
    customMetadata: {
      server: upload.server,
      sha256: upload.expectedSha256,
      source: "admin-package-upload",
      uploadId: upload.id,
    },
  });
};

const packagePartCount = (declaredSize: number): number => Math.ceil(declaredSize / PACKAGE_PART_BYTES);

const packagePartSize = (upload: PackageUploadRow, partNumber: number): number | null => {
  const count = packagePartCount(upload.declaredSize);
  if (partNumber < 1 || partNumber > count) return null;
  if (partNumber < count) return PACKAGE_PART_BYTES;
  const remainder = upload.declaredSize % PACKAGE_PART_BYTES;
  return remainder || PACKAGE_PART_BYTES;
};

const packageValue = (row: PackageUploadRow, parts: readonly PackagePartRow[] = []): JsonObject => ({
  id: row.id,
  server: row.server,
  fileName: row.fileName,
  mediaType: row.mediaType,
  declaredSize: row.declaredSize,
  expectedSha256: row.expectedSha256,
  verifiedSha256: row.verifiedSha256,
  status: row.status,
  expiresAt: row.expiresAt,
  version: row.version,
  partSize: PACKAGE_PART_BYTES,
  partCount: packagePartCount(row.declaredSize),
  parts: parts.map((part) => ({ partNumber: part.partNumber, byteSize: part.byteSize, etag: part.etag })),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt,
});

const findPackageUpload = async (env: Env, uploadId: string): Promise<PackageUploadRow | null> =>
  env.DB.prepare(
    `SELECT id, owner_user_id AS ownerUserId, server, object_key AS objectKey,
            r2_upload_id AS r2UploadId, file_name AS fileName, media_type AS mediaType,
            declared_size AS declaredSize, expected_sha256 AS expectedSha256,
            verified_sha256 AS verifiedSha256, status, expires_at AS expiresAt,
            version, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
     FROM resource_package_upload
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(uploadId)
    .first<PackageUploadRow>();

const findPackageParts = async (env: Env, uploadId: string): Promise<PackagePartRow[]> => {
  const result = await env.DB.prepare(
    `SELECT part_number AS partNumber, etag, byte_size AS byteSize
     FROM resource_package_part
     WHERE upload_id = ?
     ORDER BY part_number ASC`,
  )
    .bind(uploadId)
    .all<PackagePartRow>();
  return result.results;
};

const getPackageUpload = async (request: Request, env: Env, uploadId: string): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const upload = await findPackageUpload(env, uploadId);
  if (!upload) return error(request, 404, "package_upload_not_found", "Package upload not found");
  const parts = await findPackageParts(env, uploadId);
  return json(request, { packageUpload: packageValue(upload, parts) });
};

const createPackageUpload = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const ingress = env.RESOURCE_PACKAGE_INGRESS;
  if (!ingress) return error(request, 503, "package_ingress_unavailable", "Package ingress storage is unavailable");
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const server = body.server;
  const fileName = normalizePackageFileName(body.fileName);
  const mediaType = body.mediaType;
  const declaredSize = body.size;
  const expectedSha256 = body.sha256;
  const version = expectedVersion(body);
  if (
    typeof server !== "string" ||
    normalizeResourceServerSlug(server) !== server ||
    !fileName ||
    typeof mediaType !== "string" ||
    !PACKAGE_MEDIA_TYPES.has(mediaType.toLowerCase()) ||
    typeof declaredSize !== "number" ||
    !Number.isSafeInteger(declaredSize) ||
    declaredSize < 1 ||
    declaredSize > packageMaxBytes(env) ||
    typeof expectedSha256 !== "string" ||
    !SHA256_PATTERN.test(expectedSha256) ||
    version !== 0
  ) {
    return error(request, 422, "invalid_package_intent", "The package upload intent is invalid");
  }
  const resourceServer = await findActiveResourceServer(env, server);
  if (!resourceServer) {
    return error(request, 409, "resource_server_unavailable", "The resource server is not active");
  }
  const uploadId = crypto.randomUUID();
  const started = await startOperation(request, env, access, "package.upload.create", "package_upload", uploadId, true);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);

  const objectKey = `quarantine/v1/${server}/${uploadId}`;
  let multipart: R2MultipartUpload;
  try {
    multipart = await ingress.createMultipartUpload(objectKey, {
      httpMetadata: { contentType: mediaType.toLowerCase() },
      customMetadata: {
        declaredSize: String(declaredSize),
        expectedSha256,
        ownerUserId: access.userId,
        uploadId,
      },
    });
  } catch (failure) {
    await failOperation(env, started.operationId, "package_ingress_create_failed");
    console.error(
      JSON.stringify({
        event: "admin.package_ingress_create_failed",
        operationId: started.operationId,
        error: failure instanceof Error ? failure.name : "UnknownError",
      }),
    );
    return error(request, 502, "package_ingress_create_failed", "The multipart upload could not be created");
  }

  const now = Date.now();
  try {
    const persisted = await env.DB.prepare(
      `INSERT INTO resource_package_upload
         (id, owner_user_id, server, object_key, r2_upload_id, file_name, media_type,
          declared_size, expected_sha256, status, expires_at, version, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, 1, ?, ?
       FROM resource_server
       WHERE slug = ? AND status = 'active' AND resource_prefix = ?`,
    )
      .bind(
        uploadId,
        access.userId,
        server,
        objectKey,
        multipart.uploadId,
        fileName,
        mediaType.toLowerCase(),
        declaredSize,
        expectedSha256,
        now + PACKAGE_UPLOAD_TTL_MS,
        now,
        now,
        resourceServer.slug,
        resourceServer.resourcePrefix,
      )
      .run();
    if (Number(persisted.meta.changes || 0) !== 1) throw new Error("ResourceServerUnavailable");
  } catch (failure) {
    try {
      await multipart.abort();
    } catch {
      // R2 lifecycle rules are the final cleanup backstop for an unrecorded multipart upload.
    }
    const failureCode =
      failure instanceof Error && failure.message === "ResourceServerUnavailable"
        ? "resource_server_unavailable"
        : "package_intent_persist_failed";
    await failOperation(env, started.operationId, failureCode);
    console.error(
      JSON.stringify({
        event: "admin.package_intent_persist_failed",
        operationId: started.operationId,
        error: failure instanceof Error ? failure.name : "UnknownError",
      }),
    );
    if (failureCode === "resource_server_unavailable") {
      return error(request, 409, failureCode, "The resource server changed or is no longer active");
    }
    return error(request, 503, "package_intent_persist_failed", "The package upload intent could not be saved");
  }
  const upload = await findPackageUpload(env, uploadId);
  if (!upload) throw new Error("Created package upload disappeared");
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { declaredSize, expectedSha256, server },
    uploadId,
    null,
  );
  return json(request, { operation: operationValue(operation), packageUpload: packageValue(upload) }, 201, {
    Location: `${ADMIN_PREFIX}/package-uploads/${uploadId}`,
  });
};

const uploadPackagePart = async (
  request: Request,
  env: Env,
  url: URL,
  uploadId: string,
  partNumber: number,
): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const ingress = env.RESOURCE_PACKAGE_INGRESS;
  if (!ingress) return error(request, 503, "package_ingress_unavailable", "Package ingress storage is unavailable");
  const version = parseExpectedVersionHeader(request, url);
  if (version === null) {
    request.body?.cancel().catch(() => undefined);
    return error(
      request,
      422,
      "invalid_expected_version",
      "expectedVersion is required in the query or X-Expected-Version",
    );
  }
  if (!request.body || request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !== "application/octet-stream") {
    request.body?.cancel().catch(() => undefined);
    return error(request, 415, "invalid_part_media_type", "Package parts must use application/octet-stream");
  }
  const started = await startOperation(
    request,
    env,
    access,
    "package.upload.part",
    "package_part",
    `${uploadId}:${partNumber}`,
  );
  if (started.kind === "response") {
    request.body.cancel().catch(() => undefined);
    return started.response;
  }
  if (started.kind === "existing") {
    request.body.cancel().catch(() => undefined);
    return existingOperationResponse(request, started.operation);
  }
  const upload = await findPackageUpload(env, uploadId);
  if (!upload || upload.ownerUserId !== access.userId) {
    request.body.cancel().catch(() => undefined);
    await failOperation(env, started.operationId, "package_upload_not_found");
    return error(request, 404, "package_upload_not_found", "Package upload not found");
  }
  if (upload.version !== version) {
    request.body.cancel().catch(() => undefined);
    await failOperation(env, started.operationId, "version_conflict", { actualVersion: upload.version });
    return error(request, 409, "version_conflict", "The package upload changed; refresh and try again");
  }
  const now = Date.now();
  if (upload.expiresAt <= now) {
    request.body.cancel().catch(() => undefined);
    await env.DB.prepare(
      `UPDATE resource_package_upload
       SET status = 'expired', version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND status IN ('reserved', 'uploading')`,
    )
      .bind(now, uploadId, version)
      .run();
    await failOperation(env, started.operationId, "package_upload_expired");
    return error(request, 410, "package_upload_expired", "The package upload has expired");
  }
  if (upload.status !== "reserved" && upload.status !== "uploading") {
    request.body.cancel().catch(() => undefined);
    await failOperation(env, started.operationId, "package_upload_not_writable", { status: upload.status });
    return error(request, 409, "package_upload_not_writable", "This package upload no longer accepts parts");
  }
  const expectedSize = packagePartSize(upload, partNumber);
  const declaredPartSize = Number(request.headers.get("Content-Length") || "");
  if (!expectedSize || !Number.isSafeInteger(declaredPartSize) || declaredPartSize !== expectedSize) {
    request.body.cancel().catch(() => undefined);
    await failOperation(env, started.operationId, "invalid_part_size", { expectedSize: expectedSize || 0 });
    return error(request, 422, "invalid_part_size", "The package part size does not match the upload plan");
  }
  let uploadedPart: R2UploadedPart;
  try {
    uploadedPart = await ingress
      .resumeMultipartUpload(upload.objectKey, upload.r2UploadId)
      .uploadPart(partNumber, request.body);
  } catch (failure) {
    await failOperation(env, started.operationId, "package_part_upload_failed", { partNumber });
    console.error(
      JSON.stringify({
        event: "admin.package_part_upload_failed",
        operationId: started.operationId,
        partNumber,
        error: failure instanceof Error ? failure.name : "UnknownError",
      }),
    );
    return error(request, 502, "package_part_upload_failed", "The package part could not be stored");
  }
  const stateUpdate = await env.DB.prepare(
    `UPDATE resource_package_upload
     SET status = 'uploading', updated_at = ?
     WHERE id = ? AND version = ? AND status IN ('reserved', 'uploading')`,
  )
    .bind(now, uploadId, version)
    .run();
  if (Number(stateUpdate.meta.changes || 0) !== 1) {
    await failOperation(env, started.operationId, "package_part_state_conflict", { partNumber });
    return error(request, 409, "package_part_state_conflict", "The package upload changed while storing this part");
  }
  await env.DB.prepare(
    `INSERT INTO resource_package_part (upload_id, part_number, etag, byte_size, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(upload_id, part_number) DO UPDATE SET
       etag = excluded.etag,
       byte_size = excluded.byte_size,
       created_at = excluded.created_at`,
  )
    .bind(uploadId, partNumber, uploadedPart.etag, declaredPartSize, now)
    .run();
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { byteSize: declaredPartSize, partNumber, uploadId },
    uploadedPart.etag,
    null,
  );
  return json(request, {
    operation: operationValue(operation),
    part: { byteSize: declaredPartSize, etag: uploadedPart.etag, partNumber },
  });
};

const rejectPackageUpload = async (
  env: Env,
  upload: PackageUploadRow,
  reason: string,
): Promise<PackageUploadRow | null> => {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE resource_package_upload
     SET status = 'failed', version = version + 1, updated_at = ?, completed_at = ?
     WHERE id = ? AND version = ? AND status NOT IN ('processing', 'ready', 'succeeded')`,
  )
    .bind(now, now, upload.id, upload.version)
    .run();
  console.warn(JSON.stringify({ event: "admin.package_verification_failed", uploadId: upload.id, reason }));
  return findPackageUpload(env, upload.id);
};

const hasZipMagic = async (bucket: R2Bucket, key: string): Promise<boolean> => {
  const prefix = await bucket.get(key, { range: { offset: 0, length: 4 } });
  if (!prefix) return false;
  const bytes = await prefix.bytes();
  return bytes.length === 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
};

const completePackageUpload = async (request: Request, env: Env, uploadId: string): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const ingress = env.RESOURCE_PACKAGE_INGRESS;
  if (!ingress) return error(request, 503, "package_ingress_unavailable", "Package ingress storage is unavailable");
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const version = expectedVersion(body);
  if (version === null) return error(request, 422, "invalid_expected_version", "expectedVersion is required");
  const started = await startOperation(request, env, access, "package.upload.complete", "package_upload", uploadId);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);
  let upload = await findPackageUpload(env, uploadId);
  if (!upload || upload.ownerUserId !== access.userId) {
    await failOperation(env, started.operationId, "package_upload_not_found");
    return error(request, 404, "package_upload_not_found", "Package upload not found");
  }
  if (upload.version !== version) {
    await failOperation(env, started.operationId, "version_conflict", { actualVersion: upload.version });
    return error(request, 409, "version_conflict", "The package upload changed; refresh and try again");
  }
  if (upload.status === "ready" || upload.status === "processing" || upload.status === "succeeded") {
    try {
      await ensurePackageLease(env, upload);
    } catch (failure) {
      await failOperation(env, started.operationId, "package_lease_failed");
      console.error(
        JSON.stringify({
          event: "admin.package_lease_failed",
          operationId: started.operationId,
          error: failure instanceof Error ? failure.name : "UnknownError",
        }),
      );
      return error(request, 502, "package_lease_failed", "The completed package could not be protected from cleanup");
    }
    const operation = await transitionOperation(
      env,
      started.operationId,
      "succeeded",
      { alreadyComplete: true, status: upload.status, uploadId },
      `${CAS_PREFIX}/${upload.expectedSha256.slice(0, 2)}/${upload.expectedSha256}`,
      null,
    );
    return json(request, { operation: operationValue(operation), packageUpload: packageValue(upload) });
  }
  if (upload.status === "expired" || upload.status === "failed") {
    await failOperation(env, started.operationId, "package_upload_not_completable", { status: upload.status });
    return error(request, 409, "package_upload_not_completable", "This package upload cannot be completed");
  }
  const now = Date.now();
  if (upload.expiresAt <= now) {
    await env.DB.prepare(
      `UPDATE resource_package_upload
       SET status = 'expired', version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND status IN ('reserved', 'uploading', 'uploaded', 'verifying')`,
    )
      .bind(now, uploadId, version)
      .run();
    await failOperation(env, started.operationId, "package_upload_expired");
    return error(request, 410, "package_upload_expired", "The package upload has expired");
  }

  if (upload.status === "reserved" || upload.status === "uploading") {
    const multipartUpload = upload;
    const parts = await findPackageParts(env, uploadId);
    const expectedCount = packagePartCount(multipartUpload.declaredSize);
    const validParts =
      parts.length === expectedCount &&
      parts.every(
        (part, index) =>
          part.partNumber === index + 1 && part.byteSize === packagePartSize(multipartUpload, part.partNumber),
      );
    if (!validParts) {
      await failOperation(env, started.operationId, "package_parts_incomplete", {
        expectedPartCount: expectedCount,
        uploadedPartCount: parts.length,
      });
      return error(request, 409, "package_parts_incomplete", "All package parts must be uploaded before completion");
    }
    let completed = await ingress.head(upload.objectKey);
    if (!completed) {
      try {
        completed = await ingress
          .resumeMultipartUpload(upload.objectKey, upload.r2UploadId)
          .complete(parts.map((part) => ({ etag: part.etag, partNumber: part.partNumber })));
      } catch (failure) {
        completed = await ingress.head(upload.objectKey);
        if (!completed) {
          await failOperation(env, started.operationId, "package_multipart_complete_failed");
          console.error(
            JSON.stringify({
              event: "admin.package_multipart_complete_failed",
              operationId: started.operationId,
              error: failure instanceof Error ? failure.name : "UnknownError",
            }),
          );
          return error(
            request,
            502,
            "package_multipart_complete_failed",
            "The multipart upload could not be completed",
          );
        }
      }
    }
    if (completed.size !== upload.declaredSize || !(await hasZipMagic(ingress, upload.objectKey))) {
      await ingress.delete(upload.objectKey).catch(() => undefined);
      upload = (await rejectPackageUpload(env, upload, "invalid_size_or_magic")) || upload;
      await failOperation(env, started.operationId, "invalid_package_file", { declaredSize: upload.declaredSize });
      return error(request, 422, "invalid_package_file", "The completed object is not the declared package file");
    }
    const stateUpdate = await env.DB.prepare(
      `UPDATE resource_package_upload
       SET status = 'uploaded', version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND status IN ('reserved', 'uploading')`,
    )
      .bind(now, uploadId, upload.version)
      .run();
    if (Number(stateUpdate.meta.changes || 0) !== 1) {
      await failOperation(env, started.operationId, "package_complete_state_conflict");
      return error(request, 409, "package_complete_state_conflict", "The package upload changed during completion");
    }
    const uploadedState = await findPackageUpload(env, uploadId);
    if (!uploadedState) throw new Error("Completed package upload disappeared");
    upload = uploadedState;
  }

  if (upload.status === "uploaded") {
    const verifyingAt = Date.now();
    const verifyingUpdate = await env.DB.prepare(
      `UPDATE resource_package_upload
       SET status = 'verifying', version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND status = 'uploaded'`,
    )
      .bind(verifyingAt, uploadId, upload.version)
      .run();
    if (Number(verifyingUpdate.meta.changes || 0) !== 1) {
      await failOperation(env, started.operationId, "package_verification_state_conflict");
      return error(request, 409, "package_verification_state_conflict", "The package changed before verification");
    }
    const verifyingState = await findPackageUpload(env, uploadId);
    if (!verifyingState) throw new Error("Verifying package upload disappeared");
    upload = verifyingState;
  }
  if (upload.status !== "verifying") {
    await failOperation(env, started.operationId, "package_upload_not_verifiable", { status: upload.status });
    return error(request, 409, "package_upload_not_verifiable", "The package is not in a verifiable state");
  }

  const canonicalKey = `${CAS_PREFIX}/${upload.expectedSha256.slice(0, 2)}/${upload.expectedSha256}`;
  let canonical = await env.ASSET_BUCKET.head(canonicalKey);
  if (canonical && canonical.size !== upload.declaredSize) {
    await failOperation(env, started.operationId, "canonical_storage_invariant_failed");
    return error(request, 500, "canonical_storage_invariant_failed", "Canonical package storage is inconsistent");
  }
  if (!canonical) {
    const source = await ingress.get(upload.objectKey);
    if (!source || source.size !== upload.declaredSize) {
      await env.DB.prepare(
        `UPDATE resource_package_upload
         SET status = 'uploaded', version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND status = 'verifying'`,
      )
        .bind(Date.now(), uploadId, upload.version)
        .run();
      await failOperation(env, started.operationId, "package_ingress_object_missing");
      return error(request, 409, "package_ingress_object_missing", "The completed package object is unavailable");
    }
    try {
      canonical = await env.ASSET_BUCKET.put(canonicalKey, source.body, {
        sha256: hexBytes(upload.expectedSha256),
        httpMetadata: { contentType: upload.mediaType },
        customMetadata: {
          fileName: upload.fileName,
          source: "admin-package-upload",
          uploadId: upload.id,
        },
      });
    } catch (failure) {
      canonical = await env.ASSET_BUCKET.head(canonicalKey);
      if (!canonical || canonical.size !== upload.declaredSize) {
        await env.DB.prepare(
          `UPDATE resource_package_upload
           SET status = 'uploaded', version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND status = 'verifying'`,
        )
          .bind(Date.now(), uploadId, upload.version)
          .run();
        await failOperation(env, started.operationId, "package_promotion_failed");
        console.error(
          JSON.stringify({
            event: "admin.package_promotion_failed",
            operationId: started.operationId,
            error: failure instanceof Error ? failure.name : "UnknownError",
          }),
        );
        return error(request, 502, "package_promotion_failed", "Package integrity verification or promotion failed");
      }
    }
  }
  try {
    await ensurePackageLease(env, upload);
  } catch (failure) {
    await env.DB.prepare(
      `UPDATE resource_package_upload
       SET status = 'uploaded', version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND status = 'verifying'`,
    )
      .bind(Date.now(), uploadId, upload.version)
      .run();
    await failOperation(env, started.operationId, "package_lease_failed");
    console.error(
      JSON.stringify({
        event: "admin.package_lease_failed",
        operationId: started.operationId,
        error: failure instanceof Error ? failure.name : "UnknownError",
      }),
    );
    return error(request, 502, "package_lease_failed", "The completed package could not be protected from cleanup");
  }
  const completedAt = Date.now();
  const readyUpdate = await env.DB.prepare(
    `UPDATE resource_package_upload
     SET status = 'ready', verified_sha256 = ?, version = version + 1,
         updated_at = ?, completed_at = ?
     WHERE id = ? AND version = ? AND status = 'verifying'`,
  )
    .bind(upload.expectedSha256, completedAt, completedAt, uploadId, upload.version)
    .run();
  if (Number(readyUpdate.meta.changes || 0) !== 1) {
    await failOperation(env, started.operationId, "package_ready_state_conflict");
    return error(request, 409, "package_ready_state_conflict", "The package upload changed during promotion");
  }
  const ready = await findPackageUpload(env, uploadId);
  if (!ready) throw new Error("Promoted package upload disappeared");
  try {
    await Promise.all([
      ingress.delete(upload.objectKey),
      env.DB.prepare("DELETE FROM resource_package_part WHERE upload_id = ?").bind(uploadId).run(),
    ]);
  } catch (failure) {
    console.warn(
      JSON.stringify({
        event: "admin.package_ingress_cleanup_deferred",
        uploadId,
        error: failure instanceof Error ? failure.name : "UnknownError",
      }),
    );
  }
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { canonicalKey, declaredSize: ready.declaredSize, uploadId },
    canonicalKey,
    null,
  );
  return json(request, { operation: operationValue(operation), packageUpload: packageValue(ready) });
};

const abortPackageUpload = async (request: Request, env: Env, uploadId: string): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  const ingress = env.RESOURCE_PACKAGE_INGRESS;
  if (!ingress) return error(request, 503, "package_ingress_unavailable", "Package ingress storage is unavailable");
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const version = expectedVersion(body);
  const reasonCode = body.reasonCode;
  if (version === null || typeof reasonCode !== "string" || !REASON_PATTERN.test(reasonCode)) {
    return error(request, 422, "invalid_package_abort", "reasonCode and expectedVersion are required");
  }
  const started = await startOperation(request, env, access, "package.upload.abort", "package_upload", uploadId);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);
  const upload = await findPackageUpload(env, uploadId);
  if (!upload || upload.ownerUserId !== access.userId) {
    await failOperation(env, started.operationId, "package_upload_not_found");
    return error(request, 404, "package_upload_not_found", "Package upload not found");
  }
  if (upload.version !== version) {
    await failOperation(env, started.operationId, "version_conflict", { actualVersion: upload.version });
    return error(request, 409, "version_conflict", "The package upload changed; refresh and try again");
  }
  if (upload.status === "ready" || upload.status === "processing" || upload.status === "succeeded") {
    await failOperation(env, started.operationId, "package_upload_not_abortable", { status: upload.status });
    return error(request, 409, "package_upload_not_abortable", "A ready or processing package cannot be aborted");
  }
  const now = Date.now();
  if (upload.status !== "expired") {
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE resource_package_upload
         SET status = 'expired', version = version + 1, updated_at = ?, completed_at = ?
         WHERE id = ? AND version = ? AND status NOT IN ('processing', 'ready', 'succeeded')`,
      ).bind(now, now, uploadId, version),
      env.DB.prepare(
        `DELETE FROM resource_package_part
         WHERE upload_id = ?
           AND EXISTS (
             SELECT 1 FROM resource_package_upload
             WHERE id = ? AND status = 'expired' AND version = ?
               AND updated_at = ? AND completed_at = ?
           )`,
      ).bind(uploadId, uploadId, version + 1, now, now),
    ]);
    if (Number(results[0]?.meta.changes || 0) !== 1) {
      await failOperation(env, started.operationId, "package_abort_state_conflict");
      return error(request, 409, "package_abort_state_conflict", "The package upload changed during abort");
    }
  }
  let cleanupComplete = true;
  if (upload.status === "reserved" || upload.status === "uploading" || upload.status === "expired") {
    try {
      await ingress.resumeMultipartUpload(upload.objectKey, upload.r2UploadId).abort();
    } catch {
      cleanupComplete = false;
    }
  }
  try {
    await ingress.delete(upload.objectKey);
  } catch (failure) {
    cleanupComplete = false;
    console.warn(
      JSON.stringify({
        event: "admin.package_abort_cleanup_deferred",
        uploadId,
        error: failure instanceof Error ? failure.name : "UnknownError",
      }),
    );
  }
  const expired = await findPackageUpload(env, uploadId);
  if (!expired) throw new Error("Cancelled package upload disappeared");
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    { cleanupComplete, reasonCode, uploadId },
    uploadId,
    null,
  );
  return json(request, { operation: operationValue(operation), packageUpload: packageValue(expired) });
};

const resourceRunValue = (row: ResourceRunRow): JsonObject => ({
  id: row.id,
  operationId: row.operationId,
  server: row.server,
  sourceKind: row.sourceKind,
  sourceRef: row.sourceRef,
  status: row.status,
  conclusion: row.conclusion,
  githubRunId: row.githubRunId,
  githubRunUrl: row.githubRunUrl,
  releaseId: row.releaseId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt,
});

const findResourceRun = async (env: Env, runId: string): Promise<ResourceRunRow | null> =>
  env.DB.prepare(
    `SELECT id, operation_id AS operationId, server, source_kind AS sourceKind, source_ref AS sourceRef,
            github_run_id AS githubRunId, github_run_url AS githubRunUrl, status, conclusion,
            release_id AS releaseId, created_at AS createdAt, updated_at AS updatedAt,
            completed_at AS completedAt
     FROM resource_run
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(runId)
    .first<ResourceRunRow>();

const readLimitedExternalJson = async (response: Response): Promise<JsonObject | null> => {
  if (!response.body) return null;
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > JSON_BODY_LIMIT) {
    await response.body.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > JSON_BODY_LIMIT) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return isJsonValue(parsed) && isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const safeGitHubUrl = (value: JsonValue | undefined, hostname: "api.github.com" | "github.com"): string | null => {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === hostname ? url.toString() : null;
  } catch {
    return null;
  }
};

const dispatchGitHubWorkflow = async (
  env: Env,
  server: string,
  sourceKind: "github" | "package",
  workflowSource: string,
  ktx2: boolean,
): Promise<GitHubDispatchResponse> => {
  // Transitional credential: use a fine-grained token with Actions:write only.
  // A GitHub App installation token can replace this without changing the dispatch contract.
  const token = env.GITHUB_ACTIONS_TOKEN?.trim();
  if (!token) throw new Error("GitHubActionsTokenUnavailable");
  const endpoint = `https://api.github.com/repos/${RESOURCE_OWNER}/${RESOURCE_REPOSITORY}/actions/workflows/${RESOURCE_WORKFLOW}/dispatches`;
  const inputs: JsonObject = { ktx2, server };
  inputs[sourceKind === "package" ? "package_r2_key" : "source_id"] = workflowSource;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "haneoka-admin-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref: RESOURCE_REF, inputs }),
    redirect: "manual",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHubDispatchStatus${response.status}`);
  }
  if (response.status === 204) {
    return { htmlUrl: null, runUrl: null, workflowRunId: null };
  }
  const payload = await readLimitedExternalJson(response);
  const idValue = payload?.workflow_run_id ?? payload?.id;
  const workflowRunId = typeof idValue === "number" && Number.isSafeInteger(idValue) && idValue > 0 ? idValue : null;
  const htmlUrl = safeGitHubUrl(payload?.html_url, "github.com");
  const runUrl = safeGitHubUrl(payload?.url, "api.github.com");
  return { htmlUrl, runUrl, workflowRunId };
};

const createResourceRun = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireStaff(request, env, "admin");
  if (access instanceof Response) return access;
  if (!env.GITHUB_ACTIONS_TOKEN?.trim()) {
    return error(request, 503, "github_dispatch_unavailable", "GitHub workflow dispatch is not configured");
  }
  const body = await readJsonBody(request);
  if (!body) return error(request, 400, "invalid_body", "A JSON body is required");
  const fixedFields: ReadonlyArray<readonly [string, string]> = [
    ["owner", RESOURCE_OWNER],
    ["repo", RESOURCE_REPOSITORY],
    ["workflow", RESOURCE_WORKFLOW],
    ["ref", RESOURCE_REF],
  ];
  if (fixedFields.some(([key, value]) => body[key] !== undefined && body[key] !== value)) {
    return error(request, 422, "fixed_workflow_target", "owner, repo, workflow, and ref cannot be changed");
  }
  const server = body.server;
  const sourceKind = body.sourceKind;
  const sourceRef = body.sourceRef;
  const version = expectedVersion(body);
  const reasonCode = body.reasonCode;
  const ktx2 = body.ktx2 ?? false;
  if (
    typeof server !== "string" ||
    normalizeResourceServerSlug(server) !== server ||
    (sourceKind !== "github" && sourceKind !== "package") ||
    typeof sourceRef !== "string" ||
    typeof ktx2 !== "boolean" ||
    version === null ||
    typeof reasonCode !== "string" ||
    !REASON_PATTERN.test(reasonCode)
  ) {
    return error(request, 422, "invalid_resource_run", "The resource run request is invalid");
  }
  const resourceServer = await findActiveResourceServer(env, server);
  if (!resourceServer) {
    return error(request, 409, "resource_server_unavailable", "The resource server is not active");
  }

  let packageUpload: PackageUploadRow | null = null;
  let workflowSource: string;
  if (sourceKind === "package") {
    if (!UUID_PATTERN.test(sourceRef))
      return error(request, 422, "invalid_package_source", "sourceRef must be a package upload id");
    packageUpload = await findPackageUpload(env, sourceRef);
    if (!packageUpload || packageUpload.ownerUserId !== access.userId) {
      return error(request, 404, "package_upload_not_found", "Package upload not found");
    }
    if (
      packageUpload.server !== server ||
      packageUpload.status !== "ready" ||
      packageUpload.verifiedSha256 !== packageUpload.expectedSha256
    ) {
      return error(request, 409, "package_not_ready", "The package is not ready for resource processing");
    }
    if (packageUpload.version !== version) {
      return error(request, 409, "version_conflict", "The package upload changed; refresh and try again");
    }
    workflowSource = `${CAS_PREFIX}/${packageUpload.expectedSha256.slice(0, 2)}/${packageUpload.expectedSha256}`;
  } else {
    if (!SOURCE_ID_PATTERN.test(sourceRef) || version !== 0) {
      return error(
        request,
        422,
        "invalid_existing_source",
        "Existing sources require a safe sourceRef and expectedVersion 0",
      );
    }
    const manifest = await env.ASSET_BUCKET.head(`${resourceServer.resourcePrefix}/sources/${sourceRef}/source.json`);
    if (!manifest)
      return error(request, 404, "resource_source_not_found", "The immutable resource source does not exist");
    workflowSource = sourceRef;
  }

  const runId = crypto.randomUUID();
  const started = await startOperation(request, env, access, "resource.run.dispatch", "resource_run", runId, true);
  if (started.kind === "response") return started.response;
  if (started.kind === "existing") return existingOperationResponse(request, started.operation);
  const now = Date.now();
  let reservedPackageVersion: number | null = null;
  if (packageUpload) {
    const reserved = await env.DB.prepare(
      `UPDATE resource_package_upload
       SET status = 'processing', version = version + 1, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND version = ? AND status = 'ready'`,
    )
      .bind(now, packageUpload.id, access.userId, packageUpload.version)
      .run();
    if (Number(reserved.meta.changes || 0) !== 1) {
      await failOperation(env, started.operationId, "package_dispatch_conflict");
      return error(request, 409, "package_dispatch_conflict", "The package was selected by another operation");
    }
    reservedPackageVersion = packageUpload.version + 1;
  }
  try {
    const inserted = await env.DB.prepare(
      `INSERT INTO resource_run
         (id, operation_id, server, source_kind, source_ref, status, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'queued', ?, ?
       FROM resource_server
       WHERE slug = ? AND status = 'active' AND resource_prefix = ?`,
    )
      .bind(
        runId,
        started.operationId,
        server,
        sourceKind,
        sourceRef,
        now,
        now,
        resourceServer.slug,
        resourceServer.resourcePrefix,
      )
      .run();
    if (Number(inserted.meta.changes || 0) !== 1) throw new Error("ResourceServerUnavailable");
  } catch (failure) {
    if (packageUpload && reservedPackageVersion !== null) {
      await env.DB.prepare(
        `UPDATE resource_package_upload
         SET status = 'ready', version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND status = 'processing'`,
      )
        .bind(Date.now(), packageUpload.id, reservedPackageVersion)
        .run();
    }
    const failureCode =
      failure instanceof Error && failure.message === "ResourceServerUnavailable"
        ? "resource_server_unavailable"
        : "resource_run_persist_failed";
    await failOperation(env, started.operationId, failureCode);
    console.error(
      JSON.stringify({
        event: "admin.resource_run_persist_failed",
        operationId: started.operationId,
        error: failure instanceof Error ? failure.name : "UnknownError",
      }),
    );
    if (failureCode === "resource_server_unavailable") {
      return error(request, 409, failureCode, "The resource server changed or is no longer active");
    }
    return error(request, 503, "resource_run_persist_failed", "The resource run could not be reserved");
  }

  let dispatch: GitHubDispatchResponse;
  try {
    dispatch = await dispatchGitHubWorkflow(env, server, sourceKind, workflowSource, ktx2);
  } catch (failure) {
    const failedAt = Date.now();
    await env.DB.prepare(
      `UPDATE resource_run
       SET status = 'completed', conclusion = 'dispatch_failed', updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'queued'`,
    )
      .bind(failedAt, failedAt, runId)
      .run();
    if (packageUpload && reservedPackageVersion !== null) {
      await env.DB.prepare(
        `UPDATE resource_package_upload
         SET status = 'ready', version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND status = 'processing'`,
      )
        .bind(failedAt, packageUpload.id, reservedPackageVersion)
        .run();
    }
    await failOperation(env, started.operationId, "github_dispatch_failed");
    console.error(
      JSON.stringify({
        event: "admin.github_dispatch_failed",
        operationId: started.operationId,
        error: failure instanceof Error ? failure.message.slice(0, 80) : "UnknownError",
      }),
    );
    return error(request, 502, "github_dispatch_failed", "GitHub did not accept the fixed workflow dispatch");
  }
  const queuedAt = Date.now();
  const githubRunUrl =
    dispatch.htmlUrl ||
    (dispatch.workflowRunId
      ? `https://github.com/${RESOURCE_OWNER}/${RESOURCE_REPOSITORY}/actions/runs/${dispatch.workflowRunId}`
      : null);
  await env.DB.prepare(
    `UPDATE resource_run
     SET github_run_id = ?, github_run_url = ?, updated_at = ?
     WHERE id = ? AND status = 'queued'`,
  )
    .bind(dispatch.workflowRunId, githubRunUrl, queuedAt, runId)
    .run();
  const run = await findResourceRun(env, runId);
  if (!run) throw new Error("Queued resource run disappeared");
  const workflowUrl = `https://github.com/${RESOURCE_OWNER}/${RESOURCE_REPOSITORY}/actions/workflows/${RESOURCE_WORKFLOW}`;
  const operation = await transitionOperation(
    env,
    started.operationId,
    "succeeded",
    {
      githubApiRunUrl: dispatch.runUrl,
      githubRunId: dispatch.workflowRunId,
      ktx2,
      reasonCode,
      server,
      sourceKind,
      sourceRef,
    },
    githubRunUrl || workflowUrl,
    null,
  );
  return json(
    request,
    {
      operation: operationValue(operation),
      resourceRun: resourceRunValue(run),
      target: {
        owner: RESOURCE_OWNER,
        ref: RESOURCE_REF,
        repo: RESOURCE_REPOSITORY,
        workflow: RESOURCE_WORKFLOW,
      },
    },
    202,
  );
};

const decodedPathSegment = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

export const handleAdminRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== ADMIN_PREFIX && !url.pathname.startsWith(`${ADMIN_PREFIX}/`)) return null;
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        Allow: "GET, HEAD, POST, PUT, DELETE, OPTIONS",
        "Cache-Control": "no-store",
        "X-Request-Id": requestId(request),
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
    request.body?.cancel().catch(() => undefined);
    return error(request, 403, "same_origin_required", "Administrative mutations require a same-origin request");
  }
  const method = request.method === "HEAD" ? "GET" : request.method;
  const suffix = url.pathname.slice(ADMIN_PREFIX.length).replace(/^\/+|\/+$/gu, "");
  const rawSegments = suffix ? suffix.split("/") : [];
  const segments = rawSegments.map(decodedPathSegment);
  if (segments.some((segment) => segment === null))
    return error(request, 404, "route_not_found", "API route not found");
  const path = segments as string[];

  if (method === "GET" && path.length === 1 && path[0] === "session") return getSession(request, env);
  if (method === "GET" && path.length === 1 && path[0] === "overview") return getOverview(request, env);
  if (method === "GET" && path.length === 1 && path[0] === "users") return getUsers(request, env, url);
  if (method === "GET" && path.length === 1 && path[0] === "posts") return getPosts(request, env, url);
  if (method === "GET" && path.length === 3 && path[0] === "posts" && path[2] === "history") {
    const postId = path[1];
    return postId && UUID_PATTERN.test(postId)
      ? getPostHistory(request, env, postId, url)
      : error(request, 404, "post_not_found", "Post not found");
  }
  if (method === "PUT" && path.length === 3 && path[0] === "posts" && path[2] === "state") {
    const postId = path[1];
    return postId && UUID_PATTERN.test(postId)
      ? putPostState(request, env, postId)
      : error(request, 404, "post_not_found", "Post not found");
  }
  if (method === "GET" && path.length === 3 && path[0] === "comments" && path[2] === "history") {
    const commentId = path[1];
    return commentId && UUID_PATTERN.test(commentId)
      ? getCommentHistory(request, env, commentId, url)
      : error(request, 404, "comment_not_found", "Comment not found");
  }
  if (method === "PUT" && path.length === 3 && path[0] === "comments" && path[2] === "state") {
    const commentId = path[1];
    return commentId && UUID_PATTERN.test(commentId)
      ? putCommentState(request, env, commentId)
      : error(request, 404, "comment_not_found", "Comment not found");
  }
  if (method === "GET" && path.length === 1 && path[0] === "reports") return getReports(request, env, url);
  if (method === "PUT" && path.length === 3 && path[0] === "reports" && path[2] === "status") {
    const reportId = path[1];
    return reportId && UUID_PATTERN.test(reportId)
      ? putReportStatus(request, env, reportId)
      : error(request, 404, "report_not_found", "Report not found");
  }
  if (method === "GET" && path.length === 1 && path[0] === "appeals") return getAppeals(request, env, url);
  if (method === "GET" && path.length === 1 && path[0] === "operations") return getOperations(request, env, url);
  if (method === "POST" && path.length === 3 && path[0] === "appeals" && path[2] === "decision") {
    const appealId = path[1];
    return appealId && UUID_PATTERN.test(appealId)
      ? decideAppeal(request, env, appealId)
      : error(request, 404, "appeal_not_found", "Appeal not found");
  }
  if (method === "PUT" && path.length === 3 && path[0] === "users" && path[2] === "role") {
    const userId = path[1];
    return userId && SAFE_ID_PATTERN.test(userId)
      ? putUserRole(request, env, userId)
      : error(request, 404, "user_not_found", "User not found");
  }
  if (method === "POST" && path.length === 3 && path[0] === "users" && path[2] === "restrictions") {
    const userId = path[1];
    return userId && SAFE_ID_PATTERN.test(userId)
      ? createRestriction(request, env, userId)
      : error(request, 404, "user_not_found", "User not found");
  }
  if (method === "DELETE" && path.length === 4 && path[0] === "users" && path[2] === "restrictions") {
    const userId = path[1];
    const restrictionId = path[3];
    return userId && restrictionId && SAFE_ID_PATTERN.test(userId) && UUID_PATTERN.test(restrictionId)
      ? revokeRestriction(request, env, userId, restrictionId)
      : error(request, 404, "restriction_not_found", "Restriction not found");
  }
  if (method === "POST" && path.length === 3 && path[0] === "users" && path[2] === "session-revocations") {
    const userId = path[1];
    return userId && SAFE_ID_PATTERN.test(userId)
      ? revokeUserSessions(request, env, userId)
      : error(request, 404, "user_not_found", "User not found");
  }
  if (method === "GET" && path.length === 1 && path[0] === "resource-servers") {
    return getResourceServers(request, env);
  }
  if (method === "POST" && path.length === 1 && path[0] === "resource-servers") {
    return createResourceServer(request, env);
  }
  if (method === "PUT" && path.length === 2 && path[0] === "resource-servers") {
    const slug = path[1];
    return slug && normalizeResourceServerSlug(slug) === slug
      ? putResourceServer(request, env, slug)
      : error(request, 404, "resource_server_not_found", "Resource server not found");
  }
  if (method === "GET" && path.length === 1 && path[0] === "resource-sources") {
    return getResourceSources(request, env, url);
  }
  if (method === "POST" && path.length === 1 && path[0] === "package-uploads") {
    return createPackageUpload(request, env);
  }
  if (method === "GET" && path.length === 2 && path[0] === "package-uploads") {
    const uploadId = path[1];
    return uploadId && UUID_PATTERN.test(uploadId)
      ? getPackageUpload(request, env, uploadId)
      : error(request, 404, "package_upload_not_found", "Package upload not found");
  }
  if (method === "PUT" && path.length === 4 && path[0] === "package-uploads" && path[2] === "parts") {
    const uploadId = path[1];
    const partRaw = path[3];
    const partNumber = partRaw && /^\d{1,5}$/u.test(partRaw) ? Number(partRaw) : 0;
    return uploadId && UUID_PATTERN.test(uploadId) && partNumber >= 1 && partNumber <= 10_000
      ? uploadPackagePart(request, env, url, uploadId, partNumber)
      : error(request, 404, "package_part_not_found", "Package part route not found");
  }
  if (method === "POST" && path.length === 3 && path[0] === "package-uploads" && path[2] === "complete") {
    const uploadId = path[1];
    return uploadId && UUID_PATTERN.test(uploadId)
      ? completePackageUpload(request, env, uploadId)
      : error(request, 404, "package_upload_not_found", "Package upload not found");
  }
  if (
    (method === "DELETE" || method === "POST") &&
    ((path.length === 2 && path[0] === "package-uploads") ||
      (path.length === 3 && path[0] === "package-uploads" && path[2] === "abort"))
  ) {
    const uploadId = path[1];
    return uploadId && UUID_PATTERN.test(uploadId)
      ? abortPackageUpload(request, env, uploadId)
      : error(request, 404, "package_upload_not_found", "Package upload not found");
  }
  if (method === "POST" && path.length === 1 && path[0] === "resource-runs") {
    return createResourceRun(request, env);
  }
  return error(request, 404, "route_not_found", "API route not found");
};
