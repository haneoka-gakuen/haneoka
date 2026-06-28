<script setup lang="ts">
import {
  MaterialIcon,
  UiButton,
  UiCheckbox,
  UiFilePicker,
  UiFormLayout,
  UiIconButton,
  UiList,
  UiListItem,
  UiSegmentedControl,
  UiTextField,
  type UiFilePickerHandle,
  type UiSegmentOption,
} from "@haneoka/ui";

import { authClient } from "~/lib/auth-client";
import { authClientErrorMessage, authRequestErrorMessage } from "~/lib/auth-error";
import type { AccountProfileResponse } from "~/types/account";
import type { AuthPublicConfig, CommunityAppealCreateResponse, OAuthProvider } from "~/types/community";
import { isOAuthProvider, oauthProviderLabel } from "~/utils/oauth-provider";

type AccountMode = "signIn" | "signUp" | "forgotPassword" | "verifyEmail";
type AccountSection = "management" | "profile" | "security" | "sessions";
type AccountAction =
  | "auth"
  | "avatar"
  | "verification"
  | "passwordResetRequest"
  | "profile"
  | "profileAppeal"
  | "email"
  | "password"
  | "sessions"
  | "accounts"
  | "delete"
  | "signOut";

interface AccountSession {
  id: string;
  token: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

interface LinkedAccount {
  id: string;
  accountId: string;
  providerId: string;
  createdAt: Date | string;
}

const route = useRoute();
const { t, formatDate } = useLocale();
const { clearIdentityCache, displayIdentity, session, state: authState, user, refetch } = useAuth();
const {
  clear: clearAccountProfile,
  load: loadSharedAccountProfile,
  profile: accountProfile,
  set: setAccountProfile,
} = useAccountProfile();
const mode = ref<AccountMode>("signIn");
const activeSection = ref<AccountSection>("profile");
const email = ref("");
const password = ref("");
const legalAccepted = ref(false);
const verificationEmail = ref("");
const profileName = ref("");
const profileHandle = ref("");
const profileBio = ref("");
const profileAppealOpen = ref(false);
const profileAppealStatement = ref("");
const profileAppealError = ref("");
const profileAppealSubmitted = ref(false);
const newEmail = ref("");
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const deleteConfirmation = ref("");
const activeAction = ref<AccountAction | null>(null);
const errorMessage = ref("");
const notice = ref("");
const avatarFile = ref<File | null>(null);
const avatarPreviewUrl = ref<string | null>(null);
const avatarPicker = ref<UiFilePickerHandle>();
const turnstileToken = ref("");
const turnstile = ref<{ reset: () => void } | null>(null);
const sessions = ref<AccountSession[]>([]);
const accounts = ref<LinkedAccount[]>([]);
const securityDataLoading = ref(false);
const securityDataLoaded = ref(false);
const config = ref<AuthPublicConfig>({
  available: false,
  emailDeliveryEnabled: false,
  emailSignUpEnabled: false,
  providers: [],
  turnstileSiteKey: null,
});
const configLoaded = ref(false);
let securityRequestRevision = 0;
let renderedAccountUserId: string | null = null;
let profileFormOwnerUserId: string | null = null;
let securityDataErrorMessage = "";

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PROFILE_APPEAL_MAX_LENGTH = 2_000;
const TURNSTILE_ACTION_REGISTER = "account_register";
const TURNSTILE_ACTION_SIGN_IN = "account_sign_in";

const busy = computed(() => activeAction.value !== null);
const providers = computed(() =>
  config.value.providers.filter(
    (provider): provider is OAuthProvider =>
      provider === "discord" || provider === "github" || provider === "google" || provider === "twitter",
  ),
);
const linkedProviderIds = computed(() => new Set(accounts.value.map((account) => account.providerId)));
const availableLinkProviders = computed(() =>
  providers.value.filter((provider) => !linkedProviderIds.value.has(provider)),
);
const hasPasswordAccount = computed(() => linkedProviderIds.value.has("credential"));
const currentSessionToken = computed(() => session.value.data?.session.token || "");
const canDeleteAccount = computed(() => Boolean(user.value && deleteConfirmation.value === user.value.email));
const identityName = computed(
  () =>
    accountProfile.value?.displayName ||
    accountProfile.value?.accountName ||
    displayIdentity.value?.name ||
    user.value?.name ||
    "",
);
const avatarSource = computed(
  () =>
    avatarPreviewUrl.value ||
    accountProfile.value?.avatarUrl ||
    displayIdentity.value?.avatarUrl ||
    user.value?.image ||
    null,
);
const accountAvatarSeed = computed(() => accountProfile.value?.avatarSeed || displayIdentity.value?.avatarSeed || null);
const hasCurrentAvatar = computed(() => Boolean(accountProfile.value?.avatarUrl || user.value?.image));
const publicUid = computed(() => {
  const value = accountProfile.value?.publicUid;
  return value !== undefined && Number.isSafeInteger(value) ? String(value) : "—";
});
const publicProfilePath = computed(() =>
  accountProfile.value && Number.isSafeInteger(accountProfile.value.publicUid)
    ? `/community/users/${accountProfile.value.publicUid}`
    : "",
);
const profileRole = computed(() => {
  switch (accountProfile.value?.role) {
    case "admin":
      return t("accountPage.roleAdmin");
    case "moderator":
      return t("accountPage.roleModerator");
    case "member":
      return t("accountPage.roleMember");
    default:
      return "—";
  }
});
const profileStatus = computed(() => {
  switch (accountProfile.value?.profileStatus) {
    case "active":
      return t("accountPage.statusActive");
    case "suspended":
      return t("accountPage.statusSuspended");
    case "deleted":
      return t("accountPage.statusDeleted");
    default:
      return "—";
  }
});
const isAdmin = computed(() => accountProfile.value?.role === "admin");
const unchangedProfile = computed(() => {
  const saved =
    accountProfile.value?.candidateDisplayName || accountProfile.value?.accountName || user.value?.name || "";
  return (
    profileName.value.trim() === saved &&
    profileHandle.value.trim() === (accountProfile.value?.handle || "") &&
    profileBio.value.trim() === (accountProfile.value?.bio || "") &&
    accountProfile.value?.displayNameStatus !== "block"
  );
});
const profileAppealLength = computed(() => [...profileAppealStatement.value].length);
const canAppealProfileName = computed(
  () =>
    accountProfile.value?.displayNameStatus === "block" &&
    Boolean(accountProfile.value.candidateDisplayName) &&
    !profileAppealSubmitted.value,
);
const canSubmitProfileAppeal = computed(
  () =>
    canAppealProfileName.value &&
    Boolean(profileAppealStatement.value.trim()) &&
    profileAppealLength.value <= PROFILE_APPEAL_MAX_LENGTH &&
    activeAction.value === null,
);
const clearMessages = () => {
  errorMessage.value = "";
  notice.value = "";
};

const accountSectionItems = computed<Array<{ id: AccountSection; icon: string; label: string }>>(() => [
  { id: "profile", icon: "person", label: t("accountPage.profile") },
  { id: "security", icon: "verified_user", label: t("accountPage.security") },
  { id: "sessions", icon: "devices", label: t("accountPage.sessions") },
  { id: "management", icon: "settings", label: t("accountPage.accountManagement") },
]);

type CredentialMode = Extract<AccountMode, "signIn" | "signUp">;
const credentialMode = computed<CredentialMode>(() => (mode.value === "signUp" ? "signUp" : "signIn"));
const credentialModeOptions = computed<UiSegmentOption[]>(() => [
  { value: "signIn" as const, label: t("accountPage.signIn"), icon: "login", selectedIcon: "check" },
  ...(config.value.emailSignUpEnabled
    ? [{ value: "signUp" as const, label: t("accountPage.signUp"), icon: "person_add", selectedIcon: "check" }]
    : []),
]);
const selectCredentialMode = (value: string | number) => {
  if (value === "signIn" || value === "signUp") mode.value = value;
};

const copyPublicUid = async () => {
  if (publicUid.value === "—") return;
  clearMessages();
  try {
    await navigator.clipboard.writeText(publicUid.value);
    notice.value = t("accountPage.uidCopied");
  } catch {
    errorMessage.value = t("accountPage.uidCopyFailed");
  }
};

const actionErrorMessage = (error: unknown, fallback: string) =>
  authRequestErrorMessage(error, fallback, t("accountPage.requestTimedOut"));
const clientErrorMessage = (error: unknown, fallback: string) => authClientErrorMessage(error, t, fallback);

const loadConfig = async () => {
  try {
    config.value = await $fetch<AuthPublicConfig>("/api/v1/account/config");
  } catch {
    config.value = {
      available: false,
      emailDeliveryEnabled: false,
      emailSignUpEnabled: false,
      providers: [],
      turnstileSiteKey: null,
    };
  } finally {
    configLoaded.value = true;
  }
};

const loadSecurityData = async () => {
  const userId = user.value?.id;
  if (!userId) {
    securityRequestRevision += 1;
    securityDataLoading.value = false;
    return;
  }
  const requestRevision = ++securityRequestRevision;
  securityDataLoading.value = true;
  try {
    const [sessionResult, accountResult] = await Promise.all([authClient.listSessions(), authClient.listAccounts()]);
    if (requestRevision !== securityRequestRevision || user.value?.id !== userId) return;
    let nextErrorMessage = "";
    if (sessionResult.error) {
      nextErrorMessage = clientErrorMessage(sessionResult.error, t("accountPage.sessionRevokeFailed"));
    } else {
      sessions.value = sessionResult.data || [];
    }
    if (accountResult.error) {
      nextErrorMessage ||= clientErrorMessage(accountResult.error, t("accountPage.accountActionFailed"));
    } else {
      accounts.value = accountResult.data || [];
    }
    const previousErrorMessage = securityDataErrorMessage;
    securityDataErrorMessage = nextErrorMessage;
    if (nextErrorMessage) errorMessage.value = nextErrorMessage;
    else if (previousErrorMessage && errorMessage.value === previousErrorMessage) errorMessage.value = "";
  } catch (error) {
    if (requestRevision === securityRequestRevision && user.value?.id === userId) {
      securityDataErrorMessage = actionErrorMessage(error, t("accountPage.authFailed"));
      errorMessage.value = securityDataErrorMessage;
    }
  } finally {
    if (requestRevision === securityRequestRevision) {
      securityDataLoading.value = false;
      securityDataLoaded.value = true;
    }
  }
};

const loadAccountProfile = async (force = false) => {
  const userId = user.value?.id;
  if (!userId) return;
  try {
    const profile = await loadSharedAccountProfile({ force });
    if (!profile || user.value?.id !== userId) return;
    profileName.value = profile.candidateDisplayName || profile.accountName;
    profileHandle.value = profile.handle || "";
    profileBio.value = profile.bio || "";
    profileFormOwnerUserId = userId;
    profileAppealOpen.value = false;
    profileAppealStatement.value = "";
    profileAppealError.value = "";
    profileAppealSubmitted.value = false;
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.profileLoadFailed"));
  }
};

const openProfileAppeal = async () => {
  if (!canAppealProfileName.value) return;
  profileAppealError.value = "";
  profileAppealOpen.value = true;
  await nextTick();
  document.querySelector<HTMLElement>("#profile-appeal-statement")?.focus();
};

const closeProfileAppeal = () => {
  if (activeAction.value === "profileAppeal") return;
  profileAppealOpen.value = false;
  profileAppealStatement.value = "";
  profileAppealError.value = "";
};

const submitProfileAppeal = async () => {
  const userId = user.value?.id;
  const statement = profileAppealStatement.value.trim();
  if (!userId || !canSubmitProfileAppeal.value) return;

  clearMessages();
  profileAppealError.value = "";
  activeAction.value = "profileAppeal";
  try {
    const result = await $fetch<CommunityAppealCreateResponse>("/api/v1/community/appeals", {
      method: "POST",
      body: {
        entityKind: "profile-name",
        entityId: userId,
        statement,
      },
    });
    if (result.appeal.entityKind !== "profile-name" || result.appeal.entityId !== userId) {
      throw new Error(t("communityPage.appealFailed"));
    }
    profileAppealSubmitted.value = true;
    profileAppealOpen.value = false;
    profileAppealStatement.value = "";
  } catch (error) {
    profileAppealError.value = actionErrorMessage(error, t("communityPage.appealFailed"));
  } finally {
    activeAction.value = null;
  }
};

const captchaFetchOptions = () =>
  config.value.turnstileSiteKey
    ? {
        headers: {
          "x-captcha-response": turnstileToken.value,
        },
      }
    : undefined;

const requestAccountSetup = async (address: string) => {
  const fetchOptions = captchaFetchOptions();
  await $fetch<{ accepted: true }>("/api/v1/account/register", {
    method: "POST",
    body: { email: address },
    ...(fetchOptions ? { headers: fetchOptions.headers } : {}),
  });
};

const submitAuth = async () => {
  clearMessages();
  if (!legalAccepted.value) {
    errorMessage.value = t("accountPage.legalAgreementRequired");
    return;
  }
  if (config.value.turnstileSiteKey && !turnstileToken.value) {
    errorMessage.value = t("accountPage.completeChallenge");
    return;
  }
  activeAction.value = "auth";
  const normalizedEmail = email.value.trim();
  try {
    if (mode.value === "signUp") {
      await requestAccountSetup(normalizedEmail);
      verificationEmail.value = normalizedEmail;
      mode.value = "verifyEmail";
      notice.value = t("accountPage.verificationSent");
      return;
    }
    const result = await authClient.signIn.email({
      email: normalizedEmail,
      password: password.value,
      rememberMe: true,
      callbackURL: "/account",
      fetchOptions: captchaFetchOptions(),
    });
    if (result.error) {
      errorMessage.value = clientErrorMessage(result.error, t("accountPage.authFailed"));
      if (result.error.code === "EMAIL_NOT_VERIFIED") verificationEmail.value = normalizedEmail;
      return;
    }
    password.value = "";
    notice.value = t("accountPage.signedIn");
  } catch (error) {
    errorMessage.value =
      mode.value === "signUp"
        ? authClientErrorMessage(error, t, t("accountPage.authFailed"))
        : actionErrorMessage(error, t("accountPage.authFailed"));
  } finally {
    activeAction.value = null;
    turnstile.value?.reset();
  }
};

const sendVerification = async (address = user.value?.email || verificationEmail.value || email.value.trim()) => {
  clearMessages();
  if (!address) return;
  if (config.value.turnstileSiteKey && !turnstileToken.value) {
    errorMessage.value = t("accountPage.completeChallenge");
    return;
  }
  activeAction.value = "verification";
  try {
    await requestAccountSetup(address);
    verificationEmail.value = address;
    notice.value = t("accountPage.verificationSent");
  } catch (error) {
    errorMessage.value = authClientErrorMessage(error, t, t("accountPage.authFailed"));
  } finally {
    activeAction.value = null;
    turnstile.value?.reset();
  }
};

const requestPasswordReset = async () => {
  clearMessages();
  activeAction.value = "passwordResetRequest";
  try {
    const result = await authClient.requestPasswordReset({
      email: email.value.trim(),
      redirectTo: "/account/reset-password",
    });
    if (result.error) {
      errorMessage.value = clientErrorMessage(result.error, t("accountPage.authFailed"));
      return;
    }
    notice.value = t("accountPage.resetEmailSent");
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.authFailed"));
  } finally {
    activeAction.value = null;
  }
};

const signInWith = async (provider: OAuthProvider) => {
  clearMessages();
  if (!legalAccepted.value) {
    errorMessage.value = t("accountPage.legalAgreementRequired");
    return;
  }
  if (config.value.turnstileSiteKey && !turnstileToken.value) {
    errorMessage.value = t("accountPage.completeChallenge");
    return;
  }
  activeAction.value = "auth";
  try {
    const result = await authClient.signIn.social({
      provider,
      callbackURL: "/account",
      fetchOptions: captchaFetchOptions(),
    });
    if (result?.error) errorMessage.value = clientErrorMessage(result.error, t("accountPage.authFailed"));
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.authFailed"));
  } finally {
    activeAction.value = null;
    turnstile.value?.reset();
  }
};

const signOut = async () => {
  clearMessages();
  activeAction.value = "signOut";
  try {
    const result = await authClient.signOut();
    if (result.error) {
      errorMessage.value = clientErrorMessage(result.error, t("accountPage.authFailed"));
      return;
    }
    clearAccountProfile();
    clearIdentityCache();
    notice.value = t("accountPage.signedOut");
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.authFailed"));
  } finally {
    activeAction.value = null;
  }
};

const updateProfile = async () => {
  clearMessages();
  activeAction.value = "profile";
  try {
    const result = await $fetch<AccountProfileResponse>("/api/v1/account/profile", {
      method: "PATCH",
      body: {
        displayName: profileName.value.trim(),
        handle: profileHandle.value.trim() || null,
        bio: profileBio.value.trim() || null,
        version: accountProfile.value?.version,
      },
    });
    setAccountProfile(result.profile);
    profileName.value = result.profile.candidateDisplayName || result.profile.accountName;
    profileHandle.value = result.profile.handle || "";
    profileBio.value = result.profile.bio || "";
    profileAppealOpen.value = false;
    profileAppealStatement.value = "";
    profileAppealError.value = "";
    profileAppealSubmitted.value = false;
    await refetch();
    notice.value =
      result.profile.displayNameStatus === "block"
        ? t("accountPage.profileNameBlocked")
        : result.profile.displayNameStatus === "pending"
          ? t("accountPage.profileNamePending")
          : t("accountPage.profileUpdated");
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.authFailed"));
  } finally {
    activeAction.value = null;
  }
};

const clearAvatarSelection = () => {
  if (avatarPreviewUrl.value) URL.revokeObjectURL(avatarPreviewUrl.value);
  avatarPreviewUrl.value = null;
  avatarFile.value = null;
};

const selectAvatar = (file: File) => {
  clearMessages();
  clearAvatarSelection();
  if (!AVATAR_TYPES.has(file.type)) {
    errorMessage.value = t("accountPage.avatarUnsupported");
    return;
  }
  if (file.size === 0 || file.size > AVATAR_MAX_BYTES) {
    errorMessage.value = t("accountPage.avatarTooLarge");
    return;
  }
  activeSection.value = "profile";
  avatarFile.value = file;
  avatarPreviewUrl.value = URL.createObjectURL(file);
};

const selectAvatarFiles = (files: File[]) => {
  const file = files[0];
  if (file) selectAvatar(file);
};

const chooseAvatar = async () => {
  activeSection.value = "profile";
  await nextTick();
  avatarPicker.value?.open();
};

const uploadAvatar = async () => {
  const file = avatarFile.value;
  if (!file) return;
  clearMessages();
  activeAction.value = "avatar";
  try {
    await $fetch<{ avatar: { status: "pending" } }>("/api/v1/account/avatar", {
      method: "PUT",
      body: file,
      headers: {
        "Content-Type": file.type,
        "x-file-name": encodeURIComponent(file.name),
      },
    });
    clearAvatarSelection();
    await refetch();
    await loadAccountProfile(true);
    notice.value = t("accountPage.avatarPending");
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.avatarUploadFailed"));
  } finally {
    activeAction.value = null;
  }
};

const deleteAvatar = async () => {
  clearMessages();
  activeAction.value = "avatar";
  try {
    await $fetch<void>("/api/v1/account/avatar", { method: "DELETE" });
    clearAvatarSelection();
    await refetch();
    await loadAccountProfile(true);
    notice.value = t("accountPage.avatarDeleted");
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.avatarDeleteFailed"));
  } finally {
    activeAction.value = null;
  }
};

const updateEmail = async () => {
  clearMessages();
  activeAction.value = "email";
  try {
    const result = await authClient.changeEmail({
      newEmail: newEmail.value.trim(),
      callbackURL: "/account?verified=1",
    });
    if (result.error) {
      errorMessage.value = clientErrorMessage(result.error, t("accountPage.authFailed"));
      return;
    }
    notice.value = t("accountPage.emailChangeSent");
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.authFailed"));
  } finally {
    activeAction.value = null;
  }
};

const updatePassword = async () => {
  clearMessages();
  if (newPassword.value !== confirmPassword.value) {
    errorMessage.value = t("accountPage.passwordMismatch");
    return;
  }
  activeAction.value = "password";
  try {
    const result = await authClient.changePassword({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
      revokeOtherSessions: true,
    });
    if (result.error) {
      errorMessage.value = clientErrorMessage(result.error, t("accountPage.authFailed"));
      return;
    }
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    notice.value = t("accountPage.passwordChanged");
    await loadSecurityData();
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.authFailed"));
  } finally {
    activeAction.value = null;
  }
};

const isCurrentSession = (item: AccountSession) => item.token === currentSessionToken.value;
const sessionDate = (value: Date | string) => formatDate(value instanceof Date ? value.getTime() : Date.parse(value));

const revokeSession = async (item: AccountSession) => {
  clearMessages();
  activeAction.value = "sessions";
  try {
    const result = await authClient.revokeSession({ token: item.token });
    if (result.error) {
      errorMessage.value = clientErrorMessage(result.error, t("accountPage.sessionRevokeFailed"));
      return;
    }
    sessions.value = sessions.value.filter((entry) => entry.token !== item.token);
    notice.value = t("accountPage.sessionRevoked");
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.sessionRevokeFailed"));
  } finally {
    activeAction.value = null;
  }
};

const revokeOtherSessions = async () => {
  clearMessages();
  activeAction.value = "sessions";
  try {
    const result = await authClient.revokeOtherSessions();
    if (result.error) {
      errorMessage.value = clientErrorMessage(result.error, t("accountPage.sessionRevokeFailed"));
      return;
    }
    notice.value = t("accountPage.sessionRevoked");
    await loadSecurityData();
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.sessionRevokeFailed"));
  } finally {
    activeAction.value = null;
  }
};

const revokeAllSessions = async () => {
  clearMessages();
  activeAction.value = "sessions";
  try {
    const result = await authClient.revokeSessions();
    if (result.error) {
      errorMessage.value = clientErrorMessage(result.error, t("accountPage.sessionRevokeFailed"));
      return;
    }
    sessions.value = [];
    accounts.value = [];
    clearAccountProfile();
    clearIdentityCache();
    await refetch();
    notice.value = t("accountPage.sessionRevoked");
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.sessionRevokeFailed"));
  } finally {
    activeAction.value = null;
  }
};

const providerLabel = (providerId: string) => {
  if (providerId === "credential") return t("accountPage.passwordAccount");
  if (isOAuthProvider(providerId)) return oauthProviderLabel(providerId);
  return providerId;
};

const linkAccount = async (provider: OAuthProvider) => {
  clearMessages();
  activeAction.value = "accounts";
  try {
    const result = await authClient.linkSocial({ provider, callbackURL: "/account?linked=1" });
    if (result.error) errorMessage.value = clientErrorMessage(result.error, t("accountPage.accountActionFailed"));
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.accountActionFailed"));
  } finally {
    activeAction.value = null;
  }
};

const unlinkAccount = async (account: LinkedAccount) => {
  clearMessages();
  activeAction.value = "accounts";
  try {
    const result = await authClient.unlinkAccount({
      providerId: account.providerId,
      accountId: account.accountId,
    });
    if (result.error) {
      errorMessage.value = clientErrorMessage(result.error, t("accountPage.accountActionFailed"));
      return;
    }
    accounts.value = accounts.value.filter((entry) => entry.id !== account.id);
    notice.value = t("accountPage.accountUnlinked");
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.accountActionFailed"));
  } finally {
    activeAction.value = null;
  }
};

const requestAccountDeletion = async () => {
  if (!canDeleteAccount.value) return;
  clearMessages();
  activeAction.value = "delete";
  try {
    await $fetch<void>("/api/v1/account/profile", {
      method: "DELETE",
      body: { confirmation: deleteConfirmation.value },
    });
    deleteConfirmation.value = "";
    clearAccountProfile();
    clearIdentityCache();
    await refetch();
    await navigateTo("/account?deleted=1", { replace: true });
    notice.value = t("accountPage.accountDeleted");
  } catch (error) {
    errorMessage.value = actionErrorMessage(error, t("accountPage.deleteFailed"));
  } finally {
    activeAction.value = null;
  }
};

watch(profileAppealStatement, (value) => {
  const characters = [...value];
  if (characters.length > PROFILE_APPEAL_MAX_LENGTH) {
    profileAppealStatement.value = characters.slice(0, PROFILE_APPEAL_MAX_LENGTH).join("");
  }
});

const resetAccountWorkspace = () => {
  securityRequestRevision += 1;
  securityDataLoading.value = false;
  securityDataLoaded.value = false;
  if (securityDataErrorMessage && errorMessage.value === securityDataErrorMessage) errorMessage.value = "";
  securityDataErrorMessage = "";
  clearAvatarSelection();
  profileName.value = "";
  profileHandle.value = "";
  profileBio.value = "";
  profileAppealOpen.value = false;
  profileAppealStatement.value = "";
  profileAppealError.value = "";
  profileAppealSubmitted.value = false;
  newEmail.value = user.value?.email || "";
  currentPassword.value = "";
  newPassword.value = "";
  confirmPassword.value = "";
  deleteConfirmation.value = "";
  sessions.value = [];
  accounts.value = [];
};

watch(
  () => [user.value?.id || null, authState.value] as const,
  ([userId, state]) => {
    if (state === "error") return;
    if (!userId) {
      if (state !== "anonymous") return;
      if (renderedAccountUserId !== null) resetAccountWorkspace();
      renderedAccountUserId = null;
      profileFormOwnerUserId = null;
      return;
    }
    if (renderedAccountUserId === userId) {
      if (profileFormOwnerUserId !== userId) void loadAccountProfile();
      void loadSecurityData();
      return;
    }
    resetAccountWorkspace();
    renderedAccountUserId = userId;
    profileFormOwnerUserId = null;
    void loadAccountProfile();
    void loadSecurityData();
  },
  { immediate: true },
);

watch(
  () => user.value?.email,
  (value) => {
    if (value) newEmail.value = value;
  },
);

onMounted(() => {
  void loadConfig();
  if (route.query.verified === "1") notice.value = t("accountPage.verified");
  if (route.query.deleted === "1") notice.value = t("accountPage.accountDeleted");
  if (route.query.linked === "1") notice.value = t("accountPage.accountLinked");
});
onBeforeUnmount(clearAvatarSelection);
useHead(() => ({ title: `${t("account")} · haneoka` }));
</script>

<template>
  <WorkspaceScreen :title="t('account')" :detail-available="false">
    <PageContentSurface as="section" max-width="1120px" data-scroll-key="account">
      <div v-if="user" class="account-workspace">
        <header class="account-identity">
          <div class="account-identity__avatar">
            <div class="account-avatar-picker">
              <UserAvatar
                :src="avatarSource"
                :name="identityName"
                :seed="accountAvatarSeed"
                size="xl"
                loading="eager"
              />
              <UiIconButton
                class="account-avatar-picker__action"
                :label="t('accountPage.chooseAvatar')"
                size="compact"
                emphasis
                :disabled="busy"
                @click="chooseAvatar"
              >
                <MaterialIcon name="photo_camera" :size="18" />
              </UiIconButton>
            </div>
          </div>
          <div class="account-identity__copy">
            <h2>{{ identityName }}</h2>
            <p>{{ user.email }}</p>
            <UiButton class="account-uid" tone="neutral" :disabled="publicUid === '—'" @click="copyPublicUid">
              <template #icon><MaterialIcon name="content_copy" :size="17" /></template>
              <span>{{ t("accountPage.publicUid") }}</span>
              <strong class="display-number">{{ publicUid }}</strong>
            </UiButton>
          </div>
          <div class="account-identity__status" role="group" :aria-label="t('accountPage.accountStatus')">
            <span>
              <MaterialIcon name="person" :size="17" />
              {{ profileRole }}
            </span>
            <span :class="{ 'is-verified': user.emailVerified }">
              <MaterialIcon name="check_circle" v-if="user.emailVerified" :size="17" />
              <MaterialIcon name="alternate_email" v-else :size="17" />
              {{ user.emailVerified ? t("accountPage.verified") : t("accountPage.unverified") }}
            </span>
            <span>
              <MaterialIcon name="verified_user" :size="17" />
              {{ profileStatus }}
            </span>
          </div>
          <div class="account-identity__actions">
            <UiButton v-if="publicProfilePath" :href="publicProfilePath" tone="neutral">
              <template #icon><MaterialIcon name="open_in_new" :size="18" /></template>
              {{ t("accountPage.publicProfile") }}
            </UiButton>
            <UiButton v-if="isAdmin" href="/admin" tone="neutral">
              <template #icon><MaterialIcon name="admin_panel_settings" :size="18" /></template>
              {{ t("accountPage.adminConsole") }}
            </UiButton>
            <UiButton tone="danger" :disabled="busy" @click="signOut">
              <template #icon><MaterialIcon name="logout" :size="18" /></template>
              {{ t("accountPage.signOut") }}
            </UiButton>
          </div>
        </header>

