import { html, type TemplateResult } from "lit";
import type { TeamBuilder } from "../team-builder";
import { specList } from "../ui/spec";
import { sectionHeading } from "./catalog";
import type { ActivityMode } from "./types";

export function activityDetails(host: TeamBuilder, mode: ActivityMode): TemplateResult {
  const s = host.settings;
  const t = (key: string, fallback: string) => host.t(`activity.${key}`, fallback);
  const skip = mode === "event" && s.route === "skip";
  const play = mode === "recommend"
    ? s.ptMode === "solo"
      ? t("soloPlay", "Solo: All Perfect · Challenge: All Perfect")
      : t("gekisoPlay", "Gekisou: full combo, set JUST rate, 1st place · Challenge: All Perfect")
    : skip
      ? t("skipPlay", "Game skip rules")
      : s.playMode === "ap" ? host.t("playAp", "All Perfect") : host.t("playCustom", "My accuracy");
  return html`
    <section class="surface stack tb-activity-details">
      ${sectionHeading({ icon: "flag", label: t("conditions", "Calculation conditions") })}
      ${specList([
        { label: t("purpose", "Use"), value: mode === "recommend"
          ? t("recommendPurpose", "Choose teams, songs and difficulties for repeated event play")
          : mode === "event" ? t("singlePurpose", "Compare rewards from one normal live, challenge or skip")
            : t("budgetPurpose", "Estimate total event PT from available boosts and CP") },
        { label: t("basis", "Reward basis"), value: mode === "recommend"
          ? t("recommendBasis", "Per normal live at the set cost: direct rewards + long-term CP value")
          : mode === "event" ? t("singleBasis", "Direct rewards from one play at the set cost")
            : t("budgetBasis", "Normal-live PT + PT from whole challenge plays; fixed costs") },
        { label: host.t("play", "Play"), value: play },
        !skip ? { label: t("orders", "Skill order"), value: host.t("criterionMean", "Average of 120 orders") } : null,
        mode === "recommend" ? { label: t("comparison", "Comparison"), value: t("selectedScope", "Selected songs and difficulties · PT and shop medals ranked separately") } : null,
        mode === "plan" ? { label: t("method", "Estimate method"), value: t("budgetMethod", "Teams chosen by long-term yield; play counts estimated from the budget") } : null,
      ])}
    </section>
  `;
}
