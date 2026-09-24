import { LitElement, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { resolveLocalizedText } from "../lib/localized-text";
import { localizedText, uiText, type JsonRecord } from "./shared/catalog";
import {
  compareVoices,
  VOICE_GROUPS,
  voiceGroup,
  voiceKey,
  voiceLines,
  voiceText,
  voiceTitleKey,
} from "./shared/voice-catalog";
import { icon } from "./ui/icon";
import { iconButton } from "./ui/controls";
import { emptyState } from "./ui/state";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import "../styles/character-voices.css";

export class CharacterVoices extends LitElement {
  static properties = {
    entries: { attribute: false },
    characters: { attribute: false },
    locale: {},
    characterId: { type: Number },
    group: { state: true },
    query: { state: true },
    partner: { state: true },
    activeKey: { state: true },
    lineIndex: { state: true },
    playing: { state: true },
    busy: { state: true },
    time: { state: true },
    duration: { state: true },
    finished: { state: true },
    error: { state: true },
  };
  declare entries: JsonRecord[];
  declare characters: JsonRecord[];
  declare locale: string;
  declare characterId: number;
  declare group: string;
  declare query: string;
  declare partner: string;
  declare activeKey: string;
  declare lineIndex: number;
  declare playing: boolean;
  declare busy: boolean;
  declare time: number;
  declare duration: number;
  declare finished: boolean;
  declare error: string;
  private audio = new Audio();
  private generation = 0;
  private queue: string[] = [];
  private queueIndex = 0;
  private onMusic = (event: Event) => {
    if ((event as CustomEvent<{ playing: boolean }>).detail?.playing) this.pause();
  };
  private onOtherVoice = (event: Event) => {
    if ((event as CustomEvent).detail !== this) this.pause();
  };
  constructor() {
    super();
    this.entries = [];
    this.characters = [];
    this.locale = "ja";
    this.characterId = 0;
    this.group = "all";
    this.query = "";
    this.partner = "";
    this.activeKey = "";
    this.lineIndex = 0;
    this.playing = false;
    this.busy = false;
    this.time = 0;
    this.duration = 0;
    this.finished = false;
    this.error = "";
    this.audio.preload = "none";
    this.audio.addEventListener("play", () => {
      this.playing = true;
    });
    this.audio.addEventListener("playing", () => {
      this.busy = false;
    });
    this.audio.addEventListener("waiting", () => {
      if (!this.audio.paused) this.busy = true;
    });
    this.audio.addEventListener("pause", () => {
      this.playing = false;
      this.busy = false;
    });
    this.audio.addEventListener("timeupdate", () => {
      this.time = this.audio.currentTime;
    });
    this.audio.addEventListener("loadedmetadata", () => {
      this.duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    });
    this.audio.addEventListener("ended", () => this.advance());
    this.audio.addEventListener("error", () => {
      if (this.audio.getAttribute("src")) {
        this.busy = false;
        this.playing = false;
        this.error = this.v("failure");
      }
    });
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    addEventListener("haneoka-audio-state", this.onMusic);
    addEventListener("haneoka:character-voice", this.onOtherVoice);
  }
  disconnectedCallback() {
    this.stop();
    removeEventListener("haneoka-audio-state", this.onMusic);
    removeEventListener("haneoka:character-voice", this.onOtherVoice);
    super.disconnectedCallback();
  }
  protected willUpdate(changed: PropertyValues) {
    if (changed.has("characterId")) {
      this.stop();
      this.group = "all";
      this.query = "";
      this.partner = "";
    } else if (
      changed.has("entries") &&
      this.activeKey &&
      !this.entries.some((entry) => voiceKey(entry) === this.activeKey)
    )
      this.stop();
  }
  protected updated(changed: PropertyValues) {
    if (changed.has("entries") || changed.has("locale")) {
      for (const select of this.querySelectorAll<
        HTMLElement & { updateComplete: Promise<boolean>; value: string; select(value: string): void }
      >("md-outlined-select")) {
        void select.updateComplete.then(() => {
          if (select.isConnected) select.select(select.value);
        });
      }
    }
  }
  private v(key: string, ...values: Array<string | number>) {
    return voiceText(this.locale, key, ...values);
  }
  private t(key: string) {
    return uiText(this.locale, key);
  }
  private character(id: number) {
    return this.characters.find((item) => Number(item.characterId) === id);
  }
  private name(id: number) {
    return localizedText(this.character(id)?.characterName, this.locale) || this.t("character");
  }
  private get active() {
    return this.entries.find((entry) => voiceKey(entry) === this.activeKey);
  }
  private entryTitle(entry: JsonRecord) {
    const title = localizedText(entry.title, this.locale) || this.v(voiceTitleKey(entry));
    const rank = Number(entry.scoreRank || 0);
    const score =
      Number(entry.masterType) === 1 && Number(entry.characterVoiceType) === 7 && rank > 0
        ? ["", "E", "D", "C", "B", "A", "S", "SS"][rank]
        : "";
    const call =
      Number(entry.masterType) === 5
        ? Number(entry.dialogueCallType) === 1
          ? this.v("call")
          : Number(entry.dialogueCallType) === 2
            ? this.v("response")
            : ""
        : "";
    return [title, score, call].filter(Boolean).join(" · ");
  }
  private filtered() {
    const query = this.query.trim().normalize("NFKC").toLocaleLowerCase(this.locale);
    return [...this.entries].sort(compareVoices).filter((entry) => {
      if (this.group !== "all" && voiceGroup(entry) !== this.group) return false;
      if (this.partner && !((entry.characterIds as unknown[]) || []).map(String).includes(this.partner)) return false;
      const text = `${this.entryTitle(entry)} ${voiceLines(entry)
        .map((line) => `${this.name(line.characterId)} ${localizedText(line.text, this.locale)}`)
        .join(" ")}`;
      return !query || text.normalize("NFKC").toLocaleLowerCase(this.locale).includes(query);
    });
  }
  private pause() {
    this.generation++;
    this.audio.pause();
    this.busy = false;
  }
  private stop() {
    this.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.activeKey = "";
    this.lineIndex = 0;
    this.time = 0;
    this.duration = 0;
    this.finished = false;
    this.error = "";
    this.queue = [];
    this.queueIndex = 0;
  }
  private async playCurrent() {
    const generation = ++this.generation;
    this.error = "";
    this.busy = true;
    document.querySelector<HTMLElement & { pausePlayback?: () => void }>("audio-dock")?.pausePlayback?.();
    dispatchEvent(new CustomEvent("haneoka:character-voice", { detail: this }));
    try {
      await this.audio.play();
      if (generation === this.generation) this.busy = false;
    } catch (error) {
      if (generation === this.generation && !(error instanceof DOMException && error.name === "AbortError")) {
        this.error = this.v("failure");
        this.playing = false;
        this.busy = false;
      }
    }
  }
  private async loadLine(index: number) {
    const entry = this.active;
    if (!entry) return;
    const lines = voiceLines(entry);
    const next = lines.findIndex((line, at) => at >= index && Boolean(line.url));
    if (next < 0) {
      this.advanceEntry();
      return;
    }
    this.generation++;
    this.audio.pause();
    this.lineIndex = next;
    this.time = 0;
    this.duration = lines[next]!.duration;
    this.finished = false;
    this.audio.src = lines[next]!.url;
    await this.playCurrent();
  }
  private start(entry: JsonRecord, index = 0, queue: JsonRecord[] = [entry]) {
    this.queue = queue.filter((item) => voiceLines(item).some((line) => line.url)).map(voiceKey);
    this.queueIndex = Math.max(0, this.queue.indexOf(voiceKey(entry)));
    this.activeKey = voiceKey(entry);
    void this.loadLine(index);
  }
  private toggle(entry: JsonRecord) {
    if (voiceKey(entry) !== this.activeKey) {
      this.start(entry);
      return;
    }
    if (this.playing || this.busy) this.pause();
    else if (this.finished || this.error) void this.loadLine(0);
    else void this.playCurrent();
  }
  private advance() {
    void this.loadLine(this.lineIndex + 1);
  }
  private advanceEntry() {
    if (this.queueIndex + 1 < this.queue.length) this.selectQueue(this.queueIndex + 1);
    else {
      this.busy = false;
      this.playing = false;
      this.finished = true;
    }
  }
  private selectQueue(index: number) {
    const key = this.queue[index];
    if (!key) return;
    this.queueIndex = index;
    this.activeKey = key;
    void this.loadLine(0);
  }
  private clock(value: number) {
    const seconds = Math.max(0, Math.floor(value));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  private renderPlayer() {
    const active = this.active;
    if (!active) return nothing;
    const lines = voiceLines(active);
    return html`
      <section class="voice-player" aria-label=${this.t("player")}>
        <div class="voice-player__heading">
          <strong>${this.entryTitle(active)}</strong>
          <small>
            ${lines.length > 1 ? this.v("clip", this.lineIndex + 1, lines.length) : this.v(voiceGroup(active))}
          </small>
          ${iconButton({ icon: "close", label: this.t("close"), onClick: () => this.stop() })}
        </div>
        <div class="voice-player__controls">
          ${iconButton({ icon: "skip_previous", label: this.t("previous"), disabled: this.queueIndex === 0, onClick: () => this.selectQueue(this.queueIndex - 1) })}
          ${iconButton({ icon: this.playing || this.busy ? "pause" : this.finished ? "replay" : "play_arrow", label: this.playing || this.busy ? this.t("pause") : this.finished ? this.v("replay") : this.t("play"), variant: "filled", onClick: () => this.toggle(active) })}
          ${iconButton({ icon: "skip_next", label: this.t("next"), disabled: this.queueIndex + 1 >= this.queue.length, onClick: () => this.selectQueue(this.queueIndex + 1) })}
          <md-slider
            min="0"
            .max=${Math.max(0.01, this.duration)}
            .value=${Math.min(this.time, this.duration)}
            step="0.01"
            ?disabled=${this.duration <= 0 || this.audio.readyState < 1}
            aria-label=${this.t("playbackPosition")}
            aria-valuetext=${`${this.clock(this.time)} / ${this.clock(this.duration)}`}
            @input=${(event: Event) => {
              const value = Number((event.target as HTMLElement & { value: number }).value);
              if (this.audio.readyState >= 1) {
                this.audio.currentTime = Math.min(this.duration, Math.max(0, value));
                this.time = this.audio.currentTime;
                this.finished = false;
              }
            }}
          ></md-slider>
          <span class="voice-player__time">${this.clock(this.time)} / ${this.clock(this.duration)}</span>
        </div>
        ${
          this.error
            ? html`
                <p class="voice-player__error" role="alert">${this.error}</p>
              `
            : nothing
        }
      </section>
    `;
  }
  private renderEntry(entry: JsonRecord) {
    const key = voiceKey(entry);
    const active = key === this.activeKey;
    const lines = voiceLines(entry);
    const playable = lines.some((line) => line.url);
    const playing = active && (this.playing || this.busy);
    const duration = lines.reduce((total, line) => total + line.duration, 0);
    const title = this.entryTitle(entry);
    const nameLanguage = entry.title ? resolveLocalizedText(entry.title, this.locale).locale : this.locale;
    const condition =
      Number(entry.unlockCharacterRank) > 0
        ? this.v("unlockRank", Number(entry.unlockCharacterRank))
        : Number(entry.unlockFriendshipRank) > 0
          ? this.v("unlockBond", Number(entry.unlockFriendshipRank))
          : "";
    return html`
      <article class=${`voice-entry${active ? " is-active" : ""}`} data-voice-key=${key}>
        <header>
          <div>
            <h4 lang=${nameLanguage}>
              ${
                entry.cardId
                  ? html`
                      <a href=${`/catalog/member-cards/?card=${encodeURIComponent(String(entry.cardId))}`}>${title}</a>
                    `
                  : title
              }
            </h4>
            ${
              condition
                ? html`
                    <small>${condition}</small>
                  `
                : nothing
            }
          </div>
          <span class="voice-entry__duration">
            ${playable && duration ? this.clock(duration) : !playable ? this.v("unavailable") : ""}
          </span>
          <button
            class="icon-button"
            type="button"
            ?disabled=${!playable}
            aria-label=${`${playing ? this.t("pause") : this.t("play")} · ${title}`}
            aria-pressed=${playing}
            @click=${() => this.toggle(entry)}
          >
            ${playing ? icon("pause", 24) : icon("play_arrow", 24)}
          </button>
        </header>
        <div class="voice-entry__lines">
          ${lines.map((line, index) => {
            const text = resolveLocalizedText(line.text, this.locale);
            const character = this.character(line.characterId);
            const image = String(character?.faceImage || "");
            return html`
              <div class=${`voice-line${active && this.lineIndex === index ? " is-current" : ""}`}>
                ${
                  lines.length > 1
                    ? html`
                        <span class="voice-line__avatar">
                          ${
                            image
                              ? html`
                                  <img src=${image} alt="" loading="lazy" width="28" height="28" />
                                `
                              : icon("person", 24)
                          }
                        </span>
                      `
                    : nothing
                }
                <div>
                  ${
                    lines.length > 1
                      ? html`
                          <strong lang=${resolveLocalizedText(character?.characterName, this.locale).locale}>
                            ${this.name(line.characterId)}
                          </strong>
                        `
                      : nothing
                  }
                  <p
                    lang=${text.locale}
                    class=${text.text ? "" : "voice-line__missing"}
                    .textContent=${text.text || this.v("noText")}
                  ></p>
                  ${
                    !line.url && playable
                      ? html`
                          <small>${this.v("unavailable")}</small>
                        `
                      : nothing
                  }
                </div>
                ${
                  lines.length > 1
                    ? html`
                        <button
                          class="icon-button"
                          ?disabled=${!line.url}
                          aria-label=${`${this.v("playLine")} · ${this.name(line.characterId)}`}
                          @click=${() => this.start(entry, index)}
                        >
                          ${icon("volume_up", 20)}
                        </button>
                      `
                    : nothing
                }
              </div>
            `;
          })}
        </div>
      </article>
    `;
  }
  render() {
    const rows = this.filtered();
    const groups = VOICE_GROUPS.filter((group) => this.entries.some((entry) => voiceGroup(entry) === group));
    const partners = [
      ...new Set(
        this.entries.flatMap((entry) =>
          Array.isArray(entry.characterIds) && entry.characterIds.length > 1 ? entry.characterIds.map(Number) : [],
        ),
      ),
    ]
      .filter((id) => id !== this.characterId)
      .sort((a, b) => a - b);
    const playable = rows.filter((entry) => voiceLines(entry).some((line) => line.url));
    return html`
      <section class="character-voices">
        <div class="voice-filters">
          <label class="search-bar">
            ${icon("search", 20)}
            <input
              type="search"
              .value=${this.query}
              placeholder=${this.v("search")}
              aria-label=${this.v("search")}
              @input=${(event: Event) => (this.query = (event.target as HTMLInputElement).value)}
            />
          </label>
          <md-outlined-select
            label=${this.v("category")}
            .value=${this.group}
            @change=${(event: Event) => {
              this.group = (event.target as HTMLElement & { value: string }).value;
              if (this.group !== "interaction" && this.group !== "all") this.partner = "";
            }}
          >
            <md-select-option value="all">
              <span slot="headline">${this.v("all")} · ${this.entries.length}</span>
            </md-select-option>
            ${groups.map(
              (group) => html`
                <md-select-option value=${group}>
                  <span slot="headline">
                    ${this.v(group)} · ${this.entries.filter((entry) => voiceGroup(entry) === group).length}
                  </span>
                </md-select-option>
              `,
            )}
          </md-outlined-select>
          ${
            partners.length && ["all", "interaction"].includes(this.group)
              ? html`
                  <md-outlined-select
                    label=${this.v("partner")}
                    .value=${this.partner}
                    @change=${(event: Event) => (this.partner = (event.target as HTMLElement & { value: string }).value)}
                  >
                    <md-select-option value=""><span slot="headline">${this.t("all")}</span></md-select-option>
                    ${partners.map(
                      (id) => html`
                        <md-select-option value=${String(id)}>
                          <span slot="headline">${this.name(id)}</span>
                        </md-select-option>
                      `,
                    )}
                  </md-outlined-select>
                `
              : nothing
          }
        </div>
        <div class="voice-list-actions">
          <span role="status">${this.v("count", rows.length)}</span>
          <button
            class="button button--tonal"
            ?disabled=${!playable.length}
            @click=${() => this.start(playable[0]!, 0, playable)}
          >
            ${icon("playlist_play", 20)}${this.v("sequential")}
          </button>
        </div>
        ${this.renderPlayer()}
        ${
          rows.length
            ? VOICE_GROUPS.map((group) => {
                const items = rows.filter((entry) => voiceGroup(entry) === group);
                return items.length
                  ? html`
                      <section class="voice-group">
                        <h3>
                          ${this.v(group)}
                          <span>${items.length}</span>
                        </h3>
                        <div>${repeat(items, voiceKey, (entry) => this.renderEntry(entry))}</div>
                      </section>
                    `
                  : nothing;
              })
            : emptyState({ title: this.t("empty"), icon: "search_off" })
        }
      </section>
    `;
  }
}
customElements.define("character-voices", CharacterVoices);
