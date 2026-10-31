/**
 * Theme seeds beyond the precomputed brand and band schemes: one per character, and seasonal themes that open only
 * on their dates. Their colour roles are generated on the device (theme-schemes.ts) and cached for the boot script,
 * which applies them before first paint.
 */

/** A seasonal theme's decoration: the motif of its effect layer, brand ornament and shape. */
export type Motif = "bats" | "beans" | "confetti" | "eggs" | "fireworks" | "hearts" | "lanterns" | "leaves" | "moon" | "petals" | "snow" | "sparkles" | "stars";

export interface Season {
  id: string;
  /** i18n key under settings.seasons. */
  key: string;
  label: string;
  motif: Motif;
  /** Ornament on the brand mark, a Material Symbols name. */
  ornament: string;
  /** Shape token (shapes.css) for the brand mark's container. */
  shape: string;
  primary: string;
  secondary: string;
  tertiary: string;
  open(day: Day): boolean;
}

/** A local calendar date: Gregorian and Chinese lunar (leap months flagged). */
export interface Day {
  year: number;
  month: number;
  day: number;
  /** Days since the epoch, for windows around movable feasts. */
  serial: number;
  lunarMonth: number;
  lunarDay: number;
  leap: boolean;
}

const lunar = (() => {
  try {
    return new Intl.DateTimeFormat("en-u-ca-chinese", { month: "numeric", day: "numeric" });
  } catch {
    return null;
  }
})();
const serialOf = (year: number, month: number, day: number) => Math.round(Date.UTC(year, month - 1, day) / 86_400_000);

export function dayOf(date: Date): Day {
  let lunarMonth = 0,
    lunarDay = 0,
    leap = false;
  for (const part of lunar?.formatToParts(date) ?? []) {
    if (part.type === "month") {
      lunarMonth = Number.parseInt(part.value, 10);
      leap = /bis|leap/i.test(part.value);
    } else if (part.type === "day") lunarDay = Number.parseInt(part.value, 10);
  }
  const [year, month, day] = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  return { year, month, day, serial: serialOf(year, month, day), lunarMonth, lunarDay, leap };
}

const between = (day: Day, [m1, d1]: [number, number], [m2, d2]: [number, number]) => {
  const value = day.month * 100 + day.day;
  const from = m1 * 100 + d1,
    to = m2 * 100 + d2;
  return from <= to ? value >= from && value <= to : value >= from || value <= to;
};
const lunarBetween = (day: Day, month: number, from: number, to: number) =>
  !day.leap && day.lunarMonth === month && day.lunarDay >= from && day.lunarDay <= to;
const withinDays = (day: Day, serial: number, before: number, after: number) =>
  day.serial >= serial + before && day.serial <= serial + after;
/** Easter Sunday (anonymous Gregorian computus). */
function easter(year: number) {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100,
    d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return serialOf(year, month, ((h + l - 7 * m + 114) % 31) + 1);
}
/** The `nth` `weekday` (0 Sunday) of a month. */
function nthWeekday(year: number, month: number, weekday: number, nth: number) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return serialOf(year, month, 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7);
}

