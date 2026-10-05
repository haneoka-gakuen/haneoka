import { html, nothing } from "lit";
import { errorState, loadingState } from "./state";
import "../../styles/components/comments-state.css";

export type CommentsState =
  | { phase: "deferred" }
  | { phase: "loading"; label: string }
  | { phase: "error"; title: string; retryLabel: string; onRetry: () => void };

/** A measurable lazy-mount anchor. Only an active comment request shows progress. */
export function renderCommentsState(view: CommentsState) {
  return html`
    <div class="comments-state" data-comments-placeholder aria-busy=${String(view.phase === "loading")}>
      ${
        view.phase === "loading"
          ? loadingState(view.label, { local: true })
          : view.phase === "error"
            ? errorState(view.title, view.retryLabel, view.onRetry)
            : nothing
      }
    </div>
  `;
}
