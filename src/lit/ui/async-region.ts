import { html, nothing } from "lit";
import { loadingState } from "./state";
import "../../styles/components/async-region.css";

export type AsyncRegionView =
  | { state: "initial"; label: string; layout?: "cards" | "list" | "detail"; local?: boolean; columns?: number }
  | { state: "ready" | "refreshing"; content: unknown }
  | { state: "error"; message: string; retryLabel: string; onRetry?: () => void; retainedContent?: unknown };

/** The controller owns identity/permission checks; this view never caches data. */
export function asyncRegion(view: AsyncRegionView) {
  const columns =
    view.state === "initial" && view.layout === "cards"
      ? Math.max(1, Math.min(5, Math.trunc(view.columns || 2)))
      : undefined;
  const content =
    view.state === "ready" || view.state === "refreshing"
      ? view.content
      : view.state === "error"
        ? view.retainedContent
        : nothing;
  return html`
    <section class="async-region" aria-busy=${String(view.state === "initial" || view.state === "refreshing")}>
      ${
        view.state === "initial"
          ? html`
              ${loadingState(view.label, { local: Boolean(view.local) })}
              <div
                class=${`async-region__placeholder async-region__placeholder--${view.layout || "list"}`}
                style=${columns ? `--async-region-columns:${columns}` : nothing}
                aria-hidden="true"
              >
                ${Array.from(
                  { length: columns ? columns * 2 : view.layout === "detail" ? 2 : 6 },
                  () => html`
                    <div class="async-region__skeleton">
                      <span></span>
                      <span></span>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing
      }
      ${
        view.state === "error"
          ? html`
              <div class="inline-message error async-region__error" role="alert">
                <span>${view.message}</span>
                ${
                  view.onRetry
                    ? html`
                        <button class="button button--text" type="button" @click=${view.onRetry}>
                          ${view.retryLabel}
                        </button>
                      `
                    : nothing
                }
              </div>
            `
          : nothing
      }
      <div class="async-region__content">${content ?? nothing}</div>
    </section>
  `;
}
