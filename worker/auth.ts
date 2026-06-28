import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { captcha } from "better-auth/plugins";
import { communityAccessState } from "./access";
import { claimAuthEmailDelivery, queueAuthEmail, type EmailLocale } from "./email";
import { inspectCommunityText, scheduleEntityModeration } from "./moderation";
import { hashPassword, verifyPassword } from "./password";

const AUTH_PREFIX = "/api/auth";
const ACCOUNT_REGISTRATION_PATH = "/api/v1/account/register";
const AUTH_BODY_MAX = 32 * 1024;
const REGISTRATION_BODY_MAX = 1_024;
const REGISTRATION_RESPONSE_FLOOR_MS = 500;
const AUTH_ROUTES = new Map<string, ReadonlySet<string>>([
  ["/get-session", new Set(["GET", "HEAD"])],
  ["/sign-in/email", new Set(["POST"])],
  ["/sign-in/social", new Set(["POST"])],
  ["/sign-out", new Set(["POST"])],
  ["/send-verification-email", new Set(["POST"])],
  ["/verify-email", new Set(["GET"])],
  ["/request-password-reset", new Set(["POST"])],
  ["/reset-password", new Set(["POST"])],
  ["/change-email", new Set(["POST"])],
  ["/change-password", new Set(["POST"])],
  ["/list-accounts", new Set(["GET"])],
  ["/link-social", new Set(["POST"])],
  ["/unlink-account", new Set(["POST"])],
  ["/list-sessions", new Set(["GET"])],
  ["/revoke-session", new Set(["POST"])],
  ["/revoke-sessions", new Set(["POST"])],
  ["/revoke-other-sessions", new Set(["POST"])],
  ["/error", new Set(["GET"])],
  ["/ok", new Set(["GET"])],
]);

type ProviderId = "discord" | "github" | "google" | "twitter";

interface SocialProviderConfiguration {
  clientId: string;
  clientSecret: string;
}

type ConfiguredProviders = Partial<Record<ProviderId, SocialProviderConfiguration>>;

export interface AuthConfiguration {
  available: boolean;
  emailDeliveryEnabled: boolean;
  emailSignUpEnabled: boolean;
  providers: ProviderId[];
  turnstileSiteKey: string | null;
}

interface UserData {
  image?: string | null | undefined;
  name?: string | undefined;
}

const localHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

const TURNSTILE_ACTION_REGISTER = "account_register";
const TURNSTILE_ACTION_SIGN_IN = "account_sign_in";

const turnstileEnabled = (env: Env): boolean =>
  String(env.TURNSTILE_ENABLED || "false") === "true" && Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);

const configuredProviders = (env: Env): ConfiguredProviders => {
  const providers: ConfiguredProviders = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (env.TWITTER_CLIENT_ID && env.TWITTER_CLIENT_SECRET) {
    providers.twitter = {
      clientId: env.TWITTER_CLIENT_ID,
      clientSecret: env.TWITTER_CLIENT_SECRET,
    };
  }
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    providers.discord = {
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
    };
  }
  return providers;
};

const providerIds = (providers: ConfiguredProviders): ProviderId[] => {
  const result: ProviderId[] = [];
  if (providers.github) result.push("github");
  if (providers.google) result.push("google");
  if (providers.twitter) result.push("twitter");
  if (providers.discord) result.push("discord");
  return result;
};

const isProviderId = (value: string): value is ProviderId =>
  value === "discord" || value === "github" || value === "google" || value === "twitter";

const authBaseURL = (request: Request, env: Env): string => {
  const requestURL = new URL(request.url);
  if (localHost(requestURL.hostname)) return requestURL.origin;
  return String(env.BETTER_AUTH_URL || requestURL.origin).replace(/\/$/, "");
};

const EMAIL_LOCALE_COOKIE = "haneoka.locale";

const emailLocaleFor = (request: Request): EmailLocale => {
  const cookie = request.headers.get("Cookie") || "";
  const storedLocale = cookie
    .split(";")
    .map((entry) => entry.trim().split("=", 2))
    .find(([name]) => name === EMAIL_LOCALE_COOKIE)?.[1];
  if (
    storedLocale === "ja" ||
    storedLocale === "en" ||
    storedLocale === "zh-TW" ||
    storedLocale === "zh-CN" ||
    storedLocale === "ko"
  ) {
    return storedLocale;
  }

  for (const entry of (request.headers.get("Accept-Language") || "").split(",")) {
    const language = entry.trim().split(";", 1)[0]?.toLowerCase();
    if (language === "ja" || language?.startsWith("ja-")) return "ja";
    if (language === "ko" || language?.startsWith("ko-")) return "ko";
    if (language === "en" || language?.startsWith("en-")) return "en";
    if (language === "zh-tw" || language === "zh-hk" || language === "zh-mo" || language?.startsWith("zh-hant")) {
      return "zh-TW";
    }
    if (language === "zh" || language?.startsWith("zh-")) return "zh-CN";
  }
  return "ja";
};

