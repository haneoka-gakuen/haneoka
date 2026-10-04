export const BIRTHDAY_UTC_OFFSET = 9 * 60 * 60 * 1000;
export const BIRTHDAY_DAY_MS = 24 * 60 * 60 * 1000;

export const birthdayDayStart = (now = Date.now()) =>
  Math.floor((now + BIRTHDAY_UTC_OFFSET) / BIRTHDAY_DAY_MS) * BIRTHDAY_DAY_MS - BIRTHDAY_UTC_OFFSET;

const yearAt = (at: number) => new Date(at + BIRTHDAY_UTC_OFFSET).getUTCFullYear();
const birthdayAt = (year: number, month: number, day: number): number | undefined => {
  const at = Date.UTC(year, month - 1, day) - BIRTHDAY_UTC_OFFSET;
  const date = new Date(at + BIRTHDAY_UTC_OFFSET);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? at
    : undefined;
};

export function nextBirthdayAt(month: number, day: number, now: number, afterToday = false): number {
  const today = birthdayDayStart(now);
  for (let year = yearAt(now); year <= yearAt(now) + 8; year++) {
    const at = birthdayAt(year, month, day);
    if (at !== undefined && (afterToday ? at > today : at >= today)) return at;
  }
  return Infinity;
}

const previousBirthdayAt = (month: number, day: number, now: number): number | undefined => {
  const today = birthdayDayStart(now);
  for (let year = yearAt(now); year >= yearAt(now) - 8; year--) {
    const at = birthdayAt(year, month, day);
    if (at !== undefined && at <= today) return at;
  }
  return undefined;
};

/** The campaign and card dates identify the occurrence; titles and IDs do not. */
const nearestBirthdayAt = (month: number, day: number, reference: number): number | undefined =>
  [yearAt(reference) - 1, yearAt(reference), yearAt(reference) + 1]
    .map((year) => birthdayAt(year, month, day))
    .filter((at): at is number => at !== undefined)
    .sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference) || a - b)[0];

export interface BirthdayGachaPeriod {
  server: string;
  characterId: number;
  cardYear?: number;
  cardReleasedAt?: number;
  start: number;
  end: number;
}

export interface BirthdayOccurrence {
  nextAt: number;
  retainedUntil: number;
  announced: boolean;
}

export function birthdayPeriodMatches(period: BirthdayGachaPeriod, at: number, server: string): boolean {
  if (
    period.server !== server ||
    !Number.isFinite(period.start) ||
    period.start <= 0 ||
    !Number.isFinite(period.end) ||
    (period.end > 0 && period.end <= period.start) ||
    !Number.isFinite(at)
  )
    return false;
  const date = new Date(at + BIRTHDAY_UTC_OFFSET);
  const month = date.getUTCMonth() + 1,
    day = date.getUTCDate();
  // Keep the existing birthday/campaign association window, not a guessed campaign duration.
  if (Math.abs(period.start - at) > 45 * BIRTHDAY_DAY_MS) return false;
  if (nearestBirthdayAt(month, day, period.start) !== at) return false;
  if (period.cardYear !== undefined) return period.cardYear === date.getUTCFullYear();
  return !period.cardReleasedAt || nearestBirthdayAt(month, day, period.cardReleasedAt) === at;
}

export function characterBirthdayOccurrence(
  month: number,
  day: number,
  characterId: number | null,
  periods: readonly BirthdayGachaPeriod[],
  server: string,
  now: number,
): BirthdayOccurrence {
  const previous = previousBirthdayAt(month, day, now);
  const related = (at: number) =>
    periods.filter((period) => period.characterId === characterId && birthdayPeriodMatches(period, at, server));
  const priorPeriods = previous === undefined ? [] : related(previous);
  const unended = priorPeriods.filter((period) => period.end > now);
  const today = birthdayDayStart(now);
  // A known ended campaign exits at its exact end, including during the birthday.
  const endedToday =
    previous === today &&
    priorPeriods.length > 0 &&
    priorPeriods.every((period) => period.end > 0 && period.end <= now);
  const nextAt =
    previous !== undefined && (unended.length > 0 || (previous === today && !endedToday))
      ? previous
      : nextBirthdayAt(month, day, now, endedToday);
  const nextPeriods = related(nextAt).filter(
    (period) => period.end > now || (period.end <= 0 && now < nextAt + BIRTHDAY_DAY_MS),
  );
  const knownEnds = nextPeriods.map((period) => period.end).filter((end) => end > now);
  return {
    nextAt,
    retainedUntil: knownEnds.length ? Math.max(...knownEnds) : nextAt + BIRTHDAY_DAY_MS,
    announced: nextPeriods.length > 0,
  };
}

/** Keep every member of an announced date group, plus the next birthday group. */
export function birthdayCharacterChoices<T extends BirthdayOccurrence>(items: readonly T[]): T[] {
  const sorted = [...items].sort((a, b) => a.nextAt - b.nextAt);
  const dates = new Set(sorted.filter((item) => item.announced).map((item) => item.nextAt));
  if (sorted[0]) dates.add(sorted[0].nextAt);
  return sorted.filter((item) => dates.has(item.nextAt));
}

/** Refresh at exact campaign boundaries and JST midnight, with ordinary minute ticks. */
export function birthdayRefreshAt(now: number, periods: readonly BirthdayGachaPeriod[]): number {
  return Math.min(
    now + 60_000,
    birthdayDayStart(now) + BIRTHDAY_DAY_MS,
    ...periods.flatMap((period) => [period.start, period.end]).filter((at) => Number.isFinite(at) && at > now),
  );
}
