import { html, nothing } from "lit";
import type { MessageParams } from "@haneoka/i18n";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { communityMarkup, communityExcerpt } from "../../lib/community-markup";
import { communityCommentName, communityCommentLocation } from "../../lib/community-comment-metadata";
import { formatCommunityTime, isEdited } from "../../lib/community-time";
import { communityComment } from "./community-comment";
import { icon } from "../ui/icon";
import type { CommentMenuAction } from "./community-comment-actions";
import "./community-comment-actions";
import "../ui/comment-editor";
import "../community-sticker";

export type CommentLabel = (key: string, fallback: string, params?: MessageParams) => string;
export interface CommentRecord {
  id?: unknown;
  body?: unknown;
  floor?: unknown;
  author?: unknown;
  authorName?: unknown;
  authorImage?: unknown;
  createdAt?: unknown;
  lastEditedAt?: unknown;
  ipLocation?: unknown;
  moderationStatus?: unknown;
  likeCount?: unknown;
  viewer?: unknown;
}
export interface CommentEditView {
  body: string;
  busy: boolean;
  onBody: (body: string) => void;
  onSave: (event: Event) => void;
  onCancel: () => void;
}
export interface CommentActions {
  like: () => void;
  reply?: () => void;
  edit?: () => void;
  report?: () => void;
  appeal?: () => void;
  remove?: () => void;
}
export interface CommentContentView {
  record: CommentRecord;
  locale: string;
  label: CommentLabel;
  authorHref: string;
  authorMark?: string;
  reply?: boolean;
  replyToName?: string;
  focused?: boolean;
  canReply?: boolean;
  allowStickers?: boolean;
  preview?: boolean;
  editing?: CommentEditView;
  actions: CommentActions;
}

