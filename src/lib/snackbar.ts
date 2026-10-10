/** Page-wide snackbar: transient status floats over the page instead of moving it. */
import { html, nothing, render } from "lit";

export interface SnackbarOptions {
  action?: { label: string; run: () => void };
  /** Announced as an alert. */
  error?: boolean;
  /** 0 keeps it until dismissed or replaced. */
  durationMs?: number;
}

let host: HTMLElement | null = null;
let timer = 0;
let current = 0;

export function dismissSnackbar(id = current) {
  if (id !== current || !host) return;
  window.clearTimeout(timer);
  render(nothing, host);
}

/** Show `text`, replacing any snackbar already shown; returns an id for `dismissSnackbar`. */
export function snackbar(text: string, options: SnackbarOptions = {}): number {
  if (typeof document === "undefined") return 0;
  if (!host?.isConnected) {
    host = document.createElement("div");
    host.className = "snackbar-host";
    document.body.append(host);
  }
  const id = ++current;
  window.clearTimeout(timer);
  const action = options.action;
  render(
    html`<div class="snackbar" role=${options.error ? "alert" : "status"}>
      <span class="snackbar__text">${text}</span>
      ${action
        ? html`<button class="button button--text" type="button" @click=${() => { dismissSnackbar(id); action.run(); }}>${action.label}</button>`
        : nothing}
    </div>`,
    host,
  );
  const duration = options.durationMs ?? (action ? 8000 : 5000);
  if (duration) timer = window.setTimeout(() => dismissSnackbar(id), duration);
  return id;
}
