import { LitElement, html, nothing, type PropertyValues } from "lit";
import "@material/web/list/list.js";
import "@material/web/list/list-item.js";
import "@material/web/divider/divider.js";
import { clientText, getI18nClient } from "../i18n/client";
import { readPageData } from "../lib/page-data";
import { resolveLocalizedText } from "../lib/localized-text";
import { clearAppBarActions, clearAppBarIdentity, setAppBarActions, setAppBarIdentity } from "../lib/app-bar";
import { navigationDocumentUrl } from "../lib/document-url";
import { icon } from "./ui/icon";
import { iconButton, segmented } from "./ui/controls";
import { facet } from "./ui/facet";
import { PaneFocus } from "./ui/pane";
import { emptyState, loadingState } from "./ui/state";
import { arenaMission, arenaMissionLabel, arenaAttribute, type ArenaRuleContext } from "./shared/arena-rule";
import type { ArenaCatalog } from "../lib/arena";
import {
  CALENDAR_FACETS,
  type CalendarFacet,
  addCalendarDays,
  calendarDateUtc,
  calendarDayAt,
  calendarMonthDays,
  calendarOccurrences,
  calendarOnDay,
  calendarWeekSegments,
  calendarWeekStart,
  parseCalendarDate,
  shiftCalendarMonth,
  type CalendarArenaLeague,
  type CalendarArenaRule,
  type CalendarData,
  type CalendarDate,
  type CalendarKind,
  type CalendarOccurrence,
} from "../lib/calendar-model";
import { formatDate, formatDateRange } from "../lib/date-format";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  "character": "catalog.fields.character",
  "close": "common.actions.close",
  "empty": "common.states.empty",
  "filter": "common.actions.filter",
  "gacha": "navigation.gacha",
  "live": "catalog.songs.fields.live",
  "next": "common.actions.next",
  "previous": "common.actions.previous",
  "reset": "common.actions.reset",
  "source": "common.fields.source",
  "unavailable": "common.states.unavailable",
  "view": "common.actions.view"
};


const copy: Record<string, string> = {
  title: "Calendar",
  today: "Today",
  month: "Month",
  agenda: "Agenda",
  previous: "Previous month",
  next: "Next month",
  chooseDate: "Choose date",
  birthdays: "Birthdays",
  activities: "Game events",
  lives: "Live events",
  character: "Character birthday",
  cast: "Voice actor birthday",
  event: "Event",
  gacha: "Gacha",
  login: "Login bonus",
  pass: "Pass",
  live: "Live",
  "game-live": "Game live event",
  arena: "Arena",
  starts: "Starts",
  ends: "Ends",
  allDay: "All day",
  empty: "No events",
  more: "{count} more",
  view: "View",
  unavailable: "Some dates are unavailable",
  source: "Live information",
  date: "Date",
  invalidDate: "Invalid date",
};
const category = (kind: CalendarKind) =>
  kind === "character" || kind === "cast" ? "birthdays" : kind === "live" ? "lives" : "activities";
const facetLabels: Record<CalendarFacet, string> = {
  "our-notes:character": "ourNotesCharacterBirthday",
  "our-notes:cast": "ourNotesCastBirthday",
  "garupa:character": "garupaCharacterBirthday",
  "garupa:cast": "garupaCastBirthday",
  event: "event",
  gacha: "gacha",
  login: "login",
  pass: "pass",
  "game-live": "game-live",
  arena: "arena",
  "external-live": "externalLive",
};
let sequence = 0;
const LANES = 3;
const BAR_ORDER = ["event", "gacha", "live", "birthday", "other"];
const tone = (kind: CalendarKind) =>
  kind === "character" || kind === "cast" ? "birthday" : kind === "live" || kind === "game-live" ? "live" : kind === "gacha" ? "gacha" : kind === "event" ? "event" : "other";