        <div class="account-main">
          <UiList class="account-navigation" role="tablist" :aria-label="t('account')">
            <UiListItem
              v-for="item in accountSectionItems"
              :id="`account-tab-${item.id}`"
              :key="item.id"
              type="button"
              :class="{ 'is-active': activeSection === item.id }"
              role="tab"
              :aria-selected="activeSection === item.id"
              :aria-controls="`account-panel-${item.id}`"
              @click="activeSection = item.id"
            >
              <template #start><MaterialIcon :name="item.icon" :size="20" /></template>
              <template #headline>{{ item.label }}</template>
            </UiListItem>
          </UiList>

          <div class="account-content">
            <div class="account-content__inner">
              <InlineNotice v-if="errorMessage" tone="error">
                <span>{{ errorMessage }}</span>
                <template #actions>
                  <UiIconButton :label="t('close')" size="compact" @click="clearMessages">
                    <MaterialIcon name="close" :size="18" />
                  </UiIconButton>
                </template>
              </InlineNotice>
              <InlineNotice v-if="notice" tone="success">
                <span>{{ notice }}</span>
                <template #actions>
                  <UiIconButton :label="t('close')" size="compact" @click="clearMessages">
                    <MaterialIcon name="close" :size="18" />
                  </UiIconButton>
                </template>
              </InlineNotice>

