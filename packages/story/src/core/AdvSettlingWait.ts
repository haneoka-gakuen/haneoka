export interface AdvSettlingWait {
  readonly promise: Promise<void>;
  settle(): void;
}

/** One-shot wait whose abort path resolves synchronously and removes listeners. */
export function createAdvSettlingWait(signal?: AbortSignal, onSettle?: () => void): AdvSettlingWait {
  let resolve!: () => void;
  let settled = false;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  const settle = () => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", settle);
    onSettle?.();
    resolve();
  };
  signal?.addEventListener("abort", settle, { once: true });
  if (signal?.aborted) settle();
  return { promise, settle };
}
