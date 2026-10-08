type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value : Object.values(object(value))).map(object);
const pick = (row: Row, keys: string[]) => Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));

/** Compact home artwork/bonus projection retains native identity and its selected source's story. */
export function homeEventDisplay(row: Row): Row {
  const raw = object(row.raw);
  return {
    ...pick(row, ["id", "kind", "sourceTable", "sourceTables", "title", "image", "backgroundImage", "logo", "startAt", "endAt", "eventType"]),
    ...(raw._id === undefined ? {} : { raw: { _id: raw._id } }),
    homeStoryId: row.homeStoryId ?? String(rows(object(row.story).episodes)[0]?.storyKey || ""),
    effects: rows(row.effects).map((effect) => ({ targets: Object.fromEntries(
      Object.entries(object(effect.targets)).map(([kind, value]) => {
        const target = object(value), native = object(effect.raw);
        return [kind, {
          ...pick(target, ["kind", "resourceId", "bandId", "cardType", "name", "image", "icon"]),
          homeTargetKind: kind,
          bandId: kind === "band" ? Number(native._bandId ?? native._bandID ?? target.bandId ?? 0) : target.bandId,
          cardType: kind === "attribute" ? Number(effect.cardType ?? native._cardType ?? target.cardType ?? 0) : target.cardType,
        }];
      }),
    ) })),
  };
}