              <section
                v-if="activeSection === 'profile'"
                id="account-panel-profile"
                class="account-section"
                role="tabpanel"
                aria-labelledby="account-tab-profile"
              >
                <PageSection :title="t('accountPage.profile')" icon="person">
                  <div class="account-ledger">
                    <div class="account-setting-row account-setting-row--avatar">
                      <span class="account-setting-row__label">{{ t("accountPage.avatar") }}</span>
                      <div class="account-avatar-control">
                        <UserAvatar
                          :src="avatarSource"
                          :name="identityName"
                          :seed="accountAvatarSeed"
                          size="xl"
                          loading="eager"
                        />
                        <div class="account-row-actions">
                          <template v-if="avatarFile">
                            <UiButton tone="primary" :disabled="busy" @click="uploadAvatar">
                              <template #icon><MaterialIcon name="upload" :size="18" /></template>
                              {{ t("accountPage.uploadAvatar") }}
                            </UiButton>
                            <UiButton tone="neutral" :disabled="busy" @click="clearAvatarSelection">
                              {{ t("accountPage.cancelAvatar") }}
                            </UiButton>
                          </template>
                          <UiFilePicker
                            ref="avatarPicker"
                            accept="image/jpeg,image/png,image/webp"
                            :label="t('accountPage.chooseAvatar')"
                            :disabled="busy"
                            tone="neutral"
                            @select="selectAvatarFiles"
                          >
                            <template #icon><MaterialIcon name="photo_camera" :size="18" /></template>
                            {{ t("accountPage.changeAvatar") }}
                          </UiFilePicker>
                          <template v-if="!avatarFile">
                            <UiButton v-if="hasCurrentAvatar" tone="danger" :disabled="busy" @click="deleteAvatar">
                              {{ t("accountPage.deleteAvatar") }}
                            </UiButton>
                          </template>
                        </div>
                      </div>
                    </div>

