import { authClient } from "~/lib/auth-client";

export type AuthState = "anonymous" | "authenticated" | "error" | "pending";

const AUTH_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000] as const;
let authRetryAttempt = 0;
let authRetryTimer: ReturnType<typeof setTimeout> | null = null;

export interface AuthDisplayIdentity {
  avatarSeed: string;
  avatarUrl: string | null;
  name: string;
  ownerUserId: string;
}

export const useAuth = () => {
  const session = authClient.useSession();
  const user = computed(() => session.value.data?.user ?? null);
  const { clear: clearIdentityCache, identity: cachedIdentity, remember: rememberIdentity } = useIdentityCache();
  const state = computed<AuthState>(() => {
    // Better Auth represents a confirmed signed-out state as a successful
    // 200 response with null data. Any error status, including 401, is still
    // an error path and must not be mistaken for an authoritative sign-out.
    if (session.value.error) return "error";
    if (user.value) return "authenticated";
    if (session.value.isPending || session.value.isRefetching) return "pending";
    return "anonymous";
  });

  watch(
    () => [Boolean(session.value.error), session.value.isPending, session.value.isRefetching] as const,
    ([hasError, isPending, isRefetching]) => {
      if (!import.meta.client) return;
      if (isPending || isRefetching) {
        if (authRetryTimer) clearTimeout(authRetryTimer);
        authRetryTimer = null;
        return;
      }
      if (!hasError) {
        if (authRetryTimer) clearTimeout(authRetryTimer);
        authRetryTimer = null;
        authRetryAttempt = 0;
        return;
      }
      if (authRetryTimer) return;
      const delay = AUTH_RETRY_DELAYS_MS[Math.min(authRetryAttempt, AUTH_RETRY_DELAYS_MS.length - 1)] ?? 60_000;
      authRetryTimer = setTimeout(() => {
        authRetryTimer = null;
        authRetryAttempt += 1;
        if (navigator.onLine) void session.value.refetch();
      }, delay);
    },
    { immediate: true },
  );

  watch(
    () => {
      const current = user.value;
      return current ? ([current.id, current.name, current.image || null] as const) : null;
    },
    (current) => {
      if (!current) return;
      rememberIdentity(current[0], { sessionImage: current[2], sessionName: current[1] });
    },
    { immediate: true },
  );

  watch(
    state,
    (value) => {
      if (value === "anonymous") clearIdentityCache();
    },
    { immediate: true },
  );

  const displayIdentity = computed<AuthDisplayIdentity | null>(() => {
    const current = user.value;
    if (current) {
      const cached = cachedIdentity.value?.ownerUserId === current.id ? cachedIdentity.value : null;
      return {
        avatarSeed: current.id,
        avatarUrl: cached?.avatarUrl || current.image || cached?.sessionImage || null,
        name: cached?.displayName || cached?.accountName || current.name || cached?.sessionName || "?",
        ownerUserId: current.id,
      };
    }
    if ((state.value === "pending" || state.value === "error") && cachedIdentity.value) {
      return {
        avatarSeed: cachedIdentity.value.ownerUserId,
        avatarUrl: cachedIdentity.value.avatarUrl || cachedIdentity.value.sessionImage,
        name:
          cachedIdentity.value.displayName ||
          cachedIdentity.value.accountName ||
          cachedIdentity.value.sessionName ||
          "?",
        ownerUserId: cachedIdentity.value.ownerUserId,
      };
    }
    return null;
  });

  return {
    authClient,
    cachedIdentity,
    clearIdentityCache,
    displayIdentity,
    session,
    state,
    user,
    // Existing consumers treat this as "authentication is not conclusively anonymous".
    isPending: computed(() => state.value === "pending" || state.value === "error"),
    refetch: session.value.refetch,
  };
};