export const authConfiguration = (env: Env): AuthConfiguration => {
  const providers = configuredProviders(env);
  const secret = String(env.BETTER_AUTH_SECRET || "");
  const hasTurnstile = turnstileEnabled(env);
  const emailDeliveryEnabled = Boolean(env.EMAIL && env.AUTH_EMAIL_FROM);
  return {
    available: Boolean(env.DB && secret.length >= 32),
    emailDeliveryEnabled,
    emailSignUpEnabled: emailDeliveryEnabled,
    providers: providerIds(providers),
    turnstileSiteKey: hasTurnstile && env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SITE_KEY : null,
  };
};

const validateUserName = <T extends UserData>(data: T): T & UserData => {
  let nameData: Pick<UserData, "name"> | Record<string, never> = {};
  if (data.name !== undefined) {
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name || [...name].length > 80) {
      throw new APIError("BAD_REQUEST", { message: "Display name must be 1-80 characters" });
    }
    nameData = { name };
  }
  return { ...data, ...nameData };
};

const prepareNewUserData = <T extends UserData>(data: T): T & UserData => ({
  ...validateUserName(data),
  // Provider-hosted avatars are never exposed directly. Users can opt in to the
  // private R2 avatar flow after the account exists.
  image: null,
});

const validateInternalUserUpdate = <T extends UserData>(data: T): T & UserData => {
  if (data.image !== undefined) {
    throw new APIError("BAD_REQUEST", { message: "Profile images must use the account avatar API" });
  }
  return validateUserName(data);
};

const EMAIL_ROUTES: ReadonlySet<string> = new Set([
  "/send-verification-email",
  "/verify-email",
  "/request-password-reset",
  "/reset-password",
  "/change-email",
]);

const routeAllowed = (pathname: string, method: string, config: AuthConfiguration): boolean => {
  const path = pathname.slice(AUTH_PREFIX.length);
  const methods = AUTH_ROUTES.get(path);
  if (methods && (!EMAIL_ROUTES.has(path) || config.emailDeliveryEnabled)) {
    return methods.has(method) || method === "OPTIONS";
  }
  if (config.emailDeliveryEnabled && /^\/reset-password\/[A-Za-z0-9_-]+$/.test(path)) return method === "GET";
  const callback = /^\/callback\/([a-z0-9-]{1,32})$/i.exec(path);
  if (!callback?.[1]) return false;
  const callbackProvider = callback[1].toLowerCase();
  return (
    isProviderId(callbackProvider) &&
    config.providers.includes(callbackProvider) &&
    new Set(["GET", "POST"]).has(method)
  );
};

const bodyTooLarge = async (request: Request): Promise<boolean> => {
  if (!request.body || new Set(["GET", "HEAD"]).has(request.method)) return false;
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > AUTH_BODY_MAX) {
    await request.body.cancel();
    return true;
  }
  const clonedBody = request.clone().body;
  if (!clonedBody) return false;
  const reader = clonedBody.getReader();
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return false;
    size += value.byteLength;
    if (size > AUTH_BODY_MAX) {
      await Promise.allSettled([reader.cancel(), request.body.cancel()]);
      return true;
    }
  }
};

const authError = (status: number, code: string, message: string, headers: HeadersInit = {}): Response =>
  Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } },
  );

type RegistrationCheck = { ok: false; response: Response } | { ok: true };
type RegistrationEmail = { ok: false; response: Response } | { email: string; ok: true };

const registrationSameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("Origin");
  if (!origin) return request.headers.get("Sec-Fetch-Site") !== "cross-site";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

const registrationClientAddress = (request: Request): string | null =>
  request.headers.get("cf-connecting-ipv6") || request.headers.get("cf-connecting-ip");

