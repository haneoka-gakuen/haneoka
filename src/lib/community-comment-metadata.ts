/** Public author/location fields shared by canonical community comments. */
export interface CommunityCommentAuthor {
  authorName?: string | null;
  author?: { displayName?: string | null } | null;
}
export function communityCommentName(comment: CommunityCommentAuthor, fallback: string): string {
  return comment.author?.displayName || comment.authorName || fallback;
}
const regions = new Map<string, Intl.DisplayNames>();
/** Only the posted public country snapshot is displayed; absent history stays absent. */
export function communityCommentLocation(value: unknown, locale: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const countryCode = String((value as { countryCode?: unknown }).countryCode || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(countryCode) || countryCode === "XX") return "";
  try {
    let names = regions.get(locale);
    if (!names) {
      names = new Intl.DisplayNames([locale], { type: "region" });
      regions.set(locale, names);
      if (regions.size > 8) regions.delete(regions.keys().next().value!);
    }
    const country = names.of(countryCode) || "";
    return country === countryCode ? "" : country;
  } catch { return ""; }
}
