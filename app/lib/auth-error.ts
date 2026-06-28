const AUTH_ERROR_TRANSLATION_KEYS = {
  EMAIL_NOT_VERIFIED: "accountPage.emailNotVerified",
  INVALID_EMAIL: "accountPage.invalidEmail",
  INVALID_EMAIL_OR_PASSWORD: "accountPage.invalidCredentials",
  INVALID_PASSWORD: "accountPage.invalidCredentials",
  INVALID_TOKEN: "accountPage.invalidResetLink",
  RATE_LIMITED: "accountPage.tooManyRequests",
  RESET_PASSWORD_TOKEN_EXPIRED: "accountPage.invalidResetLink",
  SIGNUP_COMPLETION_REQUIRED: "accountPage.signupCompletionRequired",
  SIGNUP_COMPLETION_SUPERSEDED: "accountPage.signupCompletionSuperseded",
  TOKEN_EXPIRED: "accountPage.invalidResetLink",
  TOO_MANY_REQUESTS: "accountPage.tooManyRequests",
  USER_NOT_FOUND: "accountPage.invalidCredentials",
} as const;

type AuthErrorLike = {
  code?: unknown;
  data?: unknown;
  error?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

const authErrorValue = (error: unknown): AuthErrorLike | null => {
  if (!error || typeof error !== "object") return null;
  const outer = error as AuthErrorLike;
  for (const candidate of [outer, outer.data, outer.error]) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as AuthErrorLike;
    if (typeof value.code === "string" || value.status === 429 || value.statusCode === 429) return value;
    if (value.error && typeof value.error === "object") return value.error as AuthErrorLike;
  }
  return outer;
};

export const authClientErrorMessage = (
  error: unknown,
  translate: (key: ArchiveMessageKey) => string,
  fallback: string,
): string => {
  const value = authErrorValue(error);
  if (!value) return fallback;
  const code = typeof value.code === "string" ? value.code.toUpperCase() : "";
  const key = AUTH_ERROR_TRANSLATION_KEYS[code as keyof typeof AUTH_ERROR_TRANSLATION_KEYS];
  if (key) return translate(key);
  return value.status === 429 || value.statusCode === 429 ? translate("accountPage.tooManyRequests") : fallback;
};

export const authRequestErrorMessage = (error: unknown, fallback: string, timeout: string): string => {
  if (!(error instanceof Error)) return fallback;
  if (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /\b(?:abort(?:ed)?|timed? out|timeout)\b/i.test(error.message)
  ) {
    return timeout;
  }
  return fallback;
};
import type { ArchiveMessageKey } from "~/i18n/messages";
