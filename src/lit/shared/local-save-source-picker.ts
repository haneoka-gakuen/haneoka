import { html } from "lit";
import { inApp } from "../../lib/app-bridge";
import { clientText } from "../../i18n/client";
import type { GachaHistoryImportSource } from "../../lib/gacha-history-view";
import { iconButton } from "../ui/controls";
import { icon } from "../ui/icon";
import { modal } from "../ui/modal";
import "../../styles/components/selection-pane.css";

type SaveSource = GachaHistoryImportSource | "folder";
export function renderLocalSaveSourcePicker<T extends SaveSource>(options: {
  locale: string;
  historyGuidance?: boolean;
  title?: string;
  sources: readonly T[];
  onSelect: (source: T) => void;
  onClose: () => void;
}) {
  const t = (key: string) => clientText(options.locale, `catalog.gachaHistory.${key}`, "");
  const accountImport = inApp();
  const sources = {
    game: { label: accountImport ? clientText(options.locale, "account.page.openSaveImport", "Import a save in Account") : t("gameSource"), icon: icon("sports_esports") },
    saved: { label: t("savedSource"), icon: icon("account_circle") },
    files: { label: options.historyGuidance ? t("filesSource") : clientText(options.locale, "common.actions.import", "Import files"), icon: icon("upload_file") },
    folder: { label: clientText(options.locale, "account.page.toolAccounts.folder", "Choose a folder"), icon: icon("folder_open") },
    adb: { label: options.title ? clientText(options.locale, "account.page.toolAccounts.usbRead", "USB / ADB") : t("adbSource"), icon: icon("usb") },
  };
  return html`
    <dialog class="selection-pane" aria-label=${options.title ?? t("importSource")} ${modal(options.onClose)}>
      <header class="sheet__header">
        <strong>${options.title ?? t("importSource")}</strong>
        ${iconButton({ icon: "close", label: clientText(options.locale, "common.actions.close", "Close"), onClick: options.onClose })}
      </header>
      <div class="selection-pane__body">
        <ul class="list">
          ${options.sources.map(
            (source) => html`
              <li>
                <button type="button" class="list-item list-item--interactive" @click=${() => options.onSelect(source)}>
                  <span class="list-item__leading">${sources[source].icon}</span>
                  <span class="list-item__body">
                    <span class="list-item__headline">${sources[source].label}</span>
                    ${
                      source === "game" && accountImport
                        ? html`<span class="list-item__supporting">${clientText(options.locale, "account.page.saveImportGuide", "Read the game save in Account.")}</span>`
                        : options.historyGuidance && (source === "files" || source === "adb")
                        ? html`
                            <span class="list-item__supporting">
                              ${t(source === "adb" ? "usbHistoryHelp" : "historyFilesHelp")}
                            </span>
                          `
                        : ""
                    }
                  </span>
                  <span class="list-item__trailing">${icon("chevron_right")}</span>
                </button>
              </li>
            `,
          )}
        </ul>
      </div>
    </dialog>
  `;
}