                    <form class="account-profile-form" @submit.prevent="updateProfile">
                      <div class="account-setting-row account-name-form">
                        <UiTextField
                          id="account-display-name"
                          v-model="profileName"
                          :label="t('accountPage.displayName')"
                          name="display-name"
                          autocomplete="name"
                          minlength="1"
                          maxlength="80"
                          required
                        />
                      </div>

                      <div class="account-setting-row account-name-form">
                        <UiTextField
                          id="account-handle"
                          v-model="profileHandle"
                          :label="t('accountPage.handle')"
                          name="handle"
                          autocomplete="username"
                          minlength="3"
                          maxlength="32"
                          pattern="[A-Za-z0-9_-]{3,32}"
                        />
                      </div>

                      <div class="account-setting-row account-bio-form">
                        <UiTextField
                          id="account-bio"
                          v-model="profileBio"
                          :label="t('accountPage.bio')"
                          name="bio"
                          type="textarea"
                          rows="4"
                          maxlength="500"
                        />
                      </div>

                      <footer class="account-profile-form__actions">
                        <UiButton v-if="publicProfilePath" :href="publicProfilePath" tone="neutral">
                          <template #icon><MaterialIcon name="open_in_new" :size="18" /></template>
                          {{ t("accountPage.publicProfile") }}
                        </UiButton>
                        <UiButton tone="primary" type="submit" :disabled="busy || unchangedProfile">
                          {{ t("accountPage.saveProfile") }}
                        </UiButton>
                      </footer>
                    </form>

