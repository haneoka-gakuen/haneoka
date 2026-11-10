// L3 — GEB
// Input: Farming reward draft and immutable result plan.
// Output: Shared reward controls and localized ranking labels.
// Pos: [Map](../L2-2.md); activity reward setup and result presentation.
// Effects/Dependencies: Updates the host's farming draft through its existing setter.
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type { TeamBuilder } from "../team-builder";
import type { RewardMetric, RewardRankingPlan } from "../../lib/team-builder/engine/api";
import {
  changePrimaryReward,
  changeRewardMode,
  effectiveRewardPlan,
  legacyRewardPlan,
  MAX_REWARD_RATE,
  REWARD_METRICS,
  rewardFirst,
  type RewardPlan,
} from "../../lib/team-builder/reward-plan";
import { segmented } from "../ui/controls";
import { choiceField, sectionHeading } from "./catalog";

export const rewardLabel = (host: TeamBuilder, metric: RewardMetric): string =>
  metric === "points" ? "PT" : metric === "challenge-points" ? "CP" : host.t("rewardPlan.badges", "Badges");
const rewardIcon = (host: TeamBuilder, metric: RewardMetric) => {
  const settings = host.searchSettings;
  const eventId = settings.manualEventEnabled ? settings.manualEvent.templateId : settings.eventId;
  const source = host.catalog!.rewardIcon(metric, eventId);
  return html`<span class="tb-game-icon">${source ? html`<img src=${source} width="24" height="24" alt="" loading="lazy" />` : nothing}</span>`;
};
export const rewardRankingLabel = (host: TeamBuilder, plan: RewardRankingPlan): string =>
  plan.levels
    .map((level, index) => {
      const label = level
        .map(
          (term) =>
            `${rewardLabel(host, term.metric)}${index === 0 && term.weight !== plan.unit ? ` × ${new Intl.NumberFormat(host.locale, { maximumFractionDigits: 4 }).format(term.weight / plan.unit)}` : ""}`,
        )
        .join(" + ");
      return index ? `${host.t("rewardPlan.tie", "Tie-break")} ${label}` : label;
    })
    .join(" › ");

