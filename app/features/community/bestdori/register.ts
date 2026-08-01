import { resolveBestdoriServer } from "@haneoka/altair-plugin-bestdori/source";

import { normalizeSongType } from "~/config/songTypes";
import { bestdoriOrigin } from "~/features/catalog/contentSource";
import { registerSongCatalogSource } from "~/features/catalog/songSources";
import { registerExternalResourceUrlPolicy } from "~/features/resources/sourcePolicies";
import { registerStoryCatalogSource } from "~/features/story/catalogSources";
import { isBestdoriRawResourceUrl } from "~/features/community/bestdori/resources";

const SOURCE_ID = "bestdori";

export const registerBestdoriCommunitySource = (): void => {
  registerSongCatalogSource({
    id: SOURCE_ID,
    resolveCatalogOrigin: ({ locale }) => bestdoriOrigin(resolveBestdoriServer({ locale })),
    titleKey: "communityPage.songsBestDori",
    domain: "community",
    maxDifficulty: 4,
    showMusicTypeFilter: false,
    showCategoryFilter: true,
    hideSonolus: false,
    bandFallbackIcon: "star",
    defaultSort: "release",
    categorySortKey: (song) => normalizeSongType(song.musicCategories),
    resolveChartUrl: (file) => file,
  });
  registerStoryCatalogSource({
    id: SOURCE_ID,
    live2dQuery: ({ story }) => {
      const server = story.sourceServer;
      return typeof server === "string" && server ? { server } : undefined;
    },
  });
  registerExternalResourceUrlPolicy({
    id: SOURCE_ID,
    accepts: isBestdoriRawResourceUrl,
  });
};
