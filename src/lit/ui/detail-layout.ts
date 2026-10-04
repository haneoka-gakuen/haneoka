import { html, nothing, type TemplateResult } from "lit";

/** Optional discussion slot; existing two-argument detail layouts retain their structure. */
export function detailLayout(media: unknown, content: unknown, discussion?: {
  comments: unknown;
  placement: "media" | "bottom";
  hasMedia: boolean;
}): TemplateResult {
  if (!discussion) return html`
    <div class="detail-layout">
      <div class="detail-layout__media">${media}</div>
      <div class="detail-layout__content pane-sections">${content}</div>
    </div>`;
  const besideImage = discussion.hasMedia && discussion.placement === "media";
  return html`
    <div class="detail-layout detail-layout--with-comments" data-comments-placement=${besideImage ? "media" : "bottom"}>
      ${discussion.hasMedia ? html`
        <div class="detail-layout__left">
          <div class="detail-layout__media">${media}</div>
          ${besideImage ? html`<div class="detail-layout__comments">${discussion.comments}</div>` : nothing}
        </div>` : nothing}
      <div class="detail-layout__content pane-sections">${content}</div>
      ${besideImage ? nothing : html`<div class="detail-layout__comments">${discussion.comments}</div>`}
    </div>`;
}
