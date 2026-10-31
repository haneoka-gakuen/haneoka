/** Seasonal themes come on by themselves: a character's birthday, or else an open season. A reader who picks a theme
 * while one is on keeps their pick until it closes. The day's result is cached once, so the boot script applies it
 * before paint and drops it when the day changes. */
import { BIRTHDAY, birthdaySeed, birthdaysOn, openSeasons, seedCloses, type ThemeCharacter } from "./themes";
import {
  SEASON_AUTO_KEY,
  SEASON_OVERRIDE_KEY,
  SEED_CSS_KEY,
  SEED_EVENT,
  SEED_KEY,
  localDay,
  syncThemeColor,
  type AutoSeason,
} from "./tuning";

const read = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") as T | null;
  } catch {
    return null;
  }
};

/** Characters with a birthday, as the layout embeds them. */
function characters(): ThemeCharacter[] {
  const rows = JSON.parse(document.getElementById("haneoka-birthdays")?.textContent || "[]") as [number, string, number, number][];
  return rows.map(([id, color, month, day]) => ({ id, bandId: 0, color, face: "", name: "", birthday: [month, day] }));
}

/** Today's theme: a birthday (the reader's own character first), else the latest-opening season. */
async function today(): Promise<AutoSeason> {
  const day = localDay();
  const date = new Date();
  const all = characters();
  const base = localStorage.getItem(SEED_KEY) || "haneoka";
  const born = birthdaysOn(all, date).sort((a, b) => Number(`character-${b.id}` === base) - Number(`character-${a.id}` === base))[0];
  const season = openSeasons(date).at(-1);
  if (!born && !season) return { day, seed: null };
  const { seedCss } = await import("./theme-schemes");
  if (born) {
    const seed = birthdaySeed(born.id);
    return {
      day,
      seed,
      css: seedCss(seed, born.color),
      season: { id: "birthday", motif: BIRTHDAY.motif, ornament: BIRTHDAY.ornament, shape: BIRTHDAY.shape },
      closes: seedCloses(seed, all),
    };
  }
  const seed = `season-${season!.id}`;
  return {
    day,
    seed,
    css: seedCss(seed, season!),
    season: { id: season!.id, motif: season!.motif, ornament: season!.ornament, shape: season!.shape },
    closes: seedCloses(seed, all),
  };
}

/** Brings the automatic theme up to date for today and applies or removes it. */
export async function syncAutoSeason() {
  const root = document.documentElement;
  let auto = read<AutoSeason>(SEASON_AUTO_KEY);
  try {
    if (auto?.day !== localDay()) {
      auto = await today();
      localStorage.setItem(SEASON_AUTO_KEY, JSON.stringify(auto));
    }
  } catch {
    return;
  }
  const override = read<{ seed: string; until: number }>(SEASON_OVERRIDE_KEY);
  const overridden = override && override.seed === auto?.seed && Date.now() < override.until;
  const wanted = auto?.seed && !overridden && localStorage.getItem(SEED_KEY) !== auto.seed ? auto : null;
  if (wanted && root.dataset.seed !== wanted.seed) {
    let style = document.getElementById("haneoka-season-scheme");
    if (!style) {
      style = document.createElement("style");
      style.id = "haneoka-season-scheme";
      document.head.append(style);
    }
    style.textContent = wanted.css!;
    root.dataset.seed = wanted.seed!;
    root.dataset.seedAuto = "true";
    root.dataset.season = wanted.season!.id;
  } else if (!wanted && root.dataset.seedAuto) {
    // The day moved on while the page stayed open: back to the reader's own theme.
    delete root.dataset.seedAuto;
    delete root.dataset.season;
    root.dataset.seed = localStorage.getItem(SEED_KEY) || "haneoka";
    const own = read<{ seed: string; season: { id: string } | null }>(SEED_CSS_KEY);
    if (own?.seed === root.dataset.seed && own.season) root.dataset.season = own.season.id;
  } else return;
  syncThemeColor();
  window.dispatchEvent(new CustomEvent(SEED_EVENT, { detail: root.dataset.seed }));
}
