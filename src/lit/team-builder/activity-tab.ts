import { html, type TemplateResult } from "lit";
import type { TeamBuilder } from "../team-builder";
import { segmented } from "../ui/controls";
import { renderBuildTab } from "./build-tab";
import { renderPtTab } from "./pt-tab";

export function renderActivityTab(host: TeamBuilder): TemplateResult {
  const mode = host.settings.activityMode;
  return html`
    <div class="stack">
      <fieldset class="tb-activity-modes" ?disabled=${host.running || host.manualBusy}>
        ${segmented({
          label: host.t("activity.mode", "Event task"),
          value: mode,
          options: [
            { value: "recommend", label: host.t("activity.recommend", "Event farming") },
            { value: "event", label: host.t("activity.single", "Single live") },
            { value: "plan", label: host.t("activity.budget", "Budget estimate") },
          ],
          onSelect: (activityMode) => host.updateSettings({
            activityMode,
            ...(activityMode === "recommend" ? {} : { goal: activityMode }),
          }),
        })}
      </fieldset>
      ${mode === "recommend" ? renderPtTab(host) : renderBuildTab(host, false)}
    </div>
  `;
}