export interface CalendarPageSeed {
  readonly calendar: CalendarData;
  readonly labels?: Readonly<Record<string, string>>;
}
export class CalendarPage extends LitElement {
  static properties = {
    locale: {},
    data: { attribute: false },
    selected: { state: true },
    view: { state: true },
    categories: { state: true },
    filtersOpen: { state: true },
    today: { state: true },
    labels: { attribute: false },
  };
  declare locale: string;
  declare data: CalendarData | undefined;
  declare selected: CalendarDate;
  declare today: CalendarDate;
  declare view: "month" | "agenda";
  declare categories: ReadonlySet<CalendarFacet>;
  declare filtersOpen: boolean;
  private paneFocus = new PaneFocus();
  declare labels: Readonly<Record<string, string>>;
  private zone = "UTC";
  private owner = `calendar-${++sequence}`;
  private clock?: number;
  private readonly localeReady = () => {
    this.locale = getI18nClient()?.committed || this.locale;
    this.labels = {};
  };
  constructor() {
    super();
    this.locale = "en";
    this.zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.today = calendarDayAt(Date.now(), this.zone);
    this.selected = this.today;
    this.view = "month";
    this.categories = new Set(CALENDAR_FACETS);
    this.filtersOpen = false;
    this.labels = {};
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    const seed = readPageData<CalendarPageSeed>(this);
    this.data ??= seed?.calendar;
    this.labels = seed?.labels || {};
    if (this.hasAttribute("data-prerendered")) {
      this.replaceChildren();
      this.removeAttribute("data-prerendered");
    }
    const query = navigationDocumentUrl().searchParams;
    const facets = query.get("kinds")?.split(",").filter((key): key is CalendarFacet => CALENDAR_FACETS.includes(key as CalendarFacet));
    if (facets?.length) this.categories = new Set(facets);
    const requested = query.get("date") || "";
    if (parseCalendarDate(requested)) this.selected = requested as CalendarDate;
    const view = query.get("view");
    this.view = view === "agenda" ? "agenda" : "month";
    window.addEventListener("haneoka:locale-ready", this.localeReady);
    this.clock = window.setInterval(() => {
      this.today = calendarDayAt(Date.now(), this.zone);
    }, 60000);
  }
  disconnectedCallback() {
    clearInterval(this.clock);
    window.removeEventListener("haneoka:locale-ready", this.localeReady);
    this.paneFocus.detach();
    clearAppBarActions(this.owner);
    clearAppBarIdentity(this.owner);
    super.disconnectedCallback();
  }
  protected updated(_changed: PropertyValues) {
    setAppBarActions(
      this.owner,
      html`${iconButton({ label: this.t("previous"), icon: "chevron_left", onClick: () => this.select(shiftCalendarMonth(this.selected, -1)) })}
      ${iconButton({ label: this.t("next"), icon: "chevron_right", onClick: () => this.select(shiftCalendarMonth(this.selected, 1)) })}
      <button type="button" class="button button--text" @click=${() => this.select(this.today)}>${this.t("today")}</button>
      ${iconButton({
        label: this.t("filter"),
        icon: "filter_alt",
        toggle: true,
        pressed: this.filtersOpen,
        badge: this.availableFacets.filter((key) => !this.categories.has(key)).length,
        className: "browse__filter-toggle",
        onClick: () => {
          this.filtersOpen = !this.filtersOpen;
        },
      })}
      ${segmented({
        label: this.t("view"),
        value: this.view,
        iconOnly: true,
        options: [
          { value: "month", label: this.t("month"), icon: "event" },
          { value: "agenda", label: this.t("agenda"), icon: "view_list" },
        ],
        onSelect: (view) => {
          this.view = view;
          this.sync();
        },
      })}`,
    );
    setAppBarIdentity(this.owner, html`<span class="calendar-month-name" aria-live="polite">${this.monthName}</span>`);
    this.paneFocus.sync(this.filtersOpen ? this.querySelector<HTMLElement>(".browse__filters.is-open") : null, () => {
      this.filtersOpen = false;
    });
  }
  private t(key: string) {
    return (
      this.labels[key] ||
      (["filter", "close", "reset"].includes(key)
        ? clientText(this.locale, (uiLabelPaths[key] ?? key), key === "filter" ? "Filter" : key === "close" ? "Close" : "Reset")
        : clientText(this.locale, `tools.calendar.${key}`, copy[key] || key))
    );
  }
  private itemTitle(item: CalendarOccurrence) {
    return resolveLocalizedText(item.title, this.locale);
  }
  private dateLabel(date: CalendarDate, weekday = false) {
    return formatDate(this.locale, calendarDateUtc(date), { timeZone: "UTC", weekday });
  }
  private select(date: CalendarDate, focus = false) {
    this.selected = date;
    this.sync();
    if (focus)
      void this.updateComplete.then(() =>
        this.querySelector<HTMLButtonElement>(`button[data-calendar-date="${date}"]`)?.focus(),
      );
  }
  private sync() {
    const url = new URL(location.href);
    url.searchParams.set("date", this.selected);
    url.searchParams.set("view", this.view);
    history.replaceState(history.state, "", url);
  }
  private get days() {
    return calendarMonthDays(this.selected, calendarWeekStart(this.locale));
  }
  private get items() {
    const days = this.days;
    return this.data
      ? calendarOccurrences(this.data, days[0]!, days.at(-1)!, this.zone).filter((item) =>
          (item.facets ?? []).some((key) => this.categories.has(key)),
        )
      : [];
  }
  private get availableFacets(): CalendarFacet[] {
    if (!this.data) return [...CALENDAR_FACETS];
    const present = new Set<CalendarFacet>();
    for (const birthday of this.data.birthdays)
      for (const game of birthday.games ?? [birthday.game]) present.add(`${game}:${birthday.kind}` as CalendarFacet);
    for (const activity of this.data.activities)
      for (const key of activity.facets ?? [activity.kind === "live" ? "external-live" : activity.kind])
        present.add(key);
    return CALENDAR_FACETS.filter((key) => present.has(key));
  }
  private filterPanel() {
    const renderFacet = (keys: CalendarFacet[], label: string) =>
      facet(
        label,
        this.locale,
        keys
          .filter((key) => this.availableFacets.includes(key))
          .map((key) => ({ value: key, label: this.t(facetLabels[key]) })),
        [...this.categories].filter((key) => keys.includes(key) && this.availableFacets.includes(key)),
        (key) => {
          const selected = new Set(this.categories);
          if (selected.has(key as CalendarFacet)) selected.delete(key as CalendarFacet);
          else selected.add(key as CalendarFacet);
          this.categories = selected;
        },
      );
    return html`<aside class=${`browse__filters sheet sheet--side ${this.filtersOpen ? "is-open" : ""}`} role="dialog" aria-modal="true" aria-label=${this.t("filter")} ?inert=${!this.filtersOpen} tabindex="-1">
      <header class="sheet__header"><span class="detail-section-title__icon">${icon("filter_alt", 20)}</span><span class="sheet__title"><strong>${this.t("filter")}</strong></span>
        <span class="sheet__actions"><button class="button button--text" type="button" @click=${() => {
          this.categories = new Set(CALENDAR_FACETS);
        }}>${this.t("reset")}</button>
          ${iconButton({
            label: this.t("close"),
            icon: "close",
            className: "browse__filters-close",
            onClick: () => {
              this.filtersOpen = false;
            },
          })}</span></header>
      <div class="browse__filters-body">
        ${renderFacet(
          CALENDAR_FACETS.filter((key) => key.includes(":")),
          this.t("birthdays"),
        )}
        ${renderFacet(
          CALENDAR_FACETS.filter((key) => !key.includes(":")),
          this.t("activities"),
        )}
      </div></aside>
      ${
        this.filtersOpen
          ? html`<button type="button" class="scrim sheet-scrim" aria-label=${this.t("close")} @click=${() => {
              this.filtersOpen = false;
            }}></button>`
          : nothing
      }`;
  }
  private key(event: KeyboardEvent, date: CalendarDate) {
    const keys: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in keys) {
      event.preventDefault();
      this.select(addCalendarDays(date, keys[event.key]), true);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const day = (new Date(calendarDateUtc(date)).getUTCDay() - calendarWeekStart(this.locale) + 7) % 7;
      this.select(addCalendarDays(date, event.key === "Home" ? -day : 6 - day), true);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      this.select(shiftCalendarMonth(date, event.key === "PageUp" ? -1 : 1), true);
    }
  }
  private timedRange(startAtMs: number, endAtMs?: number) {
    const options = { time: true, timeZone: this.zone };
    return endAtMs
      ? formatDateRange(this.locale, startAtMs, endAtMs, options)
      : formatDate(this.locale, startAtMs, options);
  }
  private gameRange(item: CalendarOccurrence) {
    const window = item.gameWindow;
    return window?.startAtMs ? this.timedRange(window.startAtMs, window.endAtMs) : this.t("allDay");
  }
  private range(item: CalendarOccurrence) {
    if (item.kind === "character" || item.kind === "cast") return this.t("allDay");
    if (item.allDay || !item.startAtMs) {
      return item.kind === "live"
        ? `${this.dateLabel(item.start)}${item.end !== item.start ? ` – ${this.dateLabel(item.end)}` : ""} · ${this.t("allDay")}`
        : this.t("allDay");
    }
    return this.timedRange(item.startAtMs, item.endAtMs);
  }
  private entries(items: readonly CalendarOccurrence[]) {
    if (!items.length) return emptyState({ title: this.t("empty"), icon: "event" });
    return html`<md-list class="calendar-list">
      ${items.map((item, index) => {
        const title = this.itemTitle(item);
        const actorHref = item.kind === "cast" && item.voices?.length === 1 ? item.voices[0].href : undefined;
        const primaryHref = item.kind === "cast" ? actorHref : item.href;
        const actorLabel = actorHref
          ? `${title.text} · ${this.t("voiceRoles").replace("{roles}", resolveLocalizedText(item.voices![0].name, this.locale).text)}${actorHref.startsWith("https://bestdori.com/") ? " · Bestdori" : ""}`
          : undefined;
        return html`
          ${index ? html`<md-divider></md-divider>` : nothing}
          <md-list-item type=${item.kind !== "cast" && item.href ? "link" : "text"} href=${item.kind !== "cast" ? item.href || nothing : nothing}>
            <span slot="start" class=${`calendar-avatar calendar-avatar--${category(item.kind)}`}>
              ${
                item.image
                  ? html`<img src=${item.image} alt="" width="56" height="56" loading="lazy" decoding="async"
                @error=${(event: Event) => {
                  (event.target as HTMLImageElement).hidden = true;
                }} />`
                  : nothing
              }
              ${icon(item.kind === "character" || item.kind === "cast" ? "cake" : item.kind === "live" ? "festival" : "event", 24)}
            </span>
            <span slot="headline" lang=${title.lang}>${actorHref ? html`<a href=${actorHref} aria-label=${actorLabel}>${title.text}</a>` : title.text}</span>
            <span slot="supporting-text" class="calendar-list-supporting">
              <span>${this.t(item.kind)}</span>
              ${
                item.kind === "cast" && item.voices?.length
                  ? html`<span class="calendar-voice-roles">${this.t("voiceRoles").split("{roles}")[0]}${new Intl.ListFormat(
                      this.locale,
                      { style: "short", type: "conjunction" },
                    )
                      .formatToParts(item.voices.map((role) => resolveLocalizedText(role.name, this.locale).text))
                      .map((part) => {
                        const i = item.voices!.findIndex(
                          (role) => resolveLocalizedText(role.name, this.locale).text === part.value,
                        );
                        const role = item.voices![i];
                        return part.type === "element" && role?.href
                          ? html`<a href=${role.href}>${part.value}</a>`
                          : part.value;
                      })}</span>`
                  : nothing
              }
              <time>${this.range(item)}</time>
              ${item.venue ? html`<span>${item.venue}</span>` : nothing}
            </span>
            ${primaryHref ? html`<span slot="end">${icon("chevron_right", 24)}</span>` : nothing}
          </md-list-item>
          ${item.gameWindow ? html`<a class="calendar-source-link" href=${item.gameWindow.href}>${this.t("game-live")} · ${this.gameRange(item)}${icon("chevron_right", 16)}</a>` : nothing}
          ${item.sourceUrl && item.sourceUrl !== item.href ? html`<a class="calendar-source-link" href=${item.sourceUrl} rel="noopener noreferrer">${this.t("source")}${icon("open_in_new", 16)}</a>` : nothing}
        `;
      })}
    </md-list>`;
  }
  private get monthName() {
    return new Intl.DateTimeFormat(this.locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(calendarDateUtc(this.selected));
  }
  private get arenaShown() {
    return Boolean(this.data?.arena) && this.categories.has("arena");
  }
  private get arenaContext(): ArenaRuleContext | null {
    const arena = this.data?.arena;
    if (!arena) return null;
    return {
      locale: this.locale,
      server: this.data!.server,
      catalog: { identity: { releaseId: arena.releaseId }, images: { missions: arena.missions } } as unknown as ArenaCatalog,
      marks: arena.marks,
    };
  }
  private arenaRules(date: CalendarDate): readonly (CalendarArenaRule | null)[] {
    return this.arenaShown ? (this.data!.arena!.days[date] ?? []) : [];
  }
  /** Bands above their mission on wide cells; one tinted dot per band where a cell cannot hold marks. */
  private dayArena(date: CalendarDate) {
    const rules = this.arenaRules(date);
    const context = this.arenaContext;
    if (!rules.length || !context) return nothing;
    const leagues = this.data!.arena!.leagues;
    return html`
      <span class="calendar-day__arena" aria-hidden="true">
        ${rules.map((rule, index) =>
          rule
            ? html`
                <span class="calendar-day__league">
                  <img src=${leagues[index]!.image} alt="" width="16" height="16" loading="lazy" />
                  ${arenaMission(context, rule.missions[0]!, 16)}
                  ${rule.musicType === 99 ? nothing : arenaAttribute(context, rule.musicType, 16)}
                </span>
              `
            : html`<span class="calendar-day__league"></span>`,
        )}
      </span>
      <span class="calendar-day__dots" aria-hidden="true">
        ${rules.map((rule) => html`<i data-mission=${rule?.missions[0] ?? 0}></i>`)}
      </span>
    `;
  }
  private arenaDescription(date: CalendarDate) {
    const leagues = this.data?.arena?.leagues ?? [];
    return this.arenaRules(date)
      .flatMap((rule, index) =>
        rule ? [`${this.leagueName(leagues[index]!)} ${arenaMissionLabel(this.locale, rule.missions[0]!)}`] : [],
      )
      .join(", ");
  }
  private leagueName(league: CalendarArenaLeague) {
    return resolveLocalizedText(league.name, this.locale).text;
  }
  private week(days: readonly CalendarDate[], items: readonly CalendarOccurrence[]) {
    const month = this.selected.slice(0, 7);
    const bars = calendarWeekSegments(
      items.filter((item) => item.kind !== "arena").sort((left, right) => BAR_ORDER.indexOf(tone(left.kind)) - BAR_ORDER.indexOf(tone(right.kind))),
      days,
    );
    const arena = days.some((date) => this.arenaRules(date).length);
    const overflow = days.map((_, column) => bars.filter((bar) => bar.lane >= LANES && column >= bar.column && column < bar.column + bar.span).length);
    return html`
      <div class=${`calendar-week${arena ? " calendar-week--arena" : ""}`} role="row">
        ${days.map((date, column) => {
          const label = [this.dateLabel(date, true), this.arenaDescription(date)].filter(Boolean).join(", ");
          return html`
            <button
              type="button"
              role="gridcell"
              class="calendar-day"
              style=${`grid-column:${column + 1}`}
              data-calendar-date=${date}
              tabindex=${date === this.selected ? 0 : -1}
              aria-label=${label}
              aria-selected=${String(date === this.selected)}
              aria-current=${date === this.today ? "date" : nothing}
              ?data-outside=${!date.startsWith(month)}
              @click=${() => this.select(date)}
              @keydown=${(event: KeyboardEvent) => this.key(event, date)}
            >
              <span class="calendar-day__number">${Number(date.slice(-2))}</span>
              ${this.dayArena(date)}
              ${overflow[column] ? html`<span class="calendar-day__more">+${overflow[column]}</span>` : nothing}
            </button>
          `;
        })}
        ${bars
          .filter((bar) => bar.lane < LANES)
          .map((bar) => {
            const title = this.itemTitle(bar.item);
            return html`
              <span
                class=${`calendar-bar calendar-bar--${tone(bar.item.kind)}`}
                style=${`grid-column:${bar.column + 1} / span ${bar.span};grid-row:${bar.lane + 2}`}
                ?data-before=${bar.before}
                ?data-after=${bar.after}
                lang=${title.lang}
                title=${title.text}
              >${title.text}</span>
            `;
          })}
      </div>
    `;
  }
  private month(items: readonly CalendarOccurrence[]) {
    const days = this.days;
    const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, index) => days.slice(index * 7, index * 7 + 7));
    const lastMonth = this.selected.slice(0, 7);
    return html`
      <div class="calendar-month surface" role="grid" aria-label=${this.monthName}>
        <div class="calendar-weekdays" role="row">
          ${days.slice(0, 7).map(
            (date) => html`
              <span role="columnheader">${new Intl.DateTimeFormat(this.locale, { weekday: "short", timeZone: "UTC" }).format(calendarDateUtc(date))}</span>
            `,
          )}
        </div>
        ${weeks.filter((week) => week.some((date) => date.startsWith(lastMonth))).map((week) => this.week(week, items))}
        ${this.arenaShown && this.data!.arena ? this.missionLegend() : nothing}
      </div>
    `;
  }
  private missionLegend() {
    const context = this.arenaContext!;
    const seen = [...new Set(this.days.flatMap((date) => this.arenaRules(date).flatMap((rule) => (rule ? [rule.missions[0]!] : []))))].sort();
    return seen.length
      ? html`
          <p class="calendar-legend">
            ${seen.map(
              (mission) => html`<span><i data-mission=${mission}></i>${arenaMission(context, mission, 16)}${arenaMissionLabel(this.locale, mission)}</span>`,
            )}
          </p>
        `
      : nothing;
  }
  private dayArenaPanel(date: CalendarDate) {
    const rules = this.arenaRules(date);
    const context = this.arenaContext;
    if (!rules.length || !context) return nothing;
    const { leagues, href } = this.data!.arena!;
    return html`
      <section class="calendar-arena">
        <h3 class="detail-section-title">
          <span class="detail-section-title__icon" aria-hidden="true">${icon("swords", 18)}</span>
          <span class="detail-section-title__label">${this.t("arena")}</span>
        </h3>
        <ul>
          ${rules.map((rule, index) =>
            rule
              ? html`
                  <li>
                    <a href=${href}>
                      <img src=${leagues[index]!.image} alt="" width="28" height="28" loading="lazy" />
                      <span>${this.leagueName(leagues[index]!)}</span>
                      ${rule.musicType === 99 ? nothing : arenaAttribute(context, rule.musicType, 20)}
                      ${arenaMission(context, rule.missions[0]!, 20)}
                      <small>${arenaMissionLabel(this.locale, rule.missions[0]!)}</small>
                    </a>
                  </li>
                `
              : nothing,
          )}
        </ul>
      </section>
    `;
  }
  private dayPanel(items: readonly CalendarOccurrence[]) {
    return html`
      <aside class="calendar-detail surface" aria-live="polite">
        <header>
          <h2>${this.dateLabel(this.selected, true)}</h2>
          <small>${this.zone}</small>
        </header>
        ${this.dayArenaPanel(this.selected)}
        ${this.entries(calendarOnDay(items, this.selected).filter((item) => item.kind !== "arena"))}
      </aside>
    `;
  }
  /** Each day of the month with what starts or ends on it, so a long event is not repeated daily. */
  private agenda(items: readonly CalendarOccurrence[]) {
    const month = this.selected.slice(0, 7);
    const days = this.days.filter((date) => date.startsWith(month));
    const context = this.arenaContext;
    const rows = days.flatMap((date) => {
      const changes = items.filter((item) => item.kind !== "arena" && (item.start === date || item.end === date));
      const rules = this.arenaRules(date);
      return changes.length || date === this.today ? [{ date, changes, rules }] : [];
    });
    if (!rows.length) return emptyState({ title: this.t("empty"), icon: "event" });
    return html`
      <ol class="calendar-agenda">
        ${rows.map(
          ({ date, changes, rules }) => html`
            <li class="calendar-agenda__day surface" ?data-today=${date === this.today}>
              <button type="button" class="calendar-agenda__date" aria-label=${this.dateLabel(date, true)} @click=${() => {
                this.selected = date;
                this.view = "month";
                this.sync();
              }}>
                <small>${new Intl.DateTimeFormat(this.locale, { weekday: "short", timeZone: "UTC" }).format(calendarDateUtc(date))}</small>
                <strong>${Number(date.slice(-2))}</strong>
              </button>
              <div>
                ${
                  rules.length && context
                    ? html`<span class="calendar-agenda__arena">
                        ${rules.map((rule, index) =>
                          rule
                            ? html`<span><img src=${this.data!.arena!.leagues[index]!.image} alt="" width="20" height="20" loading="lazy" />${arenaMission(context, rule.missions[0]!, 18)}</span>`
                            : nothing,
                        )}
                      </span>`
                    : nothing
                }
                ${changes.map((item) => {
                  const title = this.itemTitle(item);
                  const phase = item.start === item.end ? "" : this.t(item.start === date ? "starts" : "ends");
                  const body = html`<i class=${`calendar-tone calendar-tone--${tone(item.kind)}`}></i><span lang=${title.lang}>${title.text}</span><small>${[phase, this.t(item.kind)].filter(Boolean).join(" · ")}</small>`;
                  return item.kind !== "cast" && item.href
                    ? html`<a class="calendar-agenda__item" href=${item.href}>${body}</a>`
                    : html`<span class="calendar-agenda__item">${body}</span>`;
                })}
              </div>
            </li>
          `,
        )}
      </ol>
    `;
  }
  render() {
    const items = this.items;
    return html`
      <section class="calendar-page">
        <div class="calendar-view" ?inert=${this.filtersOpen}>
          ${
            !this.data
              ? html`<div class="calendar-loading">${loadingState(clientText(this.locale, "common.states.loading", "Loading"))}</div>`
              : this.view === "month"
                ? html`<div class="calendar-layout">${this.month(items)}${this.dayPanel(items)}</div>`
                : this.agenda(items)
          }
        </div>
        ${this.filterPanel()}
      </section>
    `;
  }
}
if (!customElements.get("calendar-page")) customElements.define("calendar-page", CalendarPage);
