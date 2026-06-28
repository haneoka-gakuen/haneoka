export type OAuthProvider = "discord" | "github" | "google" | "twitter";

export interface AuthPublicConfig {
  available: boolean;
  emailDeliveryEnabled: boolean;
  emailSignUpEnabled: boolean;
  providers: OAuthProvider[];
  turnstileSiteKey: string | null;
}

export type CommunityPostVisibility = "public" | "protected" | "private";
export type CommunityPostState = "active" | "archived";
export type CommunityPostScope = "all" | "bookmarked" | "following" | "latest" | "mine" | "recommended";
export type CommunityCommentSort = "hot" | "latest";
export type CommunityModerationStatus = "pending" | "allow" | "review" | "block";
export type CommunityAppealEntityKind = "attachment" | "comment" | "post" | "profile-name";
export type CommunityRole = "admin" | "member" | "moderator";
export type CommunityWorkKind = "chart" | "story";
export type CommunityGameAccountVerificationStatus = "pending" | "revoked" | "unverified" | "verified";
export type CommunityJsonPrimitive = boolean | null | number | string;
export type CommunityJsonValue = CommunityJsonPrimitive | CommunityJsonValue[] | { [key: string]: CommunityJsonValue };

export interface CommunityIpLocation {
  countryCode: string;
  regionCode: string | null;
  regionName: string | null;
}

export type CommunityBrowserFamily =
  | "arc"
  | "bot"
  | "brave"
  | "chrome"
  | "chromium"
  | "duckduckgo"
  | "edge"
  | "electron"
  | "firefox"
  | "floorp"
  | "helium"
  | "internet_explorer"
  | "librewolf"
  | "opera"
  | "opera_gx"
  | "other"
  | "safari"
  | "samsung_internet"
  | "tor"
  | "unknown"
  | "vivaldi"
  | "webview"
  | "yandex"
  | "zen";

export type CommunityOsFamily =
  | "alpine_linux"
  | "android"
  | "arch_linux"
  | "blackberry"
  | "centos"
  | "chromeos"
  | "debian"
  | "elementary"
  | "fedora"
  | "freebsd"
  | "fuchsia"
  | "gentoo"
  | "grapheneos"
  | "haiku"
  | "harmonyos"
  | "ios"
  | "kaios"
  | "kali_linux"
  | "lineageos"
  | "linux"
  | "linux_mint"
  | "macos"
  | "manjaro"
  | "netbsd"
  | "openbsd"
  | "opensuse"
  | "other"
  | "sailfish"
  | "ubuntu"
  | "unknown"
  | "wear_os"
  | "windows";

export interface CommunityDevice {
  browserFamily: CommunityBrowserFamily | null;
  osFamily: CommunityOsFamily | null;
}

export type CommunityRecommendationReason = "followed_author" | "followed_tag" | "popular" | "recent";

export interface CommunityAppealCreateResponse {
  appeal: {
    createdAt: number;
    entityId: string;
    entityKind: CommunityAppealEntityKind;
    entityRevision: number;
    id: string;
    statement: string;
    status: "pending";
    updatedAt: number;
    version: number;
  };
}

export interface CommunityPostAttachment {
  contentUrl: string;
  fileName: string;
  id: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "text/plain";
  position: number;
  size: number;
}

export interface CommunityPost {
  id: string;
  title: string;
  body: string;
  visibility: CommunityPostVisibility;
  moderationStatus: CommunityModerationStatus;
  attachments: CommunityPostAttachment[];
  state: CommunityPostState;
  tags: string[];
  pinnedAt: number | null;
  archivedAt: number | null;
  commentsLockedAt: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastEditedAt: number;
  device: CommunityDevice | null;
  ipLocation: CommunityIpLocation | null;
  commentCount: number;
  likeCount: number;
  authorUid: number;
  avatarSeed: string;
  authorName: string;
  authorImage: string | null;
  recommendationReason?: CommunityRecommendationReason | null;
}

export interface CommunityComment {
  id: string;
  body: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  lastEditedAt: number;
  version: number;
  likeCount: number;
  device: CommunityDevice | null;
  ipLocation: CommunityIpLocation | null;
  authorUid: number;
  avatarSeed: string;
  authorName: string;
  authorImage: string | null;
  moderationStatus: CommunityModerationStatus;
  viewer: {
    liked: boolean;
    canDelete: boolean;
    canEdit: boolean;
  };
}