export const SEASONS: readonly Season[] = [
  {
    id: "new-year",
    key: "newYear",
    label: "New Year",
    motif: "fireworks",
    ornament: "celebration",
    shape: "--shape-very-sunny",
    primary: "#b3202f",
    secondary: "#8a6d3b",
    tertiary: "#c99a1e",
    open: (day) => between(day, [12, 31], [1, 7]),
  },
  {
    id: "setsubun",
    key: "setsubun",
    label: "Setsubun",
    motif: "beans",
    ornament: "mood_bad",
    shape: "--shape-cookie-4",
    primary: "#a0522d",
    secondary: "#6d6a4f",
    tertiary: "#3f7a3a",
    open: (day) => between(day, [2, 1], [2, 3]),
  },
  {
    id: "lunar-new-year",
    key: "lunarNewYear",
    label: "Lunar New Year",
    motif: "fireworks",
    ornament: "festival",
    shape: "--shape-cookie-9",
    primary: "#c62a1f",
    secondary: "#9c5a2c",
    tertiary: "#d9a227",
    open: (day) => (!day.leap && day.lunarMonth === 12 && day.lunarDay >= 29) || lunarBetween(day, 1, 1, 14),
  },
  {
    id: "lantern-festival",
    key: "lanternFestival",
    label: "Lantern Festival",
    motif: "lanterns",
    ornament: "festival",
    shape: "--shape-cookie-9",
    primary: "#d2471f",
    secondary: "#8f5e3a",
    tertiary: "#e0b23a",
    open: (day) => lunarBetween(day, 1, 15, 15),
  },
  {
    id: "valentine",
    key: "valentine",
    label: "Valentine's Day",
    motif: "hearts",
    ornament: "favorite",
    shape: "--shape-clover-4",
    primary: "#c2185b",
    secondary: "#8d5a4a",
    tertiary: "#7b4a2b",
    open: (day) => between(day, [2, 7], [2, 14]),
  },
  {
    id: "hinamatsuri",
    key: "hinamatsuri",
    label: "Hinamatsuri",
    motif: "petals",
    ornament: "filter_vintage",
    shape: "--shape-flower",
    primary: "#e07a96",
    secondary: "#8f7a6a",
    tertiary: "#5f8f4a",
    open: (day) => between(day, [2, 26], [3, 3]),
  },
  {
    id: "white-day",
    key: "whiteDay",
    label: "White Day",
    motif: "sparkles",
    ornament: "redeem",
    shape: "--shape-cookie-12",
    primary: "#4f7fbf",
    secondary: "#6d7a90",
    tertiary: "#d27aa0",
    open: (day) => between(day, [3, 7], [3, 14]),
  },
  {
    id: "hanami",
    key: "hanami",
    label: "Cherry blossoms",
    motif: "petals",
    ornament: "local_florist",
    shape: "--shape-flower",
    primary: "#d0688f",
    secondary: "#9a6f7c",
    tertiary: "#6e9a4c",
    open: (day) => between(day, [3, 20], [4, 10]),
  },
  {
    id: "april-fools",
    key: "aprilFools",
    label: "April Fools' Day",
    motif: "confetti",
    ornament: "sentiment_very_satisfied",
    shape: "--shape-gem",
    primary: "#7a3fb0",
    secondary: "#3b8a6e",
    tertiary: "#e0a100",
    open: (day) => day.month === 4 && day.day === 1,
  },
  {
    id: "easter",
    key: "easter",
    label: "Easter",
    motif: "eggs",
    ornament: "egg",
    shape: "--shape-cookie-4",
    primary: "#8a6fc4",
    secondary: "#6f8f7a",
    tertiary: "#e3a33b",
    open: (day) => withinDays(day, easter(day.year), -2, 1),
  },
  {
    id: "childrens-day",
    key: "childrensDay",
    label: "Children's Day",
    motif: "confetti",
    ornament: "toys",
    shape: "--shape-sunny",
    primary: "#2f7fd0",
    secondary: "#5f7a8f",
    tertiary: "#e2504a",
    open: (day) => between(day, [5, 1], [5, 5]),
  },
  {
    id: "mothers-day",
    key: "mothersDay",
    label: "Mother's Day",
    motif: "petals",
    ornament: "favorite",
    shape: "--shape-flower",
    primary: "#c43d6b",
    secondary: "#8a6070",
    tertiary: "#d98a3a",
    open: (day) => withinDays(day, nthWeekday(day.year, 5, 0, 2), -6, 0) || between(day, [5, 8], [5, 8]),
  },
  {
    id: "dragon-boat",
    key: "dragonBoat",
    label: "Dragon Boat Festival",
    motif: "leaves",
    ornament: "rowing",
    shape: "--shape-pill",
    primary: "#2f7d5b",
    secondary: "#5a7a68",
    tertiary: "#c9762a",
    open: (day) => lunarBetween(day, 5, 1, 5),
  },
  {
    id: "tanabata",
    key: "tanabata",
    label: "Tanabata",
    motif: "stars",
    ornament: "auto_awesome",
    shape: "--shape-sunny",
    primary: "#2c4a9a",
    secondary: "#5b6a8f",
    tertiary: "#d4a72c",
    open: (day) => between(day, [7, 1], [7, 7]),
  },
  {
    id: "qixi",
    key: "qixi",
    label: "Qixi",
    motif: "stars",
    ornament: "auto_awesome",
    shape: "--shape-sunny",
    primary: "#6e4bb5",
    secondary: "#7a6890",
    tertiary: "#d08bb0",
    open: (day) => lunarBetween(day, 7, 1, 7),
  },
  {
    id: "obon",
    key: "obon",
    label: "Obon",
    motif: "lanterns",
    ornament: "candle",
    shape: "--shape-arch",
    primary: "#3d5a9a",
    secondary: "#6a6f80",
    tertiary: "#e08a3a",
    open: (day) => between(day, [8, 13], [8, 16]),
  },
  {
    id: "mid-autumn",
    key: "midAutumn",
    label: "Mid-Autumn",
    motif: "moon",
    ornament: "bedtime",
    shape: "--shape-circle",
    primary: "#b9721a",
    secondary: "#7d6a4f",
    tertiary: "#3d4f8f",
    open: (day) => lunarBetween(day, 8, 10, 17),
  },
  {
    id: "halloween",
    key: "halloween",
    label: "Halloween",
    motif: "bats",
    ornament: "skull",
    shape: "--shape-cookie-6",
    primary: "#d9690b",
    secondary: "#6f5a4a",
    tertiary: "#6b3fa0",
    open: (day) => between(day, [10, 17], [10, 31]),
  },
  {
    id: "thanksgiving",
    key: "thanksgiving",
    label: "Thanksgiving",
    motif: "leaves",
    ornament: "dinner_dining",
    shape: "--shape-oval",
    primary: "#b45a1e",
    secondary: "#7a6650",
    tertiary: "#8a7a1e",
    open: (day) => withinDays(day, nthWeekday(day.year, 11, 4, 4), -2, 3),
  },
  {
    id: "christmas",
    key: "christmas",
    label: "Christmas",
    motif: "snow",
    ornament: "featured_seasonal_and_gifts",
    shape: "--shape-cookie-12",
    primary: "#1f7a4d",
    secondary: "#5f7466",
    tertiary: "#c0392b",
    open: (day) => between(day, [12, 18], [12, 26]),
  },
];

