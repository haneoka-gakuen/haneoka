export function localizedName(value: unknown): string {
  if (Array.isArray(value)) return String(value.find((entry) => entry) || "");
  return value == null ? "" : String(value);
}

/** Resolve a target-name collection whose entries may each be a locale-slot tuple. */
export function localizedNameEntries(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return entries
    .map(localizedName)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