                    <div
                      v-if="accountProfile?.displayNameStatus === 'pending'"
                      class="profile-review-status"
                      role="status"
                    >
                      {{ t("accountPage.profileNamePending") }}
                    </div>
                    <div
                      v-else-if="accountProfile?.displayNameStatus === 'block'"
                      class="profile-review-status is-blocked"
                      :role="profileAppealSubmitted ? 'status' : 'alert'"
                    >
                      <span>
                        {{
                          profileAppealSubmitted
                            ? t("communityPage.appealSubmitted")
                            : t("accountPage.profileNameBlocked")
                        }}
                      </span>
                      <UiButton v-if="canAppealProfileName" tone="neutral" :disabled="busy" @click="openProfileAppeal">
                        {{ t("communityPage.appeal") }}
                      </UiButton>
                    </div>
                    <form v-if="profileAppealOpen" class="profile-appeal-form" @submit.prevent="submitProfileAppeal">
                      <UiTextField
                        id="profile-appeal-statement"
                        v-model="profileAppealStatement"
                        :label="t('communityPage.appealStatement')"
                        type="textarea"
                        :aria-invalid="Boolean(profileAppealError)"
                        aria-describedby="profile-appeal-meta"
                        rows="4"
                        required
                        :disabled="activeAction === 'profileAppeal'"
                      />
                      <div id="profile-appeal-meta" class="profile-appeal-form__meta">
                        <span v-if="profileAppealError" role="alert">{{ profileAppealError }}</span>
                        <span aria-hidden="true">{{ profileAppealLength }} / {{ PROFILE_APPEAL_MAX_LENGTH }}</span>
                      </div>
                      <footer>
                        <UiButton
                          tone="neutral"
                          :disabled="activeAction === 'profileAppeal'"
                          @click="closeProfileAppeal"
                        >
                          {{ t("communityPage.cancel") }}
                        </UiButton>
                        <UiButton tone="primary" type="submit" :disabled="!canSubmitProfileAppeal">
                          {{
                            activeAction === "profileAppeal"
                              ? t("communityPage.appealSubmitting")
                              : t("communityPage.submitAppeal")
                          }}
                        </UiButton>
                      </footer>
                    </form>

                    <div class="account-setting-row">
                      <span class="account-setting-row__label">{{ t("accountPage.publicUid") }}</span>
                      <div class="account-setting-value account-setting-value--uid">
                        <code class="display-number">{{ publicUid }}</code>
                        <UiIconButton
                          :label="t('accountPage.copyUid')"
                          size="compact"
                          :disabled="publicUid === '—'"
                          @click="copyPublicUid"
                        >
                          <MaterialIcon name="content_copy" :size="18" />
                        </UiIconButton>
                      </div>
                    </div>

                    <div class="account-setting-row">
                      <span class="account-setting-row__label">{{ t("accountPage.accountStatus") }}</span>
                      <div class="account-status-line">
                        <span>
                          <MaterialIcon name="person" :size="17" />
                          {{ profileRole }}
                        </span>
                        <span>
                          <MaterialIcon name="verified_user" :size="17" />
                          {{ profileStatus }}
                        </span>
                        <span :class="{ 'is-verified': user.emailVerified }">
                          <MaterialIcon name="check_circle" v-if="user.emailVerified" :size="17" />
                          <MaterialIcon name="alternate_email" v-else :size="17" />
                          {{ user.emailVerified ? t("accountPage.verified") : t("accountPage.unverified") }}
                        </span>
                      </div>
                    </div>
                  </div>
                </PageSection>
              </section>

              <section
                v-else-if="activeSection === 'security'"
                id="account-panel-security"
                class="account-section"
                role="tabpanel"
                aria-labelledby="account-tab-security"
              >
                <PageSection :title="t('accountPage.security')" icon="verified_user">
                  <div class="account-section__stack">
                    <section class="account-block" aria-labelledby="email-settings-title">
                      <h3 id="email-settings-title">{{ t("accountPage.emailSettings") }}</h3>
                      <div class="account-setting-row">
                        <span class="account-setting-row__label">{{ t("accountPage.currentEmail") }}</span>
                        <div class="account-email-value">
                          <strong>{{ user.email }}</strong>
                          <span :class="{ 'is-verified': user.emailVerified }">
                            <MaterialIcon name="check_circle" v-if="user.emailVerified" :size="15" />
                            <MaterialIcon name="alternate_email" v-else :size="15" />
                            {{ user.emailVerified ? t("accountPage.verified") : t("accountPage.unverified") }}
                          </span>
                        </div>
                        <UiButton
                          v-if="!user.emailVerified && config.emailDeliveryEnabled"
                          tone="neutral"
                          :disabled="busy"
                          @click="sendVerification()"
                        >
                          <template #icon><MaterialIcon name="mark_email_read" :size="18" /></template>
                          {{ t("accountPage.resendVerification") }}
                        </UiButton>
                      </div>
                      <form
                        v-if="config.emailDeliveryEnabled"
                        class="account-setting-row account-inline-form"
                        @submit.prevent="updateEmail"
                      >
                        <UiTextField
                          id="account-new-email"
                          v-model="newEmail"
                          :label="t('accountPage.newEmail')"
                          name="new-email"
                          type="email"
                          autocomplete="email"
                          maxlength="254"
                          required
                        />
                        <UiButton tone="neutral" type="submit" :disabled="busy || newEmail.trim() === user.email">
                          {{ t("accountPage.changeEmail") }}
                        </UiButton>
                      </form>
                    </section>

                    <section v-if="hasPasswordAccount" class="account-block" aria-labelledby="password-settings-title">
                      <h3 id="password-settings-title">{{ t("accountPage.passwordAccount") }}</h3>
                      <form class="account-password-form" @submit.prevent="updatePassword">
                        <UiTextField
                          v-model="currentPassword"
                          :label="t('accountPage.currentPassword')"
                          name="current-password"
                          type="password"
                          autocomplete="current-password"
                          minlength="12"
                          maxlength="128"
                          required
                        />
                        <UiTextField
                          v-model="newPassword"
                          :label="t('accountPage.newPassword')"
                          name="new-password"
                          type="password"
                          autocomplete="new-password"
                          minlength="12"
                          maxlength="128"
                          required
                        />
                        <UiTextField
                          v-model="confirmPassword"
                          :label="t('accountPage.confirmPassword')"
                          name="confirm-password"
                          type="password"
                          autocomplete="new-password"
                          minlength="12"
                          maxlength="128"
                          required
                        />
                        <UiButton tone="primary" type="submit" :disabled="busy">
                          {{ t("accountPage.changePassword") }}
                        </UiButton>
                      </form>
                    </section>

