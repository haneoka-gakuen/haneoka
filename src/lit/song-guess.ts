import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { readPageData } from "../lib/page-data";
import type { PublicSongsPageData } from "../server/tool-page-data";
import { beginLoading } from "../lib/loading-progress";
import { resourcePath } from "../lib/resource-route";
import { defaultJapaneseSongTitles, japaneseSongTitles, observeSongDisplay, songTitle } from "../lib/song-display";
import { catalogUrl, currentReleaseServer, fetchJson, localizedText, preferredLocale, uiText } from "./shared/catalog";
import { segmented } from "./ui/controls";
import { errorState, loadingState } from "./ui/state";
import { icon } from "./ui/icon";
import { clientText } from "../i18n/client";
import type { Locale } from "@haneoka/i18n";
import type { ReleaseServer } from "../lib/release-server";
import "../styles/song-guess.css";

interface Song {
  id: number;
  title: string;
  titleLanguage: string;
  source: Record<string, unknown>;
  band: string;
  bandId: number;
  jacket: string;
}
type Pool = "all" | "band";
/** Zoom per wrong answer: the crop widens until the whole jacket shows. */
const ZOOMS = [6, 3.5, 2, 1];

/** Name the song from a crop of its jacket; every miss widens the crop. */
export class SongGuess extends LitElement {
  static properties = {
    locale: { type: String },
    phase: { state: true },
    pool: { state: true },
    round: { state: true },
  };
  declare locale: string;
  declare phase: "loading" | "ready" | "error";
  declare pool: Pool;
  declare round: { answer: Song; options: Song[]; misses: number[]; focus: [number, number]; solved: boolean } | null;
  private songs: Song[] = [];
  private pageData?: PublicSongsPageData;
  private server: ReleaseServer = "intl";
  private stats = { played: 0, firstTry: 0, streak: 0, best: 0 };
  constructor() {
    super();
    this.locale = "ja";
    this.phase = "loading";
    this.pool = "all";
    this.round = null;
  }
  createRenderRoot() {
    return this;
  }
  private disposeSongDisplay?: () => void;
  connectedCallback() {
    const payload = readPageData<PublicSongsPageData>(this);
    if (payload?.schema === "haneoka-public-songs-page-v1") this.preparePage(payload);
    super.connectedCallback();
    this.disposeSongDisplay = observeSongDisplay(() => {
      for (const song of this.songs) {
        const title = songTitle(song.source, this.locale);
        song.title = title.text;
        song.titleLanguage = title.locale;
      }
      this.requestUpdate();
    });
    this.locale = preferredLocale(this.locale);
    if (payload) void this.updateComplete.then(() => {
      this.server = currentReleaseServer() as ReleaseServer;
      void this.load();
    });
    else {
      this.server = currentReleaseServer() as ReleaseServer;
      void this.load();
    }
  }
  disconnectedCallback() {
    this.disposeSongDisplay?.();
    super.disconnectedCallback();
  }
  preparePage(payload: PublicSongsPageData, server = payload.server) {
    this.pageData = payload;
    this.server = server as ReleaseServer;
    const source = payload.variants[server];
    if (!source) { this.phase = "error"; this.round = null; return; }
    this.applySongs(source.songs);
    this.phase = "ready";
    // A stable initial round lets hydration adopt the final HTML. Each visit then uses next().
    const options = this.songs.slice(0, 4);
    this.round = options.length === 4 ? { answer: options[0]!, options, misses: [], focus: [50, 50], solved: false } : null;
  }
  protected update(changed: PropertyValues) {
    if (this.hasAttribute("data-prerendered") && japaneseSongTitles(this.locale) !== defaultJapaneseSongTitles(this.locale)) {
      this.replaceChildren();
      this.removeAttribute("data-prerendered");
    }
    if (this.hasAttribute("data-prerendered")) {
      hydrate(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  private applySongs(songs: Record<string, Record<string, unknown>>) {
    this.songs = Object.values(songs)
      .map(song => ({ id: Number(song.musicId), title: songTitle(song, this.locale).text, titleLanguage: songTitle(song, this.locale).locale, source: song,
        band: localizedText(song.bandName, this.locale), bandId: Number(song.bandId || 0),
        jacket: String(song.jacketUrl || song.jacketThumbUrl || "") }))
      .filter(song => song.id && song.jacket && song.title);
  }
  private text(key: string, fallback: string) {
    return clientText(this.locale, `catalog.songGuess.${key}`, fallback);
  }
  private async load() {
    if (this.pageData?.variants[this.server]) { this.preparePage(this.pageData, this.server); this.next(); return; }
    const progress = beginLoading(uiText(this.locale, "common.states.loading"), { scope: "owner" });
    try {
      const songs = await fetchJson<Record<string, Record<string, unknown>>>(catalogUrl("songs", "", this.server));
      this.applySongs(songs);
      this.phase = "ready";
      this.next();
      progress.finish();
    } catch (error) {
      this.phase = "error";
      progress.fail(error);
    }
  }
  private pick<T>(rows: readonly T[]) {
    return rows[Math.floor(Math.random() * rows.length)]!;
  }
  private next() {
    if (this.songs.length < 4) return;
    const answer = this.pick(this.songs);
    const pool = this.pool === "band" ? this.songs.filter((song) => song.bandId === answer.bandId) : this.songs;
    const others = (pool.length >= 4 ? pool : this.songs).filter((song) => song.id !== answer.id);
    const options = [answer];
    while (options.length < 4) {
      const candidate = this.pick(others);
      if (!options.includes(candidate)) options.push(candidate);
    }
    options.sort(() => Math.random() - 0.5);
    this.round = { answer, options, misses: [], focus: [10 + Math.random() * 80, 10 + Math.random() * 80], solved: false };
  }
  private choose(song: Song) {
    const round = this.round;
    if (!round || round.solved || round.misses.includes(song.id)) return;
    if (song.id === round.answer.id) {
      this.stats.played++;
      if (!round.misses.length) {
        this.stats.firstTry++;
        this.stats.streak++;
        this.stats.best = Math.max(this.stats.best, this.stats.streak);
      } else this.stats.streak = 0;
      this.round = { ...round, solved: true };
    } else this.round = { ...round, misses: [...round.misses, song.id] };
  }
  render() {
    if (this.phase === "loading") return html`<section class="page song-guess">${loadingState(uiText(this.locale, "common.states.loading"))}</section>`;
    if (this.phase === "error")
      return html`<section class="page song-guess">${errorState(uiText(this.locale, "common.states.unavailable"), uiText(this.locale, "common.actions.retry"), () => void this.load())}</section>`;
    const round = this.round;
    if (!round) return nothing;
    const zoom = round.solved ? 1 : ZOOMS[Math.min(round.misses.length, ZOOMS.length - 1)]!;
    const [x, y] = round.focus;
    const href = resourcePath({ server: this.server, locale: this.locale as Locale, kind: "songs", id: String(round.answer.id) });
    const number = (value: number) => value.toLocaleString(this.locale);
    return html`
      <section class="page song-guess">
        <div class="song-guess__layout">
          <div class="song-guess__stage">
            <div class="song-guess__jacket" role="img" aria-label=${round.solved ? round.answer.title : this.text("jacket", "Jacket")}>
              <img
                src=${round.answer.jacket}
                alt=""
                decoding="async"
                style=${`transform-origin:${x}% ${y}%;transform:scale(${zoom})`}
              />
            </div>
            <ol class="song-guess__options" role="list">
              ${round.options.map((song) => {
                const state = round.solved && song.id === round.answer.id ? "correct" : round.misses.includes(song.id) ? "wrong" : "";
                return html`<li>
                  <button
                    class="song-guess__option"
                    type="button"
                    data-state=${state || nothing}
                    ?disabled=${round.solved || round.misses.includes(song.id)}
                    @click=${() => this.choose(song)}
                  >
                    ${state === "correct" ? icon("check_circle", 20) : state === "wrong" ? icon("close", 20) : nothing}
                    <span lang=${song.titleLanguage}>${song.title}</span>
                  </button>
                </li>`;
              })}
            </ol>
            <div class="song-guess__bar">
              ${round.solved
                ? html`<a class="button button--text" href=${href}>${icon("library_music", 18)}<span lang=${round.answer.titleLanguage}>${round.answer.title}</span></a>`
                : html`<span></span>`}
              <button class="button" type="button" @click=${() => this.next()}>
                ${icon(round.solved ? "arrow_forward" : "skip_next", 18)}${round.solved ? this.text("next", "Next") : this.text("skip", "Skip")}
              </button>
            </div>
          </div>
          <aside class="surface stack song-guess__panel">
            ${segmented({
              label: this.text("choices", "Choices"),
              value: this.pool,
              options: [
                { value: "all", label: this.text("anyBand", "All songs") },
                { value: "band", label: this.text("sameBand", "Same band") },
              ],
              onSelect: (pool) => {
                this.pool = pool;
                this.next();
              },
            })}
            <dl class="spec-list spec-list--split spec-list--numeric">
              <div><dt>${this.text("played", "Played")}</dt><dd>${number(this.stats.played)}</dd></div>
              <div><dt>${this.text("firstTry", "First try")}</dt><dd>${number(this.stats.firstTry)}</dd></div>
              <div><dt>${this.text("streak", "Streak")}</dt><dd>${number(this.stats.streak)}</dd></div>
              <div><dt>${this.text("best", "Best streak")}</dt><dd>${number(this.stats.best)}</dd></div>
            </dl>
          </aside>
        </div>
      </section>
    `;
  }
}

if (!customElements.get("song-guess")) customElements.define("song-guess", SongGuess);
