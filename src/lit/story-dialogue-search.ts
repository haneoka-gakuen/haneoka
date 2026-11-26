// L3 — GEB
// Input: The selected server, AppShell query, story section and speaker filters.
// Output: Full-corpus results with official transcript and player links.
// Pos: [Map](L2-2.md); first-party dialogue search workspace.
// Effects/Dependencies: Owns its app bar and URL search state; cancels workers and timers when superseded.
import { iconButton } from "./ui/controls";
import { LitElement } from "lit";
import { clientText } from "../i18n/client";
import { isLocale, type Locale } from "../i18n/locales";
import { setAppBarActions, setAppBarSearch } from "../lib/app-bar";
import { navigationDocumentUrl, returnLink } from "../lib/document-url";
import { resourcePath, STORY_MODES } from "../lib/resource-route";
import type { ReleaseServer } from "../lib/release-server";
import type { DialogueHit, DialogueReply } from "../lib/story-dialogue";
import { renderStoryDialogueSearch, type StoryDialogueSearchView } from "./views/story-dialogue-search";

class StoryDialogueSearch extends LitElement {
  static properties = {
    locale: {}, server: {}, query: { state: true }, mode: { state: true }, category: { state: true },
    filtersOpen: { state: true }, contexts: { state: true },
    speaker: { state: true }, phase: { state: true }, results: { state: true }, speakers: { state: true },
  };
  declare locale: Locale;
  declare server: ReleaseServer;
  declare private query: string;
  declare private mode: StoryDialogueSearchView["mode"];
  declare private category: string;
  declare private speaker: string;
  declare private phase: StoryDialogueSearchView["phase"];
  declare private results: DialogueHit[];
  declare private speakers: string[];
  declare private filtersOpen: boolean;
  declare private contexts: ReadonlySet<string>;
  private voice?: HTMLAudioElement;
  private voiceUrl = "";
  private worker?: Worker;
  private timer = 0;
  private timeout = 0;
  private expansion?: { query: string; terms: string[] };
  private lifetime?: AbortController;

