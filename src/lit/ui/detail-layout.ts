import { html, type TemplateResult } from "lit";
export function detailLayout(media: unknown, content: unknown): TemplateResult {
  return html`
    <div class="detail-layout">
      <div class="detail-layout__media">${media}</div>
      <div class="detail-layout__content pane-sections">${content}</div>
    </div>
  `;
}
