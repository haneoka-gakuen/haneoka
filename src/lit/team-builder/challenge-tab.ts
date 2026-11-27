// L3 — GEB
// Input: An account's challenge draft, visible events with their pinned challenge tracks, and an optional event or ranking link.
// Output: One eligible chart under the event's score rules and a return link to its source.
// Pos: [Map](../L2-2.md); event challenge task in the shared team workspace.
// Effects/Dependencies: Updates the challenge draft and current URL, delegates search and saving to the existing engine and results.
import { html, nothing } from "lit";
import type { TeamBuilder } from "../team-builder";
import type { BuildSettings } from "./types";
import { playConditions, renderBuildRun, renderCandidates } from "./build-tab";
import { choiceField, sectionHeading } from "./catalog";
import { renderResults } from "./results";
import { toolLayout } from "./tool-layout";

function queryInteger(params: URLSearchParams, name: string, minimum = 1) {
  const raw = params.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return raw.trim() !== "" && Number.isSafeInteger(value) && value >= minimum ? value : NaN;
}

export class ChallengeController {
  private route = new URLSearchParams();
  private unavailable: Pick<BuildSettings, "eventId" | "songs"> | null = null;

  constructor(private readonly host: TeamBuilder) {}

  readRoute(params: URLSearchParams) {
    this.route = new URLSearchParams(params);
    this.unavailable = null;
  }
  clearOwnerRoute() {
    this.readRoute(new URLSearchParams());
    const url = new URL(location.href);
    for (const key of ["event", "challenge", "song", "difficulty", "region", "returnEvent", "returnChallenge"])
      url.searchParams.delete(key);
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  }
  get settings(): BuildSettings {
    return this.unavailable ? { ...this.host.settings, ...this.unavailable } : this.host.settings;
  }

  events() {
    const { catalog, data } = this.host;
    return catalog?.events().filter(({ id }) =>
      (data?.crossServer?.owners.events?.[String(id)] ?? data?.identity.server) === this.host.server &&
      data?.events[String(id)]?.kind !== "planner-event") ?? [];
  }

  tracks(eventId: number | null) {
    const { catalog } = this.host;
    return eventId === null || !catalog ? [] : catalog.challengeSongs(eventId)
      .filter((track) => catalog.difficultyRows(track.liveMusicId).length);
  }

  private chart(songId: number, requested: number | null) {
    const rows = this.host.catalog!.difficultyRows(songId);
    const levels = rows.map(row => Number(row.difficulty));
    const difficulty = requested ?? this.host.songDifficulties.find(id => levels.includes(id)) ?? levels[0];
    return difficulty !== undefined && levels.includes(difficulty) ? [{ songId, difficulty }] : [];
  }

  applyRoute() {
    const host = this.host;
    if (!host.view || !host.catalog || (this.route.has("server") && this.route.get("server") !== host.data?.identity.server)) return;
    const current = host.settings;
    const events = this.events();
    const requestedEvent = queryInteger(this.route, "event");
    const eventId = requestedEvent ?? current.eventId ?? events.find(event => this.tracks(event.id).length)?.id ?? null;
    const event = events.find(row => row.id === eventId);
    const tracks = this.tracks(event?.id ?? null);
    const challenge = queryInteger(this.route, "challenge");
    const song = queryInteger(this.route, "song");
    const difficulty = queryInteger(this.route, "difficulty", 0);
    let songs = current.songs.filter(ref => tracks.some(track => track.liveMusicId === ref.songId)).slice(0, 1);
    if (challenge !== null || song !== null) {
      const selected = tracks.find(track => (challenge === null || challenge === track.id) && (song === null || song === track.liveMusicId));
      songs = selected ? this.chart(selected.liveMusicId, difficulty) : [];
    } else if (requestedEvent !== null && current.eventId !== requestedEvent) songs = [];
    const selection = { eventId: event?.id ?? null, songs };
    if ((requestedEvent !== null && !event) || (this.wantedChart && !songs.length)) {
      this.unavailable = selection;
    } else {
      this.unavailable = null;
      const challengeBoard = this.routeBoard();
      const oldSong = current.songs[0], newSong = songs[0];
      if (selection.eventId !== current.eventId || oldSong?.songId !== newSong?.songId || oldSong?.difficulty !== newSong?.difficulty ||
          challengeBoard?.region !== current.challengeBoard?.region || challengeBoard?.eventId !== current.challengeBoard?.eventId ||
          challengeBoard?.challengeId !== current.challengeBoard?.challengeId) {
        const patch = { ...selection, challengeBoard };
        if (requestedEvent !== null && host.snapshot?.owner !== undefined) host.updateSettings(patch);
        else host.settings = { ...current, ...patch };
      }
    }
    host.requestUpdate();
  }

