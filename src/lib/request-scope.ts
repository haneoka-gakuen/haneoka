export class RequestScope {
  private controller?: AbortController;

  begin(): AbortSignal {
    this.cancel();
    this.controller = new AbortController();
    return this.controller.signal;
  }

  current(signal: AbortSignal): boolean {
    return this.controller?.signal === signal && !signal.aborted;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
  }
}
