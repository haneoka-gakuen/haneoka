import type { TemplateResult } from "lit";
import type { CommunityTime } from "./community-time";
import type { CommunityForum, ForumGroup } from "./community-forums";
import type { EntityComment, EntityThread } from "./entity-comments";

export type CommunityValue = Record<string, unknown>;
export type CommunityVisibility = "public" | "protected" | "private";

/** Supplied by the business controller from the current authorized DTO. */
export interface CommunityPostView {
  post: CommunityValue;
  viewer: CommunityValue;
  href: string;
  authorHref: string;
  media: readonly CommunityValue[];
  visibility: CommunityVisibility;
  adminPrivate: boolean;
  privateLabel: string | null;
  forum: CommunityForum | null;
}

export interface CommunityWorkspaceView {
  locale: string;
  mode: string;
  routeKind: string;
  phase: "loading" | "ready" | "error";
  refreshing: boolean;
  loadingMore: boolean;
  error: string;
  message: string;
  busy: boolean;
  items: readonly CommunityValue[];
  document: CommunityValue | null;
  currentForum: CommunityForum | null;
  forums: readonly CommunityForum[];
  forumGroups: readonly ForumGroup[];
  postView(post: CommunityValue): CommunityPostView;
  likePost(post: CommunityValue): void;
  likeComment(comment: CommunityValue): void;
  bookmarkPost(post: CommunityValue): void;
  reply(commentId?: string): void;
  refresh(): void;
  retry(): void;
}

export interface EntityCommentThreadView {
  root: EntityComment;
  replies: readonly EntityComment[];
  expanded: boolean;
  hasMore: boolean;
  remaining?: number;
  loading: boolean;
}

export interface EntityCommentsViewProps {
  locale: string;
  phase: "loading" | "ready" | "error";
  refreshing: boolean;
  loadingMore: boolean;
  thread: EntityThread | null;
  title: string;
  commentCount: number | null;
  sort: "hot" | "latest";
  threads: readonly EntityCommentThreadView[];
  focusedCommentId: string;
  signedIn: boolean;
  canComment: boolean;
  body: string;
  replyTo: EntityComment | null;
  editing: { id: string; body: string; version: number } | null;
  dialog: { kind: "delete" | "report"; id: string; reason: string; details: string } | null;
  busy: string;
  error: string;
  message: string;
  hasMore: boolean;
  label(key: string, fallback: string): string;
  time(value: unknown): CommunityTime | null;
  authorHref(comment: EntityComment): string;
}

export interface EntityCommentsViewActions {
  signIn(): void;
  refresh(): void;
  sort(value: "hot" | "latest"): void;
  more(): void;
  expand(rootId: string): void;
  moreReplies(rootId: string): void;
  like(commentId: string): void;
  reply(commentId: string): void;
  cancelReply(): void;
  body(value: string): void;
  submit(event: Event): void;
  edit(commentId: string): void;
  editBody(value: string): void;
  saveEdit(event: Event): void;
  cancelEdit(): void;
  remove(commentId: string): void;
  report(commentId: string): void;
  reason(value: string): void;
  details(value: string): void;
  submitDialog(event: Event): void;
  closeDialog(): void;
}

export type EntityCommentsPresentation = (
  props: EntityCommentsViewProps,
  actions: EntityCommentsViewActions,
) => TemplateResult;