const readRegistrationEmail = async (request: Request): Promise<RegistrationEmail> => {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLocaleLowerCase("und");
  if (mediaType !== "application/json") {
    await request.body?.cancel();
    return { ok: false, response: authError(415, "content_type_required", "Use application/json") };
  }
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > REGISTRATION_BODY_MAX) {
      await request.body?.cancel();
      return { ok: false, response: authError(413, "request_too_large", "Registration request is too large") };
    }
  }
  if (!request.body) return { ok: false, response: authError(400, "invalid_body", "A JSON body is required") };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > REGISTRATION_BODY_MAX) {
    return {
      ok: false,
      response: authError(
        bytes.byteLength ? 413 : 400,
        bytes.byteLength ? "request_too_large" : "invalid_body",
        "Invalid body",
      ),
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return { ok: false, response: authError(400, "invalid_json", "The request body is not valid JSON") };
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("email" in body)
  ) {
    return { ok: false, response: authError(400, "invalid_body", "Registration accepts only an email address") };
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (
    email.length < 3 ||
    email.length > 254 ||
    /[\p{Cc}\p{Cs}]/u.test(email) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    return { ok: false, response: authError(400, "invalid_email", "Enter a valid email address") };
  }
  return { email, ok: true };
};

const verifyRegistrationCaptcha = async (request: Request, env: Env): Promise<RegistrationCheck> => {
  if (!turnstileEnabled(env) || !env.TURNSTILE_SECRET_KEY) return { ok: true };
  const token = request.headers.get("x-captcha-response") || "";
  if (!token || token.length > 2_048) {
    return { ok: false, response: authError(400, "captcha_response_missing", "Complete the verification challenge") };
  }
  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        ...(registrationClientAddress(request) ? { remoteip: registrationClientAddress(request) } : {}),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      redirect: "manual",
    });
  } catch {
    return { ok: false, response: authError(503, "captcha_unavailable", "Verification is temporarily unavailable") };
  }
  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    return { ok: false, response: authError(503, "captcha_unavailable", "Verification is temporarily unavailable") };
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return { ok: false, response: authError(503, "captcha_unavailable", "Verification is temporarily unavailable") };
  }
  if (!result || typeof result !== "object") {
    return { ok: false, response: authError(503, "captcha_unavailable", "Verification is temporarily unavailable") };
  }
  const success = "success" in result && result.success === true;
  const hostname = "hostname" in result && typeof result.hostname === "string" ? result.hostname : null;
  const action = "action" in result && typeof result.action === "string" ? result.action : null;
  const allowedHostnames = String(env.TURNSTILE_ALLOWED_HOSTNAMES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !success ||
    action !== TURNSTILE_ACTION_REGISTER ||
    (allowedHostnames.length > 0 && (!hostname || !allowedHostnames.includes(hostname)))
  ) {
    return { ok: false, response: authError(403, "captcha_verification_failed", "Verification failed") };
  }
  return { ok: true };
};

const registrationRateLimit = async (request: Request, env: Env): Promise<RegistrationCheck> => {
  if (!env.COMMUNITY_RATE_LIMITER) return { ok: true };
  const limited = await env.COMMUNITY_RATE_LIMITER.limit({
    key: `account-register:${registrationClientAddress(request) || "unknown"}`,
  });
  return limited.success
    ? { ok: true }
    : {
        ok: false,
        response: authError(429, "rate_limit_exceeded", "Too many registration requests", { "Retry-After": "60" }),
      };
};

const registrationAccepted = async (startedAt: number): Promise<Response> => {
  const remaining = REGISTRATION_RESPONSE_FLOOR_MS - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return Response.json(
    { accepted: true },
    {
      status: 202,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
};

type ConfiguredAuthEnv = Env & { BETTER_AUTH_SECRET: string };

function assertAuthConfiguration(env: Env): asserts env is ConfiguredAuthEnv {
  const config = authConfiguration(env);
  if (!env.DB) throw new Error("The DB binding is required for authentication");
  if (!config.available) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
}

interface CreatedProfileNameRow {
  displayNameRevision: number;
  pendingDisplayName: string | null;
}

interface SignupCompletionRow {
  claimTokenExpiresAt: number;
  claimTokenHash: string;
  credentialId: string;
  generation: number;
  name: string;
  userId: string;
}

interface ResetPasswordPayload {
  newPassword: string;
  token: string;
}

interface SignupCompletionState {
  generation: number;
  hasClaim: number;
}

interface RegistrationUserRow {
  email: string;
  emailVerified: number;
  hasCredential: number;
  id: string;
  name: string;
}

const signupCompletionRequired = async (env: Env, userId: string): Promise<boolean> => {
  const row = await env.DB.prepare(
    `SELECT 1 AS required
     FROM auth_signup_completion
     WHERE user_id = ?
     LIMIT 1`,
  )
    .bind(userId)
    .first<{ required: number }>();
  return row?.required === 1;
};

const signupClaimTokenHash = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const signupCompletionState = async (env: Env, userId: string): Promise<SignupCompletionState | null> => {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO auth_signup_completion
       (user_id, required_at, generation, claim_token_hash, claim_token_expires_at, updated_at)
     SELECT id, ?, 1, NULL, NULL, ?
     FROM "user"
     WHERE id = ? AND emailVerified = 0
     ON CONFLICT(user_id) DO NOTHING`,
  )
    .bind(now, now, userId)
    .run();
  const state = await env.DB.prepare(
    `SELECT generation, claim_token_hash IS NOT NULL AS hasClaim
     FROM auth_signup_completion
     WHERE user_id = ?
     LIMIT 1`,
  )
    .bind(userId)
    .first<SignupCompletionState>();
  return state && Number.isSafeInteger(state.generation) && state.generation >= 1 ? state : null;
};

const deleteSignupResetTokens = async (env: Env, userId: string): Promise<void> => {
  await env.DB.prepare(
    `DELETE FROM verification
     WHERE value = ? AND identifier LIKE 'reset-password:%'`,
  )
    .bind(userId)
    .run();
};

const rotateSignupCompletion = async (env: Env, userId: string, generation: number): Promise<number | null> => {
  const nextGeneration = generation + 1;
  if (!Number.isSafeInteger(nextGeneration)) return null;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE auth_signup_completion
       SET generation = generation + 1,
           claim_token_hash = NULL,
           claim_token_expires_at = NULL,
           updated_at = MAX(updated_at, ?)
       WHERE user_id = ? AND generation = ? AND claim_token_hash IS NOT NULL`,
    ).bind(Date.now(), userId, generation),
    env.DB.prepare(
      `DELETE FROM verification
       WHERE value = ?
         AND identifier LIKE 'reset-password:%'
         AND EXISTS (
           SELECT 1 FROM auth_signup_completion
           WHERE user_id = ?
             AND generation = ?
             AND claim_token_hash IS NULL
         )`,
    ).bind(userId, userId, nextGeneration),
  ]);
  return Number(results[0]?.meta.changes || 0) === 1 ? nextGeneration : null;
};

