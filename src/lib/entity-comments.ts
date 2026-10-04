export interface CommunityEntityTarget {
  entityType: string;
  originalId: string;
}
export interface EntityDescriptor {
  type: string;
  originalId: string;
  titles: Record<string, string>;
  availability: Record<string, "present" | "absent" | "unknown">;
  locators: Record<string, unknown>;
  availableServers: string[];
  detailPaths: Record<string, string>;
}
export interface EntityThread {
  id: string;
  forumId: string;
  commentCount: number;
}
export interface EntityComment {
  id: string;
  threadId?: string;
  body: string;
  floor: number;
  version: number;
  parentId: string | null;
  rootId?: string;
  authorUid: string;
  authorName: string;
  authorImage?: string | null;
  createdAt: number;
  lastEditedAt?: number;
  likeCount: number;
  moderationStatus?: string;
  replyCount?: number;
  replyCursor?: string | null;
  viewer: { liked: boolean; canLike?: boolean; canEdit?: boolean; canDelete?: boolean; canReport?: boolean };
}
export interface EntityCommentsResponse {
  entity: EntityDescriptor;
  thread: EntityThread | null;
  comments: EntityComment[];
  commentCount: number;
  nextCursor: string | null;
  sort: "hot" | "latest";
  focusedCommentId?: string | null;
  focusedRootId?: string | null;
  replyCursor?: string | null;
  viewer: { canComment: boolean };
}
export function entityThreadEndpoint(target: CommunityEntityTarget): string {
  return (
    "/api/v1/community/entity-threads/" +
    encodeURIComponent(target.entityType) +
    "/" +
    encodeURIComponent(target.originalId)
  );
}
