import type { OAuthProvider } from "~/types/community";

export const OAUTH_PROVIDERS = ["github", "google", "twitter", "discord"] as const satisfies readonly OAuthProvider[];

export const isOAuthProvider = (value: string): value is OAuthProvider =>
  OAUTH_PROVIDERS.some((provider) => provider === value);

export const oauthProviderLabel = (provider: OAuthProvider): string => {
  if (provider === "twitter") return "X";
  if (provider === "github") return "GitHub";
  if (provider === "google") return "Google";
  return "Discord";
};