export function renderRewardPlan(host: TeamBuilder, plan: RewardPlan) {
  const set = (rewardPlan: RewardPlan) =>
    host.updateFarming({ rewardPlan, ptCycle: false, weighted: false, measure: rewardPlan.primary });
  const primaryOptions = REWARD_METRICS.filter(
    (metric) => host.searchSettings.route !== "challenge" || metric !== "challenge-points",
  );
  const preview =
    [
      rewardLabel(host, plan.primary),
      ...REWARD_METRICS.filter((metric) => metric !== plan.primary && plan.options[metric].mode === "convert").map(
        (metric) =>
          `${rewardLabel(host, metric)} × ${plan.options[metric].auto ? host.t("rewardPlan.auto", "Automatic") : (plan.options[metric].rate ?? "—")}`,
      ),
    ].join(" + ") +
    plan.tieOrder
      .filter((metric) => plan.options[metric].mode === "tie")
      .map((metric) => ` › ${host.t("rewardPlan.tie", "Tie-break")} ${rewardLabel(host, metric)}`)
      .join("");
  return html`
    <section class="surface stack" id="tb-reward-plan" data-tb-field tabindex="-1">
      ${sectionHeading({ icon: "emoji_events", label: host.t("rewardPlan.title", "Reward plan") })}
      ${segmented({
        label: host.t("rewardPlan.criterion", "Reward target"),
        value: plan.criterion ?? "mean",
        options: [
          { value: "mean", label: host.t("rewardPlan.mean", "Average reward") },
          { value: "max", label: host.t("rewardPlan.max", "Highest reward") },
          { value: "min", label: host.t("rewardPlan.min", "Minimum reward") },
        ],
        onSelect: (criterion) => set({ ...plan, criterion }),
      })}
      ${host.searchSettings.route !== "skip" ? html`
      ${choiceField({
        type: "select",
        label: host.t("analysis.minimumRank", "Every order reaches"),
        value: String(plan.minimumRank ?? 0),
        options: [0, 3, 4, 5, 6, 7].map((rank, index) => ({
          value: String(rank),
          label: [host.t("skillRoles.unlimited", "Any"), "C", "B", "A", "S", "SS"][index]!,
        })),
        onSelect: (rank) => set({ ...plan, minimumRank: Number(rank) || undefined }),
      })}
      ` : nothing}
      <span class="tb-field__label">${host.t("rewardPlan.primary", "Main reward")}</span>
      ${segmented({
        label: host.t("rewardPlan.primary", "Main reward"),
        value: plan.primary,
        options: primaryOptions.map((value) => ({ value, label: rewardLabel(host, value), leading: rewardIcon(host, value) })),
        onSelect: (metric) => set(changePrimaryReward(plan, metric)),
      })}
      ${REWARD_METRICS.filter(
        (metric) =>
          metric !== plan.primary && (host.searchSettings.route !== "challenge" || metric !== "challenge-points"),
      ).map((metric) => {
        const option = plan.options[metric];
        return html`
          <div class="stack">
            <span class="tb-field__label"><span class="cluster">${rewardIcon(host, metric)}<span>${rewardLabel(host, metric)}</span></span></span>
            ${segmented({
            label: rewardLabel(host, metric),
            value: option.mode,
            options: [
              { value: "ignore", label: host.t("rewardPlan.ignore", "Ignore") },
              { value: "convert", label: host.t("rewardPlan.convert", "Convert") },
              { value: "tie", label: host.t("rewardPlan.tie", "Tie-break") },
            ],
            onSelect: (mode) => set(changeRewardMode(plan, metric, mode)),
          })}
            ${
            option.mode === "convert"
              ? html`
                  ${
                  metric === "challenge-points" && !host.searchSettings.manualEventEnabled
                    ? segmented({
                        label: host.t("rewardPlan.rate", "Conversion rate"),
                        value: option.auto ? "auto" : "manual",
                        options: [
                          { value: "manual", label: host.t("rewardPlan.manual", "Manual") },
                          { value: "auto", label: host.t("rewardPlan.auto", "Automatic") },
                        ],
                        onSelect: (value) =>
                          set({
                            ...plan,
                            options: { ...plan.options, [metric]: { ...option, auto: value === "auto" } },
                          }),
                      })
                    : nothing
                }
                  ${
                  !option.auto
                    ? html`
                        <md-outlined-text-field
                          type="number"
                          min="0"
                          max=${MAX_REWARD_RATE}
                          step="0.0001"
                          label=${`${rewardLabel(host, plan.primary)} / ${rewardLabel(host, metric)}`}
                          .value=${live(option.rate === null ? "" : String(option.rate))}
                          @change=${(event: Event) => {
                      const value = (event.target as HTMLInputElement).value;
                      set({
                        ...plan,
                        options: {
                          ...plan.options,
                          [metric]: { ...option, rate: value.trim() ? Number(value) : null },
                        },
                      });
                    }}
                        ></md-outlined-text-field>
                      `
                    : nothing
                }
                `
              : nothing
          }
            ${
            option.mode === "tie" && plan.tieOrder.indexOf(metric) > 0
              ? html`
                  <button type="button" class="button button--outlined" @click=${() => set(rewardFirst(plan, metric))}>
                    ${host.t("rewardPlan.first", "Compare this first")}
                  </button>
                `
              : nothing
          }
          </div>
        `;
      })}
      <span class="tb-results__meta">${host.t("rewardPlan.order", "Ranking")}: ${preview}</span>
    </section>
  `;
}

export const farmingRewardPlan = (host: TeamBuilder): RewardPlan =>
  effectiveRewardPlan(
    host.searchSettings.rewardPlan ?? legacyRewardPlan(host.searchSettings),
    host.searchSettings.route === "challenge",
  );
