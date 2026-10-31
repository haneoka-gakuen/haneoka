/** Compact display-only slices from the Home loader's existing catalog pin. */
import type { HomeSeed } from "../lit/home-dashboard";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const rows = (value: unknown): RecordValue[] =>
  Array.isArray(value) ? value.filter(record) : record(value) ? Object.values(value).filter(record) : [];
const fields = (row: RecordValue, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
const text = (value: unknown, maximum = 400) => typeof value === "string"
  ? value.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum) : "";

export function compactHomeGacha(value: unknown, cards: unknown): RecordValue {
  const entries = rows(record(value) && value.entries !== undefined ? value.entries : value);
  const cardMap = new Map(rows(cards).map((card) => [Number(card.cardId), card]));
  return { entries: Object.fromEntries(entries.map((entry) => {
    const featured = rows(entry.featured).flatMap((prize) => {
      const card = cardMap.get(Number(prize.resourceId));
      const rarity = prize.rarity ?? card?.rarity;
      if (Number(prize.resourceType) !== 2 || Number(rarity) !== 20 || prize.pickup === false) return [];
      const characterId = prize.characterId ?? card?.characterId;
      const cardImages = record(card?.images) ? fields(card.images, ["thumbnail", "full", "background", "character"]) : {};
      return [{ ...fields(prize, ["resourceType", "resourceId"]), rarity,
        ...(typeof prize.image === "string" && prize.image ? { image: prize.image } : {}),
        ...(Object.keys(cardImages).length ? { cardImages } : {}),
        ...(typeof characterId === "number" && Number.isSafeInteger(characterId) && characterId > 0 ? { characterId } : {}) }];
    });
    return [String(entry.id), { ...fields(entry, ["id", "title", "image", "startAt", "endAt"]), featured }];
  })) };
}

export function homeFanInfo(value: unknown): NonNullable<HomeSeed["fanInfo"]> {
  if (!record(value) || value.schema !== "haneoka-calendar-lives-v1" || value.available !== true)
    return { status: "unavailable", entries: [] };
  const compact = record(value.fanInfo) ? value.fanInfo : undefined;
  const seen = new Set<string>();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const source = compact ? rows(compact.entries) : rows(value.events).filter((row) =>
    row.cancelled !== true && typeof row.endDateExclusive === "string" && row.endDateExclusive > today);
  const entries = source.flatMap((row) => {
    const title = text(row.title), href = typeof (row.href ?? row.sourceUrl) === "string" ? String(row.href ?? row.sourceUrl) : "";
    let url: URL;
    try { url = new URL(href); } catch { return []; }
    if (!title || url.protocol !== "https:" || !["bandori.fans", "www.bandori.fans"].includes(url.hostname) || url.username || url.password)
      return [];
    if (seen.has(url.href)) return [];
    seen.add(url.href);
    const place = record(row.venue) ? text(row.venue.name, 200) : text(row.venue, 200);
    const summary = text(row.summary || row.description) || [
      text(row.eventDate ?? row.startDate, 80), place,
    ].filter(Boolean).join(" / ");
    // Fetch/modified time is not the publisher's original publication time.
    const published = typeof row.sourcePublishedAt === "string" && /(?:Z|[+-]\d\d:\d\d)$/u.test(row.sourcePublishedAt)
      ? Date.parse(row.sourcePublishedAt) : typeof row.publishedAt === "number" ? row.publishedAt : NaN;
    const image = typeof row.image === "string" && /^\/images\/calendar-lives\/[a-f0-9]{64}\.png$/u.test(row.image)
      ? row.image : undefined;
    return [{ title, href: url.href, ...(summary ? { summary } : {}), ...(image ? { image } : {}),
      category: text(row.category || row.kind, 80),
      ...(typeof (row.eventDate ?? row.startDate) === "string" ? { eventDate: String(row.eventDate ?? row.startDate) } : {}),
      ...(typeof row.allDay === "boolean" ? { allDay: row.allDay } : {}),
      ...(typeof (row.eventStartAtMs ?? row.startAtMs) === "number" && Number.isFinite(row.eventStartAtMs ?? row.startAtMs)
        ? { eventStartAtMs: Number(row.eventStartAtMs ?? row.startAtMs) } : {}),
      ...(typeof (row.eventStartLocal ?? row.startLocal) === "string" ? { eventStartLocal: String(row.eventStartLocal ?? row.startLocal) } : {}),
      ...(place ? { venue: place } : {}),
      ...(Number.isFinite(published) && published > 0 ? { publishedAt: published } : {}) }];
  });
  return { status: entries.length ? "ready" : "empty", entries: entries.slice(0, 6) };
}
