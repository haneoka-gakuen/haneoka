import { html, nothing } from "lit";
import "../../styles/community.css";

/** Shared community comment row. Callers supply authorized content and actions. */
export interface CommunityCommentView {
  id: string;
  name: string;
  authorHref: string;
  avatar: unknown;
  reply?: boolean;
  focused?: boolean;
  authorMark?: unknown;
  headerActions: unknown;
  body: unknown;
  context: unknown;
  actions: unknown;
}

export function communityComment(view: CommunityCommentView) {
  return html`
    <article
      class=${`community-comment${view.reply ? " is-reply" : ""}`}
      id=${`comment-${view.id}`}
      data-comment-id=${view.focused === undefined ? nothing : view.id}
      data-comment-target=${view.focused === undefined ? nothing : String(view.focused)}
      tabindex=${view.focused ? "-1" : nothing}
    >
      <a href=${view.authorHref} aria-label=${view.name}>${view.avatar}</a>
      <div class="community-comment__main">
        <header>
          <a class="community-comment__name" href=${view.authorHref}>${view.name}</a>
          ${view.authorMark ?? nothing}
          <span class="community-comment__actions">${view.headerActions}</span>
        </header>
        ${view.body}
        <div class="community-comment__context">${view.context}</div>
        <footer>${view.actions}</footer>
      </div>
    </article>
  `;
}
