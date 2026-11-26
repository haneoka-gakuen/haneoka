// L3 — GEB
// Input: Same-origin /api/gekiso-rooms/:id requests with a per-seat bearer secret.
// Output: Public seat status/results or the host's private, current solver inputs.
// Pos: [Map](L2.md); one SQLite Durable Object owns each room and expires it after 24 idle hours.
// Effects/Dependencies: Reads bounded JSON bodies, persists seats and results in Durable Object storage, and schedules expiry.
import { DurableObject } from "cloudflare:workers";
import { readTeamBody, teamSameOrigin } from "./team-inventory";
import { validRoomPlayer, validRoomResult, validRoomSettings } from "./gekiso-room-payload";

const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const METHODS: Record<string, string> = {
  "": "GET",
  create: "POST",
  join: "POST",
  seat: "PUT",
  inputs: "GET",
  start: "POST",
  progress: "PUT",
  leave: "POST",
};
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "private, no-store", Vary: "Authorization" } });
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
const invalid = () => fail(400, "invalid_body", "Invalid room payload");
const missing = () => fail(404, "room_missing", "Room no longer exists");
const staleRun = () => fail(409, "stale_run", "Room inputs or run changed");

function route(request: Request) {
  const path = new URL(request.url).pathname.split("/");
  if (path[1] !== "api" || path[2] !== "gekiso-rooms" || path.length > 5) return null;
  const roomId = path[3] ?? "";
  const action = path[4] ?? "";
  return UUID.test(roomId) && Object.hasOwn(METHODS, action) ? { roomId, action } : null;
}

export async function handleGekisoRoom(request: Request, env: Env): Promise<Response> {
  const target = route(request);
  if (!target) return missing();
  if (!teamSameOrigin(request)) return fail(403, "cross_origin_request", "Use the same-origin room endpoint");
  if (new URL(request.url).search) return fail(400, "invalid_query", "Room credentials belong in headers");
  if (request.method !== METHODS[target.action]) return fail(405, "method_not_allowed", "Method not allowed");
  const token = request.headers.get("Authorization")?.slice("Bearer ".length) ?? "";
  if (!request.headers.get("Authorization")?.startsWith("Bearer ") || !UUID.test(token))
    return fail(401, "invalid_seat", "Seat credential required");
  let body: Body = {};
  if (request.method !== "GET") {
    const decoded = await readTeamBody(request);
    if (!decoded.ok) return decoded.response;
    body = decoded.body;
  }
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const digest = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  return env.GEKISO_ROOMS.getByName(target.roomId).handle(target.roomId, target.action, digest, body);
}

type RoomRow = {
  settings: string;
  revision: number;
  expires: number;
  closed: number;
  run: string | null;
  work: number;
  complete: number;
  result: string | null;
};
type SeatRow = { id: number; version: number };
type Body = Record<string, unknown>;
const only = (body: Body, ...keys: string[]) =>
  Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key));

export class GekisoRoom extends DurableObject<Env> {
  private get sql() {
    return this.ctx.storage.sql;
  }
  private schemaReady = false;

