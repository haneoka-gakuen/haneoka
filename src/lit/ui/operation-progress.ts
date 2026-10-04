import { html } from "lit";
import { ref } from "lit/directives/ref.js";
import { prepareMaterialProgress } from "../../lib/loading-progress";
import "@material/web/progress/linear-progress.js";

/** Local byte progress uses the same Material control as the shell. */
export function operationProgress(label: string, fraction?: number) {
  const determinate = typeof fraction === "number" && Number.isFinite(fraction);
  return html`
    <md-linear-progress
      ${ref(prepareMaterialProgress)}
      aria-label=${label}
      ?indeterminate=${!determinate}
      .value=${determinate ? Math.max(0, Math.min(1, fraction)) : 0}
    ></md-linear-progress>
  `;
}
