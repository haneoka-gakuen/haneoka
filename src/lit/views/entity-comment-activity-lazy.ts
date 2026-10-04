import { until } from "lit/directives/until.js";
import { errorState, loadingState } from "../ui/state";
import type { EntityCommentActivityView } from "./entity-comment-activity";

type ActivityModule = typeof import("./entity-comment-activity");
let renderer: ActivityModule | undefined;
let pending: Promise<ActivityModule> | undefined;

/** The homepage downloads full comment presentation only when its feed includes a comment. */
export function renderLazyEntityCommentActivity(view: EntityCommentActivityView, retry: () => void) {
  if (renderer) return renderer.renderEntityCommentActivity(view);
  const label = view.comment.label;
  pending ??= import("./entity-comment-activity").then(
    (module) => (renderer = module),
    (error) => {
      pending = undefined;
      throw error;
    },
  );
  return until(
    pending.then(
      (module) => module.renderEntityCommentActivity(view),
      () => errorState(label("unavailable", "Unavailable"), label("retry", "Retry"), retry),
    ),
    loadingState(label("loading", "Loading"), { local: true }),
  );
}