  private ensureSchema(create: boolean) {
    if (this.schemaReady) return true;
    if (!create && !this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='room'").toArray().length)
      return false;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS room (
      id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      expires INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
      run TEXT, work INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0, result TEXT)`);
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS seats (id INTEGER PRIMARY KEY, digest TEXT UNIQUE NOT NULL, version INTEGER NOT NULL DEFAULT 0, player TEXT)",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS departed (digest TEXT PRIMARY KEY, left_at INTEGER NOT NULL)");
    this.schemaReady = true;
    return true;
  }

  private room() {
    return this.sql.exec<RoomRow>("SELECT * FROM room").toArray()[0];
  }
  private seats() {
    return this.sql.exec<SeatRow>("SELECT id, version FROM seats ORDER BY id").toArray();
  }
  private invalidate() {
    this.sql.exec("UPDATE room SET revision=revision+1, run=NULL, work=0, complete=0, result=NULL");
  }
  private clear() {
    this.sql.exec("DELETE FROM room");
    this.sql.exec("DELETE FROM seats");
    this.sql.exec("DELETE FROM departed");
  }
  private view(roomId: string, seatId: number) {
    const row = this.room()!;
    return json({
      roomId,
      settings: JSON.parse(row.settings),
      seatId,
      host: seatId === 1,
      revision: row.revision,
      seats: this.seats().map(({ id, version }) => ({ id, version, ready: version > 0 })),
      run: row.run
        ? {
            id: row.run,
            revision: row.revision,
            work: row.work,
            complete: !!row.complete,
            result: row.result ? JSON.parse(row.result) : null,
          }
        : null,
      expiresAt: row.expires,
    });
  }

  override async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      if (!this.ensureSchema(false)) return;
      const row = this.room();
      if (!row || row.expires <= Date.now()) {
        await this.ctx.storage.deleteAll();
        this.schemaReady = false;
      } else await this.ctx.storage.setAlarm(row.expires);
    });
  }

  async handle(roomId: string, action: string, digest: string, body: Body) {
    // Arm cleanup before creation. A lost response or storage error can safely repeat this call.
    if (action === "create") {
      if (!only(body, "settings") || !validRoomSettings(body.settings)) return invalid();
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY);
    }
    if (!this.ensureSchema(action === "create")) return action === "leave" ? json({ left: true }) : missing();
    return this.ctx.storage.transactionSync(() => this.apply(roomId, action, digest, body));
  }

  private apply(roomId: string, action: string, digest: string, body: Body): Response {
    const now = Date.now();
    const room = this.room();
    if (room && room.expires <= now) {
      this.clear();
      return fail(410, "room_expired", "Room expired");
    }
    if (action === "create") {
      if (!room) {
        this.sql.exec("INSERT INTO room(id,settings,expires) VALUES(1,?,?)", JSON.stringify(body.settings), now + DAY);
        this.sql.exec("INSERT INTO seats(id,digest) VALUES(1,?)", digest);
        return this.view(roomId, 1);
      }
    }
    if (!room || room.closed) return action === "leave" ? json({ left: true }) : missing();
    let seat = this.sql.exec<SeatRow>("SELECT id,version FROM seats WHERE digest=?", digest).toArray()[0];
    if (action === "create" && seat?.id !== 1) return fail(409, "room_exists", "Room ID already in use");
    if (action === "join") {
      if (!only(body)) return invalid();
      if (!seat) {
        if (this.sql.exec("SELECT 1 FROM departed WHERE digest=?", digest).toArray().length)
          return fail(401, "invalid_seat", "This seat has left the room");
        const seats = this.seats();
        const id = [2, 3, 4, 5].find((n) => !seats.some((s) => s.id === n));
        if (!id) return fail(409, "room_full", "All five seats are occupied");
        this.sql.exec("INSERT INTO seats(id,digest) VALUES(?,?)", id, digest);
        this.invalidate();
        seat = { id, version: 0 };
      }
    }
    if (!seat) {
      if (action === "leave") return json({ left: true });
      return fail(401, "invalid_seat", "Seat credential does not match this room");
    }
    // Coalesce presence writes during short polling. The existing alarm reads the latest expiry.
    if (room.expires < now + DAY - 60_000) this.sql.exec("UPDATE room SET expires=?", now + DAY);
    if (action === "leave") {
      if (!only(body)) return invalid();
      if (seat.id === 1) {
        this.sql.exec("DELETE FROM seats");
        this.sql.exec("DELETE FROM departed");
        this.sql.exec("UPDATE room SET closed=1, run=NULL, result=NULL");
      } else {
        this.sql.exec("DELETE FROM seats WHERE id=?", seat.id);
        this.sql.exec("INSERT INTO departed VALUES(?,?)", digest, now);
        this.invalidate();
      }
      return json({ left: true });
    }
    if (action === "seat") {
      if (!only(body, "version", "player") || !Number.isSafeInteger(body.version) || !validRoomPlayer(body.player))
        return invalid();
      const value = JSON.stringify(body.player);
      const same = this.sql.exec("SELECT 1 FROM seats WHERE id=? AND player=?", seat.id, value).toArray().length > 0;
      if (!same) {
        if (body.version !== seat.version) return fail(409, "stale_seat", "Seat submission changed");
        this.sql.exec("UPDATE seats SET version=version+1, player=? WHERE id=?", value, seat.id);
        this.invalidate();
      }
    }
    if (action === "start" || action === "progress" || action === "inputs") {
      if (seat.id !== 1) return fail(403, "host_required", "Only the host can compute for the room");
      if (action === "inputs") {
        if (!room.run) return staleRun();
        const players = this.sql
          .exec<{ player: string }>("SELECT player FROM seats ORDER BY id")
          .toArray()
          .map((s) => JSON.parse(s.player));
        return json({ revision: room.revision, runId: room.run, players });
      }
      if (body.revision !== room.revision) return staleRun();
      if (typeof body.runId !== "string" || !UUID.test(body.runId)) return invalid();
      const seats = this.seats();
      if (action === "start") {
        if (!only(body, "revision", "runId")) return invalid();
        if (seats.length < 2 || seats.some((s) => s.version === 0))
          return fail(409, "seats_not_ready", "At least two submitted seats are required");
        if (!room.run) this.sql.exec("UPDATE room SET run=?", body.runId);
      } else {
        if (body.runId !== room.run) return staleRun();
        if (
          !only(body, "revision", "runId", "work", "complete", "result") ||
          typeof body.work !== "number" ||
          !Number.isSafeInteger(body.work) ||
          body.work < 0 ||
          typeof body.complete !== "boolean" ||
          !validRoomResult(body.result, seats.length)
        )
          return invalid();
        // Retries and two host tabs may report an older checkpoint. Keep the furthest accepted one.
        if (
          !room.complete &&
          (body.work > room.work || (body.work === room.work && (body.complete || room.result === null)))
        )
          this.sql.exec(
            "UPDATE room SET work=?, complete=?, result=?",
            body.work,
            Number(body.complete),
            JSON.stringify(body.result),
          );
      }
    }
    return this.view(roomId, seat.id);
  }
}
