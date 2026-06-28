import type { LocationQueryRaw, RouteLocationRaw } from "vue-router";

export const useStoryWorkbenchSelection = (queryKey = "episode") => {
  const route = useRoute();
  const selectedStoryId = useRouteQueryText(queryKey);
  const storyLayer = useRouteQueryLayer(queryKey, { clearOnClose: ["rotation"] });

  const storyTo = (storyId: string): RouteLocationRaw => ({
    path: route.path,
    query: {
      ...(route.query as LocationQueryRaw),
      [queryKey]: storyId,
    },
  });

  const closeStory = () => {
    void storyLayer.close();
  };

  return { selectedStoryId, storyTo, closeStory };
};
