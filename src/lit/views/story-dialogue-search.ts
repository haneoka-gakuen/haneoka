import { historySelect } from "../ui/history-select";
import { html, nothing } from "lit";
import { advText } from "../ui/adv-text";
import { accordion } from "../ui/accordion";
import { segmented } from "../ui/controls";
import { dialogueRow } from "../ui/dialogue-row";
import { icon } from "../ui/icon";
import { modal } from "../ui/modal";
import { loadingState } from "../ui/state";

type Option = { value: string; label: string };
type Mode = "text" | "regex" | "semantic";
type Result = {
  key: string;
  href: string;
  playHref: string;
  title: string;
  speaker: string;
  text: string;
  contextBefore: string;
  contextAfter: string;
  avatars?: { src: string; name: string }[];
  voices?: string[];
  textLanguage?: string;
  kind?: "dialogue" | "message" | "subtitle";
  matchedText?: string;
  matchedLocale?: string;
};

export type StoryDialogueSearchView = {
  t: (key: string, fallback: string) => string;
  locale: string;
  query: string;
  mode: Mode;
  filtersOpen?: boolean;
  onClose?: () => void;
  closeLabel?: string;
  onVoice?: (url: string) => void;
  playingVoice?: string;
  playVoiceLabel?: string;
  pauseLabel?: string;
  contexts: ReadonlySet<string>;
  onContext: (key: string, open: boolean) => void;
  onMode: (mode: Mode) => void;
  category: string;
  categories: Option[];
  onCategory: (value: string) => void;
  speaker: string;
  speakers: Option[];
  onSpeaker: (value: string) => void;
  phase: "idle" | "loading" | "ready" | "error" | "invalid";
  results: Result[];
};


export function renderStoryDialogueSearch(view: StoryDialogueSearchView) {
  const { t } = view;
  const languages = new Intl.DisplayNames(view.locale, { type: "language" });
  const modes: { value: Mode; label: string }[] = [
    { value: "text", label: t("storySearch.modeText", "Text") },
    { value: "regex", label: t("storySearch.modeRegex", "Regex") },
    { value: "semantic", label: t("storySearch.modeSemantic", "Semantic expansion") },
  ];
  const failed = view.phase === "error" || view.phase === "invalid";
  const status =
    view.phase === "error"
      ? t("storySearch.error", "Search failed")
      : view.phase === "invalid"
        ? t("storySearch.invalid", "Invalid regular expression")
        : view.phase === "ready" && !view.results.length
          ? t("storySearch.empty", "No matches")
          : "";
  const play = t("storySearch.play", "Play");

  return html`
    <div class="page stack" aria-busy=${view.phase === "loading"}>
      ${view.phase === "loading" ? loadingState(t("storySearch.loading", "Searching")) : nothing}
      ${status ? html`<p role="status">${status}</p>` : nothing}
      ${!failed && view.results.length ? html`<div class="dialogue-list" aria-label=${t("storySearch.results", "Results")}>
        ${view.results.map((r) => html`<section class="surface stack">
          <div class="row">
            <a href=${r.href}>${r.title}</a>
            <a class="icon-button" href=${r.playHref} aria-label=${`${play} · ${r.title}`} title=${play}>${icon("play_circle")}</a>
          </div>
          ${dialogueRow({
            key: r.key, className: `story-transcript__entry story-transcript__entry--${r.kind ?? "dialogue"}`,
            avatar: r.avatars?.length ? html`<span class="dialogue-row__avatar-stack">${r.avatars.map((avatar) =>
              html`<img loading="lazy" width="32" height="32" src=${avatar.src} alt=${avatar.name}>`)}</span>` : nothing,
            speaker: r.speaker, text: advText(r.text), textLanguage: r.textLanguage ?? view.locale,
            meta: r.matchedText ? html`<small>${r.matchedLocale ? languages.of(r.matchedLocale) : t("storySearch.matched", "Match")} · <span lang=${r.matchedLocale ?? nothing}>${advText(r.matchedText)}</span></small>` : nothing,
            action: r.voices?.length ? html`<div class="story-transcript__voices">${r.voices.map((url, index) => {
              const playing = url === view.playingVoice;
              const label = [playing ? view.pauseLabel : view.playVoiceLabel, r.speaker, r.voices!.length > 1 ? index + 1 : ""].filter(Boolean).join(" / ");
              return html`<button class="icon-button dialogue-row__play" type="button" aria-label=${label} title=${label}
                aria-pressed=${String(playing)} @click=${() => view.onVoice?.(url)}>${icon(playing ? "pause" : "play_arrow", 24)}</button>`;
            })}</div>` : nothing,
          })}
          ${r.contextBefore || r.contextAfter ? accordion({
            id: `story-context-${encodeURIComponent(r.key)}`,
            label: t("storySearch.context", "Context"),
            expanded: view.contexts.has(r.key),
            onExpandedChange: (open) => view.onContext(r.key, open),
            content: view.contexts.has(r.key) ? html`<div class="stack stack--tight" lang=${r.textLanguage ?? view.locale}>
              ${r.contextBefore ? html`<p>${advText(r.contextBefore)}</p>` : nothing}
              ${r.contextAfter ? html`<p>${advText(r.contextAfter)}</p>` : nothing}
            </div>` : nothing,
          }) : nothing}
        </section>`)}
      </div>` : nothing}
      ${view.filtersOpen && view.onClose ? html`
        <dialog class="dialog" aria-labelledby="dialogue-filter-title" ${modal(view.onClose)}>
          <h2 class="dialog__title" id="dialogue-filter-title">${t("storySearch.filters", "Filters")}</h2>
          <div class="dialog__body field-stack">
            ${historySelect(t("storySearch.category", "Category"), view.category, view.categories, view.onCategory)}
            ${historySelect(t("storySearch.speaker", "Speaker"), view.speaker, view.speakers, view.onSpeaker)}
            ${segmented({ label: t("storySearch.mode", "Match"), value: view.mode, options: modes,
              onSelect: (value) => view.onMode(value as Mode) })}
          </div>
          <div class="dialog__actions"><button class="button button--text" @click=${view.onClose}>${view.closeLabel}</button></div>
        </dialog>` : nothing}
    </div>
  `;
}
