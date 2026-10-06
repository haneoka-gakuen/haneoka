import { LitElement, html, nothing, type PropertyValues } from "lit";
import "@material/web/list/list.js";
import "@material/web/list/list-item.js";
import "@material/web/divider/divider.js";
import "@material/web/textfield/outlined-text-field.js";
import { clientText, getI18nClient } from "../i18n/client";
import { readPageData } from "../lib/page-data";
import { resolveLocalizedText } from "../lib/localized-text";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import { navigationDocumentUrl } from "../lib/document-url";
import { icon } from "./ui/icon";
import { iconButton, segmented } from "./ui/controls";
import { facet } from "./ui/facet";
import { PaneFocus } from "./ui/pane";
import { emptyState, loadingState } from "./ui/state";
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
  type CalendarData,
  type CalendarDate,
  type CalendarKind,
  type CalendarOccurrence,
} from "../lib/calendar-model";

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
  "external-live": "externalLive",
};
let sequence = 0;
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
    const requested = query.get("date") || "";
    if (parseCalendarDate(requested)) this.selected = requested as CalendarDate;
    const view = query.get("view");
    this.view = view === "agenda" ? "agenda" : "month";
    this.removeAttribute("data-calendar-auto");
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
    super.disconnectedCallback();
  }
  protected updated(_changed: PropertyValues) {
    setAppBarActions(
      this.owner,
      html`${iconButton({
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
          this.removeAttribute("data-calendar-auto");
          this.view = view;
          this.sync();
        },
      })}`,
    );
    this.paneFocus.sync(this.filtersOpen ? this.querySelector<HTMLElement>(".browse__filters.is-open") : null, () => {
      this.filtersOpen = false;
    });
  }
  private t(key: string) {
    return (
      this.labels[key] ||
      (["filter", "close", "reset"].includes(key)
        ? clientText(this.locale, key, key === "filter" ? "Filter" : key === "close" ? "Close" : "Reset")
        : clientText(this.locale, `calendar.${key}`, copy[key] || key))
    );
  }
  private itemTitle(item: CalendarOccurrence) {
    return resolveLocalizedText(item.title, this.locale);
  }
  private dateLabel(date: CalendarDate, weekday = false) {
    return new Intl.DateTimeFormat(this.locale, {
      timeZone: "UTC",
      month: "long",
      day: "numeric",
      ...(weekday ? { weekday: "long" as const } : {}),
    }).format(calendarDateUtc(date));
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
      ? calendarOccurrences(this.data, days[0], days[41], this.zone).filter((item) =>
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
    const date = new Intl.DateTimeFormat(this.locale, {
      timeZone: this.zone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return `${date.format(startAtMs)}${endAtMs ? ` – ${date.format(endAtMs)}` : ""}`;
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
  private dateStrip() {
    return html`
      <div class="calendar-date-strip" role="group" aria-label=${this.t("chooseDate")}>
        ${(() => {
          const offset =
            (new Date(calendarDateUtc(this.selected)).getUTCDay() - calendarWeekStart(this.locale) + 7) % 7;
          const first = addCalendarDays(this.selected, -offset);
          return Array.from({ length: 7 }, (_, i) => addCalendarDays(first, i)).map(
            (date) => html`
              <button
                type="button"
                data-calendar-date=${date}
                aria-pressed=${String(date === this.selected)}
                aria-current=${date === this.today ? "date" : nothing}
                aria-label=${this.dateLabel(date, true)}
                @click=${() => this.select(date)}
                @keydown=${(e: KeyboardEvent) => this.key(e, date)}
              >
                <small>
                  ${new Intl.DateTimeFormat(this.locale, { weekday: "narrow", timeZone: "UTC" }).format(calendarDateUtc(date))}
                </small>
                <strong>${Number(date.slice(-2))}</strong>
              </button>
            `,
          );
        })()}
      </div>
    `;
  }
  private month(items: readonly CalendarOccurrence[]) {
    const days = this.days,
      month = this.selected.slice(0, 7);
    return html`
      <div
        class="calendar-grid"
        role="grid"
        aria-label=${new Intl.DateTimeFormat(this.locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(calendarDateUtc(this.selected))}
      >
        <div class="calendar-weekday-row" role="row">
          ${days.slice(0, 7).map(
            (date) => html`
              <span role="columnheader">
                ${new Intl.DateTimeFormat(this.locale, { weekday: "short", timeZone: "UTC" }).format(calendarDateUtc(date))}
              </span>
            `,
          )}
        </div>
        ${Array.from({ length: 6 }, (_, i) => days.slice(i * 7, i * 7 + 7)).map((week) => {
          const segments = calendarWeekSegments(items, week);
          return html`
            <div class="calendar-week">
              <div class="calendar-days" role="row">
                ${week.map((date) => {
                  const onDay = calendarOnDay(items, date);
                  const overflow = segments.filter(
                    (s) => s.lane >= 3 && s.item.start <= date && s.item.end >= date,
                  ).length;
                  return html`
                  <div
                    class=${`calendar-cell${date.slice(0, 7) !== month ? " is-other-month" : ""}${date === this.selected ? " is-selected" : ""}`}
                    role="gridcell"
                    aria-selected=${String(date === this.selected)}
                  >
                    <button
                      type="button"
                      data-calendar-date=${date}
                      tabindex=${date === this.selected ? "0" : "-1"}
                      aria-label=${`${this.dateLabel(date, true)}${onDay.length ? ` · ${onDay.length}` : ""}`}
                      aria-current=${date === this.today ? "date" : nothing}
                      @click=${() => this.select(date)}
                      @keydown=${(e: KeyboardEvent) => this.key(e, date)}
                    >
                      <span class="calendar-day-number">${Number(date.slice(-2))}</span>
                      ${
                        overflow
                          ? html`
                          <span class="calendar-more">${this.t("more").replace("{count}", String(overflow))}</span>
                        `
                          : nothing
                      }
                    </button>
                  </div>
                `;
                })}
              </div>
              <div class="calendar-bars" aria-hidden="true">
                ${segments
                  .filter((s) => s.lane < 3)
                  .map((s) => {
                    const title = this.itemTitle(s.item);
                    return html`
                    <span
                      class=${`calendar-bar calendar-bar--${category(s.item.kind)}${s.before ? " continues-before" : ""}${s.after ? " continues-after" : ""}`}
                      style=${`grid-column:${s.column + 1}/span ${s.span};grid-row:${s.lane + 1}`}
                      title=${`${title.text} · ${this.range(s.item)}`}
                    >
                      ${s.item.kind === "character" || s.item.kind === "cast" ? icon("cake", 14) : nothing}
                      <span lang=${title.lang}>${title.text}</span>
                    </span>
                  `;
                  })}
              </div>
            </div>
          `;
        })}
      </div>
    `;
  }
  render() {
    const items = this.items;
    const month = new Intl.DateTimeFormat(this.locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
      calendarDateUtc(this.selected),
    );
    return html`
      <section class="calendar-page">
      <div class="calendar-view" ?inert=${this.filtersOpen}>
        <header class="calendar-toolbar">
          <h2 aria-live="polite">${month}</h2>
          <div class="calendar-month-actions">
            <button type="button" class="button button--text" @click=${() => this.select(this.today)}>
              ${this.t("today")}
            </button>
            ${iconButton({ label: this.t("previous"), icon: "chevron_left", onClick: () => this.select(shiftCalendarMonth(this.selected, -1)) })}
            ${iconButton({ label: this.t("next"), icon: "chevron_right", onClick: () => this.select(shiftCalendarMonth(this.selected, 1)) })}
            <span class="calendar-date-button">${iconButton({
              label: this.t("chooseDate"),
              icon: "event",
              onClick: () => {
                const input = this.querySelector<HTMLInputElement>("input[data-native-date]");
                if (input?.showPicker) input.showPicker();
                else input?.focus();
              },
            })}</span>
            <md-outlined-text-field class="calendar-date-field" type="text" label=${this.t("chooseDate")}
              .value=${this.selected} inputmode="text" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"
              @change=${(event: Event) => {
                const field = event.target as HTMLElement & { value: string; error: boolean; errorText: string };
                if (parseCalendarDate(field.value)) {
                  field.error = false;
                  this.select(field.value as CalendarDate);
                } else {
                  field.error = true;
                  field.errorText = this.t("invalidDate");
                }
              }}>
              <span slot="trailing-icon">${iconButton({
                label: this.t("chooseDate"),
                icon: "event",
                onClick: () => {
                  const input = this.querySelector<HTMLInputElement>("input[data-native-date]");
                  if (input?.showPicker) input.showPicker();
                  else input?.focus();
                },
              })}</span>
            </md-outlined-text-field>
            <input data-native-date class="calendar-native-date" type="date" aria-label=${this.t("chooseDate")} tabindex="-1" aria-hidden="true" .value=${this.selected}
              @change=${(event: Event) => {
                const date = (event.target as HTMLInputElement).value;
                if (parseCalendarDate(date)) this.select(date as CalendarDate);
              }} />
          </div>
        </header>
        ${
          this.data?.unavailable.length
            ? html`
                <p class="calendar-notice" role="status">${this.t("unavailable")}</p>
              `
            : nothing
        }
        <div class=${`calendar-content calendar-content--${this.view}`}>
          ${
            this.view === "month"
              ? this.month(items)
              : html`
                  <section class="calendar-day-agenda calendar-mobile-agenda">
                    ${this.dateStrip()}
                    <header>
                      <h3>${this.dateLabel(this.selected, true)}</h3>
                      <span>${this.zone}</span>
                    </header>
                    ${this.entries(calendarOnDay(items, this.selected))}
                  </section>
                `
          }
          ${
            this.view === "month"
              ? html`
                  <section class="calendar-day-agenda" aria-live="polite">
                    ${this.dateStrip()}
                    <header>
                      <h3>${this.dateLabel(this.selected, true)}</h3>
                      <span>${this.zone}</span>
                    </header>
                    ${this.entries(calendarOnDay(items, this.selected))}
                  </section>
                `
              : nothing
          }
        </div>
        ${
          !this.data
            ? html`
                <div class="calendar-loading">${loadingState(clientText(this.locale, "loading", "Loading"))}</div>
              `
            : nothing
        }
      </div>
      ${this.filterPanel()}
      </section>
    `;
  }
}
if (!customElements.get("calendar-page")) customElements.define("calendar-page", CalendarPage);
