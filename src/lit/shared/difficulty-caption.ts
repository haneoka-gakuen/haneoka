import { html, nothing } from "lit";
import { difficultyEstimatesEnabled } from "../../lib/difficulty-display";

/** Only the accepted operation-load estimate is a difficulty caption. */
export function difficultyEstimateCaption(row: Record<string, unknown>) {
  if (!difficultyEstimatesEnabled()) return nothing;
  const estimate = row.difficultyEstimate as Record<string, unknown> | null | undefined;
  const quality = estimate?.quality as Record<string, unknown> | null | undefined;
  const value = estimate?.estimatedConstant;
  return estimate?.target === "fc-operation-load" &&
    (quality?.status === "estimated" || quality?.status === "low-confidence") &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
    ? html`
        <small class="difficulty-constant">${value.toFixed(1)}</small>
      `
    : nothing;
}
