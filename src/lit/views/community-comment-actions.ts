import { LitElement, html, nothing } from "lit";
import { iconButton } from "../ui/controls";
import { icon } from "../ui/icon";

export interface CommentMenuAction {
  label: string;
  icon: string;
  run: () => void;
}
/** Presentation-only menu; mutations remain callbacks owned by the controller. */
export class CommunityCommentActions extends LitElement {
  static properties = {
    label: { type: String },
    closeLabel: { type: String },
    actions: { attribute: false },
    position: { state: true },
  };
  declare label: string;
  declare closeLabel: string;
  declare actions: CommentMenuAction[];
  declare position: { x: number; y: number } | null;
  constructor() {
    super();
    this.label = "";
    this.closeLabel = "";
    this.actions = [];
    this.position = null;
  }
  createRenderRoot() {
    return this;
  }
  disconnectedCallback() {
    this.position = null;
    super.disconnectedCallback();
  }
  private close = () => {
    this.querySelector<HTMLElement>("[popover]")?.hidePopover?.();
    this.position = null;
    this.querySelector<HTMLButtonElement>(".community-comment__more")?.focus();
  };
  private open = (event: MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.position = {
      x: Math.max(8, Math.min(rect.right - 224, innerWidth - 232)),
      y: Math.max(8, Math.min(rect.bottom, innerHeight - (this.actions.length * 48 + 24))),
    };
    void this.updateComplete.then(() => {
      const menu = this.querySelector<HTMLElement>("[role=menu]");
      if (!this.isConnected || !this.position || !menu) return;
      menu.showPopover?.();
      menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    });
  };
  private keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key === "Tab") {
      this.position = null;
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const entries = [...this.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    entries[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? entries.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length
    ]?.focus();
  };
  render() {
    if (!this.actions.length) return nothing;
    return html`
      ${iconButton({ icon: "more_horiz", label: this.label, className: "community-comment__more", onClick: this.open })}
      ${
        this.position
          ? html`
              <div
                class="menu community-card-menu community-comment-menu"
                role="menu"
                popover="auto"
                aria-label=${this.label}
                style=${`left:${this.position.x}px;top:${this.position.y}px;margin:0;border:0;right:auto;bottom:auto`}
                @keydown=${this.keys}
                @toggle=${(event: Event) => {
                  if ((event as ToggleEvent).newState === "closed") this.position = null;
                }}
              >
                ${this.actions.map(
                  (action) => html`
                    <button
                      class="menu-item"
                      type="button"
                      role="menuitem"
                      @click=${() => {
                        this.close();
                        action.run();
                      }}
                    >
                      ${icon(action.icon, 20)}${action.label}
                    </button>
                  `,
                )}
              </div>
              ${typeof HTMLElement.prototype.showPopover !== "function" ? html`<button
                class="scrim community-menu-scrim"
                type="button"
                aria-label=${this.closeLabel}
                @click=${this.close}
              ></button>` : nothing}
            `
          : nothing
      }
    `;
  }
}
if (!customElements.get("community-comment-actions"))
  customElements.define("community-comment-actions", CommunityCommentActions);
