interface Env {
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
}

declare namespace Cloudflare {
  interface Env {
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
  }
}
