/**
 * Geometry for a uniform-height grid using browser viewport containment.
 * All entries remain in the DOM: native find, keyboard navigation, selection
 * and assistive navigation keep their normal document contract. This does
 * not own the collection's data, filters, sort order or playback queue.
 *
 * One real card remains a layout sample. Its ResizeObserver follows column
 * width, typography and density without measuring every offscreen subtree.
 * Only opt in grids whose existing card anatomy has uniform row height.
 */
export class ViewportGrid {
  private collection?: HTMLElement;
  private sample?: HTMLElement;
  private root: Element | null = null;
  private resize?: ResizeObserver;
  private intersections?: IntersectionObserver;
  private observed = new Set<HTMLElement>();
  private blockSize = 0;

  /**
   * Seed a newly rendered grid from its existing real card or loading tile.
   * Only cards below the viewport plus overscan may start contained; cards
   * above it stay ordinary until the native observer classifies them. This
   * also handles a shrinking result set whose scroll position will clamp.
   */
  initialWindow(itemCount: number, root: Element | null) {
    if (!this.collection?.isConnected || !this.sample?.isConnected || root !== this.root) return;
    const sample = this.sample.getBoundingClientRect();
    if (!(sample.height > 0)) return;
    const style = getComputedStyle(this.collection);
    const widths = style.gridTemplateColumns.trim().split(/\s+/u).map(Number.parseFloat);
    if (!widths.length || widths.some((width) => !Number.isFinite(width) || width <= 0 || Math.abs(width - sample.width) > 0.1)) return;
    const columns = widths.length;
    const gap = Number.parseFloat(style.rowGap) || 0;
    const bottom = root?.getBoundingClientRect().bottom ?? innerHeight;
    const rows = Math.max(1, Math.ceil((bottom - sample.top + 600) / (sample.height + gap)) + 1);
    return { blockSize: sample.height, end: Math.min(itemCount, rows * columns) };
  }

  sync(collection: HTMLElement | null, root: Element | null = null) {
    if (!collection || typeof ResizeObserver === "undefined" || typeof IntersectionObserver === "undefined" || typeof CSS === "undefined" || !CSS.supports("content-visibility", "auto")) {
      this.disconnect();
      return;
    }
    const sample = collection.firstElementChild as HTMLElement | null;
    if (!sample) {
      this.disconnect();
      return;
    }
    if (collection !== this.collection || sample !== this.sample || root !== this.root) {
      // Lit keeps the same collection element across a filtered result change.
      // Its new initial-window attributes are already committed; clear old
      // observers without deleting that freshly seeded geometry first.
      this.disconnect(collection === this.collection ? collection : undefined);
      this.collection = collection;
      this.sample = sample;
      this.root = root;
      sample.setAttribute("data-viewport-grid-sample", "");
      // Read one natural card before enabling containment. Its border-box is
      // the exact space reserved by every existing same-width song card.
      this.measure();
      this.resize = new ResizeObserver(() => this.measure());
      this.resize.observe(sample);
      if (typeof IntersectionObserver !== "undefined") {
        this.intersections = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            (entry.target as HTMLElement).toggleAttribute("data-viewport-grid-offscreen", !entry.isIntersecting);
          }
        }, { root, rootMargin: "600px" });
      }
    }
    // A known previous layout seeds distant cards; otherwise they start
    // visible. Native intersections refine the window while its viewport and
    // overscan keep ordinary painting, including outward card shadows.
    for (const element of this.observed) {
      if (element.parentElement !== collection) {
        this.intersections?.unobserve(element);
        element.removeAttribute("data-viewport-grid-offscreen");
        this.observed.delete(element);
      }
    }
    for (const element of collection.children) {
      if (!(element instanceof HTMLElement) || element === sample || this.observed.has(element)) continue;
      this.observed.add(element);
      this.intersections?.observe(element);
    }
  }

  private measure() {
    const { collection, sample } = this;
    if (!collection || !sample?.isConnected) return;
    const height = sample.getBoundingClientRect().height;
    if (!(height > 0) || Math.abs(height - this.blockSize) < 0.1) return;
    this.blockSize = height;
    collection.style.setProperty("--viewport-grid-item-block-size", `${height}px`);
    collection.setAttribute("data-viewport-grid", "");
  }

  disconnect(preserve?: HTMLElement) {
    this.resize?.disconnect();
    this.resize = undefined;
    this.intersections?.disconnect();
    this.intersections = undefined;
    for (const element of this.observed)
      if (element.parentElement !== preserve) element.removeAttribute("data-viewport-grid-offscreen");
    this.observed.clear();
    this.sample?.removeAttribute("data-viewport-grid-sample");
    if (this.collection !== preserve) {
      this.collection?.removeAttribute("data-viewport-grid");
      this.collection?.style.removeProperty("--viewport-grid-item-block-size");
    }
    this.collection = undefined;
    this.sample = undefined;
    this.root = null;
    this.blockSize = 0;
  }
}
