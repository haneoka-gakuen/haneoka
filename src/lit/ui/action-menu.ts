// L3 — GEB
// Input: Stable anchor ID and labelled actions.
// Output: Material menu with native keyboard navigation and focus handoff.
// Pos: [Map](L2-2.md); shared optional action menu.
// Effects/Dependencies: Material Web menu; actions run after its close lifecycle.
import { html, nothing } from "lit";
import "@material/web/menu/menu.js";
import "@material/web/menu/menu-item.js";
import { CloseReason, type CloseMenuEvent } from "@material/web/menu/internal/controllers/shared.js";
import { icon } from "./icon";

export function actionMenu(options: {
  id: string;
  label: string;
  items: { label: string; icon?: string; href?: string; disabled?: boolean; run?: () => void }[];
}) {
  return html`
    <span class="action-menu">
      <button
        id=${options.id}
        class="button button--text"
        type="button"
        aria-haspopup="menu"
        aria-controls=${`${options.id}-menu`}
        aria-expanded="false"
        @click=${(event: Event) => (event.currentTarget as HTMLElement).parentElement!.querySelector("md-menu")!.show()}
      >
        ${options.label}
      </button>
      <md-menu
        id=${`${options.id}-menu`}
        anchor=${options.id}
        positioning="popover"
        @opened=${(event: Event) => (event.currentTarget as HTMLElement).parentElement!.querySelector("button")!.setAttribute("aria-expanded", "true")}
        @closed=${(event: Event) => (event.currentTarget as HTMLElement).parentElement!.querySelector("button")!.setAttribute("aria-expanded", "false")}
      >
        ${options.items.map(
          (item) => html`
            <md-menu-item
              type=${item.href ? "link" : "button"}
              href=${item.href ?? nothing}
              ?disabled=${item.disabled}
              @close-menu=${(event: CloseMenuEvent) => {
                const reason = event.detail.reason;
                if (
                  !item.run ||
                  item.disabled ||
                  (reason.kind !== CloseReason.CLICK_SELECTION &&
                    !(reason.kind === CloseReason.KEYDOWN && (reason.key === "Enter" || reason.key === "Space")))
                )
                  return;
                const menu = (event.currentTarget as HTMLElement).closest("md-menu")!;
                menu.addEventListener("closed", () => item.run!(), { once: true });
              }}
            >
              ${
                item.icon
                  ? html`
                      <span slot="start">${icon(item.icon, 20)}</span>
                    `
                  : nothing
              }
              <span slot="headline">${item.label}</span>
            </md-menu-item>
          `,
        )}
      </md-menu>
    </span>
  `;
}