                    <section class="account-block" aria-labelledby="accounts-settings-title">
                      <h3 id="accounts-settings-title">
                        {{ t("accountPage.connectedAccounts") }}
                        <LoadingState
                          v-if="securityDataLoading && securityDataLoaded"
                          :label="t('accountPage.loading')"
                          size="xs"
                          variant="inline"
                        />
                      </h3>
                      <LoadingState
                        v-if="securityDataLoading && !securityDataLoaded"
                        :label="t('accountPage.loading')"
                        size="sm"
                        variant="fill"
                      />
                      <div v-else class="provider-list">
                        <div v-for="account in accounts" :key="account.id" class="provider-row">
                          <span class="provider-mark">
                            <OAuthProviderIcon
                              v-if="isOAuthProvider(account.providerId)"
                              :provider="account.providerId"
                            />
                            <MaterialIcon name="key" v-else :size="18" />
                          </span>
                          <span>
                            <strong>{{ providerLabel(account.providerId) }}</strong>
                            <small>{{ t("accountPage.linked") }}</small>
                          </span>
                          <UiButton
                            v-if="account.providerId !== 'credential'"
                            tone="neutral"
                            :disabled="busy || accounts.length <= 1"
                            @click="unlinkAccount(account)"
                          >
                            <template #icon><MaterialIcon name="link_off" :size="18" /></template>
                            {{ t("accountPage.unlink") }}
                          </UiButton>
                        </div>
                        <UiListItem
                          v-for="provider in availableLinkProviders"
                          :key="provider"
                          class="provider-row provider-row--link"
                          :headline="providerLabel(provider)"
                          :supporting-text="t('accountPage.link')"
                          type="button"
                          :disabled="busy"
                          @click="linkAccount(provider)"
                        >
                          <template #start>
                            <span class="provider-mark">
                              <OAuthProviderIcon :provider="provider" />
                            </span>
                          </template>
                        </UiListItem>
                      </div>
                    </section>
                  </div>
                </PageSection>
              </section>

              <section
                v-else-if="activeSection === 'sessions'"
                id="account-panel-sessions"
                class="account-section"
                role="tabpanel"
                aria-labelledby="account-tab-sessions"
              >
                <PageSection :title="t('accountPage.sessions')" icon="devices">
                  <template #actions>
                    <LoadingState
                      v-if="securityDataLoading && securityDataLoaded"
                      :label="t('accountPage.loading')"
                      size="xs"
                      variant="inline"
                    />
                    <UiButton tone="neutral" :disabled="busy" @click="loadSecurityData">
                      <template #icon><MaterialIcon name="refresh" :size="18" /></template>
                      {{ t("accountPage.refresh") }}
                    </UiButton>
                  </template>
                  <LoadingState
                    v-if="securityDataLoading && !securityDataLoaded"
                    :label="t('accountPage.loading')"
                    size="sm"
                    variant="fill"
                  />
                  <div v-else class="session-list">
                    <article v-for="item in sessions" :key="item.id" class="session-item">
                      <span class="session-item__icon" :class="{ 'is-current': isCurrentSession(item) }">
                        <MaterialIcon name="laptop" :size="20" />
                      </span>
                      <div>
                        <strong>
                          {{
                            isCurrentSession(item)
                              ? t("accountPage.currentSession")
                              : item.userAgent || t("accountPage.sessionUnknown")
                          }}
                        </strong>
                        <small v-if="isCurrentSession(item) && item.userAgent">{{ item.userAgent }}</small>
                        <small>
                          {{ item.ipAddress || t("accountPage.sessionUnknown") }} · {{ sessionDate(item.createdAt) }}
                        </small>
                      </div>
                      <UiButton tone="neutral" :disabled="busy" @click="revokeSession(item)">
                        {{ t("accountPage.revoke") }}
                      </UiButton>
                    </article>
                    <footer class="session-actions">
                      <UiButton tone="neutral" :disabled="busy || sessions.length <= 1" @click="revokeOtherSessions">
                        {{ t("accountPage.revokeOthers") }}
                      </UiButton>
                      <UiButton tone="danger" :disabled="busy || !sessions.length" @click="revokeAllSessions">
                        {{ t("accountPage.revokeAllSessions") }}
                      </UiButton>
                    </footer>
                  </div>
                </PageSection>
              </section>

              <section
                v-else
                id="account-panel-management"
                class="account-section"
                role="tabpanel"
                aria-labelledby="account-tab-management"
              >
                <PageSection :title="t('accountPage.accountManagement')" icon="settings">
                  <div class="account-section__stack">
                    <div class="account-ledger account-ledger--compact">
                      <div class="account-setting-row">
                        <span class="account-setting-row__label">{{ t("accountPage.publicUid") }}</span>
                        <strong class="display-number">{{ publicUid }}</strong>
                      </div>
                      <div class="account-setting-row">
                        <span class="account-setting-row__label">{{ t("accountPage.role") }}</span>
                        <strong>{{ profileRole }}</strong>
                      </div>
                      <div class="account-setting-row">
                        <span class="account-setting-row__label">{{ t("accountPage.accountStatus") }}</span>
                        <strong>{{ profileStatus }}</strong>
                      </div>
                    </div>

                    <section class="account-danger" aria-labelledby="danger-settings-title">
                      <header>
                        <span><MaterialIcon name="delete" :size="18" /></span>
                        <div>
                          <h3 id="danger-settings-title">{{ t("accountPage.dangerZone") }}</h3>
                          <p>{{ t("accountPage.deleteAccountDescription") }}</p>
                        </div>
                      </header>
                      <form class="account-danger-form" @submit.prevent="requestAccountDeletion">
                        <UiTextField
                          v-model="deleteConfirmation"
                          :label="t('accountPage.confirmDeleteHint')"
                          name="delete-confirmation"
                          type="email"
                          autocomplete="off"
                          :placeholder="user.email"
                          required
                        />
                        <UiButton tone="danger" type="submit" :disabled="busy || !canDeleteAccount">
                          <template #icon><MaterialIcon name="delete" :size="18" /></template>
                          {{ t("accountPage.requestDeletion") }}
                        </UiButton>
                      </form>
                    </section>
                  </div>
                </PageSection>
              </section>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="authState !== 'anonymous'" class="auth-layout">
        <section class="auth-panel" aria-live="polite">
          <div v-if="authState === 'error'" class="account-state account-state--identity" role="alert">
            <UserAvatar
              v-if="displayIdentity"
              :src="displayIdentity.avatarUrl"
              :name="displayIdentity.name"
              :seed="displayIdentity.avatarSeed"
              size="xl"
              loading="eager"
            />
            <MaterialIcon name="error" v-else :size="28" />
            <h2 v-if="displayIdentity">{{ displayIdentity.name }}</h2>
            <p>{{ t("accountPage.authFailed") }}</p>
            <UiButton tone="neutral" @click="refetch()">
              <template #icon><MaterialIcon name="refresh" :size="18" /></template>
              {{ t("accountPage.refresh") }}
            </UiButton>
          </div>
          <div v-else-if="displayIdentity" class="account-state account-state--identity">
            <UserAvatar
              :src="displayIdentity.avatarUrl"
              :name="displayIdentity.name"
              :seed="displayIdentity.avatarSeed"
              size="xl"
              loading="eager"
            />
            <h2>{{ displayIdentity.name }}</h2>
            <LoadingState :label="t('accountPage.loading')" size="xs" variant="inline" />
          </div>
          <LoadingState v-else :label="t('accountPage.loading')" variant="block" />
        </section>
      </div>

      <div v-else class="auth-layout">
        <InlineNotice v-if="errorMessage" tone="error">{{ errorMessage }}</InlineNotice>
        <InlineNotice v-if="notice" tone="success">{{ notice }}</InlineNotice>
        <section class="auth-panel">
          <LoadingState v-if="!configLoaded" :label="t('accountPage.loading')" variant="block" />
          <div v-else-if="!config.available" class="account-state">
            <MaterialIcon name="verified_user" :size="28" />
            <h2>{{ t("accountPage.unavailableTitle") }}</h2>
            <p>{{ t("accountPage.unavailableBody") }}</p>
          </div>

