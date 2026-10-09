import { html, nothing, type TemplateResult } from "lit";
import type { PtIssue } from "../../lib/team-builder/engine/pt-eligibility";
import type { TeamBuilder } from "../team-builder";
import { icon } from "../ui/icon";

/** Stable editor identities, independent of translated labels and list ordering. */
export function issueField(issue: PtIssue): string | null {
  if (issue.code === "practice" || issue.code === "player") return issue.target;
  if (issue.code === "constraint") return issue.target === "minBonus" ? "minBonus" : "constraints";
  if (issue.code === "inventory") return "inventory";
  if (issue.code === "chart") return issue.target.startsWith("challenge") ? "challenge-selection" : "selection";
  if (issue.code === "mode") return issue.target === "gekiso-input" ? "gekiso-input" : null;
  if (issue.code === "event")
    return ["consumption", "challenge-consumption"].includes(issue.target) ? issue.target : "event";
  if (issue.code === "skill") {
    const card = /^(m\d+|s\d+)(?:[.:/]|$)/u.exec(issue.target)?.[1];
    if (card) return `${card}.use`;
  }
  return null;
}

export function ptField(host: TeamBuilder, key: string, content: TemplateResult): TemplateResult {
  const invalid = host.pt.issues.some((issue) => issueField(issue) === key);
  return html`
    <div
      class=${`pt-field${invalid ? " pt-field--invalid" : ""}`}
      data-pt-field=${key}
      tabindex="-1"
      role="group"
      aria-invalid=${invalid ? "true" : nothing}
      aria-describedby=${invalid ? `pt-help-${key}` : nothing}
    >
      ${content}
      ${
        invalid
          ? html`
              <p class="pt-field__error" id=${`pt-help-${key}`}>
                ${icon("error", 18)}${host.t("pt.fieldNeedsReview", "Check this input before calculating.")}
              </p>
            `
          : nothing
      }
    </div>
  `;
}
