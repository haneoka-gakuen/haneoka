import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { live } from "lit/directives/live.js";
import type { EntityComment } from "../../lib/entity-comments";
import type {
  EntityCommentsViewProps as Props,
  EntityCommentsViewActions as Actions,
} from "../../lib/community-view-contract";
import { registerEntityCommentsPresentation } from "../../lib/entity-comments-presentation";
import { isEdited } from "../../lib/community-time";
import { segmented } from "../ui/controls";
import { icon } from "../ui/icon";
import { asyncRegion } from "../ui/async-region";
import { communityComment } from "./community-comment";
import "./community-comment-actions";
import "../../styles/detail-comments.css";

const value = (event: Event) => (event.currentTarget as HTMLInputElement).value;
const timestamp = (props: Props, input: unknown) => {
  const time = props.time(input);
  return time
    ? html`
        <time datetime=${time.dateTime} title=${time.title}>${time.text}</time>
      `
    : nothing;
};

function commentView(comment: EntityComment, props: Props, actions: Actions, reply = false) {
  const name = comment.authorName || props.label("member", "Member");
  const editing = props.editing?.id === comment.id ? props.editing : null;
  const floor = props.label("commentFloor", "Floor {floor}").replace("{floor}", String(comment.floor));
  const menu = [
    ...(comment.viewer.canEdit
      ? [{ label: props.label("edit", "Edit"), icon: "edit", run: () => actions.edit(comment.id) }]
      : []),
    ...(comment.viewer.canReport
      ? [{ label: props.label("report", "Report"), icon: "flag", run: () => actions.report(comment.id) }]
      : []),
    ...(comment.viewer.canDelete
      ? [{ label: props.label("delete", "Delete"), icon: "delete", run: () => actions.remove(comment.id) }]
      : []),
  ];
  return communityComment({
    id: comment.id,
    name,
    authorHref: props.authorHref(comment),
    reply,
    focused: comment.id === props.focusedCommentId,
    avatar: html`
      <span class=${`community-avatar community-avatar--${reply ? 28 : 40}`} aria-hidden="true">
        ${
          comment.authorImage
            ? html`
                <img src=${comment.authorImage} alt="" loading="lazy" decoding="async" />
              `
            : name.slice(0, 1)
        }
      </span>
    `,
    headerActions: html`
      <span class="community-comment__floor" aria-label=${floor}>${floor}</span>
      <community-comment-actions
        .label=${props.label("commentActions", "Comment actions")}
        .closeLabel=${props.label("close", "Close")}
        .actions=${menu}
      ></community-comment-actions>
    `,
    body: html`
      ${
        editing
          ? html`
              <form class="community-comment-edit" @submit=${actions.saveEdit}>
                <textarea
                  class="text-area"
                  .value=${live(editing.body)}
                  @input=${(event: Event) => actions.editBody(value(event))}
                  aria-label=${props.label("edit", "Edit")}
                  maxlength="5000"
                  required
                ></textarea>
                <div class="dialog-actions">
                  <button class="button button--text" type="button" @click=${actions.cancelEdit}>
                    ${props.label("cancel", "Cancel")}
                  </button>
                  <button
                    class="button button--tonal"
                    type="submit"
                    ?disabled=${Boolean(props.busy) || !editing.body.trim()}
                  >
                    ${props.label("save", "Save")}
                  </button>
                </div>
              </form>
            `
          : html`
              <div class="community-comment__body entity-comments__text">${comment.body}</div>
            `
      }
    `,
    context: html`
      ${timestamp(props, comment.createdAt)}
      ${
        isEdited({ ...comment })
          ? html`
              <span>${props.label("lastEdited", "Last edited")} ${timestamp(props, comment.lastEditedAt)}</span>
            `
          : nothing
      }
      ${
        comment.moderationStatus && comment.moderationStatus !== "allow"
          ? html`
              <span role="status">
                ${props.label(comment.moderationStatus === "block" ? "moderationBlocked" : "moderationPending", "Reviewing")}
              </span>
            `
          : nothing
      }
    `,
    actions: html`
      <button
        type="button"
        aria-label=${props.label(comment.viewer.liked ? "unlike" : "like", "Like")}
        aria-pressed=${String(comment.viewer.liked)}
        ?disabled=${comment.viewer.canLike === false}
        @click=${() => actions.like(comment.id)}
      >
        ${icon(comment.viewer.liked ? "favorite-filled" : "favorite_border", 18)}
        <span>${comment.likeCount || props.label("like", "Like")}</span>
      </button>
      ${
        props.canComment || !props.signedIn
          ? html`
              <button type="button" @click=${() => (props.signedIn ? actions.reply(comment.id) : actions.signIn())}>
                ${icon("chat_bubble_outline", 18)}${props.label("reply", "Reply")}
              </button>
            `
          : nothing
      }
    `,
  });
}

