// L3 — GEB
// Input: Entity artwork, page language and the build's immutable release declarations.
// Output: An existing localized social image or the original artwork URL.
// Pos: [Map](L2-2.md); build-time entity artwork selection for social metadata.
// Effects/Dependencies: Reuses captured release manifests; never probes candidate image URLs.
import type { Locale } from "../i18n/locales";
import { localizedImageCandidates } from "../lib/localized-image";
import { isSiteOrigin } from "../lib/site-origin";
import { fetchStaticReleaseEntry, staticCatalogRelease } from "../lib/static-catalog-source";

export async function localizedSocialImage(
  source: string | undefined,
  locale: Locale,
  origin: string,
): Promise<string | undefined> {
  if (!source?.trim()) return undefined;
  const original = new URL(source.trim(), origin);
  if (original.origin !== new URL(origin).origin && !isSiteOrigin(original.origin)) return original.href;
  const match = /^\/assets\/(jp|intl)\/(?:Assets|Packages)\//u.exec(original.pathname);
  if (!match) return original.href;
  const base = original.pathname.replace(/\((?:en|ko|zh-Hans|zh-Hant)\)(?=\.[^./]+$)/u, "");
  const candidates = [...new Set([...localizedImageCandidates(base, locale), original.pathname])];
  if (candidates.length === 1 && candidates[0] === original.pathname) return original.href;
  const server = match[1]!;
  const pin = await staticCatalogRelease(server);
  const requested = original.searchParams.get("release");
  if (requested && requested !== pin.releaseId) return original.href;
  for (const candidate of candidates) {
    let relative: string;
    try {
      relative = `assets/${decodeURIComponent(candidate.slice(`/assets/${server}/`.length))}`;
    } catch {
      return original.href;
    }
    if (!(await fetchStaticReleaseEntry(relative, server, pin))) continue;
    const selected = new URL(original);
    selected.pathname = candidate;
    selected.searchParams.set("release", pin.releaseId);
    return selected.href;
  }
  return original.href;
}
