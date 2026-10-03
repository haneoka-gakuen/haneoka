import { LitElement, html, nothing, type PropertyValues } from "lit";
import "@material/web/progress/circular-progress.js";
import { repeat } from "lit/directives/repeat.js";
import { resolveLocalizedText } from "../lib/localized-text";
import { isLocale, localePath } from "../i18n/locales";
import { localizedText, uiText, type JsonRecord } from "./shared/catalog";
import {
  compareVoices,
  VOICE_GROUPS,
  voiceGroup,
  voiceGroupLabelKey,
  voiceGroupMasterType,
  voiceLines,
  voiceText,
  voiceTitleKey,
} from "./shared/voice-catalog";
import { icon } from "./ui/icon";
import { dialogueRow, type DialogueRowState } from "./ui/dialogue-row";
import { emptyState } from "./ui/state";
import "../styles/character-voices.css";

type PlaybackState = Extract<DialogueRowState, "idle" | "loading" | "playing" | "error" | "cancelled">;

interface ClipStatus {
  state: PlaybackState;
  message?: string;
}

export class CharacterVoices extends LitElement {
  static properties = {
    entries: { attribute: false },
    characters: { attribute: false },
    locale: {},
    characterId: { type: Number },
    activeClipKey: { state: true },
  };
  declare entries: JsonRecord[];
  declare characters: JsonRecord[];
  declare locale: string;
  declare characterId: number;
  declare activeClipKey: string;
  private audio?: HTMLAudioElement;
  private audioEvents?: AbortController;
  private generation = 0;
  private clipStatuses = new Map<string, ClipStatus>();
  private onMusic = (event: Event) => {
    if ((event as CustomEvent<{ playing: boolean }>).detail?.playing) this.cancelActive();
  };
  private onOtherVoice = (event: Event) => {
    if ((event as CustomEvent).detail !== this) this.cancelActive();
  };

