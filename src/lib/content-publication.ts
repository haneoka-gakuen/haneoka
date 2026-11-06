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
    chapters = record(document.chapters);
  const source = story.episodes;
  const episodes = (Array.isArray(source) ? source : Object.values(record(source))).map((value) => {
    const episode = record(value),
      id = String(episode.storyId ?? episode.storyKey);
    const full = record(index[id]),
      chapter = record(chapters[String(episode.chapterId ?? story.chapterId)]);
    const publishedAt = full.publishedAt ?? episode.publishedAt ?? chapter.publishedAt ?? chapter.startAt;
    return withContentSource(
      { ...episode, ...(publishedAt === undefined ? { __publicationPending: true } : { publishedAt }) },
      server,
    );
  });
  return { ...item, story: { ...story, episodes } };
}
