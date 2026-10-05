import { AsyncLocalStorage } from "node:async_hooks";

type Phase = "catalog" | "thread" | "post" | "comments" | "feed_query" | "hydrate" | "metadata";
interface Timing { total: number; longest: number; calls: number; }
interface ReadTiming { phases: Map<Phase, Timing>; sql: number; sqlCalls: number; }
const scope = new AsyncLocalStorage<ReadTiming>();

/** Fixed phase names only; no query text, user identifiers or content is retained. */
export async function measureCommunityRead<T>(phase: Phase, read: () => Promise<T>): Promise<T> {
  const timing = scope.getStore();
  if (!timing) return read();
  const start = performance.now();
  try {
    const result = await read();
    const sql = (result as { meta?: { timings?: { sql_duration_ms?: unknown } } } | null)?.meta?.timings?.sql_duration_ms;
    if (typeof sql === "number" && Number.isFinite(sql) && sql >= 0) {
      timing.sql += sql;
      timing.sqlCalls++;
    }
    return result;
  } finally {
    const duration = Math.max(0, performance.now() - start);
    const previous = timing.phases.get(phase) ?? { total: 0, longest: 0, calls: 0 };
    previous.total += duration;
    previous.longest = Math.max(previous.longest, duration);
    previous.calls++;
    timing.phases.set(phase, previous);
  }
}

/** Timings belong to one bootstrap invocation and do not include subsequent background work. */
export async function withCommunityReadTiming(read: () => Promise<Response>): Promise<Response> {
  const timing: ReadTiming = { phases: new Map(), sql: 0, sqlCalls: 0 };
  const response = await scope.run(timing, read);
  if (!timing.phases.size) return response;
  const metrics = [...timing.phases].map(([name, value]) =>
    `${name};dur=${value.total.toFixed(1)};desc="${value.calls} calls; max ${value.longest.toFixed(1)}ms"`);
  if (timing.sqlCalls) metrics.push(`db_sql;dur=${timing.sql.toFixed(1)};desc="${timing.sqlCalls} measured queries"`);
  const measured = new Response(response.body, response);
  measured.headers.append("Server-Timing", metrics.join(","));
  return measured;
}
