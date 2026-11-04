export class RequestScope {
  private controller?: AbortController;
  private detachParent?: () => void;

  begin(parent?: AbortSignal): AbortSignal {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    if (parent?.aborted) controller.abort(parent.reason);
    else if (parent) {
      const abort = () => controller.abort(parent.reason);
      parent.addEventListener("abort", abort, { once: true });
      this.detachParent = () => parent.removeEventListener("abort", abort);
    }
    return controller.signal;
  }

  current(signal: AbortSignal): boolean {
    return this.controller?.signal === signal && !signal.aborted;
  }

  cancel(): void {
    this.detachParent?.();
    this.detachParent = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
