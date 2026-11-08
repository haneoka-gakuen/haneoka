interface Env {
  OFFICIAL_ACCOUNT_ENCRYPTION_KEY?: string;
  OFFICIAL_GLOBAL_LOGIN_CONFIG?: string;
  OFFICIAL_JP_GUEST_CONFIG?: string;
  OFFICIAL_COLLECTOR_REMOTE_ORIGIN?: string;
  OFFICIAL_COLLECTOR_REMOTE_TOKEN?: string;
  OFFICIAL_CALLBACK_ORIGIN?: string;
  OFFICIAL_HOST_ORIGIN?: string;
  /** The other regional collectors, provided by the collector host. */
  OFFICIAL_RANKING_COLLECTOR?: { getByName(name: string): import("./official-ranking-collector").OfficialRankingCollector };
  TOOLS_SERVICE_URL?: string;
  TOOLS_SERVICE_TOKEN?: string;
  ADMIN_PACKAGE_MAX_BYTES?: string;
  BETTER_AUTH_SECRET?: string;
  BESTDORI_UPSTREAM_BASE?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  GITHUB_ACTIONS_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  LOCAL_MODERATION_MODE?: string;
  TWITTER_CLIENT_ID?: string;
  TWITTER_CLIENT_SECRET?: string;
  RESOURCE_PACKAGE_INGRESS?: R2Bucket;
  TURNSTILE_ENABLED?: string;
  TURNSTILE_SECRET_KEY?: string;
  KOFI_VERIFICATION_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env {
    OFFICIAL_ACCOUNT_ENCRYPTION_KEY?: string;
    OFFICIAL_GLOBAL_LOGIN_CONFIG?: string;
    OFFICIAL_JP_GUEST_CONFIG?: string;
    OFFICIAL_COLLECTOR_REMOTE_ORIGIN?: string;
    OFFICIAL_COLLECTOR_REMOTE_TOKEN?: string;
  OFFICIAL_CALLBACK_ORIGIN?: string;
  OFFICIAL_HOST_ORIGIN?: string;
  /** The other regional collectors, provided by the collector host. */
  OFFICIAL_RANKING_COLLECTOR?: { getByName(name: string): import("./official-ranking-collector").OfficialRankingCollector };
    TOOLS_SERVICE_URL?: string;
    TOOLS_SERVICE_TOKEN?: string;
    ADMIN_PACKAGE_MAX_BYTES?: string;
    BETTER_AUTH_SECRET?: string;
    BESTDORI_UPSTREAM_BASE?: string;
    DISCORD_CLIENT_ID?: string;
    DISCORD_CLIENT_SECRET?: string;
    GITHUB_ACTIONS_TOKEN?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    LOCAL_MODERATION_MODE?: string;
    TWITTER_CLIENT_ID?: string;
    TWITTER_CLIENT_SECRET?: string;
    RESOURCE_PACKAGE_INGRESS?: R2Bucket;
    TURNSTILE_ENABLED?: string;
    TURNSTILE_SECRET_KEY?: string;
    KOFI_VERIFICATION_TOKEN?: string;
  }
}
