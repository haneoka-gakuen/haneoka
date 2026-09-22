/**
 * Overlay behaviour: focus containment for anything that covers content.
 *
 * Material requires a modal surface to take focus, keep it inside itself,
 * close on Escape, and return focus to whatever opened it. The site had five
 * overlays (detail sheet, filter sheet, community dialog, admin dialog,
 * queue panel), none of which did any of it — a keyboard user tabbed
 * straight out of an open sheet into the page underneath it.
 *
 * This is one function, so every overlay behaves identically.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
  "md-outlined-select",
  "md-outlined-text-field",
  "md-slider",
  "md-switch",
].join(",");

const focusable = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (node) => !node.hasAttribute("inert") && node.offsetParent !== null,
  );

export interface OverlayOptions {
  /** Called for Escape, and for a click on the scrim if one is passed. */
  onDismiss?: () => void;
  /** Element to focus first; defaults to the first focusable descendant. */
  initialFocus?: HTMLElement | null;
  /** Element to restore focus to on release; defaults to the active element. */
  returnFocus?: HTMLElement | null;
}

/**
 * Traps focus inside `root` until the returned function is called.
 * The returned function is idempotent.
 */
export function trapFocus(root: HTMLElement, options: OverlayOptions = {}): () => void {
  const previous = options.returnFocus ?? (document.activeElement as HTMLElement | null);
  let released = false;

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      options.onDismiss?.();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = focusable(root);
    if (!nodes.length) {
      event.preventDefault();
      root.focus();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // A pointer press that lands outside the overlay (and outside its scrim) is
  // still a dismissal in Material; the scrim handles the visible case, this
  // covers focus arriving from elsewhere in the document.
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target || root.contains(target)) return;
    const nodes = focusable(root);
    (nodes[0] ?? root).focus();
  };

  root.addEventListener("keydown", onKeydown);
  document.addEventListener("focusin", onFocusIn);

  const initial = options.initialFocus ?? focusable(root)[0] ?? root;
  // Wait a frame: the overlay is usually mid-transition and a focus() on a
  // `visibility: hidden` element is a no-op.
  requestAnimationFrame(() => {
    if (!released) initial.focus({ preventScroll: true });
  });

  return () => {
    if (released) return;
    released = true;
    root.removeEventListener("keydown", onKeydown);
    document.removeEventListener("focusin", onFocusIn);
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
}
