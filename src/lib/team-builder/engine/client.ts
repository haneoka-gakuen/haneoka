/** Main-thread handle on the engine Worker. Cancelling replaces the Worker, so a long search never blocks. */
import type { TeamBuilderData } from "../data";
import type { EngineRequest, EngineResponse, TeamEvaluation, Timeline } from "./api";
import type { EngineCall, EngineReply, EvaluateRequest, ExplainRequest } from "./protocol";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: (done: number, total: number) => void };
export class EngineClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly data: TeamBuilderData) {}

  private spawn(): Promise<void> {
    if (this.ready) return this.ready;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "team-engine" });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<EngineReply>) => {
      const reply = event.data;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      if (reply.type === "progress") pending.progress?.(reply.done, reply.total);
      else {
        this.pending.delete(reply.id);
        if (reply.type === "error") pending.reject(new Error(reply.message));
        else pending.resolve(reply.type === "result" ? reply.result : undefined);
      }
    };
    worker.onerror = (event) => {
      for (const pending of this.pending.values()) pending.reject(new Error(event.message || "engine-crashed"));
      this.pending.clear();
      this.reset();
    };
    this.ready = this.call({ type: "init", id: 0, data: this.data }) as Promise<void>;
    return this.ready;
  }
  private call(message: EngineCall, progress?: Pending["progress"]): Promise<unknown> {
    const id = message.type === "init" ? this.nextId++ : this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      this.worker!.postMessage({ ...message, id });
    });
  }
  private async send<T>(message: EngineCall, progress?: Pending["progress"]): Promise<T> {
    await this.spawn();
    return (await this.call(message, progress)) as T;
  }
  run(request: EngineRequest, progress?: Pending["progress"]) {
    return this.send<EngineResponse>({ type: "run", id: 0, request }, progress);
  }
  evaluate(request: EvaluateRequest) {
    return this.send<TeamEvaluation[]>({ type: "evaluate", id: 0, request });
  }
  explain(request: ExplainRequest) {
    return this.send<Timeline>({ type: "explain", id: 0, request });
  }
  /** Stops everything in flight; the next call starts a fresh Worker. */
  cancel() {
    for (const pending of this.pending.values()) pending.reject(new DOMException("Cancelled", "AbortError"));
    this.pending.clear();
    this.reset();
  }
  private reset() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
  dispose() {
    this.cancel();
  }
}
