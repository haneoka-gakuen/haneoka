import { isBestdoriServer, type BestdoriServer } from "@haneoka/bestdori";

/** A configured Our Notes resource-release slug, such as `jp-cbt` or `jp`. */
export type OurNotesReleaseId = string;
export type BestdoriRegion = BestdoriServer;

/** A selectable Our Notes release returned by the release registry. */
export interface OurNotesRelease {
  readonly id: OurNotesReleaseId;
  readonly displayName: string;
  readonly region: string;
}

/**
 * A namespaced origin for content that can appear in a catalog or audio queue.
 *
 * `releaseId: "jp"` and `region: "jp"` deliberately live in different
 * variants: the former identifies an Our Notes release; the latter identifies
 * Garupa data published through Bestdori. They can never be confused by a
 * route, cache key, queue entry, or fallback rule.
 */
export type ContentOrigin =
  | { readonly game: "our-notes"; readonly provider: "release"; readonly releaseId: OurNotesReleaseId }
  | { readonly game: "garupa"; readonly provider: "bestdori"; readonly region: BestdoriRegion }
  | { readonly game: "community"; readonly provider: "user-upload" };

export type CatalogContentOrigin = Exclude<ContentOrigin, { readonly provider: "user-upload" }>;
export type PlayableContentOrigin = CatalogContentOrigin | Extract<ContentOrigin, { provider: "user-upload" }>;
/** The Our Notes release namespace used by the native runtime renderer. */
export type OurNotesReleaseOrigin = Extract<ContentOrigin, { readonly provider: "release" }>;

/** Garupa Master only defines playlists; it is never a playable source. */
export interface GarupaMasterOrigin {
  readonly game: "garupa";
  readonly provider: "garupa-master";
  readonly region: "jp";
}

export const ourNotesReleaseOrigin = (
  releaseId: OurNotesReleaseId,
): Extract<ContentOrigin, { provider: "release" }> => ({
  game: "our-notes",
  provider: "release",
  releaseId: String(releaseId).trim(),
});

export const bestdoriOrigin = (region: BestdoriRegion = "jp"): Extract<ContentOrigin, { provider: "bestdori" }> => ({
  game: "garupa",
  provider: "bestdori",
  region,
});

export const userUploadOrigin = (): Extract<ContentOrigin, { provider: "user-upload" }> => ({
  game: "community",
  provider: "user-upload",
});

export const garupaMasterOrigin = (): GarupaMasterOrigin => ({
  game: "garupa",
  provider: "garupa-master",
  region: "jp",
});

export const isOurNotesReleaseOrigin = (
  origin: ContentOrigin | null | undefined,
): origin is Extract<ContentOrigin, { provider: "release" }> =>
  origin?.game === "our-notes" && origin.provider === "release";

export const isBestdoriOrigin = (
  origin: ContentOrigin | null | undefined,
): origin is Extract<ContentOrigin, { provider: "bestdori" }> =>
  origin?.game === "garupa" && origin.provider === "bestdori";

export const contentOriginKey = (origin: ContentOrigin): string => {
  if (origin.provider === "release") return `our-notes:release:${origin.releaseId}`;
  if (origin.provider === "bestdori") return `garupa:bestdori:${origin.region}`;
  return "community:user-upload";
};

/** A compact, unambiguous label for provenance in UI and exported metadata. */
export const contentOriginLabel = (origin: ContentOrigin): string => {
  if (origin.provider === "release") return `Our Notes · ${origin.releaseId}`;
  if (origin.provider === "bestdori") return `Bestdori · ${origin.region.toLocaleUpperCase()}`;
  return "Community upload";
};

export const sameContentOrigin = (left: ContentOrigin, right: ContentOrigin): boolean =>
  contentOriginKey(left) === contentOriginKey(right);

export const isCatalogContentOrigin = (value: unknown): value is CatalogContentOrigin => {
  if (!value || typeof value !== "object") return false;
  const origin = value as Partial<ContentOrigin>;
  if (origin.game === "our-notes" && origin.provider === "release")
    return typeof origin.releaseId === "string" && Boolean(origin.releaseId.trim());
  return origin.game === "garupa" && origin.provider === "bestdori" && isBestdoriServer(origin.region);
};

/**
 * Resolve the Our Notes release whose runtime artwork should render a piece
 * of catalog content.
 *
 * Garupa/Bestdori data has no Our Notes runtime namespace. Its caller must
 * therefore supply an explicit renderer fallback release (normally the
 * user's selected release); this does not change or disguise the content's
 * actual origin.
 */
export const runtimeReleaseForCatalogOrigin = (
  origin: CatalogContentOrigin | null | undefined,
  rendererFallbackRelease: OurNotesReleaseId,
): OurNotesReleaseOrigin => (isOurNotesReleaseOrigin(origin) ? origin : ourNotesReleaseOrigin(rendererFallbackRelease));

/** Preferred release first, followed by configured release-only fallbacks. */
export const releaseFallbackOrder = (
  preferred: OurNotesReleaseId,
  available: readonly OurNotesReleaseId[],
): Extract<ContentOrigin, { provider: "release" }>[] =>
  [...new Set([preferred, ...available].map((value) => String(value).trim()).filter(Boolean))].map(
    ourNotesReleaseOrigin,
  );
