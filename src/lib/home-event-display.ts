// L3 — GEB
// Input: Native event metadata and its resolved bonus targets.
// Output: Source-preserving home artwork, story and complete band, character and attribute identities.
// Pos: [Map](L2-2.md); compact home event projection.
// Effects/Dependencies: Pure projection; the shared bonus summary contains presentation identities only.
type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value : Object.values(object(value))).map(object);
const pick = (row: Row, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));

/** Compact home artwork/bonus projection retains native identity and its selected source's story. */
export function homeEventDisplay(row: Row): Row {
  const raw = object(row.raw);
  return {
    ...pick(row, [
      "id",
      "kind",
      "sourceTable",
      "sourceTables",
      "title",
      "image",
      "backgroundImage",
      "logo",
      "startAt",
      "endAt",
      "eventType",
    ]),
    ...(raw._id === undefined ? {} : { raw: { _id: raw._id } }),
    ...(row.homeStoryId !== undefined || row.story !== undefined
      ? { homeStoryId: row.homeStoryId ?? String(rows(object(row.story).episodes)[0]?.storyKey || "") }
      : {}),
    ...homeEventBonuses(row),
  };
}

/** Only the target identities that appear on the event spotlight. */
export function homeEventBonuses(row: Row): Row {
  if (row.effects === undefined) return {};
  return {
    effects: rows(row.effects).map((effect) => ({
      targets: Object.fromEntries(
        Object.entries(object(effect.targets))
          .filter(([kind]) => kind === "band" || kind === "character" || kind === "attribute")
          .map(([kind, value]) => {
            const target = object(value);
            const native = object(effect.raw);
            return [
              kind,
              {
                ...pick(target, ["kind", "resourceId", "bandId", "characterId", "cardType", "name", "image", "icon"]),
                homeTargetKind: kind,
                bandId:
                  kind === "band" ? Number(native._bandId ?? native._bandID ?? target.bandId ?? 0) : target.bandId,
                characterId:
                  kind === "character" ? Number(native._characterId ?? target.characterId ?? target.resourceId ?? 0) : target.characterId,
                cardType:
                  kind === "attribute"
                    ? Number(effect.cardType ?? native._cardType ?? target.cardType ?? 0)
                    : target.cardType,
              },
            ];
          }),
      ),
    })),
  };
}
