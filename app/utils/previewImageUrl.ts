/**
 * Give a rendered model preview a content/policy-specific browser cache key.
 *
 * Release media paths intentionally stay stable while a release pointer moves.
 * A preview policy change can therefore replace a PNG at the same path; without
 * this query component browsers may retain the previous render for a week.
 */
export const versionedPreviewImageUrl = (value: unknown, version: unknown): string => {
  const url = String(value || "").trim();
  const token = String(version || "").trim();
  if (!url || !token) return url;

  const fragmentIndex = url.indexOf("#");
  const resource = fragmentIndex >= 0 ? url.slice(0, fragmentIndex) : url;
  const fragment = fragmentIndex >= 0 ? url.slice(fragmentIndex) : "";
  const separator = resource.includes("?") ? "&" : "?";
  return `${resource}${separator}preview=${encodeURIComponent(token)}${fragment}`;
};
