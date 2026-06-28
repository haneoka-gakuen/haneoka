import { createAuthClient } from "better-auth/vue";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  fetchOptions: {
    // Session state must never be satisfied by a stale anonymous response
    // retained by the browser or an intermediary.
    cache: "no-store",
  },
  sessionOptions: {
    // A hard load already validates the session. Avoid refetching on every
    // tab focus while still refreshing long-lived open tabs periodically.
    refetchInterval: 60 * 60 * 6,
    refetchOnWindowFocus: false,
    refetchWhenOffline: false,
  },
});
