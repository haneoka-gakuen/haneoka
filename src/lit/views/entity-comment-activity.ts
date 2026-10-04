import { html, nothing } from "lit";
import { icon } from "../ui/icon";
import { renderCommunityComment, type CommentContentView } from "./community-comment-content";
import "../../styles/detail-comments.css";

export interface EntityCommentActivityView {
  contextLabel: string;
  targetTitle: string;
  targetHref: string;
  targetIcon?: string;
  referenceLabel?: string;
  privateLabel?: string;
  comment: CommentContentView;
}

/** One canonical comment in the recommendation stream, using the same complete row as its detail. */
export function renderEntityCommentActivity(view: EntityCommentActivityView) {
  return html`
    <article class="surface entity-comment-tile">
      <div class="entity-comment-context">
        <span>${view.contextLabel}</span>
        ${view.targetHref
          ? html`<a href=${view.targetHref}>${view.targetIcon ? icon(view.targetIcon, 16) : nothing}${view.targetTitle}</a>`
          : html`<span>${view.targetTitle}</span>`}
        ${
          view.privateLabel
            ? html`
                <span class="chip">${icon("lock", 14)}${view.privateLabel}</span>
              `
            : nothing
        }
      </div>
      ${
        view.referenceLabel
          ? html`
              <div class="entity-comment-reference">${view.referenceLabel}</div>
            `
          : nothing
      }
      ${renderCommunityComment(view.comment)}
    </article>
  `;
}
