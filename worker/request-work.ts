import { AsyncLocalStorage } from "node:async_hooks";

interface RequestWork {
  context: Pick<ExecutionContext, "waitUntil">;
  scheduled: Set<string>;
}
const requests = new AsyncLocalStorage<RequestWork>();

/** Async-local state belongs to one invocation, including its internal read handlers. */
export function withRequestWork<T>(context: Pick<ExecutionContext, "waitUntil">, work: () => T): T {
  return requests.run({ context, scheduled: new Set() }, work);
}

/** Keep shared reads alive when the initiating client leaves. The reader reports errors. */
export function retainRequestRead(read: Promise<unknown>): void {
  requests.getStore()?.context.waitUntil(read.catch(() => undefined));
}

/** Complete non-authoritative telemetry after the response; retain synchronous behavior outside fetch. */
export async function backgroundWork(key: string, work: () => Promise<unknown>): Promise<void> {
  const state = requests.getStore();
  if (!state) { await work(); return; }
  if (state.scheduled.has(key)) return;
  state.scheduled.add(key);
  state.context.waitUntil(work());
}
