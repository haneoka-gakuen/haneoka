/**
 * Theme seeds beyond the precomputed brand and band schemes: one per character, and seasonal themes that open only
 * on their dates. Their colour roles are generated on the device (theme-schemes.ts) and cached for the boot script,
 * which applies them before first paint.
 */

/** A seasonal theme's decoration: the motif of its effect layer, brand ornament and shape. */
export type Motif = "bats" | "beans" | "confetti" | "fireworks" | "hearts" | "lanterns" | "moon" | "petals" | "snow" | "sparkles" | "stars";

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
  return { year, month, day, lunarMonth, lunarDay, leap };
}

const between = (day: Day, [m1, d1]: [number, number], [m2, d2]: [number, number]) => {
  const value = day.month * 100 + day.day;
  const from = m1 * 100 + d1,
    to = m2 * 100 + d2;
  return from <= to ? value >= from && value <= to : value >= from || value <= to;
};
const lunarBetween = (day: Day, month: number, from: number, to: number) =>
  !day.leap && day.lunarMonth === month && day.lunarDay >= from && day.lunarDay <= to;
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

const JST_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;
/** The date in Japan, where the game keeps its characters' birthdays. */
export function japanDay(date = new Date()): { month: number; day: number } {
  const japan = new Date(date.getTime() + JST_MS);
  return { month: japan.getUTCMonth() + 1, day: japan.getUTCDate() };
}

export function birthdaysOn(characters: readonly ThemeCharacter[], date = new Date()): ThemeCharacter[] {
  const day = japanDay(date);
  return characters.filter((character) => character.birthday?.[0] === day.month && character.birthday[1] === day.day);
}

/** Whether a seed may be applied today. Character seeds always; seasonal ones only while open. */
export function seedOpen(seed: string, characters: readonly ThemeCharacter[], date = new Date()): boolean {
  if (seed.startsWith("character-")) return characters.some((character) => characterSeed(character.id) === seed);
  if (seed.startsWith("season-")) return openSeasons(date).some((season) => seasonSeed(season.id) === seed);
  if (seed.startsWith("birthday-")) return birthdaysOn(characters, date).some((character) => birthdaySeed(character.id) === seed);
  return false;
}

/** The first moment after `date` when a seasonal seed closes, for the boot cache: local midnight for seasons, Japan's
 * midnight for birthdays. */
export function seedCloses(seed: string, characters: readonly ThemeCharacter[], date = new Date()): number | null {
  if (seed.startsWith("character-")) return null;
  if (seed.startsWith("birthday-")) return Math.floor((date.getTime() + JST_MS) / DAY_MS) * DAY_MS + DAY_MS - JST_MS;
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  for (let step = 0; step < 60; step++) {
    day.setDate(day.getDate() + 1);
    if (!seedOpen(seed, characters, day)) return day.getTime();
  }
  return day.getTime();
}
