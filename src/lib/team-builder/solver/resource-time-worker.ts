import { prepareNativeResourceTime, type NativeResourceTimeRequest, type NativeResourceTimeResponse } from "./native-resource-time.ts";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<NativeResourceTimeRequest>) => void) | null;
  postMessage(message: NativeResourceTimeResponse): void;
};
let active: { runId: string; cancelled: boolean } | null = null;
scope.onmessage = event => {
  const message = event.data;
  if (message.type === "cancel") { if (active?.runId === message.runId) active.cancelled = true; return; }
  if (message.type !== "prepare") return;
  if (active) active.cancelled = true;
  const run = { runId: message.runId, cancelled: false };
  active = run;
  void prepareNativeResourceTime(message.request, {
    cancelled: () => run.cancelled || active !== run,
    progress: progress => { if (active === run) scope.postMessage({ type: "progress", runId: run.runId, progress }); },
  }).then(result => {
    if (active !== run) return;
    scope.postMessage({ type: "result", runId: run.runId, result }); active = null;
  }).catch((error: unknown) => {
    if (active !== run) return;
    scope.postMessage({ type: "error", runId: run.runId, code: error instanceof Error ? error.message : "resource-time-error" }); active = null;
  });
};