function composer(props: Props, actions: Actions) {
  if (!props.signedIn)
    return html`
      <div class="entity-comments__composer">
        <button class="button button--tonal" type="button" @click=${actions.signIn}>
          ${props.label("signInToComment", "Sign in to comment")}
        </button>
      </div>
    `;
  if (!props.canComment)
    return html`
      <p class="entity-comments__status">${props.label("commentsClosed", "Comments are closed for this post")}</p>
    `;
  return html`
    <form class="entity-comments__composer community-comment-form" @submit=${actions.submit}>
      ${
        props.replyTo
          ? html`
              <div class="community-comment-form__actions">
                <span>
                  ${props.label("replyingTo", "Replying to")} ${props.replyTo.authorName} · #${props.replyTo.floor}
                </span>
                <button class="button button--text" type="button" @click=${actions.cancelReply}>
                  ${props.label("cancel", "Cancel")}
                </button>
              </div>
            `
          : nothing
      }
      <md-outlined-text-field
        type="textarea"
        rows="3"
        maxlength="5000"
        required
        label=${props.label("commentPlaceholder", "Write a comment")}
        .value=${live(props.body)}
        @input=${(event: Event) => actions.body(value(event))}
      ></md-outlined-text-field>
      <div class="community-comment-form__actions">
        <button
          class="button button--tonal"
          type="submit"
          ?disabled=${Boolean(props.busy) || !props.body.trim() || props.body.length > 5000}
        >
          ${props.busy === "publish" ? props.label("publishing", "Publishing…") : props.label("comment", "Comment")}
        </button>
      </div>
    </form>
  `;
}

function dialogView(props: Props, actions: Actions) {
  const dialog = props.dialog;
  if (!dialog) return nothing;
  const reporting = dialog.kind === "report";
  const title = reporting ? props.label("reportDialog.title", "Report") : props.label("delete", "Delete");
  const reasons = [
    "spam",
    "harassment",
    "hate",
    "sexual",
    "violence",
    "privacy",
    "copyright",
    "misinformation",
    "other",
  ];
  return html`
    <div
      class="dialog-host community-dialog-scrim"
      @click=${() => {
        if (!props.busy) actions.closeDialog();
      }}
    >
      <section
        class="community-dialog surface"
        data-entity-comment-dialog
        role="dialog"
        aria-modal="true"
        aria-label=${title}
        tabindex="-1"
        @click=${(event: Event) => event.stopPropagation()}
      >
        <header>
          <span>${icon(reporting ? "flag" : "delete", 22)}</span>
          <h2>${title}</h2>
        </header>
        <form @submit=${actions.submitDialog}>
          ${
            reporting
              ? html`
                  <md-outlined-select
                    label=${props.label("reportDialog.reason", "Reason")}
                    .value=${dialog.reason}
                    required
                    @change=${(event: Event) => actions.reason(value(event))}
                  >
                    ${reasons.map(
                      (reason) => html`
                        <md-select-option value=${reason} ?selected=${reason === dialog.reason}>
                          <div slot="headline">${props.label(`reportDialog.reasons.${reason}`, reason)}</div>
                        </md-select-option>
                      `,
                    )}
                  </md-outlined-select>
                  <md-outlined-text-field
                    type="textarea"
                    rows="4"
                    maxlength="5000"
                    .value=${live(dialog.details)}
                    label=${props.label("reportDialog.details", "Details")}
                    ?required=${dialog.reason === "other"}
                    supporting-text=${dialog.reason === "other" ? props.label("reportDialog.detailsOtherHint", "Details are required when you choose Other.") : props.label("reportDialog.detailsHint", "Describe what happened if helpful.")}
                    @input=${(event: Event) => actions.details(value(event))}
                  ></md-outlined-text-field>
                `
              : html`
                  <p class="community-dialog__warning">
                    ${props.label("deleteCommentConfirm", "This comment will be removed and cannot be restored.")}
                  </p>
                `
          }
          ${
            props.error
              ? html`
                  <div class="inline-message error" role="alert">${props.error}</div>
                `
              : nothing
          }
          <footer>
            <button
              class="button button--text"
              type="button"
              ?disabled=${Boolean(props.busy)}
              @click=${actions.closeDialog}
            >
              ${props.label("cancel", "Cancel")}
            </button>
            <button
              class=${reporting ? "button" : "button button--danger"}
              type="submit"
              ?disabled=${Boolean(props.busy) || (reporting && dialog.reason === "other" && !dialog.details.trim())}
            >
              ${reporting ? props.label("reportDialog.submit", "Submit report") : title}
            </button>
          </footer>
        </form>
      </section>
    </div>
  `;
}