const scheduleInitialProfileName = async (
  env: Env,
  user: { emailVerified?: boolean; id: string; name: string },
): Promise<void> => {
  if (user.emailVerified === false) return;
  const profile = await env.DB.prepare(
    `SELECT pending_display_name AS pendingDisplayName, display_name_revision AS displayNameRevision
     FROM community_profile
     WHERE user_id = ?
     LIMIT 1`,
  )
    .bind(user.id)
    .first<CreatedProfileNameRow>();
  if (!profile || profile.pendingDisplayName !== user.name || profile.displayNameRevision < 1) return;
  try {
    await scheduleEntityModeration(
      env,
      "profile-name",
      user.id,
      inspectCommunityText(profile.pendingDisplayName),
      profile.displayNameRevision,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        errorName: error instanceof Error ? error.name : "ProfileNameModerationError",
        event: "auth.initial_profile_name_moderation_failed",
        userId: user.id,
      }),
    );
  }
};

const passwordSetupURLForGeneration = async (
  env: ConfiguredAuthEnv,
  baseURL: string,
  user: { email: string; id: string },
  generation: number,
): Promise<string | null> => {
  const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1_000);
  const tokenHash = await signupClaimTokenHash(token);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
       SELECT ?, ?, completion.user_id, ?, ?, ?
       FROM auth_signup_completion AS completion
       WHERE completion.user_id = ?
         AND completion.generation = ?
         AND completion.claim_token_hash IS NULL`,
    ).bind(
      crypto.randomUUID(),
      `reset-password:${token}`,
      expiresAt.toISOString(),
      now.toISOString(),
      now.toISOString(),
      user.id,
      generation,
    ),
    env.DB.prepare(
      `UPDATE auth_signup_completion
       SET claim_token_hash = ?, claim_token_expires_at = ?, updated_at = MAX(updated_at, ?)
       WHERE user_id = ?
         AND generation = ?
         AND claim_token_hash IS NULL`,
    ).bind(tokenHash, expiresAt.getTime(), now.getTime(), user.id, generation),
  ]);
  if (Number(results[0]?.meta.changes || 0) !== 1 || Number(results[1]?.meta.changes || 0) !== 1) return null;
  const setupURL = new URL(`/api/auth/reset-password/${token}`, baseURL);
  setupURL.searchParams.set("callbackURL", "/account/reset-password?claim=1");
  return setupURL.toString();
};

const passwordSetupURL = async (
  env: ConfiguredAuthEnv,
  baseURL: string,
  user: { email: string; id: string },
): Promise<string | null> => {
  const state = await signupCompletionState(env, user.id);
  if (!state) return null;
  // A throttled anonymous retry must not invalidate a link already delivered
  // to the mailbox owner. Rotation begins only after the resend slot is won.
  if (!(await claimAuthEmailDelivery(env, user.email, "continue-signup"))) return null;
  let generation = state.generation;
  if (state.hasClaim === 1) {
    const rotated = await rotateSignupCompletion(env, user.id, state.generation);
    if (rotated === null) return null;
    generation = rotated;
  } else {
    await deleteSignupResetTokens(env, user.id);
  }
  return passwordSetupURLForGeneration(env, baseURL, user, generation);
};

const registrationUser = (env: Env, email: string): Promise<RegistrationUserRow | null> =>
  env.DB.prepare(
    `SELECT account.id, account.email, account.name, account.emailVerified,
            EXISTS(
              SELECT 1 FROM account AS credential
              WHERE credential.userId = account.id AND credential.providerId = 'credential'
            ) AS hasCredential
     FROM "user" AS account
     WHERE account.email = ? COLLATE NOCASE
     ORDER BY account.createdAt ASC
     LIMIT 1`,
  )
    .bind(email)
    .first<RegistrationUserRow>();

const opaqueRegistrationSecret = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const registrationDefaultName = (): string =>
  `haneoka-${crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;

const createPendingRegistration = async (env: Env, email: string): Promise<RegistrationUserRow> => {
  const userId = crypto.randomUUID();
  const name = registrationDefaultName();
  const password = await hashPassword(`pending-registration:${opaqueRegistrationSecret()}`);
  const now = new Date();
  const accountId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, NULL, ?, ?)`,
    ).bind(userId, name, email, now.toISOString(), now.toISOString()),
    env.DB.prepare(
      `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
       VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
    ).bind(accountId, userId, userId, password, now.toISOString(), now.toISOString()),
    env.DB.prepare(
      `INSERT INTO auth_signup_completion
         (user_id, required_at, generation, claim_token_hash, claim_token_expires_at, updated_at)
       VALUES (?, ?, 1, NULL, NULL, ?)`,
    ).bind(userId, now.getTime(), now.getTime()),
  ]);
  // D1 may include trigger-side profile writes in a statement's change count.
  // Every statement must change at least its directly inserted row.
  if (results.some((result) => Number(result.meta.changes || 0) < 1)) {
    throw new Error("Pending registration was not created atomically");
  }
  return { email, emailVerified: 0, hasCredential: 1, id: userId, name };
};