const fields = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export function commentAuthorName(record: CommentRecord, label: CommentLabel) {
  const displayName = fields(record.author).displayName;
  return communityCommentName(
    {
      authorName: typeof record.authorName === "string" ? record.authorName : undefined,
      author: typeof displayName === "string" ? { displayName } : undefined,
    },
    label("member", "Member"),
  );
}
export const commentIpLocation = communityCommentLocation;
function time(value: unknown, locale: string) {
  const result = formatCommunityTime(value, locale);
  return result
    ? html`
        <time datetime=${result.dateTime} title=${result.title} aria-label=${result.title}>${result.text}</time>
      `
    : nothing;
}
function editor(
  value: string,
  locale: string,
  label: CommentLabel,
  onBody: (body: string) => void,
  allowStickers = true,
  focusOnReady = false,
) {
  return html`
    <community-comment-editor
      .value=${value}
      .locale=${locale}
      .maxLength=${5000}
      .labels=${(key: string, fallback = key, params?: MessageParams) => label(key, fallback, params)}
      .allowStickers=${allowStickers}
      .focusOnReady=${focusOnReady}
      .loadingLabel=${label("loading", "Loading")}
      .errorLabel=${label("unavailable", "Unavailable")}
      .retryLabel=${label("retry", "Retry")}
      @body-change=${(event: CustomEvent<string>) => onBody(event.detail)}
    ></community-comment-editor>
  `;
}
export function renderCommunityComment(view: CommentContentView) {
  const { record, label, actions } = view;
  const viewer = fields(record.viewer),
    name = commentAuthorName(record, label);
  const id = String(record.id || ""),
    floor = Number(record.floor);
  const floorLabel =
    Number.isSafeInteger(floor) && floor > 0
      ? label("commentFloor", "Floor {floor}").replace("{floor}", String(floor))
      : "";
  const location = commentIpLocation(record.ipLocation, view.locale);
  const menu: CommentMenuAction[] = [
    ...(viewer.canEdit && actions.edit ? [{ label: label("edit", "Edit"), icon: "edit", run: actions.edit }] : []),
    ...(viewer.canReport !== false && actions.report
      ? [{ label: label("report", "Report"), icon: "flag", run: actions.report }]
      : []),
    ...(record.moderationStatus === "block" && viewer.canEdit && actions.appeal
      ? [{ label: label("appeal", "Appeal"), icon: "gavel", run: actions.appeal }]
      : []),
    ...(viewer.canDelete && actions.remove
      ? [{ label: label("delete", "Delete"), icon: "delete", run: actions.remove }]
      : []),
  ];
  const editing = viewer.canEdit ? view.editing : undefined;
  return communityComment({
    id,
    name,
    authorHref: view.authorHref,
    reply: view.reply,
    focused: view.focused,
    avatar: html`
      <span class=${`community-avatar community-avatar--${view.reply ? 28 : 40}`} aria-hidden="true">
        ${
          record.authorImage
            ? html`
                <img src=${String(record.authorImage)} alt="" loading="lazy" decoding="async" />
              `
            : name.slice(0, 1)
        }
      </span>
    `,
    authorMark: view.authorMark
      ? html`
          <span class="community-comment__author-mark">${view.authorMark}</span>
        `
      : nothing,
    headerActions: html`
      ${
        floorLabel
          ? html`
              <span class="community-comment__floor" aria-label=${floorLabel}>${floorLabel}</span>
            `
          : nothing
      }
      <community-comment-actions
        .label=${label("commentActions", "Comment actions")}
        .closeLabel=${label("close", "Close")}
        .actions=${menu}
      ></community-comment-actions>
    `,
    body: editing
      ? html`
          <form class="community-comment-edit" @submit=${editing.onSave}>
            ${editor(editing.body, view.locale, label, editing.onBody, view.allowStickers !== false, true)}
            <div class="dialog-actions">
              <button class="button button--text" type="button" @click=${editing.onCancel}>
                ${label("cancel", "Cancel")}
              </button>
              <button
                class="button button--tonal"
                type="submit"
                ?disabled=${editing.busy || !editing.body.trim() || editing.body.length > 5000}
              >
                ${label("save", "Save")}
              </button>
            </div>
          </form>
        `
      : html`
          <div class=${`community-bbcode community-comment__body${view.preview ? " community-comment__body--preview" : ""}`}>
            ${
              view.replyToName
                ? html`
                    <span class="community-comment__reply-name">
                      ${label("replyingTo", "Replying to")} ${view.replyToName}
                    </span>
                  `
                : nothing
            }
            ${view.preview
              ? communityExcerpt(String(record.body || ""))
              : unsafeHTML(communityMarkup(String(record.body || ""), label("spoiler", "Spoiler"), view.locale, { allowStickers: view.allowStickers !== false }))}
          </div>
        `,
    context: html`
      ${time(record.createdAt, view.locale)}
      ${
        isEdited({ createdAt: record.createdAt, lastEditedAt: record.lastEditedAt })
          ? html`
              <span>${label("lastEdited", "Last edited")} ${time(record.lastEditedAt, view.locale)}</span>
            `
          : nothing
      }
      ${
        location
          ? html`
              <span>${label("ipLocation", "IP location")}: ${location}</span>
            `
          : nothing
      }
      ${
        record.moderationStatus && record.moderationStatus !== "allow"
          ? html`
              <span role="status">
                ${label(record.moderationStatus === "block" ? "moderationBlocked" : "moderationPending", "Reviewing")}
              </span>
            `
          : nothing
      }
    `,
    actions: html`
      <button
        type="button"
        aria-label=${label(viewer.liked ? "unlike" : "like", "Like")}
        aria-pressed=${String(Boolean(viewer.liked))}
        ?disabled=${viewer.canLike === false}
        @click=${actions.like}
      >
        ${icon(viewer.liked ? "favorite-filled" : "favorite_border", 18)}
        <span>${Number(record.likeCount || 0) || label("like", "Like")}</span>
      </button>
      ${
        view.canReply !== false && actions.reply
          ? html`
              <button type="button" @click=${actions.reply}>
                ${icon("chat_bubble_outline", 18)}${label("reply", "Reply")}
              </button>
            `
          : nothing
      }
    `,
  });
}

