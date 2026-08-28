import { ourNotesReleaseOrigin } from "~/features/catalog/contentSource";
import type { AnonTokyoDocument } from "~/types/anonTokyo";

/** The Anon Tokyo document is always pinned to the selected release server. */
export const useAnonTokyoCatalog = () => {
  const { releaseServer } = useReleaseServer();
  const origin = computed(() => ourNotesReleaseOrigin(releaseServer.value));
  const request = useCatalogDocument<AnonTokyoDocument>("anon-tokyo", origin);
  return { ...request, origin };
};