const ensurePendingCredential = async (env: Env, user: RegistrationUserRow, generation: number): Promise<void> => {
  if (user.hasCredential === 1) return;
  const now = new Date().toISOString();
  const password = await hashPassword(`pending-registration:${opaqueRegistrationSecret()}`);
  await env.DB.prepare(
    `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
     SELECT ?, pending.id, 'credential', pending.id, ?, ?, ?
     FROM "user" AS pending
     WHERE pending.id = ?
       AND pending.emailVerified = 0
       AND EXISTS (
         SELECT 1 FROM auth_signup_completion AS completion
         WHERE completion.user_id = pending.id AND completion.generation = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM account AS credential
         WHERE credential.userId = pending.id AND credential.providerId = 'credential'
       )
     ON CONFLICT(providerId, accountId) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), password, now, now, user.id, generation)
    .run();
};

const processEmailRegistration = async (
  env: ConfiguredAuthEnv,
  baseURL: string,
  email: string,
  locale: EmailLocale,
): Promise<void> => {
  let user = await registrationUser(env, email);
  if (!user) {
    try {
      user = await createPendingRegistration(env, email);
    } catch (error) {
      user = await registrationUser(env, email);
      if (!user) throw error;
    }
  }
  if (user.emailVerified === 1) return;
  const state = await signupCompletionState(env, user.id);
  if (!state) return;
  await ensurePendingCredential(env, user, state.generation);
  const setupURL = await passwordSetupURL(env, baseURL, user);
  if (!setupURL) return;
  queueAuthEmail(env, baseURL, {
    actionURL: setupURL,
    kind: "continue-signup",
    locale,
    recipient: user.email,
    userName: user.name,
  });
};

const resetPasswordPayload = async (request: Request): Promise<ResetPasswordPayload | null> => {
  try {
    const payload = (await request.clone().json()) as { newPassword?: unknown; token?: unknown };
    const token = typeof payload.token === "string" ? payload.token : new URL(request.url).searchParams.get("token");
    return token && /^[A-Za-z0-9_-]{16,256}$/u.test(token) && typeof payload.newPassword === "string"
      ? { newPassword: payload.newPassword, token }
      : null;
  } catch {
    return null;
  }
};

const signupCompletionForToken = async (env: Env, token: string): Promise<SignupCompletionRow | null> =>
  env.DB.prepare(
    `SELECT completion.user_id AS userId,
            completion.generation,
            completion.claim_token_hash AS claimTokenHash,
            completion.claim_token_expires_at AS claimTokenExpiresAt,
            account.name,
            credential.id AS credentialId
     FROM verification AS reset_token
     JOIN auth_signup_completion AS completion ON completion.user_id = reset_token.value
     JOIN "user" AS account ON account.id = completion.user_id AND account.emailVerified = 0
     JOIN account AS credential
       ON credential.userId = completion.user_id
      AND credential.providerId = 'credential'
     WHERE reset_token.identifier = ?
     LIMIT 1`,
  )
    .bind(`reset-password:${token}`)
    .first<SignupCompletionRow>();

const completeSignupWithPassword = async (
  env: Env,
  completion: SignupCompletionRow,
  payload: ResetPasswordPayload,
): Promise<boolean> => {
  const now = new Date();
  const nowISO = now.toISOString();
  const tokenHash = await signupClaimTokenHash(payload.token);
  if (tokenHash !== completion.claimTokenHash || completion.claimTokenExpiresAt < now.getTime()) return false;
  const password = await hashPassword(payload.newPassword);
  const tokenIdentifier = `reset-password:${payload.token}`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE account
       SET password = ?, updatedAt = ?
       WHERE id = ?
         AND userId = ?
         AND providerId = 'credential'
         AND EXISTS (
           SELECT 1
           FROM auth_signup_completion AS pending
           JOIN verification AS reset_token
             ON reset_token.identifier = ?
            AND reset_token.value = pending.user_id
            AND reset_token.expiresAt >= ?
           WHERE pending.user_id = ?
             AND pending.generation = ?
             AND pending.claim_token_hash = ?
             AND pending.claim_token_expires_at >= ?
         )`,
    ).bind(
      password,
      nowISO,
      completion.credentialId,
      completion.userId,
      tokenIdentifier,
      nowISO,
      completion.userId,
      completion.generation,
      tokenHash,
      now.getTime(),
    ),
    env.DB.prepare(
      `DELETE FROM verification
       WHERE identifier = ?
         AND value = ?
         AND expiresAt >= ?
         AND EXISTS (
           SELECT 1 FROM account
           WHERE id = ? AND userId = ? AND providerId = 'credential' AND password = ?
         )
         AND EXISTS (
           SELECT 1 FROM auth_signup_completion
           WHERE user_id = ? AND generation = ? AND claim_token_hash = ?
         )`,
    ).bind(
      tokenIdentifier,
      completion.userId,
      nowISO,
      completion.credentialId,
      completion.userId,
      password,
      completion.userId,
      completion.generation,
      tokenHash,
    ),
    env.DB.prepare(
      `DELETE FROM auth_signup_completion
       WHERE user_id = ?
         AND generation = ?
         AND claim_token_hash = ?
         AND claim_token_expires_at >= ?
         AND EXISTS (
           SELECT 1 FROM account
           WHERE id = ? AND userId = ? AND providerId = 'credential' AND password = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM verification WHERE identifier = ? AND value = ?
         )`,
    ).bind(
      completion.userId,
      completion.generation,
      tokenHash,
      now.getTime(),
      completion.credentialId,
      completion.userId,
      password,
      tokenIdentifier,
      completion.userId,
    ),
    env.DB.prepare(
      `UPDATE "user"
       SET emailVerified = 1, updatedAt = ?
       WHERE id = ?
         AND emailVerified = 0
         AND NOT EXISTS (
           SELECT 1 FROM auth_signup_completion WHERE user_id = ?
         )
         AND EXISTS (
           SELECT 1 FROM account
           WHERE id = ? AND userId = ? AND providerId = 'credential' AND password = ?
         )`,
    ).bind(nowISO, completion.userId, completion.userId, completion.credentialId, completion.userId, password),
    env.DB.prepare(
      `DELETE FROM "session"
       WHERE userId = ?
         AND EXISTS (
           SELECT 1 FROM "user" WHERE id = ? AND emailVerified = 1
         )
         AND EXISTS (
           SELECT 1 FROM account
           WHERE id = ? AND userId = ? AND providerId = 'credential' AND password = ?
         )`,
    ).bind(completion.userId, completion.userId, completion.credentialId, completion.userId, password),
  ]);
  const passwordChanged = Number(results[0]?.meta.changes || 0) === 1;
  const tokenConsumed = Number(results[1]?.meta.changes || 0) === 1;
  const completionClaimed = Number(results[2]?.meta.changes || 0) === 1;
  const newlyVerified = Number(results[3]?.meta.changes || 0) >= 1;
  if (passwordChanged && tokenConsumed && completionClaimed && newlyVerified) {
    await scheduleInitialProfileName(env, {
      emailVerified: true,
      id: completion.userId,
      name: completion.name,
    });
    return true;
  }
  return false;
};

