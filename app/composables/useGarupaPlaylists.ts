import type { GarupaPlaylistCatalog } from "~/types/playlists";

export const useGarupaPlaylists = () => {
  const config = useRuntimeConfig();
  const url = computed(() => `${String(config.public.apiBase || "/api/v1").replace(/\/+$/u, "")}/garupa/playlists`);

  return useAsyncData<GarupaPlaylistCatalog>("garupa:playlists", () => $fetch<GarupaPlaylistCatalog>(url.value), {
    deep: false,
    server: false,
    watch: [url],
  });
};
