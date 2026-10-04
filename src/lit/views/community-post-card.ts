import { html, nothing } from "lit";
import { icon } from "../ui/icon";
import "../../styles/community-posts.css";

export interface CommunityPostCardView {
  href: string;
  title: string;
  hasMedia: boolean;
  media: unknown;
  forum: unknown;
  privateLabel?: string;
  status: unknown;
  excerpt: unknown;
  author: unknown;
  reaction: unknown;
}

/** Presentation only: the caller supplies authorized data and existing controls. */
export function communityPostCard(view: CommunityPostCardView) {
  return html`
    <article class=${`community-pin community-post-card${view.hasMedia ? "" : " community-post-card--text"}`}>
      ${
        view.hasMedia
          ? html`
              <a
                class="community-pin__link community-post-card__visual"
                href=${view.href}
                tabindex="-1"
                aria-hidden="true"
              >
                ${view.media}
              </a>
            `
          : nothing
      }
      <div class="community-pin__body">
        <div class="community-post-card__context">${view.forum}</div>
        ${
          view.privateLabel
            ? html`
                <span class="community-post-card__visibility">${icon("lock", 14)}${view.privateLabel}</span>
              `
            : nothing
        }
        <a class="community-post-card__text" href=${view.href} aria-label=${view.title}>
          <span class="community-pin__title">${view.title}</span>
          ${view.excerpt}
        </a>
        ${view.status}
      </div>
      <footer class="community-pin__meta">${view.author}${view.reaction}</footer>
    </article>
  `;
}