          <template v-else-if="mode === 'verifyEmail'">
            <PageSection
              :title="t('accountPage.verifyEmailTitle')"
              :description="t('accountPage.verifyEmailBody')"
              icon="mark_email_read"
            >
              <div class="verification-panel">
                <strong>{{ verificationEmail }}</strong>
                <p>{{ t("accountPage.verificationPasswordNote") }}</p>
                <TurnstileWidget
                  v-if="config.turnstileSiteKey"
                  ref="turnstile"
                  :site-key="config.turnstileSiteKey"
                  :action="TURNSTILE_ACTION_REGISTER"
                  @token="turnstileToken = $event"
                />
                <UiButton tone="primary" :disabled="busy" @click="sendVerification()">
                  <template #icon><MaterialIcon name="mark_email_read" :size="18" /></template>
                  {{ t("accountPage.resendVerification") }}
                </UiButton>
                <UiButton tone="neutral" @click="mode = 'signIn'">
                  {{ t("accountPage.backToSignIn") }}
                </UiButton>
              </div>
            </PageSection>
          </template>

          <template v-else-if="mode === 'forgotPassword'">
            <PageSection
              :title="t('accountPage.forgotPasswordTitle')"
              :description="t('accountPage.forgotPasswordBody')"
              icon="key"
            >
              <UiFormLayout as="form" @submit.prevent="requestPasswordReset">
                <UiTextField
                  v-model="email"
                  :label="t('accountPage.email')"
                  name="reset-email"
                  type="email"
                  autocomplete="email"
                  maxlength="254"
                  required
                />
                <UiButton tone="primary" type="submit" :disabled="busy">
                  <template #icon><MaterialIcon name="mark_email_read" :size="18" /></template>
                  {{ busy ? t("accountPage.working") : t("accountPage.sendResetLink") }}
                </UiButton>
                <UiButton tone="neutral" @click="mode = 'signIn'">
                  {{ t("accountPage.backToSignIn") }}
                </UiButton>
              </UiFormLayout>
            </PageSection>
          </template>

          <template v-else>
            <header class="auth-panel__heading">
              <span><MaterialIcon :name="mode === 'signUp' ? 'person_add' : 'lock_person'" :size="24" /></span>
              <h2>{{ mode === "signUp" ? t("accountPage.signUp") : t("accountPage.signIn") }}</h2>
            </header>
            <UiFormLayout as="form" @submit.prevent="submitAuth">
              <UiSegmentedControl
                :model-value="credentialMode"
                :options="credentialModeOptions"
                :label="t('account')"
                @update:model-value="selectCredentialMode"
              />
              <UiTextField
                v-model="email"
                :label="t('accountPage.email')"
                :supporting-text="mode === 'signUp' ? t('accountPage.emailOnlySignupHint') : ''"
                name="email"
                type="email"
                autocomplete="email"
                maxlength="254"
                required
              />
              <UiTextField
                v-if="mode === 'signIn'"
                v-model="password"
                :label="t('accountPage.password')"
                name="password"
                type="password"
                autocomplete="current-password"
                minlength="12"
                maxlength="128"
                required
              />

              <TurnstileWidget
                v-if="config.turnstileSiteKey"
                ref="turnstile"
                :site-key="config.turnstileSiteKey"
                :action="mode === 'signUp' ? TURNSTILE_ACTION_REGISTER : TURNSTILE_ACTION_SIGN_IN"
                @token="turnstileToken = $event"
              />

              <UiCheckbox v-model="legalAccepted" :label="t('accountPage.legalAgreementPrefix')" aria-required="true">
                <span>
                  {{ t("accountPage.legalAgreementPrefix") }}
                  <NuxtLink to="/privacy" target="_blank" rel="noopener noreferrer">
                    {{ t("homePage.privacy") }}
                  </NuxtLink>
                  {{ t("accountPage.legalAgreementJoiner") }}
                  <NuxtLink to="/terms" target="_blank" rel="noopener noreferrer">
                    {{ t("homePage.terms") }}
                  </NuxtLink>
                  {{ t("accountPage.legalAgreementSuffix") }}
                </span>
              </UiCheckbox>

              <UiButton tone="primary" type="submit" :disabled="busy">
                <template #icon>
                  <MaterialIcon name="mark_email_read" v-if="mode === 'signUp'" :size="18" />
                  <MaterialIcon name="login" v-else :size="18" />
                </template>
                {{
                  busy
                    ? t("accountPage.working")
                    : mode === "signUp"
                      ? t("accountPage.signUp")
                      : t("accountPage.signIn")
                }}
              </UiButton>
              <UiButton
                v-if="mode === 'signIn' && config.emailSignUpEnabled"
                tone="neutral"
                @click="mode = 'forgotPassword'"
              >
                {{ t("accountPage.forgotPassword") }}
              </UiButton>
              <UiButton v-if="mode === 'signIn' && verificationEmail" tone="neutral" @click="mode = 'verifyEmail'">
                {{ t("accountPage.resendVerification") }}
              </UiButton>
            </UiFormLayout>