const handleSignupPasswordCompletion = async (request: Request, env: Env): Promise<Response | null> => {
  const payload = await resetPasswordPayload(request);
  if (!payload) return null;
  const completion = await signupCompletionForToken(env, payload.token);
  if (!completion) return null;
  if (payload.newPassword.length < 12) {
    return authError(400, "password_too_short", "Password must contain at least 12 characters");
  }
  if (payload.newPassword.length > 128) {
    return authError(400, "password_too_long", "Password must contain no more than 128 characters");
  }
  if (await completeSignupWithPassword(env, completion, payload)) {
    return Response.json(
      { status: true },
      { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  }
  return authError(
    409,
    "signup_completion_superseded",
    "A newer account setup link was issued; use the latest email to finish setup",
  );
};

const buildAuth = (
  env: ConfiguredAuthEnv,
  baseURL: string,
  config: AuthConfiguration,
  providers: ConfiguredProviders,
  plugins: BetterAuthPlugin[],
  locale: EmailLocale,
) =>
  betterAuth({
    appName: "haneoka",
    baseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [baseURL],
    ...(config.emailDeliveryEnabled
      ? {
          emailVerification: {
            expiresIn: 60 * 60,
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: false,
            beforeEmailVerification: async (user: { id: string }) => {
              if (await signupCompletionRequired(env, user.id)) {
                throw new APIError("FORBIDDEN", {
                  code: "SIGNUP_COMPLETION_REQUIRED",
                  message: "Choose the final password from the latest account setup email first",
                });
              }
            },
            sendVerificationEmail: async ({
              user,
              url,
            }: {
              user: { email: string; id: string; name: string };
              url: string;
            }) => {
              if (await signupCompletionRequired(env, user.id)) {
                const setupURL = await passwordSetupURL(env, baseURL, user);
                if (!setupURL) return;
                queueAuthEmail(env, baseURL, {
                  actionURL: setupURL,
                  kind: "continue-signup",
                  locale,
                  recipient: user.email,
                  userName: user.name,
                });
                return;
              }
              if (!(await claimAuthEmailDelivery(env, user.email, "verify-email"))) return;
              queueAuthEmail(env, baseURL, {
                actionURL: url,
                kind: "verify-email",
                locale,
                recipient: user.email,
                userName: user.name,
              });
            },
          },
        }
      : {}),
    emailAndPassword: {
      enabled: true,
      // Public password sign-up is intentionally unavailable. Email-only
      // registration is handled by /api/v1/account/register, and only the
      // server creates the temporary credential used before mailbox proof.
      disableSignUp: true,
      requireEmailVerification: config.emailDeliveryEnabled,
      autoSignIn: !config.emailDeliveryEnabled,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      password: {
        hash: hashPassword,
        verify: verifyPassword,
      },
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      ...(config.emailDeliveryEnabled
        ? {
            sendResetPassword: async ({
              user,
              url,
            }: {
              user: { email: string; id: string; name: string };
              url: string;
            }) => {
              if (await signupCompletionRequired(env, user.id)) {
                const setupURL = await passwordSetupURL(env, baseURL, user);
                if (!setupURL) return;
                queueAuthEmail(env, baseURL, {
                  actionURL: setupURL,
                  kind: "continue-signup",
                  locale,
                  recipient: user.email,
                  userName: user.name,
                });
                return;
              }
              if (!(await claimAuthEmailDelivery(env, user.email, "reset-password"))) return;
              queueAuthEmail(env, baseURL, {
                actionURL: url,
                kind: "reset-password",
                locale,
                recipient: user.email,
                userName: user.name,
              });
            },
            onPasswordReset: async ({ user }: { user: { id: string; name: string } }) => {
              const now = new Date().toISOString();
              const verified = await env.DB.prepare(
                `UPDATE "user"
                 SET emailVerified = 1, updatedAt = ?
                 WHERE id = ?
                   AND emailVerified = 0
                   AND NOT EXISTS (
                     SELECT 1 FROM auth_signup_completion WHERE user_id = ?
                   )`,
              )
                .bind(now, user.id, user.id)
                .run();
              if (Number(verified.meta.changes || 0) > 0) {
                await scheduleInitialProfileName(env, { ...user, emailVerified: true });
              }
            },
          }
        : {}),
    },
    user: {
      changeEmail: {
        enabled: config.emailDeliveryEnabled,
        updateEmailWithoutVerification: false,
        ...(config.emailDeliveryEnabled
          ? {
              sendChangeEmailConfirmation: async ({
                user,
                newEmail,
                url,
              }: {
                user: { email: string; name: string };
                newEmail: string;
                url: string;
              }) => {
                if (!(await claimAuthEmailDelivery(env, user.email, "verify-email-change"))) return;
                queueAuthEmail(env, baseURL, {
                  actionURL: url,
                  kind: "verify-email-change",
                  locale,
                  newEmail,
                  recipient: user.email,
                  userName: user.name,
                });
              },
            }
          : {}),
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      // Internal authorization reads explicitly disable refresh below, so
      // only the public session endpoint performs this once-daily write.
      updateAge: 60 * 60 * 24,
      // Better Auth's signed short-lived cache keeps ordinary reads off D1.
      // Mutations and staff APIs bypass it through getAuthSession below.
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
        strategy: "compact",
      },
      // Account and admin code applies explicit step-up checks only to the
      // small set of genuinely sensitive operations. Better Auth's global
      // freshness gate otherwise reports a valid session as "expired".
      freshAge: 0,
    },
    account: {
      encryptOAuthTokens: true,
      // OAuth state is short-lived, encrypted and bound to the browser. A
      // cookie avoids putting a D1 write on the critical redirect path.
      storeStateStrategy: "cookie",
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
        updateUserInfoOnLink: false,
      },
    },
    socialProviders: providers,
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({ data: prepareNewUserData(user) }),
          after: async (user) => scheduleInitialProfileName(env, user),
        },
        update: {
          before: async (user) => ({ data: validateInternalUserUpdate(user) }),
          after: async (user) => scheduleInitialProfileName(env, user),
        },
      },
      session: {
        create: {
          before: async (session) => {
            const access = await communityAccessState(env, session.userId, ["sign_in"]);
            if (!access || access.status === "deleted") {
              throw new APIError("FORBIDDEN", { message: "Account is unavailable" });
            }
            if (access.restriction) {
              throw new APIError("FORBIDDEN", { message: "Account sign-in is restricted" });
            }
            return { data: session };
          },
        },
      },
    },
    advanced: {
      cookiePrefix: "haneoka",
      useSecureCookies: new URL(baseURL).protocol === "https:",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: new URL(baseURL).protocol === "https:",
      },
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ipv6", "cf-connecting-ip"],
      },
    },
    plugins,
  });

