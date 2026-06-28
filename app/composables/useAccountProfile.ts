import type { AccountProfile, AccountProfileResponse } from "~/types/account";

interface ActiveProfileRequest {
  controller: AbortController;
  promise: Promise<AccountProfile>;
  revision: number;
  userId: string;
}

let activeRequest: ActiveProfileRequest | null = null;
let requestRevision = 0;

export const useAccountProfile = () => {
  const { state: authState, user } = useAuth();
  const { remember: rememberIdentity } = useIdentityCache();
  const profile = useState<AccountProfile | null>("current-account-profile", () => null);
  const ownerUserId = useState<string | null>("current-account-profile-owner", () => null);
  const pending = useState<boolean>("current-account-profile-pending", () => false);

  const cancelActiveRequest = () => {
    requestRevision += 1;
    activeRequest?.controller.abort();
    activeRequest = null;
    pending.value = false;
  };

  const clear = () => {
    cancelActiveRequest();
    profile.value = null;
    ownerUserId.value = null;
  };

  const set = (value: AccountProfile) => {
    const userId = user.value?.id;
    if (!userId) return;
    cancelActiveRequest();
    profile.value = value;
    ownerUserId.value = userId;
    rememberIdentity(userId, {
      accountName: value.accountName,
      avatarUrl: value.avatarUrl,
      displayName: value.displayName,
    });
  };

  const load = async (options: { force?: boolean } = {}): Promise<AccountProfile | null> => {
    const userId = user.value?.id;
    if (!userId) {
      clear();
      return null;
    }
    if (!options.force && ownerUserId.value === userId && profile.value) return profile.value;

    if (options.force || activeRequest?.userId !== userId) {
      cancelActiveRequest();
      const controller = new AbortController();
      const revision = ++requestRevision;
      activeRequest = {
        controller,
        revision,
        userId,
        promise: $fetch<AccountProfileResponse>("/api/v1/account/profile", { signal: controller.signal }).then(
          (result) => result.profile,
        ),
      };
    }
    const request = activeRequest;
    if (!request) return null;
    pending.value = true;
    try {
      const value = await request.promise;
      if (request.revision !== requestRevision || user.value?.id !== request.userId) return null;
      profile.value = value;
      ownerUserId.value = request.userId;
      rememberIdentity(request.userId, {
        accountName: value.accountName,
        avatarUrl: value.avatarUrl,
        displayName: value.displayName,
      });
      return value;
    } catch (error) {
      if (request.revision !== requestRevision || user.value?.id !== request.userId) return null;
      throw error;
    } finally {
      if (activeRequest === request) activeRequest = null;
      pending.value = Boolean(activeRequest && activeRequest.userId === user.value?.id);
    }
  };

  watch(
    () => [user.value?.id || null, authState.value] as const,
    ([userId, state]) => {
      if (state === "error") return;
      if (!userId) {
        if (state === "anonymous") clear();
        return;
      }
      if (ownerUserId.value !== userId) {
        cancelActiveRequest();
        profile.value = null;
        ownerUserId.value = userId;
      }
      void load().catch(() => {
        // The session retry loop owns recovery. A profile read failure must
        // not become an unhandled rejection or erase the last known profile.
      });
    },
    { immediate: true },
  );

  return { clear, load, pending: readonly(pending), profile: readonly(profile), set };
};