            <template v-if="providers.length">
              <div class="account-divider">
                <span>{{ t("accountPage.orContinueWith") }}</span>
              </div>
              <div class="oauth-actions">
                <UiButton
                  v-for="provider in providers"
                  :key="provider"
                  tone="neutral"
                  :disabled="busy || !legalAccepted"
                  @click="signInWith(provider)"
                >
                  <template #icon><OAuthProviderIcon :provider="provider" :size="18" /></template>
                  {{ providerLabel(provider) }}
                </UiButton>
              </div>
            </template>
          </template>
        </section>
      </div>
    </PageContentSurface>
  </WorkspaceScreen>
</template>

<style scoped>
.account-workspace {
  display: grid;
  gap: var(--md-sys-spacing-4);
}

.account-identity {
  display: grid;
  grid-template-columns: auto minmax(180px, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-4);
  padding: var(--md-sys-spacing-4);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.account-identity__avatar,
.account-avatar-picker {
  position: relative;
  width: fit-content;
}

.account-avatar-picker__action {
  position: absolute;
  right: calc(var(--md-sys-spacing-2) * -1);
  bottom: calc(var(--md-sys-spacing-2) * -1);
}

.account-identity__copy {
  min-width: 0;
}

.account-identity__copy h2,
.account-identity__copy p {
  margin: 0;
}

.account-identity__copy h2 {
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-title-large-font);
  font-size: var(--md-sys-typescale-title-large-size);
  font-weight: var(--md-sys-typescale-title-large-weight);
  line-height: var(--md-sys-typescale-title-large-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-identity__copy p {
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: var(--md-sys-typescale-body-small-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-uid {
  margin-top: var(--md-sys-spacing-2);
}

.account-identity__status {
  display: flex;
  flex-wrap: wrap;
  grid-column: 2;
  gap: var(--md-sys-spacing-2);
}

.account-identity__status span,
.account-status-line span,
.account-email-value span {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: var(--md-sys-spacing-1);
  padding-inline: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.account-identity__status span.is-verified,
.account-status-line span.is-verified,
.account-email-value span.is-verified {
  color: var(--md-sys-color-on-primary-container);
  background: var(--md-sys-color-primary-container);
}

.account-identity__actions {
  display: flex;
  flex-wrap: wrap;
  grid-column: 3;
  grid-row: 1 / span 2;
  justify-content: flex-end;
  gap: var(--md-sys-spacing-2);
}

.account-navigation {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-2);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.account-navigation :deep(.md3-list-item) {
  min-height: 56px;
  border-radius: var(--md-sys-shape-corner-full);
  --md-list-item-label-text-font: var(--md-sys-typescale-label-large-font);
  --md-list-item-label-text-size: var(--md-sys-typescale-label-large-size);
  --md-list-item-label-text-weight: var(--md-sys-typescale-label-large-weight);
}

.account-navigation :deep(.md3-list-item.is-active) {
  --md-list-item-container-color: var(--md-sys-color-secondary-container);
  --md-list-item-label-text-color: var(--md-sys-color-on-secondary-container);
}

.account-main {
  display: grid;
  min-width: 0;
  grid-template-columns: 224px minmax(0, 1fr);
  align-items: start;
  gap: var(--md-sys-spacing-5);
}

.account-content {
  min-width: 0;
}

.account-content__inner {
  display: grid;
  gap: var(--md-sys-spacing-3);
}

.account-section {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-3);
}

.account-block h3,
.account-danger h3 {
  margin: 0;
  color: var(--md-sys-color-on-surface);
}

.account-section__stack {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-3);
}

.account-ledger,
.account-block,
.account-danger {
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.account-setting-row {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(140px, 0.32fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.account-setting-row:last-child,
.account-ledger--compact .account-setting-row:last-child {
  border-bottom: 0;
}

.account-setting-row__label {
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-medium-line-height);
}

.account-setting-row :deep(.md3-text-field) {
  width: 100%;
}

.account-setting-row--avatar {
  align-items: start;
}

.account-avatar-control {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-4);
}

.account-row-actions,
.account-profile-form__actions,
.profile-appeal-form footer,
.session-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--md-sys-spacing-2);
}

.account-profile-form {
  display: contents;
}

.account-profile-form__actions {
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
}

.account-name-form,
.account-bio-form {
  grid-template-columns: minmax(0, 1fr);
}

.profile-review-status {
  margin: 0;
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: var(--md-sys-typescale-body-small-line-height);
}

.profile-review-status.is-blocked {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-error-container);
  background: var(--md-sys-color-error-container);
}

.profile-appeal-form {
  display: grid;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-4);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.profile-appeal-form :deep(.md3-text-field) {
  width: 100%;
}

.profile-appeal-form__meta {
  display: flex;
  min-height: 20px;
  justify-content: flex-end;
  gap: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.profile-appeal-form__meta [role="alert"] {
  margin-right: auto;
  color: var(--md-sys-color-error);
}

.account-setting-value,
.account-status-line,
.account-email-value {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--md-sys-spacing-2);
}

.account-setting-value--uid code,
.account-email-value strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-status-line {
  grid-column: 2 / -1;
}

.account-block {
  display: grid;
}

.account-block h3,
.account-danger > header {
  padding: var(--md-sys-spacing-4);
  background: var(--md-sys-color-surface-container);
}

.account-block h3,
.account-danger h3 {
  font-family: var(--md-sys-typescale-title-medium-font);
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
  line-height: var(--md-sys-typescale-title-medium-line-height);
}

.account-inline-form {
  grid-template-columns: minmax(0, 1fr) auto;
}

.account-password-form {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: end;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-4);
}

.account-password-form :deep(.md3-text-field) {
  width: 100%;
}

.account-password-form :deep(.md3-button) {
  grid-column: 3;
  justify-self: end;
}

.provider-list,
.session-list {
  display: grid;
}

.provider-row:not(.provider-row--link),
.session-item {
  display: grid;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.provider-row:not(.provider-row--link) {
  grid-template-columns: 40px minmax(0, 1fr) auto;
}

.provider-row--link {
  width: 100%;
  min-height: 64px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 0;
  --md-list-item-container-color: transparent;
  --md-list-item-label-text-color: var(--md-sys-color-on-surface);
  --md-list-item-supporting-text-color: var(--md-sys-color-on-surface-variant);
  --md-list-item-leading-space: var(--md-sys-spacing-4);
  --md-list-item-trailing-space: var(--md-sys-spacing-4);
}

.provider-row--link:hover,
.provider-row--link:focus-within {
  --md-list-item-container-color: var(--md-sys-color-surface-container-high);
}

.provider-mark,
.session-item__icon {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
}

.provider-row:not(.provider-row--link) > span:nth-child(2),
.session-item > div {
  display: grid;
  min-width: 0;
}

.provider-row:not(.provider-row--link) strong,
.provider-row:not(.provider-row--link) small,
.session-item strong,
.session-item small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-row:not(.provider-row--link) strong,
.session-item strong {
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: var(--md-sys-typescale-body-medium-line-height);
}

.provider-row:not(.provider-row--link) small,
.session-item small {
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: var(--md-sys-typescale-body-small-line-height);
}

.session-item {
  grid-template-columns: 40px minmax(0, 1fr) auto;
}

.session-item__icon.is-current {
  color: var(--md-sys-color-on-primary-container);
  background: var(--md-sys-color-primary-container);
}

.session-actions {
  justify-content: flex-start;
  padding: var(--md-sys-spacing-4);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.account-danger > header {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: center;
  gap: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-error-container);
  background: var(--md-sys-color-error-container);
}

.account-danger > header > span {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-error);
  color: var(--md-sys-color-on-error);
}

.account-danger h3 {
  color: inherit;
}

.account-danger p {
  margin: var(--md-sys-spacing-1) 0 0;
  color: inherit;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: var(--md-sys-typescale-body-small-line-height);
}

.account-danger-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-4);
}

.account-danger-form :deep(.md3-text-field) {
  width: 100%;
}

.auth-layout {
  display: grid;
  width: min(100%, 560px);
  margin-inline: auto;
  gap: var(--md-sys-spacing-4);
}

.auth-panel {
  display: grid;
  overflow: visible;
  background: transparent;
}

.auth-panel__heading {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-5) 0;
}

.auth-panel__heading > span {
  display: grid;
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  place-items: center;
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
}

.auth-panel__heading h2 {
  margin: 0;
  font: var(--md-sys-typescale-headline-small-weight) var(--md-sys-typescale-headline-small-size) /
    var(--md-sys-typescale-headline-small-line-height) var(--md-sys-typescale-headline-small-font);
}

.verification-panel,
.account-state {
  display: grid;
  min-height: 240px;
  justify-items: center;
  align-content: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-6);
  text-align: center;
}

.verification-panel p,
.account-state p,
.account-state h2 {
  margin: 0;
}

.verification-panel p,
.account-state p {
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: var(--md-sys-typescale-body-medium-line-height);
}

.account-state h2 {
  font-family: var(--md-sys-typescale-title-medium-font);
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
  line-height: var(--md-sys-typescale-title-medium-line-height);
}

.account-divider {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding-inline: var(--md-sys-spacing-5);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.account-divider::before,
.account-divider::after {
  height: 1px;
  flex: 1;
  background: var(--md-sys-color-outline-variant);
  content: "";
}

.oauth-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-4) var(--md-sys-spacing-5) var(--md-sys-spacing-5);
}

.oauth-actions :deep(.md3-button) {
  width: 100%;
}

@media (max-width: 839px) {
  .account-main {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--md-sys-spacing-3);
  }

  .account-navigation {
    display: flex;
    flex-direction: row;
    padding: var(--md-sys-spacing-1);
    overflow-x: auto;
    border-radius: var(--md-sys-shape-corner-full);
    scrollbar-width: none;
  }

  .account-navigation::-webkit-scrollbar {
    display: none;
  }

  .account-navigation :deep(.md3-list-item) {
    width: max-content;
    min-width: max-content;
    min-height: 48px;
    flex: none;
  }

  .account-identity {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .account-identity__status {
    grid-column: 1 / -1;
  }

  .account-identity__actions {
    grid-column: 1 / -1;
    grid-row: auto;
    justify-content: flex-start;
  }

  .account-password-form {
    grid-template-columns: minmax(0, 1fr);
  }

  .account-password-form :deep(.md3-button) {
    grid-column: 1;
    justify-self: stretch;
  }
}

@media (max-width: 599px) {
  .account-identity,
  .account-ledger,
  .account-block,
  .account-danger {
    border-radius: var(--md-sys-shape-corner-medium);
  }

  .account-setting-row,
  .account-name-form,
  .account-bio-form,
  .account-inline-form,
  .account-danger-form {
    grid-template-columns: minmax(0, 1fr);
  }

  .account-setting-row {
    align-items: stretch;
    gap: var(--md-sys-spacing-2);
  }

  .account-avatar-control {
    align-items: flex-start;
    flex-direction: column;
  }

  .account-row-actions,
  .account-profile-form__actions,
  .profile-appeal-form footer,
  .session-actions {
    justify-content: stretch;
  }

  .account-row-actions :deep(.md3-button),
  .account-profile-form__actions :deep(.md3-button),
  .profile-appeal-form footer :deep(.md3-button),
  .session-actions :deep(.md3-button),
  .account-danger-form :deep(.md3-button) {
    flex: 1 1 auto;
  }

  .account-status-line {
    grid-column: 1;
  }

  .profile-review-status.is-blocked {
    align-items: stretch;
    flex-direction: column;
  }

  .provider-row:not(.provider-row--link),
  .session-item {
    grid-template-columns: 40px minmax(0, 1fr);
  }

  .provider-row:not(.provider-row--link) > :deep(.md3-button),
  .session-item > :deep(.md3-button) {
    grid-column: 2;
    justify-self: start;
  }

  .oauth-actions {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
