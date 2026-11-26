// L3 — GEB
// Input: Pointer movement over native scroll containers and the viewport.
// Output: The horizontal and vertical scrollbar edges under the mouse.
// Pos: [Map](L2-2.md); installed once by the shared document layout.
// Effects/Dependencies: Passive pointer listeners and transient DOM attributes.
const EDGE_SIZE = 16;
const HOVER = "data-scrollbar-hover";
const ENABLED = "data-scrollbar-hover-enabled";

function scrolls(overflow: string, viewport: boolean) {
  return overflow === "auto" || overflow === "scroll" || (viewport && overflow === "visible");
}

export function installScrollbarHover() {
  const root = document.documentElement;
  const media = matchMedia("(hover: hover) and (pointer: fine)");
  const forcedColors = matchMedia("(forced-colors: active)");
  let active = new Map<HTMLElement, string>();
  let frame = 0;

  const clear = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    for (const element of active.keys()) element.removeAttribute(HOVER);
    active.clear();
  };
  const reset = () => {
    clear();
    root.toggleAttribute(ENABLED, media.matches && !forcedColors.matches);
  };

  const move = (event: PointerEvent) => {
    if (!root.hasAttribute(ENABLED) || event.pointerType !== "mouse") return;
    const path = event.composedPath();
    const { clientX: x, clientY: y } = event;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      const next = new Map<HTMLElement, string>();
      for (const element of path) {
        if (!(element instanceof HTMLElement)) continue;
        const wide = element.scrollWidth > element.clientWidth;
        const tall = element.scrollHeight > element.clientHeight;
        if (!wide && !tall) continue;

        const viewport = element === document.scrollingElement;
        const style = getComputedStyle(element);
        if (style.scrollbarWidth === "none") continue;
        const { left, top, right, bottom } = viewport
          ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
          : element.getBoundingClientRect();
        if (x < left || x > right || y < top || y > bottom) continue;

        const fromBottom = bottom - y;
        const fromSide = style.direction === "rtl" ? x - left : right - x;
        const horizontal = wide && fromBottom <= EDGE_SIZE && scrolls(style.overflowX, viewport);
        const vertical = tall && fromSide <= EDGE_SIZE && scrolls(style.overflowY, viewport);
        if (horizontal || vertical) next.set(element, horizontal && vertical ? "x y" : horizontal ? "x" : "y");
      }

      for (const element of active.keys()) if (!next.has(element)) element.removeAttribute(HOVER);
      for (const [element, value] of next) if (active.get(element) !== value) element.setAttribute(HOVER, value);
      active = next;
    });
  };

  window.addEventListener("pointermove", move, { capture: true, passive: true });
  window.addEventListener(
    "pointerout",
    (event) => {
      if (!event.relatedTarget && event.pointerType === "mouse") clear();
    },
    { passive: true },
  );
  window.addEventListener("blur", clear);
  document.addEventListener("astro:after-swap", reset);
  media.addEventListener?.("change", reset);
  forcedColors.addEventListener?.("change", reset);
  reset();
}
