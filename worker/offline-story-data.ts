// L3 — GEB
// Input: Published provider scenarios and their resolved Live2D rows.
// Output: Portable Vega story data for the App's download planner.
// Pos: [Map](L2.md); used by the Bestdori and SEKAI read APIs.
// Effects/Dependencies: Pure projection with stable model ordering.
type RecordValue = Record<string, unknown>;

export function storyModelIds(story: RecordValue): string[] {
  const assets = story.assets as RecordValue | undefined;
  const rows = Array.isArray(assets?.live2d) ? assets.live2d as RecordValue[] : [];
  return [...new Set(rows.map((row) => String(row.live2dKey || "")).filter(Boolean))];
}

export function offlineProviderStory(story: RecordValue, models: RecordValue, characters: unknown[] = []) {
  const items = models.items as RecordValue | undefined;
  return {
    schema: "haneoka-portable-story-v1",
    story,
    live2d: storyModelIds(story).map((id) => ({ id, ...(items?.[id] as RecordValue | undefined) })),
    characters,
  };
}

export function offlineProviderCatalog(rows: RecordValue) {
  return Object.values(rows).flatMap((raw) => {
    const row = raw as RecordValue;
    const title = row.title || row.caption || row.chapterName || row.eventName || row.storyId;
    const thumbnail = [row.episodeImage, row.thumbnail, row.image].find((value) => typeof value === "string");
    return typeof row.storyId === "string" ? [{
      id: row.storyId,
      title,
      group: row.chapterName || row.eventName || null,
      groupId: String(row.chapterKey || row.chapterId || row.eventId || ""),
      thumbnail: thumbnail || null,
    }] : [];
  });
}
