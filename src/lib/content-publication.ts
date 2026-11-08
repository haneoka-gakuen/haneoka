import { CONTENT_SOURCE_IDS } from "./content-access-state";
type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

export function withContentSource<T extends Row>(value: T, server: string): T {
  return server === "jp" || server === "intl" || !CONTENT_SOURCE_IDS.includes(server)
    ? value
    : { ...value, __unreleasedSource: true };
}

export function contentPublished(value: unknown, now = Date.now()): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const row = value as Row;
  if (row.__unreleasedSource === true || row.__publicationPending === true) return false;
  const time = row.publicStartAt ?? row.releasedAt ?? row.publishedAt ?? row.releaseAt ?? row.startAt;
  const first = Array.isArray(time) ? time.find((entry) => Number(entry) > 0) : time;
  const timestamp = typeof first === "string" && !Number.isFinite(Number(first)) ? Date.parse(first) : Number(first);
  const event = Number(row.eventPublishedAt);
  return (
    (!(timestamp > now) || (event > 0 && event <= now)) &&
    (!row.catalogMetadata || contentPublished(row.catalogMetadata, now))
  );
}

export function publicationFields(value: Row): Row {
  return Object.fromEntries(
    [
      "publicStartAt",
      "releasedAt",
      "publishedAt",
      "releaseAt",
      "startAt",
      "eventPublishedAt",
      "catalogMetadata",
      "__unreleasedSource",
      "__publicationPending",
    ].flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  );
}

export function withEventStoryVisibility<T extends Row>(item: T, catalog: unknown, server: string): T {
  const story = record(item.story);
  if (!Object.keys(story).length) return item;
  const document = record(catalog),
    index = record(document.episodes),
    chapters = record(document.chapters),
    starts = eventStoryStarts(document),
    eventStart = Number(Array.isArray(item.startAt) ? item.startAt[0] : item.startAt);
  const source = story.episodes;
  const episodes = (Array.isArray(source) ? source : Object.values(record(source))).map((value) => {
    const episode = record(value),
      id = String(episode.storyId ?? episode.storyKey);
    const full = record(index[id]),
      chapter = record(chapters[String(episode.chapterId ?? story.chapterId)]);
    const publishedAt = full.publishedAt ?? episode.publishedAt ?? chapter.publishedAt ?? chapter.startAt;
    const eventPublishedAt =
      full.eventPublishedAt ??
      starts.get(String(episode.chapterId ?? story.chapterId)) ??
      (eventStart > 0 ? eventStart : undefined);
    return withContentSource(
      {
        ...episode,
        ...(publishedAt === undefined ? { __publicationPending: true } : { publishedAt }),
        ...(eventPublishedAt === undefined ? {} : { eventPublishedAt }),
      },
      server,
    );
  });
  return { ...item, story: { ...story, episodes } };
}

/**
 * An event's story opens with the event; its chapter's own start is when it
 * joins the story archive afterwards. Episodes and chapters of an event take
 * the event's start as `eventPublishedAt`.
 */
export function eventStoryStarts(document: unknown): Map<string, number> {
  const starts = new Map<string, number>();
  const events = record(document).storyEvents;
  for (const value of Array.isArray(events) ? events : Object.values(record(events))) {
    const event = record(value),
      start = Array.isArray(event.startAt) ? Number(event.startAt[0]) : Number(event.startAt);
    if (start > 0 && event.chapterId !== undefined) starts.set(String(event.chapterId), start);
  }
  return starts;
}

export function withEventStart<T extends Row>(row: T, starts: Map<string, number>): T {
  const start = starts.get(String(row.chapterId));
  return start && row.eventPublishedAt === undefined ? { ...row, eventPublishedAt: start } : row;
}
