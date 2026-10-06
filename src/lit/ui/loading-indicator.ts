import { html, nothing } from "lit";

export interface LoadingIndicatorOptions {
  label?: string;
  contained?: boolean;
  size?: "small" | "large";
  className?: string;
}

/** Material 3 Expressive loading indicator (styles/components/shapes.css). Decorative unless labelled. */
export function loadingIndicator(options: LoadingIndicatorOptions = {}) {
  const classes = [
    "loading-indicator",
    options.contained ? "loading-indicator--contained" : "",
    options.size ? `loading-indicator--${options.size}` : "",
    options.className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <span
      class=${classes}
      role=${options.label ? "progressbar" : nothing}
      aria-label=${options.label ?? nothing}
      aria-hidden=${options.label ? nothing : "true"}
    ></span>
  `;
}

/** The same indicator as a DOM node, for code that builds elements imperatively. */
export function createLoadingIndicator(options: LoadingIndicatorOptions = {}): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = ["loading-indicator", options.contained ? "loading-indicator--contained" : "", options.size ? `loading-indicator--${options.size}` : "", options.className ?? ""]
    .filter(Boolean)
    .join(" ");
  if (options.label) {
    element.setAttribute("role", "progressbar");
    element.setAttribute("aria-label", options.label);
  } else element.setAttribute("aria-hidden", "true");
  return element;
}