type HaneokaAuth = ReturnType<typeof buildAuth>;

interface AuthCacheEntry {
  auth: HaneokaAuth;
  key: string;
}

const authCache = new WeakMap<D1Database, AuthCacheEntry>();

export const createAuth = (request: Request, env: Env): HaneokaAuth => {
  assertAuthConfiguration(env);
  const config = authConfiguration(env);
  const baseURL = authBaseURL(request, env);
  const locale = emailLocaleFor(request);
  const providers = configuredProviders(env);
  const cacheKey = JSON.stringify({
    baseURL,
    emailSignUp: config.emailSignUpEnabled,
    emailDelivery: config.emailDeliveryEnabled,
    emailFrom: env.AUTH_EMAIL_FROM,
    locale,
    providers: config.providers,
    turnstile: turnstileEnabled(env),
  });
  const cached = authCache.get(env.DB);
  if (cached?.key === cacheKey) return cached.auth;

  const plugins: BetterAuthPlugin[] = [];
  if (turnstileEnabled(env) && env.TURNSTILE_SECRET_KEY) {
    const allowedHostnames = String(env.TURNSTILE_ALLOWED_HOSTNAMES || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    plugins.push(
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: env.TURNSTILE_SECRET_KEY,
        endpoints: ["/sign-in/email", "/sign-in/social"],
        expectedAction: TURNSTILE_ACTION_SIGN_IN,
        ...(allowedHostnames.length ? { allowedHostnames } : {}),
      }),
    );
  }

  const auth = buildAuth(env, baseURL, config, providers, plugins, locale);

  authCache.set(env.DB, { key: cacheKey, auth });
  return auth;
};

