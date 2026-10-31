/** Civil dates stay separate from instants: adding a calendar day must survive DST. */
export type CalendarDate = `${number}-${number}-${number}`;
export type CalendarKind = "character" | "cast" | "event" | "gacha" | "login" | "pass" | "live" | "game-live" | "arena";
export const CALENDAR_FACETS = [
  "our-notes:character",
  "our-notes:cast",
  "garupa:character",
  "garupa:cast",
  "event",
  "gacha",
  "login",
  "pass",
  "game-live",
  "arena",
  "external-live",
] as const;
export type CalendarFacet = (typeof CALENDAR_FACETS)[number];
export interface CalendarVoiceRole {
  readonly id: string;
  readonly name: readonly string[];
  readonly href?: string;
}
export interface CalendarBirthday {
  readonly id: string;
  readonly game: "our-notes" | "garupa";
  readonly games?: readonly ("our-notes" | "garupa")[];
  readonly voices?: readonly CalendarVoiceRole[];
  readonly kind: "character" | "cast";
  readonly name: readonly string[];
  readonly month: number;
  readonly day: number;
  readonly image?: string;
  readonly characterIds?: readonly string[];
  readonly href?: string;
  readonly sourceUrls?: readonly string[];
}
export interface CalendarGameWindow {
  readonly startAtMs?: number;
  readonly endAtMs?: number;
  readonly href: string;
}
export interface CalendarActivity {
  readonly id: string;
  readonly kind: Exclude<CalendarKind, "character" | "cast">;
  readonly title: readonly string[] | string;
  readonly startAtMs?: number;
  readonly endAtMs?: number;
  /** External source only knows the date; never fabricate a start time. */
  readonly date?: CalendarDate;
  readonly endDate?: CalendarDate;
  readonly allDay?: boolean;
  readonly endExclusive?: boolean;
  readonly timeZone?: string;
  readonly href: string;
  readonly image?: string;
  readonly venue?: string;
  readonly sourceUrl?: string;
  readonly facets?: readonly CalendarFacet[];
  readonly gameWindow?: CalendarGameWindow;
  readonly liveStartLocal?: string;
}
export interface CalendarLiveSource {
  readonly id: string;
  readonly title: readonly string[] | string;
  readonly startAtMs?: number;
  readonly endAtMs?: number;
  readonly date?: CalendarDate;
  readonly endDate?: CalendarDate;
  readonly allDay?: boolean;
  readonly endExclusive?: boolean;
  readonly timeZone?: string;
  readonly venue?: string;
  readonly sourceUrl: string;
  readonly startLocal?: string;
  readonly realLiveIds?: Readonly<Partial<Record<string, readonly string[]>>>;
  readonly image?: string;
}
export interface CalendarArenaRule {
  readonly musicType: number;
  readonly missions: readonly number[];
}
export interface CalendarArenaLeague {
  readonly id: number;
  readonly name: readonly string[];
  readonly image: string;
}
/** Each day's rule per league, resolved at build time so the page needs no Arena catalogue. */
export interface CalendarArena {
  readonly releaseId: string;
  readonly href: string;
  readonly leagues: readonly CalendarArenaLeague[];
  readonly missions: Readonly<Record<string, string>>;
  readonly marks: Readonly<Record<string, string>>;
  readonly days: Readonly<Record<string, readonly (CalendarArenaRule | null)[]>>;
}
export interface CalendarData {
  readonly schema: "haneoka-calendar-v1";
  readonly server: string;
  readonly releaseId: string;
  readonly sourceId?: string;
  readonly snapshotBuildId?: string;
  readonly birthdays: readonly CalendarBirthday[];
  readonly activities: readonly CalendarActivity[];
  readonly unavailable: readonly string[];
  readonly arena?: CalendarArena;
}
export interface CalendarOccurrence {
  readonly id: string;
  readonly kind: CalendarKind;
  readonly title: readonly string[] | string;
  readonly start: CalendarDate;
  readonly end: CalendarDate;
  readonly href?: string;
  readonly image?: string;
  readonly game?: "our-notes" | "garupa";
  readonly voices?: readonly CalendarVoiceRole[];
  readonly facets?: readonly CalendarFacet[];
  readonly gameWindow?: CalendarGameWindow;
  readonly liveStartLocal?: string;
  readonly startAtMs?: number;
  readonly endAtMs?: number;
  readonly venue?: string;
  readonly sourceUrl?: string;
  readonly allDay?: boolean;
  readonly timeZone?: string;
}
export interface CalendarSegment {
  readonly item: CalendarOccurrence;
  readonly column: number;
  readonly span: number;
  readonly lane: number;
  readonly before: boolean;
  readonly after: boolean;
}
const dayMs = 86400000;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
export function parseCalendarDate(value: string): { year: number; month: number; day: number } | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!m) return;
  const [year, month, day] = m.slice(1).map(Number);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
    ? { year, month, day }
    : undefined;
}
export function calendarDate(year: number, month: number, day: number): CalendarDate {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!parseCalendarDate(value)) throw new RangeError("Invalid calendar date");
  return value as CalendarDate;
}
export function calendarDayAt(ms: number, timeZone: string): CalendarDate {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(ms).map((p) => [p.type, p.value]));
  return calendarDate(Number(parts.year), Number(parts.month), Number(parts.day));
}
export function calendarDateUtc(value: CalendarDate): number {
  const d = parseCalendarDate(value);
  if (!d) throw new RangeError("Invalid calendar date");
  return Date.UTC(d.year, d.month - 1, d.day, 12);
}
export function addCalendarDays(value: CalendarDate, days: number): CalendarDate {
  const d = new Date(calendarDateUtc(value) + days * dayMs);
  return calendarDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
export function shiftCalendarMonth(value: CalendarDate, step: number): CalendarDate {
  const d = parseCalendarDate(value)!;
  const first = new Date(Date.UTC(d.year, d.month - 1 + step, 1));
  const cap = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return calendarDate(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(d.day, cap));
}
export function calendarMonthDays(value: CalendarDate, weekStart = 0): CalendarDate[] {
  const d = parseCalendarDate(value)!;
  const first = calendarDate(d.year, d.month, 1);
  const offset = (new Date(calendarDateUtc(first)).getUTCDay() - weekStart + 7) % 7;
  const start = addCalendarDays(first, -offset);
  const nextMonth = shiftCalendarMonth(first, 1);
  const weeks = Math.ceil(((calendarDateUtc(nextMonth) - calendarDateUtc(start)) / dayMs) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addCalendarDays(start, i));
}
export function calendarWeekStart(locale: string): number {
  const l = new Intl.Locale(locale) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number };
    weekInfo?: { firstDay: number };
  };
  return (l.getWeekInfo?.().firstDay ?? l.weekInfo?.firstDay ?? 7) % 7;
}
export function calendarOccurrences(
  data: CalendarData,
  first: CalendarDate,
  last: CalendarDate,
  timeZone: string,
): CalendarOccurrence[] {
  const a = parseCalendarDate(first)!,
    b = parseCalendarDate(last)!;
  const result: CalendarOccurrence[] = [];
  for (const person of data.birthdays) {
    for (let year = a.year; year <= b.year; year++) {
      const value = `${year}-${String(person.month).padStart(2, "0")}-${String(person.day).padStart(2, "0")}`;
      if (!parseCalendarDate(value) || value < first || value > last) continue;
      result.push({
        id: `${person.id}@${year}`,
        kind: person.kind,
        title: person.name,
        start: value as CalendarDate,
        end: value as CalendarDate,
        href: person.href,
        image: person.image,
        game: person.game,
        voices: person.voices,
        facets: (person.games ?? [person.game]).map((game) => `${game}:${person.kind}` as CalendarFacet),
      });
    }
  }
  for (const activity of data.activities) {
    const hasTime = activity.allDay !== true && Number.isFinite(activity.startAtMs) && Number(activity.startAtMs) > 0;
    if (!hasTime && (!activity.date || !parseCalendarDate(activity.date))) continue;
    const start = hasTime ? calendarDayAt(activity.startAtMs!, timeZone) : activity.date!;
    const end =
      hasTime && Number.isFinite(activity.endAtMs) && activity.endAtMs! > activity.startAtMs!
        ? calendarDayAt(activity.endAtMs! - (activity.endExclusive === false ? 0 : 1), timeZone)
        : hasTime
          ? start
          : activity.endDate && parseCalendarDate(activity.endDate)
            ? activity.endExclusive
              ? addCalendarDays(activity.endDate, -1)
              : activity.endDate
            : start;
    if (end < start || end < first || start > last) continue;
    result.push({
      ...activity,
      start,
      end,
      facets: activity.facets ?? [activity.kind === "live" ? "external-live" : activity.kind],
    });
  }
  const kindPriority = (kind: CalendarKind) => (kind === "character" ? 0 : kind === "cast" ? 1 : 2);
  return result.sort(
    (x, y) =>
      x.start.localeCompare(y.start) ||
      kindPriority(x.kind) - kindPriority(y.kind) ||
      y.end.localeCompare(x.end) ||
      x.id.localeCompare(y.id),
  );
}
export function calendarOnDay(items: readonly CalendarOccurrence[], date: CalendarDate): CalendarOccurrence[] {
  return items.filter((item) => item.start <= date && item.end >= date);
}
/** Stable greedy lanes preserve each event's interval; overflow is listed in the date's agenda. */
export function calendarWeekSegments(
  items: readonly CalendarOccurrence[],
  days: readonly CalendarDate[],
): CalendarSegment[] {
  const first = days[0],
    last = days[6];
  const ends: number[] = [];
  return items
    .filter((item) => item.start <= last && item.end >= first)
    .map((item) => {
      const start = item.start < first ? first : item.start;
      const end = item.end > last ? last : item.end;
      const column = days.indexOf(start),
        final = days.indexOf(end);
      let lane = ends.findIndex((previous) => previous < column);
      if (lane < 0) lane = ends.length;
      ends[lane] = final;
      return { item, column, span: final - column + 1, lane, before: item.start < first, after: item.end > last };
    });
}
