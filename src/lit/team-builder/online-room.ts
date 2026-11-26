// L3 — GEB
// Input: Persistent local Box, release data, seat conditions and authenticated room state.
// Output: Invite, resume, submit, host search and shared team/score views.
// Pos: [Map](../L2-2.md); GEKISO section of the team builder.
// Effects/Dependencies: Only an explicit submission shares the current player's calculation input.
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { teamFormation } from "./results";
import { LazyImages } from "../ui/lazy-images";
import { live } from "lit/directives/live.js";
import { navigationDocumentUrl } from "../../lib/document-url";
import { isReleasedContent } from "../../lib/content-release";
import { availableOnServer } from "../../lib/team-builder/song-comparison";
import type { BoxView } from "../../lib/team-builder/sync/box-view";
import type { RoomSettings } from "../../lib/team-builder/cooperative-room";
import type { TeamBuilder } from "../team-builder";
import { RoomConnection, RoomRequestError, lastRoomId, roomIdValid, type RoomView } from "./room-connection";

type SeatDraft = { difficulty: number | null; just: number; great: number; missEvery: number; team: string };
const freshDraft = (h: TeamBuilder): SeatDraft => {
  const live = h.buildDrafts.live;
  return {
    difficulty: null,
    just: live.just,
    great: live.playMode === "ap" ? 0 : live.great,
    missEvery: live.playMode === "ap" ? 0 : live.missEvery,
    team: "",
  };
};
const draftKey = (id: string) => "haneoka.gekiso-room.conditions." + id;
const valueOf = (event: Event) => (event.currentTarget as HTMLInputElement).value;

class OnlineRoom extends LitElement {
  private readonly images = new LazyImages();
  static properties = { builder: { attribute: false }, box: { attribute: false }, route: {}, server: {} };
  declare builder: TeamBuilder;
  declare box: BoxView;
  declare route: string;
  declare server: string;
  private readonly room = new RoomConnection(() => {
    const run = this.room.view?.run;
    if (this.search && (run?.id !== this.search.id || run.revision !== this.search.revision || run.complete))
      this.search.controller.abort();
    this.requestUpdate();
  });
  private draft!: SeatDraft;
  private songId = 0;
  private objective: RoomSettings["objective"] = "meanScore";
  private sampleCount = 8;
  private seed = 0;
  private busy = false;
  private copied = false;
  private error = "";
  private search?: { id: string; revision: number; controller: AbortController };
  private songs?: { owner: TeamBuilder["publicData"]; locale: string; choices: [number, string][] };

