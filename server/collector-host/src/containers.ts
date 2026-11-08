// L3 — GEB
// Input: The collector object's schedules and the host's object context.
// Output: The part of `@cloudflare/containers` the collector code uses: schedules, environment and context.
// Pos: [Map](../../L2.md); stand-in for the Container base class on the collector host.
// Effects/Dependencies: Keeps schedules in the object's SQLite file and runs due ones in order.
import type { LocalStorage } from "./storage";

export interface HostContext {
  storage: LocalStorage;
  id: { name: string; toString(): string };
  blockConcurrencyWhile<T>(work: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduleRow { id: string; callback: string; payload: string | null; time: number }

export class Container<Env = unknown> {
  defaultPort = 8080;
  sleepAfter: string | number = "10m";
  enableInternet = true;
  pingEndpoint = "ping";
  envVars: Record<string, string> = {};

  constructor(protected readonly ctx: HostContext, protected readonly env: Env) {
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS container_schedules (
      id TEXT PRIMARY KEY NOT NULL, callback TEXT NOT NULL, payload TEXT, type TEXT NOT NULL DEFAULT 'scheduled',
      time INTEGER NOT NULL, delayInSeconds INTEGER, cron TEXT, created_at INTEGER DEFAULT (unixepoch()))`);
  }

  async schedule(when: Date | number, callback: string, payload?: unknown): Promise<{ taskId: string; time: number }> {
    if (typeof (this as unknown as Record<string, unknown>)[callback] !== "function") throw new Error(`this.${callback} is not a function`);
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 9);
    const time = when instanceof Date ? Math.floor(when.getTime() / 1000) : Math.floor(Date.now() / 1000 + when);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO container_schedules (id,callback,payload,type,time) VALUES (?,?,?,?,?)",
      id, callback, JSON.stringify(payload ?? null), when instanceof Date ? "scheduled" : "delayed", time);
    return { taskId: id, time };
  }

  /** The host checks schedules every second; there is no alarm to set. */
  async scheduleNextAlarm(): Promise<void> {}

  deleteSchedules(name: string): void {
    this.ctx.storage.sql.exec("DELETE FROM container_schedules WHERE callback=?", name);
  }

  /** Runs every schedule that is due, one after another, as the Container alarm does. */
  async runDueSchedules(): Promise<number> {
    const now = Date.now() / 1000;
    const due = this.ctx.storage.sql.exec<ScheduleRow>("SELECT id,callback,payload,time FROM container_schedules WHERE time<=? ORDER BY time,id", now).toArray();
    for (const row of due) {
      const callback = (this as unknown as Record<string, unknown>)[row.callback];
      try {
        if (typeof callback === "function") await callback.call(this, row.payload ? JSON.parse(row.payload) : undefined);
      } catch (error) {
        console.error(JSON.stringify({ event: "schedule_failed", callback: row.callback, error: error instanceof Error ? error.message : String(error) }));
      }
      this.ctx.storage.sql.exec("DELETE FROM container_schedules WHERE id=?", row.id);
    }
    return due.length;
  }

  /** The collector runs beside the host; the remote origin carries every request there. */
  async containerFetch(): Promise<Response> {
    throw new Error("container_unavailable");
  }

  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }
}

export function getContainer(): never {
  throw new Error("container_unavailable");
}
