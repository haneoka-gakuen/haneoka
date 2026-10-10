import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { iconButton } from "../ui/controls";
import type { InputIssue } from "../../lib/team-builder/engine/input-eligibility";
import type { TeamBuilder } from "../team-builder";

function label(host: TeamBuilder, issue: InputIssue) {
  if (issue.key === "team")
    return host.t("importFlow.needCharacters", "At least five different characters are needed.");
  if (issue.code === "required")
    return host.t("importFlow.required", "A required card is outside the selected candidates.") + ` (${issue.key})`;
  if (issue.key !== "player")
    return `${host.catalog!.cardName(issue.key.startsWith("m") ? "members" : "snaps", Number(issue.key.slice(1)))} · ${host.t(issue.field === "liveSkillLevel" ? "liveSkill" : issue.field === "gekisoSkillLevel" ? "gekisoSkill" : issue.field, issue.field)}`;
  const [field, id] = issue.field.split(".");
  const name =
    field === "bandItems"
      ? host.catalog!.text(host.data!.bandItems[id!]?.name)
      : field === "musicMemory"
        ? host.catalog!.songTitle(Number(id))
        : id
          ? host.catalog!.characterName(Number(id))
          : "";
  return `${host.t(field === "characterTotalRank" ? "totalRank" : field === "characterMemory" || field === "musicMemory" ? `importFlow.${field}` : field!, field!)} ${name}`;
}

/** Reuses the current box keys; edits are explicit observations, never inferred defaults. */
export function renderInputReview(host: TeamBuilder) {
  if (!host.inputIssues) return nothing;
  const close = () => {
    host.inputIssues = null;
    host.requestUpdate();
  };
  return html`
    <dialog
      class="selection-pane"
      aria-label=${host.t("importFlow.complete", "Complete required information")}
      @cancel=${(event: Event) => {
        event.preventDefault();
        close();
      }}
    >
      <header class="sheet__header">
        <strong>${host.t("importFlow.complete", "Complete required information")}</strong>
        ${iconButton({ icon: "close", label: host.common("common.actions.close", "Close"), onClick: close })}
      </header>
      <div class="selection-pane__body stack">
        <p>
          ${host.t("importFlow.fillHint", "Enter values observed in the game. Zero means explicitly none; blank remains unknown. This list follows the current goal and candidates.")}
        </p>
        ${
          !host.inputIssues.length
            ? html`
                <p role="status">${host.t("importFlow.ready", "The selected goal has the required information.")}</p>
              `
            : nothing
        }
        ${[false, true].map(
          (account) => html`
            <section class="stack">
              <strong>${host.t(account ? "accountTitle" : "tabBox", account ? "Account bonuses" : "My cards")}</strong>
              ${host
              .inputIssues!.filter((issue) => (issue.key === "player") === account)
              .map((issue) => {
                const caption = label(host, issue);
                if (!issue.storageKey)
                  return html`
                    <p role="alert">${caption}</p>
                  `;
                const value = host.snapshot?.entries[issue.storageKey]?.v;
                const saved = typeof value === "number" ? value : null;
                const write = (next: number | null) => host.write([{ key: issue.storageKey!, value: next }]);
                return issue.values
                  ? html`
                      <md-outlined-select
                        label=${caption}
                        .value=${saved === null ? "unknown" : String(saved)}
                        @change=${(event: Event) => {
                      const next = (event.target as HTMLInputElement).value;
                      write(next === "unknown" ? null : Number(next));
                    }}
                      >
                        <md-select-option value="unknown">
                          <span slot="headline">${host.t("unknown", "Unknown")}</span>
                        </md-select-option>
                        ${issue.values.map(
                      (option) => html`
                        <md-select-option value=${String(option)}>
                          <span slot="headline">${option}</span>
                        </md-select-option>
                      `,
                    )}
                      </md-outlined-select>
                    `
                  : html`
                      <label class="tb-field">
                        <span>${caption}</span>
                        <input
                          type="number"
                          inputmode="numeric"
                          min=${issue.min ?? 0}
                          max=${issue.max ?? 0x7fffffff}
                          .value=${live(saved === null ? "" : String(saved))}
                          placeholder="—"
                          @change=${(event: Event) => {
                        const input = event.target as HTMLInputElement;
                        if (!input.value) write(null);
                        else if (input.checkValidity() && Number.isSafeInteger(Number(input.value)))
                          write(Number(input.value));
                      }}
                        />
                      </label>
                    `;
              })}
            </section>
          `,
        )}
      </div>
      <footer class="selection-pane__footer">
        <button class="button" @click=${() => host.completeInputs()}>
          ${host.t("importFlow.recheck", "Check again")}
        </button>
      </footer>
    </dialog>
  `;
}