export type AuthSession = Awaited<ReturnType<HaneokaAuth["api"]["getSession"]>>;

export const getAuthSession = async (
  request: Request,
  env: Env,
  options: { authoritative?: boolean } = {},
): Promise<AuthSession | null> => {
  if (!authConfiguration(env).available) return null;
  // Internal authorization reads cannot forward Set-Cookie to the browser,
  // so they never consume its refresh window. GET/HEAD requests may use the
  // signed five-minute Better Auth cache; mutations and explicit staff reads
  // always validate the durable D1 session. Restrictions are checked by the
  // mutation/staff guards, while issuing a sign-in restriction or deleting an
  // account revokes its durable sessions.
  const authoritative = options.authoritative ?? (request.method !== "GET" && request.method !== "HEAD");
  return createAuth(request, env).api.getSession({
    headers: request.headers,
    query: { disableCookieCache: authoritative, disableRefresh: true },
  });
};

export const handleAccountRegistrationRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== ACCOUNT_REGISTRATION_PATH) return null;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "POST, OPTIONS" } });
  }
  if (request.method !== "POST") {
    return authError(405, "method_not_allowed", "Method not allowed", { Allow: "POST, OPTIONS" });
  }
  if (!registrationSameOrigin(request)) {
    return authError(403, "cross_origin_request", "Cross-origin registration requests are not allowed");
  }
  const config = authConfiguration(env);
  if (!config.available || !config.emailDeliveryEnabled) {
    return authError(503, "registration_unavailable", "Email registration is temporarily unavailable");
  }
  const startedAt = Date.now();
  const rateLimit = await registrationRateLimit(request, env);
  if (!rateLimit.ok) return rateLimit.response;
  const email = await readRegistrationEmail(request);
  if (!email.ok) return email.response;
  const captchaResult = await verifyRegistrationCaptcha(request, env);
  if (!captchaResult.ok) return captchaResult.response;
  assertAuthConfiguration(env);
  try {
    await processEmailRegistration(env, authBaseURL(request, env), email.email, emailLocaleFor(request));
  } catch (error) {
    console.error(
      JSON.stringify({
        errorName: error instanceof Error ? error.name : "RegistrationError",
        event: "auth.email_registration_failed",
      }),
    );
  }
  return registrationAccepted(startedAt);
};

export const handleAuthRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== AUTH_PREFIX && !url.pathname.startsWith(`${AUTH_PREFIX}/`)) return null;
  const config = authConfiguration(env);
  if (!routeAllowed(url.pathname, request.method, config)) {
    return authError(404, "auth_route_not_found", "Authentication route not found");
  }
  if (await bodyTooLarge(request)) return authError(413, "request_too_large", "Authentication request is too large");
  if (!config.available) {
    return Response.json(
      { error: { code: "auth_not_configured", message: "Authentication is not configured" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const auth = createAuth(request, env);
  const authPath = url.pathname.slice(AUTH_PREFIX.length);
  if (request.method === "POST" && authPath === "/reset-password") {
    const signupCompletionResponse = await handleSignupPasswordCompletion(request, env);
    if (signupCompletionResponse) return signupCompletionResponse;
  }
  const response = await auth.handler(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Expires", "0");
  headers.set("Pragma", "no-cache");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};
