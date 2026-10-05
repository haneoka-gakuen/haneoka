import { html, nothing } from "lit";
import { modal } from "../ui/modal";
import { repeat } from "lit/directives/repeat.js";
import { live } from "lit/directives/live.js";
import type { EntityComment } from "../../lib/entity-comments";
import type {
  EntityCommentsViewProps as Props,
  EntityCommentsViewActions as Actions,
} from "../../lib/community-view-contract";
import { registerEntityCommentsPresentation } from "../../lib/entity-comments-presentation";
import { segmented } from "../ui/controls";
import { icon } from "../ui/icon";
import { asyncRegion } from "../ui/async-region";
import {
  renderCommunityComment,
  renderCommentComposer,
  renderCommentReplies,
  commentAuthorName,
} from "./community-comment-content";
import "./community-comment-actions";
import "../../styles/detail-comments.css";

const value = (event: Event) => (event.currentTarget as HTMLInputElement).value;
type RichProps = Props;
type RichActions = Actions;

function commentView(comment: EntityComment, props: RichProps, actions: RichActions, reply = false) {
  const parent = props.threads
    .flatMap((thread) => [thread.root, ...thread.replies])
    .find((entry) => entry.id === comment.parentId);
  const editing = props.editing?.id === comment.id ? props.editing : undefined;
  return renderCommunityComment({
    record: comment,
    locale: props.locale,
    label: props.label,
    authorHref: props.authorHref(comment),
    reply,
    focused: comment.id === props.focusedCommentId,
    replyToName: reply && parent?.parentId ? commentAuthorName(parent, props.label) : undefined,
    canReply: props.canComment || !props.signedIn,
    allowStickers: true,
    editing: editing
      ? {
          body: editing.body,
          busy: Boolean(props.busy),
          onBody: actions.editBody,
          onSave: actions.saveEdit,
          onCancel: actions.cancelEdit,
        }
      : undefined,
    actions: {
      like: () => actions.like(comment.id),
      reply: () => (props.signedIn ? actions.reply(comment.id) : actions.signIn()),
      edit: () => actions.edit(comment.id),
      report: () => actions.report(comment.id),
      appeal: actions.appeal ? () => actions.appeal!(comment.id) : undefined,
      remove: () => actions.remove(comment.id),
    },
  });
}
function composer(props: RichProps, actions: RichActions) {
  return html`
    <div class="entity-comments__composer">
      ${renderCommentComposer({
        locale: props.locale,
        label: props.label,
        body: props.body,
        open: props.composerOpen,
        allowStickers: true,
        signedIn: props.signedIn,
        canComment: props.canComment,
        busy: Boolean(props.busy),
        sending: props.busy === "publish",
        replyName: props.replyTo ? commentAuthorName(props.replyTo, props.label) : undefined,
        onSignIn: actions.signIn,
        onOpen: actions.openComposer,
        onClose: actions.closeComposer,
        onCancelReply: actions.cancelReply,
        onBody: actions.body,
        onSubmit: actions.submit,
      })}
    </div>
  `;
}

function dialogView(props: Props, actions: Actions) {
  const dialog = props.dialog;
  if (!dialog) return nothing;
  const reporting = dialog.kind === "report";
  const appealing = dialog.kind === "appeal";
  const title = reporting
    ? props.label("reportDialog.title", "Report")
    : appealing
      ? props.label("appeal", "Appeal")
      : props.label("delete", "Delete");
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
    <dialog
      ${modal(() => { if (!props.busy) actions.closeDialog(); })}
      aria-label=${title}
      class="dialog-host community-dialog-scrim"
      @click=${() => {
        if (!props.busy) actions.closeDialog();
      }}
    >
      <section
        class="community-dialog surface"
        data-entity-comment-dialog
        tabindex="-1"
        @click=${(event: Event) => event.stopPropagation()}
      >
        <header>
          <span>${icon(reporting ? "flag" : appealing ? "gavel" : "delete", 22)}</span>
          <div>
            <h2>${title}</h2>
            <small>${props.title}</small>
          </div>
          <button
            class="icon-button"
            type="button"
            aria-label=${props.label("close", "Close")}
            @click=${actions.closeDialog}
          >
            ${icon("close", 20)}
          </button>
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
              : appealing
                ? html`
                    <md-outlined-text-field
                      type="textarea"
                      rows="4"
                      maxlength="5000"
                      required
                      .value=${live(dialog.details)}
                      label=${props.label("appealStatement", "Appeal statement")}
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
              class=${reporting || appealing ? "button" : "button button--danger"}
              type="submit"
              ?disabled=${Boolean(props.busy) || ((appealing || (reporting && dialog.reason === "other")) && !dialog.details.trim())}
            >
              ${reporting ? props.label("reportDialog.submit", "Submit report") : appealing ? props.label("submitAppeal", "Submit appeal") : title}
            </button>
          </footer>
        </form>
      </section>
    </dialog>
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
            ${renderCommentReplies({
              label: props.label,
              expanded: thread.expanded,
              hasMore: thread.hasMore,
              remaining: thread.remaining,
              loading: thread.loading,
              onToggle: () => actions.expand(thread.root.id),
              onMore: thread.root.replyCursor ? () => actions.moreReplies(thread.root.id) : undefined,
            })}
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
          ${props.commentCount === null ? props.label("comments", "Comments") : props.label("commentCount", "{count} comments").replace("{count}", props.commentCount.toLocaleString(props.locale))}
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