  createRenderRoot() {
    return this;
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.images.disconnect();
    this.search?.controller.abort();
    this.room.close();
  }
  connectedCallback() {
    super.connectedCallback();
    this.requestUpdate("route");
  }
  protected updated() {
    this.images.observe(this);
  }
  protected willUpdate(changes: PropertyValues) {
    if (!this.builder) return;
    if (changes.has("route") || changes.has("server")) {
      if (this.room.id === this.route && this.room.id && !changes.has("server")) return;
      this.search?.controller.abort();
      this.search = undefined;
      this.busy = false;
      this.error = "";
      this.copied = false;
      this.draft = freshDraft(this.builder);
      this.room.open(this.route || "", this.server);
      if (this.route && this.room.hasSeat) {
        const saved = localStorage.getItem(draftKey(this.route));
        if (saved) {
          try {
            Object.assign(this.draft, JSON.parse(saved));
          } catch {
            /* use Box defaults */
          }
        }
      }
    }
    this.draft ??= freshDraft(this.builder);
  }
  private url(id: string) {
    const url = navigationDocumentUrl();
    url.search = "";
    url.hash = "";
    url.searchParams.set("tab", "room");
    url.searchParams.set("server", this.server);
    if (id) url.searchParams.set("room", id);
    return url;
  }
  private navigate(id: string) {
    const target = this.url(id);
    const account = navigationDocumentUrl().searchParams.get("gameAccount");
    if (account) target.searchParams.set("gameAccount", account);
    history.replaceState(history.state, "", target);
    this.route = id;
    this.requestUpdate();
  }
  private t(key: string, fallback: string, params?: Record<string, number | string>) {
    return this.builder.t("onlineRoom." + key, fallback, params);
  }
  private async action(fn: (signal: AbortSignal) => Promise<void>) {
    if (this.busy) return;
    const signal = this.room.signal;
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
      await fn(signal);
    } catch (e) {
      if (!signal.aborted) {
        this.error =
          e instanceof RoomRequestError
            ? this.failure(e.code)
            : e instanceof Error &&
                [
                  "room-unowned-constraint",
                  "room-release-mismatch",
                  "room-search-stalled",
                  "invalid-room-checkpoint",
                ].includes(e.message)
              ? this.failure(e.message)
              : e instanceof TypeError && /fetch|network/i.test(e.message)
                ? this.t("retry", "Connection interrupted. Try again when you are online.")
                : String(e instanceof Error ? e.message : e);
        void this.room.sync();
      }
    } finally {
      if (!signal.aborted) {
        this.busy = false;
        this.requestUpdate();
      }
    }
  }
  private failure(code: string) {
    const known: Record<string, [string, string]> = {
      "room-unowned-constraint": [
        "missingCards",
        "A required card, leader, binding or saved team references a card you do not own.",
      ],
      "room-release-mismatch": [
        "releaseMismatch",
        "Your card data and the room use different releases. Open the room with matching game data.",
      ],
      "room-search-stalled": [
        "stalled",
        "The calculation stopped before the next checkpoint. Continue the search to try again.",
      ],
      "invalid-room-checkpoint": ["checkpointError", "The saved search progress could not be restored."],
      invalid_link: ["invalidLink", "This invitation link is invalid."],
      room_missing: ["gone", "This room has closed or expired."],
      room_expired: ["gone", "This room has closed or expired."],
      invalid_seat: ["seatLost", "Your saved seat is no longer available."],
      room_full: ["full", "All five seats are taken."],
      reconnecting: ["retrying", "Connection interrupted. Reconnecting…"],
      stale_run: ["changed", "Room inputs changed. Check the current room and continue."],
      stale_seat: ["changed", "Room inputs changed. Check the current room and continue."],
      seats_not_ready: ["needPlayers", "At least two players must join and everyone must submit their cards."],
    };
    const pair = known[code];
    return pair ? this.t(...pair) : this.t("serviceError", "Room request failed ({code}).", { code });
  }
  private songChoices() {
    const h = this.builder,
      data = h.publicData!;
    if (this.songs?.owner !== data || this.songs.locale !== h.locale) {
      const choices: [number, string][] = Object.keys(data.songs)
        .map(Number)
        .filter(
          (id) =>
            availableOnServer(data, "songs", id) && h.catalog!.songVisible(id) && this.difficulties(id).length > 0,
        )
        .map((id) => [id, h.catalog!.songTitle(id)]);
      this.songs = { owner: data, locale: h.locale, choices };
    }
    return this.songs.choices;
  }
  private difficulties(id: number) {
    return this.builder
      .catalog!.difficultyRows(id)
      .filter((row) => isReleasedContent(row))
      .map((row) => Number(row.difficulty));
  }
  private seatDifficulty(song: RoomSettings["song"]) {
    const selected = this.draft.difficulty;
    return selected !== null && this.difficulties(song.songId).includes(selected) ? selected : song.difficulty;
  }
  private baseDifficulty(id: number) {
    const diffs = this.difficulties(id);
    return diffs.includes(4) ? 4 : diffs[diffs.length - 1];
  }
  private async create() {
    const data = this.builder.publicData!;
    const id = crypto.randomUUID(),
      songId = this.songId || this.songChoices()[0]?.[0];
    if (!songId) return;
    if (data.identity.server !== "jp" && data.identity.server !== "intl") return;
    const settings: RoomSettings = {
      server: data.identity.server,
      releaseId: data.identity.releaseId,
      ...(data.identity.sourceId ? { sourceId: data.identity.sourceId } : {}),
      song: { songId, difficulty: this.baseDifficulty(songId) },
      objective: this.objective,
      sampling: { seed: this.seed, count: this.sampleCount, skillOrders: "uniform" },
    };
    this.navigate(id);
    await this.updateComplete;
    if (this.route === id && this.isConnected) await this.action(() => this.room.enter(settings));
  }
  private async submit(view: RoomView) {
    await this.action(async (signal) => {
      const { exportRoomPlayer, assertRoomRelease } = await import("../../lib/team-builder/cooperative-room");
      const h = this.builder,
        { song } = view.settings;
      const count = this.eligibleCharacters();
      if (count < 5) throw new Error(h.t("eligibleCharacters", "{count}/5 eligible characters", { count }));
      assertRoomRelease(h.publicData!, view.settings);
      const options = {
        ...h.buildDrafts.live,
        goal: "gekiso" as const,
        scope: "box" as const,
        songs: [{ ...song, difficulty: this.seatDifficulty(song) }],
      };
      const goal = h.goal(options);
      if (!goal) throw new Error(this.t("noInput", "Check the song and your card settings."));
      const saved = this.box.teams.find((team) => team.id === this.draft.team);
      const lockedTeam = saved
        ? {
            members: saved.members.map((id) => "m" + id),
            snaps: saved.snaps.map((id) => (id === null ? null : "s" + id)),
            leader: "m" + (saved.leader ?? saved.members[0]),
          }
        : undefined;
      const player = exportRoomPlayer(this.box, {
        difficulty: this.seatDifficulty(song),
        accuracy: { just: this.draft.just / 100, great: this.draft.great / 100, missEvery: this.draft.missEvery },
        constraints: h.constraintsFor(goal, options, this.box),
        unknownPolicy: options.unknownPolicy,
        ...(lockedTeam ? { lockedTeam } : {}),
      });
      if (signal.aborted) return;
      const seat = view.seats.find((row) => row.id === view.seatId)!;
      await this.room.mutate("/seat", "PUT", { version: seat.version, player }, signal);
      if (!signal.aborted) localStorage.setItem(draftKey(view.roomId), JSON.stringify(this.draft));
    });
  }
  private async run(view: RoomView) {
    await this.action(async (scope) => {
      const active = view.run
        ? view
        : await this.room.mutate("/start", "POST", { revision: view.revision, runId: crypto.randomUUID() }, scope);
      if (scope.aborted || !active.run || active.run.complete) return;
      const { id, revision, work } = active.run,
        controller = new AbortController(),
        { signal } = controller;
      this.search = { id, revision, controller };
      this.requestUpdate();
      const stop = () => controller.abort();
      scope.addEventListener("abort", stop, { once: true });
      try {
        const { players, runId, revision: inputRevision } = await this.room.inputs(signal);
        if (runId !== id || inputRevision !== revision) throw new RoomRequestError("stale_run", "Changed room");
        const { runRoomSearch } = await import("../../lib/team-builder/cooperative-room");
        for await (const step of runRoomSearch(this.builder.publicData!, active.settings, players, work, signal)) {
          if (signal.aborted) break;
          await this.room.mutate("/progress", "PUT", { revision, runId: id, ...step }, signal);
        }
      } catch (e) {
        if (!signal.aborted) throw e;
      } finally {
        scope.removeEventListener("abort", stop);
        controller.abort();
        if (this.search?.controller === controller) this.search = undefined;
        if (!scope.aborted) void this.room.sync();
      }
    });
  }
  private async leave(view: RoomView) {
    if (
      !window.confirm(
        view.host
          ? this.t("confirmClose", "Close the room for everyone?")
          : this.t("confirmLeave", "Leave this seat and remove your submitted cards?"),
      )
    )
      return;
    await this.action(async (signal) => {
      await this.room.request("/leave", "POST", {}, signal);
      if (!signal.aborted) this.clearRoom();
    });
  }
  private clearRoom() {
    localStorage.removeItem(draftKey(this.room.id));
    this.room.forget();
    this.navigate("");
  }

  private button(action: string, label: string, click: () => unknown, disabled = false, primary = false) {
    return html`
      <button
        type="button"
        class=${primary ? "button button--filled" : "button button--outlined"}
        data-room-action=${action}
        ?disabled=${disabled}
        @click=${click}
      >
        ${label}
      </button>
    `;
  }
  private choice(
    name: string,
    label: string,
    choices: [string | number, string][],
    value: string | number,
    onChange: (value: string) => void,
  ) {
    return html`
      <label class="field-stack">
        <span class="tb-field__label">${label}</span>
        <span class="field">
          <select
            name=${name}
            @change=${(e: Event) => {
              onChange(valueOf(e));
              this.requestUpdate();
            }}
          >
            ${choices.map(
              ([id, text]) => html`
                <option value=${id} ?selected=${String(id) === String(value)}>${text}</option>
              `,
            )}
          </select>
        </span>
      </label>
    `;
  }
  private number(name: string, label: string, value: number, min: number, max: number, onChange: (n: number) => void) {
    return html`
      <label class="field-stack">
        <span class="tb-field__label">${label}</span>
        <span class="field">
          <input
            type="number"
            name=${name}
            .value=${live(String(value))}
            required
            min=${min}
            max=${max}
            step="1"
            @input=${(e: Event) => {
              const input = e.currentTarget as HTMLInputElement;
              if (input.validity.valid) onChange(input.valueAsNumber);
            }}
          />
        </span>
      </label>
    `;
  }
  private form(action: () => unknown) {
    return (event: Event) => {
      event.preventDefault();
      void action();
    };
  }
  private lobby() {
    if (this.room.id)
      return html`
        <section class="surface stack">
          <h2 class="detail-section-title">${this.t("invitation", "Room invitation")}</h2>
          <p>${this.t("inviteDetail", "Join to claim a seat. You can choose which cards to submit after joining.")}</p>
          <div class="cluster">
            ${!this.room.failure && !this.room.hasSeat ? this.button("join", this.t("join", "Join room"), () => this.action(() => this.room.enter()), this.busy, true) : nothing}
            ${
              this.room.hasSeat && !this.room.failure
                ? html`
                    <p role="status">${this.t("connecting", "Connecting to your seat…")}</p>
                  `
                : nothing
            }
            ${this.button("back", this.t("lobby", "Return to lobby"), () => {
              if (["room_missing", "room_expired", "invalid_seat", "room_full"].includes(this.room.failure))
                this.clearRoom();
              else this.navigate("");
            })}
          </div>
        </section>
      `;
    const choices = this.songChoices(),
      last = lastRoomId(this.server);
    if (!this.songId || !choices.some(([id]) => id === this.songId)) {
      const selected = this.builder.buildDrafts.live.songs[0]?.songId;
      this.songId = choices.find(([id]) => id === selected)?.[0] ?? choices[0]?.[0] ?? 0;
    }
    return html`
      <form class="surface stack" @submit=${this.form(() => this.create())}>
        <h2 class="detail-section-title">${this.t("title", "Co-op room")}</h2>
        <p>
          ${this.t("setup", "Choose a song, then invite 1–4 other players. Each player can use their own difficulty.")}
        </p>
        ${this.choice("room-song", this.builder.t("song", "Song"), choices, this.songId, (v) => {
          this.songId = Number(v);
        })}
        ${this.choice(
          "room-objective",
          this.t("objective", "Optimize for"),
          [
            ["meanScore", this.t("mean", "Mean room score")],
            ["ssRate", this.t("rate", "Room SS rate")],
          ],
          this.objective,
          (v) => {
            this.objective = v as RoomSettings["objective"];
          },
        )}
        <div class="cluster">
          ${this.number("room-samples", this.t("samples", "Samples"), this.sampleCount, 1, 4096, (n) => {
            this.sampleCount = n;
          })}
          ${this.number("room-seed", this.t("seed", "Random seed"), this.seed, 0, 4294967295, (n) => {
            this.seed = n;
          })}
        </div>
        <p class="muted">
          ${this.t("samplesHint", "Each sample draws LUCK and skill order. The same seed repeats the same draws.")}
        </p>
        <div class="cluster">
          <button
            class="button button--filled"
            data-room-action="create"
            type="submit"
            ?disabled=${!choices.length || this.busy}
          >
            ${this.t("create", "Create room")}
          </button>
          ${last && roomIdValid(last) ? this.button("resume", this.t("resume", "Return to my room"), () => this.navigate(last)) : nothing}
        </div>
      </form>
    `;
  }
  private eligibleCharacters() {
    const h = this.builder;
    return h.characterCount(
      [...this.box.members.values()].filter((card) => card.use && availableOnServer(h.publicData!, "members", card.cardId)),
    );
  }

  private seatForm(view: RoomView) {
    const { song } = view.settings,
      h = this.builder,
      seat = view.seats.find((row) => row.id === view.seatId)!;
    const diffs = this.difficulties(song.songId);
    const choices: [number, string][] = diffs.map((id) => [id, h.catalog!.difficultyLabel(song.songId, id)]);
    const members = [...this.box.members.values()].filter((card) => card.use).length;
    const snaps = [...this.box.snaps.values()].filter((card) => card.use).length;
    const count = this.eligibleCharacters();
    return html`
      <form class="surface stack" @submit=${this.form(() => this.submit(view))}>
        <h3 class="detail-section-title">${this.t("mySeat", "My seat · {id}", { id: view.seatId })}</h3>
        <div class="row row--between">
          <span>${this.t("owned", "{members} available member cards · {snaps} snapshots", { members, snaps })}</span>
          ${this.button("cards", h.t("tabBox", "My cards"), () => h.setTab("box"))}
        </div>
        ${this.choice(
          "seat-team",
          this.t("formation", "Team selection"),
          [
            ["", this.t("all", "Search my available cards")],
            ...this.box.teams.map((team) => [team.id, team.name || team.id] as [string, string]),
          ],
          this.draft.team,
          (v) => {
            this.draft.team = v;
          },
        )}
        <div class="cluster">
          ${this.choice(
            "seat-difficulty",
            this.t("difficulty", "My difficulty"),
            choices,
            this.seatDifficulty(song),
            (v) => {
              this.draft.difficulty = Number(v);
            },
          )}
          ${this.number("seat-just", this.t("just", "JUST on eligible notes (%)"), this.draft.just, 0, 100, (n) => {
            this.draft.just = n;
          })}
          ${this.number("seat-great", this.t("great", "GREAT (%)"), this.draft.great, 0, 100, (n) => {
            this.draft.great = n;
          })}
          ${this.number(
            "seat-miss",
            this.t("miss", "MISS every N notes (0 = off)"),
            this.draft.missEvery,
            0,
            1000000,
            (n) => {
              this.draft.missEvery = n;
            },
          )}
        </div>
        <p class="muted">
          ${this.t("consent", "The host receives your owned member cards and snapshots, including disabled cards, along with their growth, account bonuses and play conditions. Disabled cards are excluded from teams. Everyone in the room can see the resulting teams.")}
        </p>
        <div>
          <button
            data-room-action="submit"
            class="button button--filled"
            type="submit"
            ?disabled=${this.busy || !choices.length || count < 5}
          >
            ${seat.ready ? this.t("update", "Update my submission") : this.t("submit", "Submit my cards")}
          </button>
        </div>
        ${
          count < 5
            ? html`
                <p role="status">${h.t("eligibleCharacters", "{count}/5 eligible characters", { count })}</p>
              `
            : nothing
        }
      </form>
    `;
  }
  private result(view: RoomView) {
    const run = view.run,
      result = run?.result;
    if (!run) return nothing;
    const phase =
      result?.phase === "inventory"
        ? this.t("phaseInventory", "Preparing each player’s teams")
        : result?.phase === "bounds"
          ? this.t("phaseBounds", "Checking possible room scores")
          : this.t("phaseSearch", "Comparing room combinations");
    const format = (n: number) => new Intl.NumberFormat(this.builder.locale, { maximumFractionDigits: 1 }).format(n);
    return html`
      <section class="surface stack" data-room-result>
        <h3 class="detail-section-title">${this.t("results", "Room results")}</h3>
        <p role="status">
          ${
            run.complete
              ? this.t("complete", "Search complete for the selected samples.")
              : this.t("partial", "Search in progress. The teams shown are the best found so far.")
          }
          ${
            result && !run.complete
              ? html`
                  <span>
                    ${phase} · ${this.t("workDone", "{count} work units saved", { count: format(run.work) })}.
                  </span>
                `
              : nothing
          }
          ${result ? this.t("evaluated", "{count} combinations evaluated.", { count: typeof result.evaluated === "string" ? result.evaluated : format(result.evaluated) }) : nothing}
        </p>
        ${
          result?.teams && result.meanTotal !== null
            ? html`
                <div class="cluster">
                  <strong>${this.t("mean", "Mean room score")} · ${format(result.meanTotal)}</strong>
                  ${
                  result.ssRate !== null
                    ? html`
                        <strong>
                          ${this.t("rate", "Room SS rate")} · ${format(result.ssRate * 100)}%
                          (${result.ssHits}/${result.sampleCount})
                        </strong>
                      `
                    : nothing
                }
                </div>
                ${
                result.ssThreshold !== null
                  ? html`
                      <p>${this.t("threshold", "Room SS threshold")} · ${format(result.ssThreshold)}</p>
                    `
                  : nothing
              }
                <p class="muted">
                  ${
                  result.ssThreshold === null
                    ? this.t("noThreshold", "The room SS threshold is unavailable for this song.")
                    : this.t(
                        "estimate",
                        "The SS rate is the share of these samples that reached SS. Actual play can differ.",
                      )
                }
                </p>
                ${result.teams.map(
                (team, index) => html`
                  <section class="stack stack--tight" data-room-team=${view.seats[index]?.id}>
                    <div class="row row--between">
                      <strong>${this.t("seat", "Seat {id}", { id: view.seats[index]?.id ?? index + 1 })}</strong>
                      <span>${this.t("meanSeat", "Mean score")} · ${format(team.meanScore)}</span>
                    </div>
                    ${teamFormation(
              this.builder,
              team.members.map((member, i) => ({
                member,
                snap: team.snaps[i] ?? null,
                memberGrowth: null,
                snapGrowth: null,
              })),
              team.members.indexOf(team.leader),
              false,
            )}
                    <span>
                      ${this.t("leader", "Leader")} · ${this.builder.catalog!.cardName("members", team.leader)}
                    </span>
                      <details>
                        <summary>${this.t("cardList", "Cards by slot")}</summary>
                        <ol>
                          ${team.members.map((member, slot) => {
                            const catalog = this.builder.catalog!;
                            const snap = team.snaps[slot];
                            return html`<li>
                              ${catalog.characterName(catalog.member(member)?.characterId ?? 0)} ·
                              ${catalog.cardName("members", member)} (#${member})
                              ${snap != null ? html` / ${catalog.cardName("snaps", snap)} (#${snap})` : nothing}
                            </li>`;
                          })}
                        </ol>
                      </details>
                  </section>
                `,
              )}
              `
            : html`
                <p>
                  ${run.complete ? this.t("none", "No legal room formation was found.") : this.t("waitingResult", "Waiting for the first room formation.")}
                </p>
              `
        }
      </section>
    `;
  }
  private async copyInvite(href: string) {
    const signal = this.room.signal;
    try {
      await navigator.clipboard.writeText(href);
      if (!signal.aborted) this.copied = true;
    } catch {
      if (!signal.aborted) this.error = this.t("copyHelp", "Select the invitation link above and copy it.");
    }
    if (!signal.aborted) this.requestUpdate();
  }
  private active(view: RoomView) {
    const { settings, seats } = view,
      ready = seats.every((s) => s.ready) && seats.length >= 2;
    const href = this.url(view.roomId).href;
    return html`
      <section class="surface stack">
        <div class="row row--between">
          <h2 class="detail-section-title">${this.t("title", "Co-op room")}</h2>
          <span>${this.t("players", "{count}/5 players", { count: seats.length })}</span>
        </div>
        <p>
          <strong>${this.builder.catalog!.songTitle(settings.song.songId)}</strong>
          · ${settings.objective === "ssRate" ? this.t("rate", "Room SS rate") : this.t("mean", "Mean room score")} ·
          ${this.t("sampleCount", "{count} samples", { count: settings.sampling?.count ?? 1 })}
        </p>
        <label class="field-stack">
          <span class="tb-field__label">${this.t("invite", "Invitation link")}</span>
          <span class="field">
            <input
              name="room-invite"
              type="url"
              readonly
              .value=${href}
              @focus=${(e: Event) => (e.target as HTMLInputElement).select()}
            />
          </span>
        </label>
        <div class="cluster">
          ${this.button("copy", this.copied ? this.t("copied", "Copied") : this.t("copy", "Copy invitation"), () =>
            this.copyInvite(href),
          )}
          ${this.button("leave", view.host ? this.t("close", "Close room") : this.t("leave", "Leave room"), () => this.leave(view), this.busy)}
        </div>
        <ul class="stack stack--tight">
          ${seats.map(
            (s) => html`
              <li data-room-seat=${s.id}>
                ${this.t("seat", "Seat {id}", { id: s.id })}
                ${
              s.id === 1
                ? html`
                    · ${this.t("host", "Host")}
                  `
                : nothing
            }
                ${
              s.id === view.seatId
                ? html`
                    · ${this.t("you", "You")}
                  `
                : nothing
            }
                · ${s.ready ? this.t("ready", "Cards submitted") : this.t("waiting", "Waiting for cards")}
              </li>
            `,
          )}
        </ul>
      </section>
      ${this.seatForm(view)}
      <section class="surface stack">
        <h3 class="detail-section-title">${this.t("search", "Joint team search")}</h3>
        ${
          view.host
            ? html`
                <p>
                  ${
                  ready
                    ? this.t(
                        "hostHint",
                        "Keep this page open while calculating. You can resume from the last shared checkpoint.",
                      )
                    : this.t("needPlayers", "At least two players must join and everyone must submit their cards.")
                }
                </p>
                <div class="cluster">
                  ${
                  this.search
                    ? this.button("pause", this.t("pause", "Pause search"), () => this.search?.controller.abort())
                    : !view.run?.complete
                      ? this.button(
                          view.run ? "continue" : "start",
                          view.run ? this.t("continue", "Continue search") : this.t("start", "Start search"),
                          () => this.run(view),
                          this.busy || !ready || this.room.offline,
                          true,
                        )
                      : nothing
                }
                </div>
              `
            : html`
                <p>${this.t("guestHint", "The host runs the search. Its progress and results appear here.")}</p>
              `
        }
      </section>
      ${this.result(view)}
    `;
  }
  protected render() {
    if (!this.builder?.publicData || !this.box || !this.draft) return nothing;
    if (this.builder.publicData.identity.server !== "jp" && this.builder.publicData.identity.server !== "intl")
      return html`
        <p class="surface">
          ${this.t("unsupportedServer", "Choose the Japanese or international server to use co-op rooms.")}
        </p>
      `;
    const failure = this.error || (this.room.failure && this.failure(this.room.failure));
    return html`
      <div class="stack">
        ${
          failure
            ? html`
                <p class="surface" role="alert">${failure}</p>
              `
            : nothing
        }
        ${this.room.view ? this.active(this.room.view) : this.lobby()}
      </div>
    `;
  }
}
if (!customElements.get("gekiso-online-room")) customElements.define("gekiso-online-room", OnlineRoom);