  constructor() {
    super();
    this.entries = [];
    this.characters = [];
    this.locale = "ja";
    this.characterId = 0;
    this.activeClipKey = "";
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
    this.releaseMedia();
    removeEventListener("haneoka-audio-state", this.onMusic);
    removeEventListener("haneoka:character-voice", this.onOtherVoice);
    super.disconnectedCallback();
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has("characterId")) {
      this.releaseMedia();
      this.clipStatuses.clear();
    } else if (
      changed.has("entries") &&
      this.activeClipKey &&
      !this.entries.some((entry) => this.activeClipKey.startsWith(`${this.voiceKey(entry)}:`))
    ) {
      this.releaseMedia();
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

  private voiceKey(entry: JsonRecord) {
    return String(entry.voiceKey || `${entry.masterType}:${entry.masterId}`);
  }

  private entryTitle(entry: JsonRecord) {
    const title = localizedText(entry.title, this.locale) || this.v(voiceTitleKey(entry));
    const rank = Number(entry.scoreRank || 0);
    const score =
      Number(entry.masterType) === 1 && Number(entry.characterVoiceType) === 7 && rank > 0
        ? ["", "E", "D", "C", "B", "A", "S", "SS"][rank]
        : "";
    const call = [5, 6].includes(Number(entry.masterType))
      ? Number(entry.dialogueCallType) === 1
        ? this.v("call")
        : Number(entry.dialogueCallType) === 2
          ? this.v("response")
          : ""
      : "";
    return [title, score, call].filter(Boolean).join(" · ");
  }

  private clipKey(entry: JsonRecord, index: number) {
    return `${this.voiceKey(entry)}:${index}`;
  }

  private clipStatus(key: string): ClipStatus {
    return this.clipStatuses.get(key) || { state: "idle" };
  }

  private setClipStatus(key: string, state: PlaybackState, message?: string) {
    this.clipStatuses.set(key, { state, message });
    this.requestUpdate();
  }

  private releaseMedia(status: "cancelled" | "idle" = "cancelled") {
    const key = this.activeClipKey;
    this.generation++;
    this.activeClipKey = "";
    const audio = this.audio;
    this.audio = undefined;
    this.audioEvents?.abort();
    this.audioEvents = undefined;
    audio?.pause();
    audio?.removeAttribute("src");
    audio?.load();
    if (key) this.setClipStatus(key, status);
  }

  private cancelActive() {
    this.releaseMedia("cancelled");
  }

  private finishActive() {
    if (!this.activeClipKey) return;
    this.releaseMedia("idle");
  }

  private failActive() {
    const key = this.activeClipKey;
    if (!key) return;
    this.releaseMedia("idle");
    this.setClipStatus(key, "error", this.v("failure"));
  }

  private async playLine(entry: JsonRecord, index: number) {
    const line = voiceLines(entry)[index];
    if (!line?.url) return;
    const key = this.clipKey(entry, index);
    const status = this.clipStatus(key).state;
    if (this.activeClipKey === key && (status === "loading" || status === "playing")) {
      this.cancelActive();
      return;
    }
    this.cancelActive();
    const generation = ++this.generation;
    const audio = new Audio();
    const events = new AbortController();
    this.audio = audio;
    this.audioEvents = events;
    this.activeClipKey = key;
    const ownsClip = () => this.audio === audio && this.generation === generation && this.activeClipKey === key;
    const listen = (type: string, action: () => void) =>
      audio.addEventListener(
        type,
        () => {
          if (ownsClip()) action();
        },
        { signal: events.signal },
      );
    audio.preload = "none";
    listen("playing", () => this.setClipStatus(key, "playing"));
    listen("waiting", () => {
      if (!audio.paused) this.setClipStatus(key, "loading", this.v("loading"));
    });
    listen("ended", () => this.finishActive());
    listen("error", () => this.failActive());
    this.setClipStatus(key, "loading", this.v("loading"));
    document.querySelector<HTMLElement & { pausePlayback?: () => void }>("audio-dock")?.pausePlayback?.();
    dispatchEvent(new CustomEvent("haneoka:character-voice", { detail: this }));
    audio.src = line.url;
    try {
      await audio.play();
      if (ownsClip()) this.setClipStatus(key, "playing");
    } catch (error) {
      if (ownsClip() && !(error instanceof DOMException && error.name === "AbortError")) {
        this.failActive();
      }
    }
  }

  private lineAction(entry: JsonRecord, index: number, line: ReturnType<typeof voiceLines>[number]) {
    const key = this.clipKey(entry, index);
    const status = this.clipStatus(key);
    const active = this.activeClipKey === key;
    const playing = active && status.state === "playing";
    const loading = active && status.state === "loading";
    const label = loading
      ? `${this.v("loading")} · ${this.name(line.characterId)}`
      : playing
        ? `${this.v("stop")} · ${this.name(line.characterId)}`
        : status.state === "error"
          ? `${this.t("retry")} · ${this.name(line.characterId)}`
          : `${this.v("playLine")} · ${this.name(line.characterId)}`;
    return html`
      <button
        class="icon-button dialogue-row__play"
        type="button"
        ?disabled=${!line.url}
        aria-label=${label}
        aria-pressed=${String(playing)}
        aria-busy=${String(loading)}
        title=${label}
        @click=${() => void this.playLine(entry, index)}
      >
        ${
          loading
            ? html`
                <md-circular-progress
                  class="dialogue-row__progress"
                  indeterminate
                  aria-hidden="true"
                ></md-circular-progress>
              `
            : icon(playing ? "stop" : status.state === "error" ? "refresh" : "play_arrow", 24)
        }
      </button>
    `;
  }

  private renderLine(entry: JsonRecord, index: number) {
    const line = voiceLines(entry)[index]!;
    const text = resolveLocalizedText(line.text, this.locale);
    const character = this.character(line.characterId);
    const image = String(character?.faceImage || "");
    const key = this.clipKey(entry, index);
    const status = this.clipStatus(key);
    const statusMessage = status.message || (!line.url ? this.v("unavailable") : "");
    return dialogueRow({
      key,
      className: `voice-line voice-line--${voiceGroup(entry)}`,
      avatar: image
        ? html`
            <img src=${image} alt="" loading="lazy" width="48" height="48" />
          `
        : icon("person", 24),
      speaker: this.name(line.characterId),
      speakerLanguage: resolveLocalizedText(character?.characterName, this.locale).locale,
      text: text.text || this.v("noText"),
      textLanguage: text.locale,
      action: this.lineAction(entry, index, line),
      state: status.state,
      statusMessage,
    });
  }

  private condition(entry: JsonRecord) {
    return Number(entry.unlockCharacterRank) > 0
      ? this.v("unlockRank", Number(entry.unlockCharacterRank))
      : Number(entry.unlockFriendshipRank) > 0
        ? this.v("unlockBond", Number(entry.unlockFriendshipRank))
        : "";
  }

  private renderEntry(entry: JsonRecord, previous?: JsonRecord) {
    const lines = voiceLines(entry);
    const title = this.entryTitle(entry);
    const titleLanguage = entry.title ? resolveLocalizedText(entry.title, this.locale).locale : this.locale;
    const condition = this.condition(entry);
    const showHeading =
      !previous ||
      title !== this.entryTitle(previous) ||
      condition !== this.condition(previous) ||
      entry.cardId !== previous.cardId;
    return html`
      <article
        class="voice-entry"
        data-voice-key=${this.voiceKey(entry)}
        data-master-type=${String(entry.masterType ?? "")}
      >
        ${
          showHeading
            ? html`
                <header class="voice-entry__header">
                  <div class="voice-entry__identity">
                    <h4 lang=${titleLanguage}>
                      ${
                        entry.cardId
                          ? html`
                              <a
                                href=${`${localePath("/catalog/member-cards", isLocale(this.locale) ? this.locale : "en")}?card=${encodeURIComponent(String(entry.cardId))}`}
                              >
                                ${title}
                              </a>
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
                </header>
              `
            : nothing
        }
        <div class="voice-entry__lines">
          ${repeat(
            lines,
            (_, index) => this.clipKey(entry, index),
            (_, index) => this.renderLine(entry, index),
          )}
        </div>
      </article>
    `;
  }

  private grouped() {
    const entries = [...this.entries].sort(compareVoices);
    return VOICE_GROUPS.map((group) => ({
      group,
      items: entries.filter((entry) => voiceGroup(entry) === group),
    })).filter(({ items }) => items.length);
  }

  render() {
    const groups = this.grouped();
    return html`
      <section class="character-voices" aria-label=${this.v("title")}>
        ${
          groups.length
            ? groups.map(
                ({ group, items }) => html`
                  <section
                    class="voice-group"
                    id=${`voice-group-${group}`}
                    data-source-master-type=${String(voiceGroupMasterType(group))}
                  >
                    <h3>
                      <span class="voice-group__title">${this.v(voiceGroupLabelKey(group))}</span>
                      <span class="voice-group__count">${items.length}</span>
                    </h3>
                    <div>
                      ${repeat(
                        items,
                        (entry) => this.voiceKey(entry),
                        (entry, index) => this.renderEntry(entry, items[index - 1]),
                      )}
                    </div>
                  </section>
                `,
              )
            : emptyState({ title: this.t("empty"), icon: "volume_off" })
        }
      </section>
    `;
  }
}
customElements.define("character-voices", CharacterVoices);