export interface CommunityPostSummary extends Omit<CommunityPost, "body"> {
  excerpt: string;
  viewer: {
    canGiveFeedback: boolean;
  };
}

export interface CommunityPostListResponse {
  posts: CommunityPostSummary[];
  nextCursor: string | null;
  seed?: number;
}

export interface CommunityPostResponse {
  post: CommunityPost;
  comments: CommunityComment[];
  commentsNextCursor: string | null;
  commentsSort: CommunityCommentSort;
  viewer: {
    liked: boolean;
    bookmarked: boolean;
    canEdit: boolean;
    canComment: boolean;
    canDelete: boolean;
  };
}

export interface CommunityPostCreateInput {
  attachmentIds?: string[];
  body: string;
  title?: string;
  tags?: string[];
  visibility?: CommunityPostVisibility;
}

export interface CommunityPostUpdateInput {
  body: string;
  title?: string;
  tags?: string[];
  editReason?: string;
  version: number;
  visibility?: CommunityPostVisibility;
}

export interface CommunityPostListQuery {
  cursor?: string;
  limit?: number;
  q?: string;
  refresh?: true;
  seed?: number;
  scope?: CommunityPostScope;
  state?: "active" | "archived" | "all";
  tag?: string;
}

export interface CommunityCommentUpdateInput {
  body: string;
  editReason?: string;
  version: number;
}

export interface CommunityToggleInput {
  active: boolean;
}

export interface CommunityNotification {
  id: string;
  kind: "comment" | "comment_reaction" | "follow" | "mention" | "moderation" | "post_reaction" | "reply";
  postId: string | null;
  commentId: string | null;
  actorUid: number | null;
  actorAvatarSeed: string | null;
  actorName: string | null;
  actorImage: string | null;
  createdAt: number;
  readAt: number | null;
}

export type CommunityTagPreferenceState = "follow" | "mute" | null;

export interface CommunityTagSummary {
  description: string | null;
  displayName: string;
  followerCount: number;
  normalizedName: string;
  postCount: number;
  preference: CommunityTagPreferenceState;
}

export interface CommunityTagListResponse {
  tags: CommunityTagSummary[];
}

export interface CommunityRelationshipState {
  blocked: boolean;
  followedBy: boolean;
  following: boolean;
  muted: boolean;
}

export interface CommunityNotificationListResponse {
  notifications: CommunityNotification[];
  nextCursor: string | null;
  unreadCount: number;
}

export interface CommunityPublicProfile {
  avatarSeed: string;
  avatarUrl: string | null;
  bio: string | null;
  displayName: string | null;
  handle: string | null;
  joinedAt: number;
  owner: boolean;
  role: CommunityRole;
  stats: {
    followers: number;
    following: number;
    gameAccounts: number;
    posts: number;
    works: number;
  };
  uid: number;
}

export interface CommunityPublicProfilePost {
  commentCount: number;
  coverUrl: string | null;
  createdAt: number;
  excerpt: string;
  id: string;
  likeCount: number;
  tags: string[];
  title: string;
  updatedAt: number;
}

export interface CommunityPublicWork {
  coverUrl: string | null;
  id: string;
  kind: CommunityWorkKind;
  publishedAt: number;
  summary: string | null;
  title: string;
  updatedAt: number;
}

export interface CommunityPublicGameAccountSnapshot {
  capturedAt: number;
  summary: { [key: string]: CommunityJsonValue };
}

export interface CommunityPublicGameAccount {
  displayName: string | null;
  lastSyncedAt: number | null;
  latestSnapshot: CommunityPublicGameAccountSnapshot | null;
  playerUid: string;
  provider: string;
  region: string;
  updatedAt: number;
  verificationStatus: CommunityGameAccountVerificationStatus;
}

export interface CommunityPublicProfileResponse {
  gameAccounts: CommunityPublicGameAccount[];
  posts: CommunityPublicProfilePost[];
  postsNextCursor: string | null;
  profile: CommunityPublicProfile;
  viewer: CommunityRelationshipState & {
    canInteract: boolean;
  };
  works: CommunityPublicWork[];
}