  constructor() {
    super();
    this.locale = "en";
    this.server = "intl";
    this.query = "";
    this.mode = "text";
    this.category = "";
    this.speaker = "";
    this.phase = "idle";
    this.results = [];
    this.speakers = [];
    this.filtersOpen = false;
    this.contexts = new Set();
  }

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    const params = navigationDocumentUrl().searchParams;
    this.query = (params.get("q") ?? "").slice(0, 240);
    const match = params.get("match");
    this.mode = match === "regex" || match === "semantic" ? match : "text";
    this.category = STORY_MODES.find((mode) => mode === params.get("category")) ?? "";
    this.speaker = params.get("speaker") ?? "";
    this.lifetime = new AbortController();
    addEventListener("haneoka:locale-ready", () => {
      const lang = document.documentElement.lang;
      if (isLocale(lang) && this.locale !== lang) {
        this.locale = lang;
        this.speaker = "";
        this.queueSearch();
      }
      this.syncSearch();
    }, { signal: this.lifetime.signal });
    this.queueSearch(0, false);
  }

  disconnectedCallback() {
    this.voice?.pause();
    this.lifetime?.abort();
    this.stopSearch();
    super.disconnectedCallback();
  }

  updated() { this.syncSearch(); }

  private label = (key: string, fallback: string) => clientText(this.locale, `story.dialogueSearch.${key.replace(/^storySearch\./u, "")}`, fallback);

  private syncSearch() {
    setAppBarActions(this, "story-dialogue-search", iconButton({
      icon: "filter_alt", label: this.label("filters", "Filters"),
      badge: Number(Boolean(this.category)) + Number(Boolean(this.speaker)) + Number(this.mode !== "text"),
      onClick: () => { this.filtersOpen = true; },
    }));
    setAppBarSearch(this, "story-dialogue-search", {
      value: this.query,
      label: this.label("title", "Search dialogue"),
      onInput: (query) => { this.query = query.slice(0, 240); this.queueSearch(); },
      onSubmit: () => this.queueSearch(0),
      expanded: true,
    });
  }

  private playVoice = (url: string) => {
    const playing = this.voiceUrl === url && this.voice && !this.voice.paused;
    this.voice?.pause();
    if (playing) return;
    document.querySelector<HTMLElement & { pausePlayback?: () => void }>("audio-dock")?.pausePlayback?.();
    this.voiceUrl = url;
    this.voice = new Audio(url);
    for (const event of ["playing", "ended", "pause", "error"]) {
      this.voice.addEventListener(event, () => this.requestUpdate());
    }
    void this.voice.play().catch(() => this.requestUpdate());
  };

  private stopSearch() {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.timeout);
    this.worker?.terminate();
    this.worker = undefined;
  }

  private queueSearch(delay = 220, updateUrl = true) {
    this.stopSearch();
    this.voice?.pause();
    if (updateUrl) {
      const url = new URL(location.href);
      for (const [key, value] of Object.entries({
        q: this.query.trim(), match: this.mode === "text" ? "" : this.mode, category: this.category, speaker: this.speaker,
      })) {
        if (value) url.searchParams.set(key, value);
        else url.searchParams.delete(key);
      }
      if (url.href !== location.href) history.replaceState(history.state, "", url);
    }
    this.results = [];
    this.contexts = new Set();
    this.phase = this.query.trim() && (this.mode !== "semantic" || delay === 0) ? "loading" : "idle";
    if (this.phase === "loading") this.timer = window.setTimeout(() => this.search(), delay);
  }

  private search() {
    const worker = new Worker(new URL("../workers/story-dialogue-search.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    const query = this.query.trim();
    const fail = () => {
      if (worker !== this.worker) return;
      this.stopSearch();
      this.phase = "error";
    };
    this.timeout = window.setTimeout(fail, 60_000);
    worker.addEventListener("error", fail);
    worker.addEventListener("message", ({ data }: MessageEvent<DialogueReply | { phase: "index-ready" }>) => {
      if (worker !== this.worker) return;
      if (data.phase === "index-ready") {
        window.clearTimeout(this.timeout);
        this.timeout = window.setTimeout(fail, this.mode === "regex" ? 4000 : 20_000);
        return;
      }
      this.stopSearch();
      this.phase = data.phase;
      this.results = data.results ?? [];
      if (data.speakers) this.speakers = data.speakers;
      if (data.terms) this.expansion = { query, terms: data.terms };
    });
    worker.postMessage({
      server: this.server,
      request: {
        locale: this.locale, query, mode: this.mode, category: this.category, speaker: this.speaker,
        terms: this.expansion?.query === query ? this.expansion.terms : undefined,
      },
    });
  }

  render() {
    const all = this.label("all", "All");
    const current = navigationDocumentUrl();
    const link = (hit: DialogueHit, view?: "story") => {
      const href = resourcePath({ server: this.server, locale: this.locale, kind: "stories", id: hit.id, view });
      return returnLink(`${href}?line=${hit.command}`, current.pathname + current.search);
    };
    return renderStoryDialogueSearch({
      filtersOpen: this.filtersOpen, onClose: () => { this.filtersOpen = false; },
      closeLabel: clientText(this.locale, "common.actions.close", "Close"),
      playVoiceLabel: clientText(this.locale, "story.labels.playVoice", "Play voice"),
      pauseLabel: clientText(this.locale, "common.actions.pause", "Pause"),
      onVoice: this.playVoice, playingVoice: this.voice && !this.voice.paused ? this.voiceUrl : "",
      contexts: this.contexts,
      onContext: (key, open) => {
        const contexts = new Set(this.contexts);
        if (open) contexts.add(key);
        else contexts.delete(key);
        this.contexts = contexts;
      },
      t: this.label, locale: this.locale, query: this.query, mode: this.mode, category: this.category, speaker: this.speaker,
      onMode: (mode) => { this.mode = mode; this.queueSearch(0); },
      categories: [{ value: "", label: all }, ...STORY_MODES.map((value) => ({
        value,
        label: clientText(this.locale, value === "birthday" ? "story.labels.birthdayStory" : `story.navigation.${value}`, value),
      }))],
      onCategory: (value) => { this.category = value; this.speaker = ""; this.queueSearch(0); },
      speakers: [{ value: "", label: all }, ...[...new Set([...this.speakers, this.speaker])].filter(Boolean).map((name) => ({ value: name, label: name }))],
      onSpeaker: (value) => { this.speaker = value; this.queueSearch(0); },
      phase: this.phase,
      results: this.results.map((hit) => ({ ...hit, key: `${hit.id}/${hit.index}`, href: link(hit), playHref: link(hit, "story") })),
    });
  }
}

if (!customElements.get("story-dialogue-search")) customElements.define("story-dialogue-search", StoryDialogueSearch);
