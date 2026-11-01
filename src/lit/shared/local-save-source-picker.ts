import { html } from "lit";
import { clientText } from "../../i18n/client";
import type { GachaHistoryImportSource } from "../../lib/gacha-history-view";
import { iconButton } from "../ui/controls";
import { icon } from "../ui/icon";
import { modal } from "../ui/modal";
import "../../styles/components/selection-pane.css";

export function renderLocalSaveSourcePicker(options: {
  locale: string;
  historyGuidance?: boolean;
  sources: readonly GachaHistoryImportSource[];
  onSelect: (source: GachaHistoryImportSource) => void;
  onClose: () => void;
}) {
  const t = (key: string) => clientText(options.locale, `catalog.gachaHistory.${key}`, "");
  const sources = {
    game: { label: t("gameSource"), icon: icon("sports_esports") },
    saved: { label: t("savedSource"), icon: icon("account_circle") },
    files: { label: t("filesSource"), icon: icon("folder_open") },
    adb: { label: t("adbSource"), icon: icon("usb") },
  };
  return html`
    <dialog class="selection-pane" aria-label=${t("importSource")} ${modal(options.onClose)}>
      <header class="sheet__header">
        <strong>${t("importSource")}</strong>
        ${iconButton({ icon: "close", label: t("close"), onClick: options.onClose })}
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
                      options.historyGuidance && (source === "files" || source === "adb")
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
