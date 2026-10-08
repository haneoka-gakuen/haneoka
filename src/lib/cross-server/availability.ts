import type { OfficialCatalogServer } from "./catalog";

/** Production availability takes precedence over preview-source presence. */
export function exclusiveCatalogServer(availability: readonly OfficialCatalogServer[]): OfficialCatalogServer | undefined {
  const jp = availability.includes("jp"), intl = availability.includes("intl");
  if (jp && intl) return undefined;
  if (jp) return "jp";
  if (intl) return "intl";
  return availability.includes("intl-test") ? "intl-test" : undefined;
}