/** A character as the theme picker and birthday theme read it. */
export interface ThemeCharacter {
  id: number;
  bandId: number;
  color: string;
  face: string;
  name: string;
  birthday: [number, number] | null;
}

export const characterSeed = (id: number) => `character-${id}`;
export const seasonSeed = (id: string) => `season-${id}`;
export const birthdaySeed = (id: number) => `birthday-${id}`;
export const DYNAMIC_SEED = /^(character-\d+|season-[a-z-]+|birthday-\d+)$/;

/** The decoration a seed carries, if it is seasonal. A birthday borrows its character's colour. */
export const BIRTHDAY: Omit<Season, "id" | "primary" | "secondary" | "tertiary" | "open"> = {
  key: "birthday",
  label: "Birthday",
  motif: "confetti",
  ornament: "cake",
  shape: "--shape-soft-burst",
};

export function openSeasons(date = new Date()): Season[] {
  const day = dayOf(date);
  return SEASONS.filter((season) => season.open(day));
}

export function birthdaysOn(characters: readonly ThemeCharacter[], date = new Date()): ThemeCharacter[] {
  const day = dayOf(date);
  return characters.filter((character) => character.birthday?.[0] === day.month && character.birthday[1] === day.day);
}

/** Whether a seed may be applied today. Character seeds always; seasonal ones only while open. */
export function seedOpen(seed: string, characters: readonly ThemeCharacter[], date = new Date()): boolean {
  if (seed.startsWith("character-")) return characters.some((character) => characterSeed(character.id) === seed);
  if (seed.startsWith("season-")) return openSeasons(date).some((season) => seasonSeed(season.id) === seed);
  if (seed.startsWith("birthday-")) return birthdaysOn(characters, date).some((character) => birthdaySeed(character.id) === seed);
  return false;
}

/** The first moment after `date` when a seasonal seed closes (local midnight), for the boot cache. */
export function seedCloses(seed: string, characters: readonly ThemeCharacter[], date = new Date()): number | null {
  if (seed.startsWith("character-")) return null;
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  for (let step = 0; step < 60; step++) {
    day.setDate(day.getDate() + 1);
    if (!seedOpen(seed, characters, day)) return day.getTime();
  }
  return day.getTime();
}