export interface CommentComposerView {
  locale: string;
  label: CommentLabel;
  body: string;
  open: boolean;
  signedIn: boolean;
  canComment: boolean;
  busy: boolean;
  sending: boolean;
  replyName?: string;
  allowStickers?: boolean;
  onSignIn: () => void;
  onOpen?: () => void;
  onClose?: () => void;
  onCancelReply: () => void;
  onBody: (body: string) => void;
  onSubmit: (event: Event) => void;
}
export function renderCommentComposer(view: CommentComposerView) {
  const { label } = view;
  if (!view.signedIn)
    return html`
      <div class="community-engagement">
        <button class="button button--tonal" type="button" @click=${view.onSignIn}>
          ${label("signInToComment", "Sign in to comment")}
        </button>
      </div>
    `;
  if (!view.canComment)
    return html`
      <p class="community-comments__empty">${label("commentsClosed", "Comments are closed for this post")}</p>
    `;
  if (!view.open && view.onOpen)
    return html`
      <div class="community-engagement">
        <button class="community-comment-prompt" type="button" @click=${view.onOpen}>
          ${icon("edit", 20)}
          <span>${label("writeComment", "Write a comment")}</span>
        </button>
      </div>
    `;
  return html`
    <form class="community-comment-form" @submit=${view.onSubmit}>
      ${
        view.replyName
          ? html`
              <div class="community-reply-banner">
                <span>${label("replyingTo", "Replying to")} · ${view.replyName}</span>
                <button
                  class="icon-button"
                  type="button"
                  aria-label=${label("cancel", "Cancel")}
                  @click=${view.onCancelReply}
                >
                  ${icon("close", 20)}
                </button>
              </div>
            `
          : nothing
      }
      ${editor(view.body, view.locale, label, view.onBody, view.allowStickers !== false)}
      <div class="community-comment-form__actions">
        ${
          view.onClose
            ? html`
                <button class="button button--text" type="button" @click=${view.onClose}>
                  ${label("cancel", "Cancel")}
                </button>
              `
            : nothing
        }
        <button class="button" type="submit" ?disabled=${view.busy || !view.body.trim() || view.body.length > 5000}>
          ${icon("send", 18)}${label(view.sending ? "publishing" : "comment", view.sending ? "Publishing…" : "Comment")}
        </button>
      </div>
    </form>
  `;
}

export interface CommentRepliesView {
  label: CommentLabel;
  expanded: boolean;
  hasMore: boolean;
  remaining?: number;
  loading: boolean;
  onToggle: () => void;
  onMore?: () => void;
}
export function renderCommentReplies(view: CommentRepliesView) {
  const moreLabel =
    typeof view.remaining === "number" && view.remaining > 0
      ? view.label("expandReplies", "Show {count} more replies").replace("{count}", String(view.remaining))
      : view.label("loadMoreComments", "Load more comments");
  return html`
    ${
      view.hasMore || view.expanded
        ? html`
            <button
              class="button button--text community-replies-toggle"
              type="button"
              aria-expanded=${String(view.expanded)}
              aria-busy=${String(view.loading)}
              ?disabled=${view.loading}
              @click=${view.onToggle}
            >
              ${view.expanded ? view.label("collapseReplies", "Collapse replies") : moreLabel}${icon(view.expanded ? "expand_less" : "expand_more", 18)}
            </button>
          `
        : nothing
    }
    ${
      view.expanded && view.onMore
        ? html`
            <button
              class="button button--text community-replies-toggle"
              type="button"
              aria-busy=${String(view.loading)}
              ?disabled=${view.loading}
              @click=${view.onMore}
            >
              ${moreLabel}${icon("expand_more", 18)}
            </button>
          `
        : nothing
    }
  `;
}
