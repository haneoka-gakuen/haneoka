type Row = Record<string, unknown>;
export type EventSongReleases = Record<string, number>;
export type ChallengeEvent = { id: string; startAt: number };
export type EventSongAvailability = {
  releases: EventSongReleases;
  challengeEvents: Record<string, ChallengeEvent[]>;
};
export const EMPTY_EVENT_SONG_AVAILABILITY: EventSongAvailability = { releases: {}, challengeEvents: {} };

const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const instant = (value: unknown): number => {
  if (Array.isArray(value)) return value.map(instant).find((at) => at > 0) ?? 0;
  if (!value) return 0;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const text = String(value);
  const native = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(text);
  const at = native
    ? Date.UTC(
        Number(native[1]),
        Number(native[2]) - 1,
        Number(native[3]),
        Number(native[4]) - 9,
        Number(native[5]),
        Number(native[6] || 0),
      )
    : Date.parse(text);
  return Number.isFinite(at) ? at : 0;
};

export const needsEventSongRelease = (song: Row): boolean =>
  song.eventPublishedAt === undefined && instant(song.publishedAt) > Date.now();

export const needsEventSongAvailability = (song: Row): boolean =>
  song.challengeEvents === undefined && instant(song.publishedAt) > Date.now();

export function eventSongAvailability(events: unknown, challenges: unknown): EventSongAvailability {
  const eventRows = record(events)._allData ?? record(events).entries ?? events;
  const entries = Array.isArray(eventRows)
    ? Object.fromEntries(eventRows.map((row) => [String(record(row).id ?? record(row)._id), record(row)]))
    : record(eventRows);
  const challengeRows = Array.isArray(challenges) ? challenges : record(challenges)._allData;
  const releases: EventSongReleases = {};
  const related = new Map<string, Map<string, ChallengeEvent>>();
  for (const challenge of Array.isArray(challengeRows) ? challengeRows : []) {
    const row = record(challenge);
    const eventId = String(row.eventId ?? row._eventId);
    const event = record(entries[eventId]);
    const start = instant(event.startAt ?? event._startAt),
      songId = row.liveMusicId ?? row._liveMusicId;
    if (!start || !songId) continue;
    const at = Math.max(start, instant(row.stratAt ?? row.startAt ?? row._stratAt ?? row._startAt));
    const id = String(songId);
    releases[id] = Math.min(releases[id] ?? Infinity, at);
    const linked = related.get(id) ?? new Map<string, ChallengeEvent>();
    linked.set(eventId, { id: eventId, startAt: start });
    related.set(id, linked);
  }
  const challengeEvents = Object.fromEntries([...related].map(([id, events]) => [id, [...events.values()]]));
  return { releases, challengeEvents };
}

export const eventSongReleases = (events: unknown, challenges: unknown): EventSongReleases =>
  eventSongAvailability(events, challenges).releases;

export function withEventSongAvailability<T extends Row>(song: T, context: EventSongAvailability): T {
  const id = String(song.musicId);
  const events = context.challengeEvents[id];
  const timed = withEventSongRelease(song, context.releases);
  return events && song.challengeEvents === undefined ? { ...timed, challengeEvents: events } : timed;
}

export function withEventSongRelease<T extends Row>(song: T, releases: EventSongReleases): T {
  const at = releases[String(song.musicId)];
  if (!at || song.eventPublishedAt === at) return song;
  const publishedAt = instant(song.publishedAt);
  return {
    ...song,
    eventPublishedAt: at,
    ...(Array.isArray(song.difficulty)
      ? {
          difficulty: song.difficulty.map((row: Row) =>
            instant(row.publishedAt) <= publishedAt ? { ...row, eventPublishedAt: at } : row,
          ),
        }
      : {}),
  };
}

export const withEventSongReleases = <T extends Row>(
  songs: Record<string, T>,
  releases: EventSongReleases,
): Record<string, T> =>
  Object.fromEntries(Object.entries(songs).map(([id, row]) => [id, withEventSongRelease(row, releases)]));

export const withEventSongsAvailability = <T extends Row>(
  songs: Record<string, T>,
  context: EventSongAvailability,
): Record<string, T> =>
  Object.fromEntries(Object.entries(songs).map(([id, row]) => [id, withEventSongAvailability(row, context)]));
