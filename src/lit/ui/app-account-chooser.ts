// L3 — GEB
// Input: The app's game accounts and the page locale.
// Output: The chosen account's key, or null when the reader closes the dialog.
// Pos: [Map](L2-2.md); shared chooser for app bridge calls that name a save.
// Effects/Dependencies: Renders a modal dialog into document.body and removes it on close.
import { html, render } from "lit";
import { clientText } from "../../i18n/client";
import { formatDate } from "../../lib/date-format";
import type { DeviceSave } from "../../lib/app-bridge";
import { modal } from "./modal";

export function chooseAppAccount(locale: string, accounts: DeviceSave[]): Promise<string | null> {
  const text = (key: string, fallback: string) => clientText(locale, `common.appAccounts.${key}`, fallback);
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise((resolve) => {
    const done = (key: string | null) => {
      render(html``, host);
      host.remove();
      resolve(key);
    };
    render(
      html`
        <dialog class="dialog" ${modal(() => done(null))}>
          <div class="dialog__surface">
            <header class="dialog__header"><h2>${text("choose", "Choose a game account")}</h2></header>
            <div class="dialog__body">
              <ul class="detail-object-list" role="list">
                ${accounts.map(
                  (account) => html`
                    <li>
                      <button class="detail-object" type="button" @click=${() => done(account.key)}>
                        <span>
                          ${account.name || account.profileId}
                          <small class="md-body-small">
                            ${[
                              account.region ?? "",
                              account.profileId,
                              account.savedAt === null ? "" : formatDate(locale, account.savedAt),
                            ]
                              .filter(Boolean)
                              .join(" / ")}
                          </small>
                        </span>
                      </button>
                    </li>
                  `,
                )}
              </ul>
            </div>
            <footer class="dialog__actions">
              <button class="button button--text" type="button" @click=${() => done(null)}>
                ${text("close", "Close")}
              </button>
            </footer>
          </div>
        </dialog>
      `,
      host,
    );
  });
}
