// Shared reading guide owned by [history/save transport](../../lib/gacha-history-help.ts).
import { html } from "lit";
import { modal } from "./modal";
import { iconButton } from "./controls";
import type { HistoryHelpKey } from "../../lib/gacha-history-help";
export function gameHistoryHelp(t: (key: HistoryHelpKey) => string, close: () => void) {
  return html`
    <dialog class="dialog" aria-label=${t("readHelpTitle")} ${modal(close)}>
      <div class="dialog__surface">
        <header class="dialog__header">
          <div class="row row--between">
            <h2 class="md-headline-small">${t("readHelpTitle")}</h2>
            ${iconButton({ icon: "close", label: t("close"), onClick: close })}
          </div>
        </header>
        <div class="dialog__body stack">
          <p class="md-body-medium">${t("readHelpSummary")}</p>
          <ol class="stack stack--tight md-body-medium">
            <li>${t("readHelpStep1")}</li>
            <li>${t("readHelpStep2")}</li>
            <li>${t("readHelpStep3")}</li>
          </ol>
          <p class="md-body-medium">${t("readHelpCredentials")}</p>
          <p class="md-body-medium">${t("readHelpPrivacy")}</p>
          <p class="md-body-medium">${t("readHelpOther")}</p>
        </div>
        <footer class="dialog__actions">
          <button class="button button--text" type="button" @click=${close}>${t("close")}</button>
        </footer>
      </div>
    </dialog>
  `;
}
