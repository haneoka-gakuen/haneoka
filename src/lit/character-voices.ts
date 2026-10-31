import { LitElement, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { resolveLocalizedText } from "../lib/localized-text";
import { isLocale } from "../i18n/locales";
import { resourcePath } from "../lib/resource-route";
import type { ReleaseServer } from "../lib/release-server";
import { formatList, localizedText, uiText, type JsonRecord } from "./shared/catalog";
import {
  compareVoices,
  VOICE_TABS,
  voiceGroup,
  voiceGroupLabelKey,
  voiceKind,
  voiceTab,
  type VoiceTab,
  voiceLines,
  voiceText,
  voiceTitleKey,
  voiceCalendarDate,
  voiceSeasonRange,
} from "./shared/voice-catalog";
import { icon } from "./ui/icon";
import { dialogueRow, type DialogueRowState } from "./ui/dialogue-row";
import { emptyState } from "./ui/state";
import "../styles/character-voices.css";
import { loadingIndicator } from "./ui/loading-indicator";
import { accordion } from "./ui/accordion";
import { serverAvailabilityBadge } from "./shared/server-availability";
import { preferredVoiceRecordings } from "../lib/cross-server/voices";
import { formatDate } from "../lib/date-format";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  character: "catalog.fields.character",
  empty: "common.states.empty",
  error: "common.states.error",
  loading: "common.states.loading",
  none: "common.states.none",
  refresh: "common.actions.refresh",
  retry: "common.actions.retry",
  stop: "common.actions.stop",
  title: "common.fields.title",
  unavailable: "common.states.unavailable",
};

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
    server: {},
    characterId: { type: Number },
    activeClipKey: { state: true },
    expandedGroups: { state: true },
  };
  declare entries: JsonRecord[];
  declare characters: JsonRecord[];
  declare locale: string;
  declare server: ReleaseServer;
  declare characterId: number;
  declare activeClipKey: string;
  declare private expandedGroups: Set<VoiceTab>;
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
    this.server = "intl";
    this.characterId = 0;
    this.activeClipKey = "";
    this.expandedGroups = new Set<VoiceTab>(["comment"]);
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
      this.expandedGroups = new Set<VoiceTab>(["comment"]);
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
    return uiText(this.locale, uiLabelPaths[key] ?? key);
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
    const call =
      Number(entry.dialogueCallType) === 1
        ? this.v("call")
        : Number(entry.dialogueCallType) === 2
          ? this.v("response")
          : "";
    const birthdayId = Number(entry.birthdayCharacterId || 0);
    if (birthdayId > 0) return this.v("birthdayOf", this.name(birthdayId));
    const pair =
      Number(entry.masterType) === 6 ||
      (voiceKind(entry) === "resultPair" && (entry.characterIds as unknown[]).length > 1)
        ? (entry.characterIds as unknown[]).map((id) => this.name(Number(id))).join(" → ")
        : "";
    return [title, score, call, pair].filter(Boolean).join(" · ");
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

  private async playSequence(entry: JsonRecord, indices: number[]) {
    const lines = voiceLines(entry);
    const clips = indices.flatMap((index) => (lines[index]?.url ? [{ index, line: lines[index]! }] : []));
    if (!clips.length) return;
    this.cancelActive();
    const generation = ++this.generation;
    const audio = new Audio();
    const events = new AbortController();
    this.audio = audio;
    this.audioEvents = events;
    let position = 0;
    const ownsSequence = () => this.audio === audio && this.generation === generation;
    const startClip = async () => {
      if (!ownsSequence()) return;
      const { index, line } = clips[position]!;
      const key = this.clipKey(entry, index);
      this.activeClipKey = key;
      this.setClipStatus(key, "loading", this.v("loading"));
      audio.src = line.url;
      try {
        await audio.play();
        if (ownsSequence() && this.activeClipKey === key) this.setClipStatus(key, "playing");
      } catch (error) {
        if (
          ownsSequence() &&
          this.activeClipKey === key &&
          !(error instanceof DOMException && error.name === "AbortError")
        )
          this.failActive();
      }
    };
    const listen = (type: string, action: () => void) =>
      audio.addEventListener(
        type,
        () => {
          if (ownsSequence()) action();
        },
        { signal: events.signal },
      );
    audio.preload = "none";
    listen("playing", () => this.setClipStatus(this.activeClipKey, "playing"));
    listen("waiting", () => {
      if (!audio.paused) this.setClipStatus(this.activeClipKey, "loading", this.v("loading"));
    });
    listen("ended", () => {
      this.setClipStatus(this.activeClipKey, "idle");
      if (++position < clips.length) void startClip();
      else this.finishActive();
    });
    listen("error", () => this.failActive());
    document.querySelector<HTMLElement & { pausePlayback?: () => void }>("audio-dock")?.pausePlayback?.();
    dispatchEvent(new CustomEvent("haneoka:character-voice", { detail: this }));
    await startClip();
  }

  private async playLine(entry: JsonRecord, index: number) {
    const key = this.clipKey(entry, index);
    const state = this.clipStatus(key).state;
    if (this.activeClipKey === key && (state === "loading" || state === "playing")) this.cancelActive();
    else await this.playSequence(entry, [index]);
  }

  private playGroup(entry: JsonRecord) {
    if (this.activeClipKey.startsWith(`${this.voiceKey(entry)}:`)) this.cancelActive();
    else
      void this.playSequence(
        entry,
        voiceLines(entry).map((_, index) => index),
      );
  }

  private lineAction(entry: JsonRecord, index: number, line: ReturnType<typeof voiceLines>[number], speaker: string) {
    const key = this.clipKey(entry, index);
    const status = this.clipStatus(key);
    const active = this.activeClipKey === key;
    const playing = active && status.state === "playing";
    const loading = active && status.state === "loading";
    const label = loading
      ? `${this.v("loading")} · ${speaker}`
      : playing
        ? `${this.v("stop")} · ${speaker}`
        : status.state === "error"
          ? `${this.t("retry")} · ${speaker}`
          : `${this.v("playLine")} · ${speaker}`;
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
                ${loadingIndicator({ className: "dialogue-row__progress" })}
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
    const speaker = line.characterId
      ? this.name(line.characterId)
      : formatList((entry.characterIds as number[]).map((id) => this.name(id)), this.locale);
    return dialogueRow({
      key,
      className: `voice-line voice-line--${voiceGroup(entry)}`,
      avatar: image
        ? html`
            <img src=${image} alt="" loading="lazy" width="48" height="48" />
          `
        : icon("person", 24),
      speaker,
      speakerContent: html`
        ${speaker}
        ${entry.sourcesComplete ? serverAvailabilityBadge((entry.sourceServers as string[] | undefined) || [], this.locale) : nothing}
      `,
      speakerLanguage: resolveLocalizedText(character?.characterName, this.locale).locale,
      text: text.text || (voiceGroup(entry) === "title" ? this.v(voiceKind(entry)) : this.v("noText")),
      textLanguage: text.locale,
      action: this.lineAction(entry, index, line, speaker),
      state: status.state,
      statusMessage,
    });
  }

  private calendarDate(entry: JsonRecord) {
    const seasonal = voiceSeasonRange(entry, this.locale);
    const birthday = this.character(Number(entry.birthdayCharacterId))?.birthday as JsonRecord | undefined;
    const birthdayDate = birthday
      ? voiceCalendarDate(this.locale, `${birthday.month}/${birthday.day}`, Number(entry.year) || 0)
      : "";
    const startAt = Number((entry.startAt as number[] | undefined)?.[0] || 0);
    const realLiveDate =
      voiceGroup(entry) === "realLive" && startAt
        ? formatDate(this.locale, startAt, { timeZone: "Asia/Tokyo", year: "always" })
        : "";
    return seasonal || birthdayDate || realLiveDate;
  }

  private condition(entry: JsonRecord) {
    return Number(entry.unlockCharacterRank) > 1
      ? this.v("unlockRank", Number(entry.unlockCharacterRank))
      : Number(entry.unlockFriendshipRank) > 0
        ? this.v("unlockBond", Number(entry.unlockFriendshipRank))
        : "";
  }

  private renderEntry(entry: JsonRecord, previous?: JsonRecord, calendarInGroup = false) {
    const lines = voiceLines(entry);
    const title = this.entryTitle(entry);
    const titleLanguage = entry.title ? resolveLocalizedText(entry.title, this.locale).locale : this.locale;
    const condition = [calendarInGroup ? "" : this.calendarDate(entry), this.condition(entry)]
      .filter(Boolean)
      .join(" · ");
    const sequence = lines.length > 1;
    const groupActive = this.activeClipKey.startsWith(`${this.voiceKey(entry)}:`);
    const hasHeading =
      sequence || entry.title || condition || entry.scoreRank || entry.dialogueCallType || entry.birthdayCharacterId;
    const showHeading =
      hasHeading &&
      (sequence ||
        !previous ||
        title !== this.entryTitle(previous) ||
        this.condition(entry) !== this.condition(previous) ||
        (!calendarInGroup && this.calendarDate(entry) !== this.calendarDate(previous)) ||
        entry.cardId !== previous.cardId);
    const linkedKind = entry.cardId ? "member-cards" : entry.storyId ? "stories" : undefined;
    const linkedId = entry.cardId || entry.storyId;
    const heading = condition ? this.v("withDetails", title, condition) : title;
    return html`
      <article
        class=${`voice-entry${sequence ? " voice-entry--sequence" : ""}`}
        data-voice-key=${this.voiceKey(entry)}
        data-master-type=${String(entry.masterType ?? "")}
      >
        ${
          showHeading
            ? html`
                <header class="voice-entry__header">
                  <div class="voice-entry__identity">
                    <h5 lang=${titleLanguage}>
                      ${
                        linkedKind
                          ? html`
                              <a
                                href=${resourcePath({ server: String(entry.sourceServer || this.server), locale: isLocale(this.locale) ? this.locale : "en", kind: linkedKind, id: String(linkedId) })}
                              >
                                ${heading}
                              </a>
                            `
                          : heading
                      }
                    </h5>
                  </div>
                  ${
                    sequence
                      ? html`
                          <button
                            class="button button--tonal voice-entry__play-group"
                            type="button"
                            ?disabled=${!lines.some((line) => line.url)}
                            aria-label=${`${groupActive ? this.v("stop") : this.v("playGroup")} · ${title}`}
                            aria-pressed=${String(groupActive)}
                            @click=${() => this.playGroup(entry)}
                          >
                            ${icon(groupActive ? "stop" : "play_arrow", 24)}
                            <span>${groupActive ? this.v("stop") : this.v("playGroup")}</span>
                          </button>
                        `
                      : nothing
                  }
                </header>
              `
            : nothing
        }
        <div class="voice-entry__lines dialogue-list">
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
    const entries = preferredVoiceRecordings(this.entries).sort((a, b) => compareVoices(a, b, this.characterId));
    return VOICE_TABS.map((group) => ({
      group,
      items: entries.filter((entry) => voiceTab(entry) === group),
    })).filter(({ items }) => items.length);
  }

  private subgroupKey(entry: JsonRecord) {
    return [voiceGroup(entry), voiceKind(entry), voiceGroup(entry) === "birthday" ? "" : this.calendarDate(entry)].join(
      ":",
    );
  }

  render() {
    const groups = this.grouped();
    return html`
      <section class="character-voices" aria-label=${this.v("title")}>
        ${
          groups.length
            ? groups.map(({ group, items }) =>
                accordion({
                  id: `voice-group-${group}`,
                  label: this.v(voiceGroupLabelKey(group)),
                  metadata: items.length,
                  headingLevel: 3,
                  expanded: this.expandedGroups.has(group),
                  onExpandedChange: (expanded) => {
                    const groups = new Set(this.expandedGroups);
                    if (expanded) groups.add(group);
                    else groups.delete(group);
                    this.expandedGroups = groups;
                  },
                  content: html`
                    <div class="voice-group">
                      ${[...new Set(items.map((entry) => this.subgroupKey(entry)))].map((key) => {
                        const entries = items.filter((entry) => this.subgroupKey(entry) === key);
                        const kind = voiceKind(entries[0]!);
                        const category = voiceGroup(entries[0]!);
                        const title = ["realLive", "liveDialogue", "livePairDialogue", "seasonal"].includes(category)
                          ? this.v(voiceGroupLabelKey(category)) + " · " + this.v(kind)
                          : this.v(kind);
                        const date = category === "birthday" ? "" : this.calendarDate(entries[0]!);
                        const label = date ? this.v("withDetails", title, date) : title;
                        return html`
                          <section class="voice-subgroup" data-voice-kind=${kind}>
                            <h4 class="detail-section-title">${label}</h4>
                            <div class="dialogue-list">
                              ${repeat(
                                entries,
                                (entry) => this.voiceKey(entry),
                                (entry, index) => this.renderEntry(entry, entries[index - 1], Boolean(date)),
                              )}
                            </div>
                          </section>
                        `;
                      })}
                    </div>
                  `,
                }),
              )
            : emptyState({ title: this.t("empty"), icon: "volume_off" })
        }
      </section>
    `;
  }
}
customElements.define("character-voices", CharacterVoices);
