// L3 — GEB
// Input: Room URL, this browser's seat token and the room service responses.
// Output: Current authenticated room view, reconnect state and host checkpoints.
// Pos: [Map](../L2-2.md); network and recovery state for the co-op room panel.
// Effects/Dependencies: Stores seat credentials locally; polls the service and cancels stale requests.
import type { RoomSettings, RoomPlayer, RoomCheckpoint } from "../../lib/team-builder/cooperative-room";

export interface RoomView {
  roomId: string;
  settings: RoomSettings;
  seatId: number;
  host: boolean;
  revision: number;
  seats: { id: number; ready: boolean; version: number }[];
  run:
    | ({ id: string; revision: number } & Omit<RoomCheckpoint, "result"> & { result: RoomCheckpoint["result"] | null })
    | null;
  expiresAt: number;
}
interface SeatKey {
  token: string;
  pending?: "create" | "join";
  settings?: RoomSettings;
}
export class RoomRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const roomIdValid = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id);
const seatKey = (id: string) => "haneoka.gekiso-room.seat." + id;
const lastKey = (server: string) => "haneoka.gekiso-room.last." + server;
export function lastRoomId(server: string) {
  return localStorage.getItem(lastKey(server)) ?? "";
}

export class RoomConnection {
  view: RoomView | null = null;
  id = "";
  offline = false;
  pending = false;
  failure = "";
  private server = "";
  private key: SeatKey | null = null;
  private scope = new AbortController();
  private timer?: number;
  private requestNumber = 0;
  private acceptedRequest = 0;
  constructor(private readonly changed: () => void) {}

  get signal() {
    return this.scope.signal;
  }
  get hasSeat() {
    return this.key !== null;
  }
  close() {
    this.scope.abort();
    clearTimeout(this.timer);
    this.key = null;
    this.view = null;
    this.id = "";
    this.pending = false;
    this.failure = "";
    this.offline = false;
    this.acceptedRequest = 0;
    this.requestNumber = 0;
  }
  open(id: string, server: string) {
    this.close();
    this.scope = new AbortController();
    this.id = id;
    this.server = server;
    if (!id) return;
    if (!roomIdValid(id)) {
      this.failure = "invalid_link";
      return;
    }
    const saved = localStorage.getItem(seatKey(id));
    if (saved) {
      try {
        const key: SeatKey = JSON.parse(saved);
        if (roomIdValid(key.token)) this.key = key;
      } catch {
        this.failure = "invalid_seat";
      }
    }
    if (this.key) void this.sync();
  }
  private save(key: SeatKey) {
    localStorage.setItem(seatKey(this.id), JSON.stringify(key));
    localStorage.setItem(lastKey(this.server), this.id);
    this.key = key;
  }
  forget() {
    localStorage.removeItem(seatKey(this.id));
    if (lastRoomId(this.server) === this.id) localStorage.removeItem(lastKey(this.server));
    this.close();
  }
  async enter(settings?: RoomSettings) {
    if (this.key) return this.sync();
    const stored = localStorage.getItem(seatKey(this.id));
    if (stored) {
      const key: SeatKey = JSON.parse(stored);
      if (roomIdValid(key.token)) {
        this.key = key;
        return this.sync();
      }
    }
    this.save({ token: crypto.randomUUID(), pending: settings ? "create" : "join", ...(settings ? { settings } : {}) });
    await this.sync();
  }

  async request<T>(path: string, method = "GET", body?: unknown, signal = this.signal): Promise<T> {
    if (!this.key) throw new RoomRequestError("invalid_seat", "Missing seat");
    const res = await fetch("/api/gekiso-rooms/" + this.id + path, {
      method,
      signal,
      cache: "no-store",
      credentials: "omit",
      headers: {
        Authorization: "Bearer " + this.key.token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      throw new RoomRequestError(payload?.error?.code ?? String(res.status), payload?.error?.message ?? res.statusText);
    }
    return res.json();
  }
  private accept(view: RoomView, sequence: number) {
    if (view.roomId !== this.id || sequence < this.acceptedRequest) return;
    const previous = this.view;
    if (
      previous &&
      (view.revision < previous.revision ||
        (view.revision === previous.revision &&
          previous.run &&
          (!view.run || view.run.work < previous.run.work || (previous.run.complete && !view.run.complete))))
    )
      return;
    this.acceptedRequest = sequence;
    this.view = view;
    this.offline = false;
    this.failure = "";
    this.changed();
  }
  private handle(error: unknown) {
    this.offline = !(error instanceof RoomRequestError);
    this.failure = this.offline ? "reconnecting" : (error as RoomRequestError).code;
    if (["room_missing", "room_expired", "invalid_seat"].includes(this.failure)) this.view = null;
    this.changed();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (
      this.signal.aborted ||
      !this.key ||
      ["room_expired", "room_missing", "invalid_seat", "room_full"].includes(this.failure)
    )
      return;
    this.timer = window.setTimeout(() => void this.sync(), this.offline ? 3500 : 1800);
  }
  async sync() {
    if (!this.key || this.pending) return;
    this.pending = true;
    const { signal } = this,
      seq = ++this.requestNumber;
    const { pending, settings } = this.key;
    try {
      const view = pending
        ? await this.request<RoomView>("/" + pending, "POST", pending === "create" ? { settings } : {})
        : await this.request<RoomView>("");
      if (signal.aborted) return;
      if (pending) this.save({ token: this.key!.token });
      this.accept(view, seq);
    } catch (error) {
      if (!signal.aborted && seq === this.requestNumber) this.handle(error);
    } finally {
      if (!signal.aborted) {
        this.pending = false;
        this.schedule();
        this.changed();
      }
    }
  }
  async mutate(path: string, method: string, body: unknown, signal = this.signal) {
    const seq = ++this.requestNumber;
    const view = await this.request<RoomView>(path, method, body, signal);
    if (!signal.aborted) this.accept(view, seq);
    return view;
  }
  inputs(signal: AbortSignal) {
    return this.request<{ revision: number; runId: string; players: RoomPlayer[] }>(
      "/inputs",
      "GET",
      undefined,
      signal,
    );
  }
}
