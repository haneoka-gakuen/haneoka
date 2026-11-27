import { html, nothing } from "lit";
import { icon } from "../ui/icon";
import type { CardGrowthIcons } from "../../lib/ui-marks";

export interface CardGrowth {
  kind: "member" | "support";
  icons: CardGrowthIcons;
  level?: number | null;
  training?: number | null;
  rank?: number | null;
  liveSkill?: { level: number | null; icon: string; label: string };
  gekisoSkill?: { level: number | null; icon: string; label: string };
  unknown?: string;
  hideSkillIcons?: boolean;
  trainingLabel: string;
  rankLabel: string;
}

export function cardGrowth(options: CardGrowth) {
  const value = (number: number | null | undefined) => number ?? options.unknown ?? "?";
  const rank = options.kind === "member" ? options.icons.memberRanks : options.icons.supportRanks;
  const rankImage = rank[options.rank ?? 0];
  const skills = [options.liveSkill, options.gekisoSkill];
  const skillMarks = skills.map((skill) => skill && (options.hideSkillIcons || skill.icon)
    ? html`<span title=${`${skill.label} ${value(skill.level)}`} aria-label=${`${skill.label} ${value(skill.level)}`}>
        ${options.hideSkillIcons ? icon("help", 16) : html`<img src=${skill.icon} alt="" />`}<span>${value(skill.level)}</span>
      </span>` : nothing);
  return html`<span class=${`card-growth card-growth--${options.kind}`}>
    ${options.level !== undefined
      ? html`<span class="card-growth__level"><small>Lv.</small>${value(options.level)}</span>`
      : nothing}
    ${options.kind === "member" && options.training !== undefined
      ? html`<span class="card-growth__training" title=${`${options.trainingLabel} ${value(options.training)}`}>
          ${options.icons.training ? html`<img src=${options.icons.training} alt=${options.trainingLabel} />` : options.trainingLabel}
          <span>${value(options.training)}</span>
        </span>`
      : nothing}
    ${(options.liveSkill || options.gekisoSkill)
      ? html`<span class="card-growth__skills">
          ${skillMarks}
        </span>`
      : nothing}
    ${options.rank !== undefined
      ? html`<span class="card-growth__rank" title=${`${options.rankLabel} ${value(options.rank)}`}>
          ${rankImage ? html`<img src=${rankImage} alt=${`${options.rankLabel} ${value(options.rank)}`} />` : html`<span>${options.rankLabel} ${value(options.rank)}</span>`}
          ${options.rank === null && rankImage ? html`<strong>${value(options.rank)}</strong>` : nothing}
        </span>`
      : nothing}
  </span>`;
}
