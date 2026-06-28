type StoryRuntimeRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is StoryRuntimeRecord =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const cloneRuntimeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneRuntimeValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneRuntimeValue(entry)]));
};

const mergeRuntimeRecords = (defaults: StoryRuntimeRecord, authored: StoryRuntimeRecord): StoryRuntimeRecord => {
  const merged = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, cloneRuntimeValue(value)]));
  for (const [key, authoredValue] of Object.entries(authored)) {
    if (authoredValue === undefined) continue;
    const defaultValue = defaults[key];
    merged[key] =
      isRecord(defaultValue) && isRecord(authoredValue)
        ? mergeRuntimeRecords(defaultValue, authoredValue)
        : cloneRuntimeValue(authoredValue);
  }
  return merged;
};

/** Merge host defaults with story-authored runtime configuration without mutating either input. */
export const mergeStoryRuntime = (defaults: unknown, authored: unknown): StoryRuntimeRecord =>
  mergeRuntimeRecords(isRecord(defaults) ? defaults : {}, isRecord(authored) ? authored : {});
