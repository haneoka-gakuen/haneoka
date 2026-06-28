import type { CommunityNotificationListResponse } from "~/types/community";

const UNREAD_CACHE_TTL_MS = 5 * 60 * 1_000;

export const useCommunityUnread = () => {
  const count = useState<number>("community-unread-count", () => 0);
  const refreshing = useState<boolean>("community-unread-refreshing", () => false);
  const lastRefreshedAt = useState<number>("community-unread-refreshed-at", () => 0);

  const refresh = async (options: { force?: boolean } = {}) => {
    if (refreshing.value) return;
    if (!options.force && Date.now() - lastRefreshedAt.value < UNREAD_CACHE_TTL_MS) return;
    refreshing.value = true;
    try {
      const response = await $fetch<CommunityNotificationListResponse>("/api/v1/community/notifications", {
        query: { countOnly: true },
      });
      count.value = response.unreadCount;
      lastRefreshedAt.value = Date.now();
    } catch {
      // Keep the last confirmed count across transient network failures.
    } finally {
      refreshing.value = false;
    }
  };

  const setCount = (value: number) => {
    count.value = Math.max(0, Math.trunc(value));
    lastRefreshedAt.value = Date.now();
  };

  const markOneRead = () => {
    count.value = Math.max(0, count.value - 1);
    lastRefreshedAt.value = Date.now();
  };

  const reset = () => {
    count.value = 0;
    lastRefreshedAt.value = 0;
  };

  return { count: readonly(count), refresh, reset, setCount, markOneRead };
};
