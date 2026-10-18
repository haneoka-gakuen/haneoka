/** The deck the song analysis and song pages score charts with, kept in the URL and remembered per viewer. */
import type { DeckSlot } from "./chart-rates";

export interface Deck {
  power: number;
  slots: DeckSlot[];
  /** Target score rank (3 C … 7 SS). */
  rank: number;
  /** Gekisou room size. */
  room: number;
  /** Great share in percent. */
  great: number;
  /** Seconds between plays. */
  overhead: number;
  /** 0 is the latest event that has started. */
  event: number;
  boosts: number;
  pointBonus: number;
  itemBonus: number;
}
export const DEFAULT_DECK: Deck = {
  power: 1000000,
  slots: Array.from({ length: 5 }, () => ({ score: 100, perfect: 0, extensionMs: 0 })),
  rank: 7,
  room: 5,
  great: 0,
  overhead: 30,
  event: 0,
  boosts: 0,
  pointBonus: 0,
  itemBonus: 0,
};
const STORAGE_KEY = "haneoka.deck";
const slotText = (slot: DeckSlot) => `${slot.score}:${slot.perfect}:${slot.extensionMs}`;
/** `score:perfect:extensionMs` per member; a plain percentage is a score skill without extension. */
function parseSlots(value: string | null): DeckSlot[] | null {
  const slots = (value || "").split(",").map((part) => {
    const [score, perfect = 0, extension = 0] = part.split(":").map(Number);
    return { score: score!, perfect: perfect!, extensionMs: extension! };
  });
  return slots.length === 5 &&
    slots.every((slot) => [slot.score, slot.perfect, slot.extensionMs].every((v) => Number.isFinite(v) && v >= 0))
    ? slots
    : null;
}
export function parseDeck(params: URLSearchParams, fallback: Deck = DEFAULT_DECK): Deck {
  const whole = (key: string, low: number, high: number, value: number) => {
    const parsed = Math.round(Number(params.get(key)));
    return params.has(key) && Number.isFinite(parsed) ? Math.min(high, Math.max(low, parsed)) : value;
  };
  return {
    power: whole("deckPower", 1, 99999999, fallback.power),
    slots: parseSlots(params.get("deckSlots")) ?? parseSlots(params.get("deckSkills")) ?? fallback.slots,
    rank: whole("deckRank", 3, 7, fallback.rank),
    room: whole("deckRoom", 1, 5, fallback.room),
    great: whole("deckGreat", 0, 100, fallback.great),
    overhead: whole("deckOverhead", 0, 600, fallback.overhead),
    event: whole("deckEvent", 0, 99999, fallback.event),
    boosts: whole("deckBoosts", 0, 10, fallback.boosts),
    pointBonus: whole("deckPointBonus", 0, 100000, fallback.pointBonus),
    itemBonus: whole("deckItemBonus", 0, 100000, fallback.itemBonus),
  };
}
/** URL parameters of a deck, defaults left out. */
export function deckParams(deck: Deck): [string, string | null][] {
  const value = (key: keyof Deck, name: string): [string, string | null] => [
    name,
    deck[key] === DEFAULT_DECK[key] ? null : String(deck[key]),
  ];
  const slots = deck.slots.map(slotText).join(",");
  return [
    value("power", "deckPower"),
    ["deckSlots", slots === DEFAULT_DECK.slots.map(slotText).join(",") ? null : slots],
    ["deckSkills", null],
    value("rank", "deckRank"),
    value("room", "deckRoom"),
    value("great", "deckGreat"),
    value("overhead", "deckOverhead"),
    value("event", "deckEvent"),
    value("boosts", "deckBoosts"),
    value("pointBonus", "deckPointBonus"),
    value("itemBonus", "deckItemBonus"),
  ];
}
export function rememberedDeck(): Deck {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? parseDeck(new URLSearchParams(stored)) : DEFAULT_DECK;
  } catch {
    return DEFAULT_DECK;
  }
}
export function rememberDeck(deck: Deck): void {
  const params = new URLSearchParams();
  for (const [key, value] of deckParams(deck)) if (value !== null) params.set(key, value);
  try {
    localStorage.setItem(STORAGE_KEY, params.toString());
  } catch {
    // The deck stays in this page's URL.
  }
}