export function entityCommentsView(props: Props, actions: Actions) {
  const content = html`
    <div class="entity-comments__list">
      ${repeat(
        props.threads,
        (thread) => thread.root.id,
        (thread) => html`
          <div class="community-comment-thread">
            ${commentView(thread.root, props, actions)}
            ${
              thread.replies.length
                ? html`
                    <div class="community-comment-replies">
                      ${repeat(
                        thread.replies,
                        (reply) => reply.id,
                        (reply) => commentView(reply, props, actions, true),
                      )}
                    </div>
                  `
                : nothing
            }
            ${
              thread.hasMore || thread.expanded
                ? html`
                    <button
                      class="button button--text community-replies-toggle"
                      type="button"
                      aria-expanded=${String(thread.expanded)}
                      ?disabled=${thread.loading}
                      @click=${() => actions.expand(thread.root.id)}
                    >
                      ${thread.expanded ? props.label("collapseReplies", "Collapse replies") : props.label("expandReplies", "Show {count} more replies").replace("{count}", String(thread.remaining ?? ""))}
                      ${icon(thread.expanded ? "expand_less" : "expand_more", 18)}
                    </button>
                  `
                : nothing
            }
            ${
              thread.expanded && thread.root.replyCursor
                ? html`
                    <button
                      class="button button--text community-replies-toggle"
                      type="button"
                      ?disabled=${thread.loading}
                      @click=${() => actions.moreReplies(thread.root.id)}
                    >
                      ${props.label("loadMoreComments", "Load more comments")}${icon("expand_more", 18)}
                    </button>
                  `
                : nothing
            }
          </div>
        `,
      )}
      ${
        !props.threads.length
          ? html`
              <p class="entity-comments__status">${props.label("noComments", "No comments yet.")}</p>
            `
          : nothing
      }
    </div>
    ${
      props.hasMore
        ? html`
            <button class="button button--text" type="button" ?disabled=${props.loadingMore} @click=${actions.more}>
              ${props.label("loadMoreComments", "Load more comments")}
            </button>
          `
        : nothing
    }
    ${composer(props, actions)}
  `;
  return html`
    <section class="entity-comments" aria-label=${props.label("comments", "Comments")}>
      <header class="entity-comments__header community-comments__heading">
        <h2>
          ${props.label("comments", "Comments")}${
            props.commentCount === null
              ? nothing
              : html`
                  <span>${props.commentCount.toLocaleString(props.locale)}</span>
                `
          }
        </h2>
        <div class="community-comment-sort">
          ${segmented({
            label: props.label("sort", "Sort"),
            value: props.sort,
            options: [
              { value: "hot", label: props.label("commentSortPopular", "Hot") },
              { value: "latest", label: props.label("commentSortLatest", "Latest") },
            ],
            onSelect: actions.sort,
          })}
        </div>
      </header>
      ${
        props.message
          ? html`
              <p class="inline-message" role="status">${props.message}</p>
            `
          : nothing
      }
      ${asyncRegion(props.phase === "loading" ? { state: "initial", label: props.label("loading", "Loading…"), local: true, layout: "list" } : props.phase === "error" || (props.error && !props.dialog) ? { state: "error", message: props.error, retryLabel: props.label("retry", "Retry"), onRetry: actions.refresh, retainedContent: props.phase === "ready" ? content : nothing } : { state: props.refreshing ? "refreshing" : "ready", content })}
      ${dialogView(props, actions)}
    </section>
  `;
}

registerEntityCommentsPresentation(entityCommentsView);
