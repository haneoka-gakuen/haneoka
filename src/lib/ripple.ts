/**
 * Material ripple for the native component layer (index.css). One delegated
 * pointerdown listener positions a CSS-only ripple; nothing is allocated per
 * element and reduced-motion users get the plain state layer instead.
 */
const RIPPLE_TARGETS = [
  ".button",
  ".icon-button",
  ".chip",
  ".nav-item",
  ".rail-item",
  ".list-item--interactive",
  ".card--interactive",
  ".tile--interactive",
  ".segmented > button",
  ".tab",
  ".menu-item",
  ".hub-link",
].join(", ");

export function installRipple() {
  const root = document.documentElement;
  if (root.dataset.ripple === "true") return;
  root.dataset.ripple = "true";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  window.addEventListener(
    "pointerdown",
    (event: PointerEvent) => {
      if (reduced.matches || event.button !== 0) return;
      const hit = (event.target as Element | null)?.closest<HTMLElement>(RIPPLE_TARGETS);
      // A rail item ripples inside its indicator pill, not across its whole box.
      const target = hit?.matches(".rail-item") ? hit.querySelector<HTMLElement>(".rail-item__indicator") : hit;
      if (!target || target.matches(":disabled, [aria-disabled='true']")) return;
      const rect = target.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const size = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y)) * 2;
      target.style.setProperty("--ripple-x", `${x}px`);
      target.style.setProperty("--ripple-y", `${y}px`);
      target.style.setProperty("--ripple-size", `${size}px`);
      target.classList.add("has-ripple");
      target.classList.remove("is-rippling");
      // Restart the animation on rapid repeated presses.
      void target.offsetWidth;
      target.classList.add("is-rippling");
    },
    { passive: true, capture: true },
  );
  window.addEventListener(
    "animationend",
    (event: AnimationEvent) => {
      if (event.animationName === "md-ripple") (event.target as HTMLElement).classList.remove("is-rippling");
    },
    { passive: true },
  );
}
