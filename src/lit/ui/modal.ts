import { noChange } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, PartType, type ElementPart, type PartInfo } from "lit/directive.js";
import "../../styles/components/modal.css";

const scrollLocks = new WeakMap<HTMLElement, { count: number; value: string; priority: string }>();

class ModalDirective extends AsyncDirective {
  private element?: HTMLDialogElement;
  private dismiss?: () => void;
  private previous?: HTMLElement;
  private locked: HTMLElement[] = [];
  private generation = 0;
  constructor(info: PartInfo) {
    super(info);
    if (info.type !== PartType.ELEMENT) throw new Error("modal() requires a dialog element");
  }
  render(onDismiss: () => void) {
    this.dismiss = onDismiss;
    return noChange;
  }
  private cancel = (event: Event) => {
    if (event.target !== this.element) return;
    event.preventDefault();
    this.dismiss?.();
  };
  update(part: ElementPart, [onDismiss]: [() => void]) {
    this.dismiss = onDismiss;
    const element = part.element as HTMLDialogElement;
    if (this.element !== element) {
      this.release();
      this.element = element;
      element.addEventListener("cancel", this.cancel);
    }
    this.open();
    return noChange;
  }
  private open() {
    const generation = ++this.generation;
    queueMicrotask(() => {
      const element = this.element;
      if (!element?.isConnected || !this.isConnected || generation !== this.generation || element.open) return;
      const previous = element.ownerDocument.activeElement;
      this.previous = previous instanceof HTMLElement ? previous : undefined;
      element.showModal();
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (!/auto|scroll|overlay/u.test(style.overflowY) && parent !== element.ownerDocument.scrollingElement)
          continue;
        const lock = scrollLocks.get(parent);
        if (lock) ++lock.count;
        else {
          scrollLocks.set(parent, {
            count: 1,
            value: parent.style.getPropertyValue("overflow"),
            priority: parent.style.getPropertyPriority("overflow"),
          });
          parent.style.setProperty("overflow", "hidden", "important");
        }
        this.locked.push(parent);
      }
    });
  }
  private release() {
    ++this.generation;
    this.element?.removeEventListener("cancel", this.cancel);
    if (this.element?.open) this.element.close();
    for (const parent of this.locked) {
      const lock = scrollLocks.get(parent);
      if (!lock || --lock.count > 0) continue;
      if (lock.value) parent.style.setProperty("overflow", lock.value, lock.priority);
      else parent.style.removeProperty("overflow");
      scrollLocks.delete(parent);
    }
    this.locked = [];
    if (this.previous?.isConnected) this.previous.focus({ preventScroll: true });
    this.previous = undefined;
  }
  protected disconnected() {
    this.release();
  }
  protected reconnected() {
    this.element?.addEventListener("cancel", this.cancel);
    this.open();
  }
}

/** Native top-layer placement preserves the existing dialog surface and theme. */
export const modal = directive(ModalDirective);

const backdropPresses = new WeakMap<HTMLDialogElement, boolean>();

/** The dialog's own padding shares its target with the backdrop; only the box edges tell them apart. */
const outside = (dialog: HTMLDialogElement, event: MouseEvent) => {
  const box = dialog.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
};

/** Records whether a press started on the backdrop, outside the dialog's box. */
export function backdropPress(event: PointerEvent) {
  const dialog = event.currentTarget as HTMLDialogElement;
  backdropPresses.set(dialog, event.target === dialog && outside(dialog, event));
}

/**
 * True only for a click that both started and ended on the backdrop. A drag that
 * begins inside the dialog (selecting text in a field) and is released outside it
 * fires a click on the dialog too, and must not close it.
 */
export function isBackdropClick(event: MouseEvent): boolean {
  const dialog = event.currentTarget as HTMLDialogElement;
  const started = backdropPresses.get(dialog) === true;
  backdropPresses.delete(dialog);
  return started && event.target === dialog && outside(dialog, event);
}