  select(eventId: number, challengeId?: number, difficulty?: number) {
    const track = this.tracks(eventId).find(row => row.id === challengeId);
    const songs = track ? this.chart(track.liveMusicId, difficulty ?? null) : [];
    const url = new URL(location.href);
    const board = this.routeBoard();
    url.searchParams.set("event", String(eventId));
    for (const key of ["challenge", "song", "difficulty", "returnEvent", "returnChallenge"]) url.searchParams.delete(key);
    if (board) {
      url.searchParams.set("region", board.region);
      if (eventId !== board.eventId) url.searchParams.set("returnEvent", String(board.eventId));
      if (challengeId !== board.challengeId) url.searchParams.set("returnChallenge", String(board.challengeId));
    }
    if (track) {
      url.searchParams.set("challenge", String(track.id));
      url.searchParams.set("song", String(track.liveMusicId));
      if (songs[0]) url.searchParams.set("difficulty", String(songs[0].difficulty));
    }
    this.readRoute(url.searchParams);
    history.replaceState(history.state, "", url);
    this.host.updateSettings({ eventId, songs, challengeBoard: board });
  }

  private routeBoard(): NonNullable<BuildSettings["challengeBoard"]> | null {
    if (!this.wantedEvent) return this.host.settings.challengeBoard ?? null;
    const region = this.route.get("region");
    const eventId = queryInteger(this.route, "returnEvent") ?? queryInteger(this.route, "event");
    const challengeId = queryInteger(this.route, "returnChallenge") ?? queryInteger(this.route, "challenge");
    if (!eventId || !challengeId) return null;
    return ((this.host.server === "jp" && region === "jp") ||
      (this.host.server === "intl" && (region === "en" || region === "tw" || region === "kr"))) ? { eventId, challengeId, region } : null;
  }
  get region() { return this.routeBoard()?.region; }

  get returnHref() {
    const { host } = this;
    const base = `/${host.server}/${host.locale}/events/`;
    const board = this.routeBoard();
    if (board) {
      const params = new URLSearchParams({ event: String(board.eventId), region: board.region, board: "challenge", challenge: String(board.challengeId) });
      return `${base}tracker/?${params}`;
    }
    const event = this.settings.eventId ?? queryInteger(this.route, "event");
    return event && host.data?.events[String(event)] ? `${base}${event}/` : null;
  }
  get wantedEvent() { return this.route.has("event"); }
  get wantedChart() { return this.route.has("challenge") || this.route.has("song"); }
}

export function renderChallengeTab(host: TeamBuilder) {
  const { challenge, catalog } = host;
  const s = host.searchSettings;
  const events = challenge.events();
  const event = events.find(row => row.id === s.eventId);
  const tracks = challenge.tracks(event?.id ?? null);
  const song = s.songs[0];
  const track = tracks.find(row => row.liveMusicId === song?.songId);
  const title = host.t("challenge.title", "Challenge song ranking");
  const max = host.t("criterionMax", "Single-run maximum (ranking)");
  const unavailable = host.t("unavailable", "Unavailable");
  const summary = [event?.name, track && catalog!.songTitle(track.liveMusicId),
    song && catalog!.difficultyLabel(song.songId, song.difficulty), max].filter(Boolean).join(" / ");
  const back = challenge.returnHref;
  return toolLayout(host, () => html`
    <section class="surface stack">
      ${sectionHeading({ icon: "emoji_events", label: title })}
      <div id="tb-event" data-tb-field tabindex="-1">${choiceField({
        type: "select", label: host.t("event", "Event"), value: String(event?.id ?? ""),
        options: [...(event ? [] : [{ value: "", label: challenge.wantedEvent ? unavailable : host.t("needEvent", "Choose an event"), disabled: true }]),
          ...events.map(row => ({ value: String(row.id), label: row.name }))],
        onSelect: value => challenge.select(Number(value)),
      })}</div>
      <div id="tb-songs" class="stack" data-tb-field tabindex="-1">
        ${choiceField({ type: "select", label: host.t("planChallengeSongs", "Challenge songs"), value: String(track?.id ?? ""),
          options: [...(track ? [] : [{ value: "", label: (!tracks.length || challenge.wantedChart) ? unavailable : host.t("addSongs", "Choose songs"), disabled: true }]),
            ...tracks.map(row => ({ value: String(row.id), label: catalog!.songTitle(row.liveMusicId) }))],
          onSelect: value => challenge.select(event!.id, Number(value)),
        })}
        ${track ? choiceField({ type: "buttons", label: host.t("difficulty", "Difficulty"), value: String(song?.difficulty),
          options: catalog!.difficultyRows(track.liveMusicId).map(row => ({
            value: String(row.difficulty), label: catalog!.difficultyLabel(track.liveMusicId, Number(row.difficulty)),
          })),
          onSelect: value => challenge.select(event!.id, track.id, Number(value)),
        }) : nothing}
      </div>
      <span>${host.t("challengeRules", "Challenge live rules (event parameter bonus)")} / ${max}</span>
      ${playConditions(host, s)}
    </section>
    ${renderCandidates(host)}`, renderBuildRun(host), html`
      ${back ? html`<a class="button button--text" href=${back}>${host.t(challenge.region ? "challenge.backRanking" : "challenge.backEvent",
        challenge.region ? "Return to ranking" : "Return to event")}</a>` : nothing}
      ${renderResults(host)}`, { summary });
}
