export const adminSections = ["overview", "users", "posts", "reports", "appeals", "operations"] as const;

export type AdminSection = (typeof adminSections)[number];
export type AdminRole = "admin" | "member" | "moderator";
export type AdminAccountStatus = "active" | "deleted" | "suspended";
export type AdminModerationStatus = "allow" | "block" | "pending" | "review";
export type AdminModerationCaseStatus = AdminModerationStatus | "superseded";
export type AdminOperationStatus = "failed" | "pending" | "running" | "succeeded";
export type AdminReportStatus = "dismissed" | "pending" | "resolved" | "reviewing";
export type AdminRestrictionKind = "sign_in" | "upload" | "write";
export type AdminResourceServerRegion = "cn" | "en" | "global" | "jp" | "kr" | "tw";
export type AdminResourceServerStatus = "active" | "draft" | "retired";
export type AdminPackageStatus =
  "expired" | "failed" | "processing" | "ready" | "reserved" | "succeeded" | "uploaded" | "uploading" | "verifying";

export interface AdminStaffSession {
  user: {
    id: string;
    name: string;
    email: string;
    avatarSeed: string;
    avatarUrl: string | null;
  };
  role: Exclude<AdminRole, "member">;
  profileVersion: number;
  capabilities: string[];
}

export interface AdminOverview {
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

export interface AdminOverviewResponse {
  session: AdminStaffSession;
  overview: AdminOverview;
}

export interface AdminResourceServer {
  id: string;
  slug: string;
  displayName: string;
  region: AdminResourceServerRegion;
  status: AdminResourceServerStatus;
  resourcePrefix: string;
  version: number;
  builtIn: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AdminResourceServersResponse {
  resourceServers: AdminResourceServer[];
}

export interface AdminResourceServerResponse {
  resourceServer: AdminResourceServer;
}

export interface AdminResourceSource {
  current: boolean;
  id: string;
  uploadedAt: number;
}

export interface AdminResourceSourcesResponse {
  currentReleaseId: string | null;
  currentSourceId: string | null;
  resourceSources: AdminResourceSource[];
  truncated: boolean;
}

export interface AdminPackagePart {
  byteSize: number;
  etag: string;
  partNumber: number;
}

export interface AdminPackageUpload {
  completedAt: number | null;
  createdAt: number;
  declaredSize: number;
  expectedSha256: string;
  expiresAt: number;
  fileName: string;
  id: string;
  mediaType: string;
  partCount: number;
  partSize: number;
  parts: AdminPackagePart[];
  server: string;
  status: AdminPackageStatus;
  updatedAt: number;
  verifiedSha256: string | null;
  version: number;
}

export interface AdminPackageUploadResponse {
  packageUpload: AdminPackageUpload;
}

export interface AdminResourceRun {
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

export interface AdminResourceRunResponse {
  resourceRun: AdminResourceRun;
}

export interface AdminUserSummary {
  accountName: string;
  candidateDisplayName: string | null;
  displayNameStatus: "allow" | "block" | "pending";
  id: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  publicDisplayName: string | null;
  handle: string | null;
  role: AdminRole;
  status: AdminAccountStatus;
  version: number;
  restrictions: {
    signIn: boolean;
    upload: boolean;
    write: boolean;
  };
  activeRestrictions: AdminUserRestriction[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserRestriction {
  actorUserId: string;
  createdAt: number;
  expiresAt: number | null;
  id: string;
  kind: AdminRestrictionKind;
  reasonCode: string;
  revokedAt: number | null;
  revokedByUserId: string | null;
  updatedAt: number;
  userId: string;
  version: number;
}

export interface AdminIpLocation {
  countryCode: string | null;
  regionCode: string | null;
  regionName: string | null;
}

export interface AdminIpAudit {
  browserFamily: string | null;
  ipAddress: string | null;
  ipLocation: AdminIpLocation | null;
  osFamily: string | null;
  userAgent: string | null;
}

export interface AdminAuditUser {
  accountName: string;
  displayName: string | null;
  handle: string | null;
  id: string;
}

export interface AdminNullableAuditUser {
  accountName: string | null;
  displayName: string | null;
  handle: string | null;
  id: string;
}

export interface AdminPostHistoryTag {
  displayName: string;
  id: string;
  normalizedName: string;
  position: number;
}

export interface AdminPostHistoryAttachment {
  byteSize: number | null;
  declaredSize: number;
  id: string;
  mediaType: string;
  originalName: string;
  position: number;
  sha256: string | null;
  status: "deleted" | "ready" | "rejected" | "reserved" | "review" | "scanning";
}

export interface AdminPostRevision extends AdminIpAudit {
  attachments: AdminPostHistoryAttachment[];
  body: string;
  createdAt: number;
  editReason: string | null;
  editor: AdminAuditUser;
  revisionNumber: number;
  sourceKind: "create" | "edit" | "migration_snapshot" | "restore_snapshot";
  tags: AdminPostHistoryTag[];
  title: string;
  visibility: "private" | "protected" | "public";
}

export interface AdminPostStateEvent extends AdminIpAudit {
  actor: AdminNullableAuditUser | null;
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

export interface AdminPostHistoryComment extends AdminIpAudit {
  author: AdminAuditUser;
  createdAt: number;
  deletedAt: number | null;
  hiddenAt: number | null;
  id: string;
  moderationRevision: number;
  moderationStatus: AdminModerationStatus;
  parentId: string | null;
  updatedAt: number;
  version: number;
}

export interface AdminPostHistoryResponse {
  comments: AdminPostHistoryComment[];
  nextCursors: {
    comments: string | null;
    revisions: string | null;
    stateEvents: string | null;
  };
  post: AdminIpAudit & {
    archivedAt: number | null;
    author: AdminAuditUser;
    commentsLockedAt: number | null;
    createdAt: number;
    deletedAt: number | null;
    id: string;
    moderationRevision: number;
    moderationStatus: AdminModerationStatus;
    pinnedAt: number | null;
    status: "draft" | "hidden" | "published";
    updatedAt: number;
    version: number;
    visibility: "private" | "protected" | "public";
  };
  revisions: AdminPostRevision[];
  stateEvents: AdminPostStateEvent[];
}

export interface AdminPostRevisionHistoryPageResponse {
  nextCursor: string | null;
  revisions: AdminPostRevision[];
}

export interface AdminPostStateEventHistoryPageResponse {
  nextCursor: string | null;
  stateEvents: AdminPostStateEvent[];
}

export interface AdminPostCommentHistoryPageResponse {
  comments: AdminPostHistoryComment[];
  nextCursor: string | null;
}

export interface AdminCommentRevision extends AdminIpAudit {
  body: string;
  createdAt: number;
  editReason: string | null;
  editor: AdminAuditUser;
  revisionNumber: number;
  sourceKind: "create" | "edit" | "migration_snapshot" | "restore_snapshot";
}

export interface AdminCommentStateEvent extends AdminIpAudit {
  actor: AdminNullableAuditUser | null;
  createdAt: number;
  eventKind: "deleted" | "hidden" | "restored" | "unhidden";
  id: string;
  reasonCode: string | null;
  revisionNumber: number | null;
}

export interface AdminCommentHistoryResponse {
  comment: AdminIpAudit & {
    author: AdminAuditUser;
    createdAt: number;
    deletedAt: number | null;
    hiddenAt: number | null;
    id: string;
    moderationRevision: number;
    moderationStatus: AdminModerationStatus;
    parentId: string | null;
    postId: string;
    updatedAt: number;
    version: number;
  };
  nextCursors: {
    revisions: string | null;
    stateEvents: string | null;
  };
  revisions: AdminCommentRevision[];
  stateEvents: AdminCommentStateEvent[];
}

export interface AdminCommentRevisionHistoryPageResponse {
  nextCursor: string | null;
  revisions: AdminCommentRevision[];
}

export interface AdminCommentStateEventHistoryPageResponse {
  nextCursor: string | null;
  stateEvents: AdminCommentStateEvent[];
}

export interface AdminPostSummary {
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
  moderationStatus: AdminModerationStatus;
  pinnedAt: number | null;
  status: "draft" | "hidden" | "published";
  title: string;
  updatedAt: number;
  version: number;
  visibility: "private" | "protected" | "public";
}

export interface AdminAppealSummary {
  appellantHandle: string | null;
  appellantName: string;
  appellantUserId: string;
  caseId: string;
  caseStatus: AdminModerationCaseStatus;
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

export type AdminReportTarget =
  | { body: string | null; id: string; kind: "comment"; postId: string | null; revision: number | null }
  | { id: string; kind: "post"; revision: number | null; title: string | null }
  | {
      accountName: string | null;
      displayName: string | null;
      handle: string | null;
      id: string | null;
      kind: "user";
      publicUid: number | null;
    };

export interface AdminReportSummary {
  createdAt: number;
  detail: string | null;
  id: string;
  reasonCode: string;
  reporter: AdminAuditUser;
  resolutionReasonCode: string | null;
  resolvedAt: number | null;
  reviewer: Pick<AdminAuditUser, "accountName" | "id"> | null;
  status: AdminReportStatus;
  target: AdminReportTarget;
  updatedAt: number;
  version: number;
}

export interface AdminOperationSummary {
  id: string;
  actorName: string;
  action: string;
  targetKind: string;
  targetId: string;
  status: AdminOperationStatus;
  requestId: string;
  externalRef: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface AdminUsersResponse {
  users: AdminUserSummary[];
  nextCursor: string | null;
}

export interface AdminPostsResponse {
  posts: AdminPostSummary[];
  nextCursor: string | null;
}

export interface AdminAppealsResponse {
  appeals: AdminAppealSummary[];
  nextCursor: string | null;
}

export interface AdminReportsResponse {
  nextCursor: string | null;
  reports: AdminReportSummary[];
}

export interface AdminOperationsResponse {
  operations: AdminOperationSummary[];
  nextCursor: string | null;
}

export const isAdminSection = (value: string): value is AdminSection =>
  (adminSections as readonly string[]).includes(value);
