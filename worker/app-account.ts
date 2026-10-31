// L3 — GEB
// Input: App bearer sessions, browser handoffs and imported player summaries.
// Output: PKCE sign-in, same-session browser cookies and linked game accounts.
// Pos: [Map](L2.md); native app account transport.
// Effects/Dependencies: Better Auth, D1 sessions/codes and private account records.
import { profileRegion } from "../src/lib/game-records";
import { createAuth, getAuthSession } from "./auth";

/**
 * The Haneoka app's account surface.
 *
 * Sign-in: the app opens /{locale}/account/app/ in the system browser with a
 * PKCE challenge. Once the reader is signed in there (the site's own sign-in,
 * captcha and providers), the page asks for a one-time code bound to that
 * challenge and hands it to the app's callback. The app exchanges the code
 * and its verifier for a session of its own, sent as a bearer token and
 * revocable like any other session.
 *
 * Game accounts: a signed-in reader links the Our Notes players they import
 * in the app (`community_game_account`, provider `our-notes`, region = the
 * release server). Each import adds an immutable snapshot of the player's
 * public summary, never the save; a player ID on one server belongs to one
 * Haneoka account at a time.
 */
const AUTHORIZE_PATH = "/api/v1/account/app/authorize";
const TOKEN_PATH = "/api/v1/account/app/token";
const WEB_PATH = "/api/v1/account/app/web";
const OAUTH_PATH = "/api/v1/account/app/oauth";
const OAUTH_RETURN_PATH = "/api/v1/account/app/oauth/return";
const GAME_ACCOUNTS_PATH = "/api/v1/account/game-accounts";
const CODE_TTL_MS = 2 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024;
const SERVERS = new Set(["jp", "intl"]);
const CALLBACK = "haneoka://auth";

const json = (value: object, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
const error = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);

const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("Origin");
  if (!origin) return request.headers.get("Sec-Fetch-Site") !== "cross-site";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const base64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};
const sha256 = async (value: string): Promise<string> =>
  base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

/** RFC 7636: 43–128 unreserved characters. */
const PKCE = /^[A-Za-z0-9\-._~]{43,128}$/u;

const authorize = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") return error(405, "method_not_allowed", "Method not allowed");
  if (!sameOrigin(request)) return error(403, "cross_origin_request", "Cross-origin requests are not allowed");
  const session = await getAuthSession(request, env, { authoritative: true });
  if (!session?.user?.id) return error(401, "unauthenticated", "Sign in first");
  const body = await readJson(request);
  const challenge = typeof body?.challenge === "string" ? body.challenge : "";
  if (!/^[A-Za-z0-9\-_]{43}$/u.test(challenge)) return error(400, "invalid_challenge", "A S256 code challenge is required");
  return json({ code: await issueCode(env, session.user.id, challenge), callback: CALLBACK });
};

/** A one-time code for [userId], redeemable once with the verifier of [challenge]. */
const issueCode = async (env: Env, userId: string, challenge: string): Promise<string> => {
  const code = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_auth_code WHERE expires_at < ?").bind(now),
    env.DB.prepare(
      "INSERT INTO app_auth_code (code_hash, user_id, challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(await sha256(code), userId, challenge, now, now + CODE_TTL_MS),
  ]);
  return code;
};

/** The app's callback: its scheme, or a desktop build's loopback listener (RFC 8252). */
const appCallback = (requested: string | null): string =>
  requested && /^http:\/\/(?:localhost|127\.0\.0\.1):\d{4,5}\/auth$/u.test(requested) ? requested : CALLBACK;

const redirect = (location: string, cookies: readonly string[] = []): Response => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
};

/**
 * Provider sign-in for the app, with no page in between: the browser goes from here straight to the provider
 * (carrying the OAuth state cookie this response sets), back through the provider callback, and then to
 * [oauthReturn], which hands the app a one-time code.
 */
const oauthStart = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (request.method !== "GET") return error(405, "method_not_allowed", "Method not allowed");
  const provider = url.searchParams.get("provider") || "";
  const challenge = url.searchParams.get("challenge") || "";
  const state = url.searchParams.get("state") || "";
  if (!/^[a-z]{2,16}$/u.test(provider) || !/^[A-Za-z0-9\-_]{43}$/u.test(challenge) || !/^[A-Za-z0-9\-_]{1,128}$/u.test(state))
    return error(400, "invalid_request", "provider, challenge and state are required");
  const back = new URLSearchParams({ challenge, state });
  const requested = url.searchParams.get("redirect");
  if (requested) back.set("redirect", requested);
  const returnPath = `${OAUTH_RETURN_PATH}?${back}`;
  const started = await createAuth(request, env).handler(
    new Request(new URL("/api/auth/sign-in/social", url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        "User-Agent": request.headers.get("User-Agent") || "Haneoka app",
        ...(request.headers.get("CF-Connecting-IP") ? { "CF-Connecting-IP": request.headers.get("CF-Connecting-IP")! } : {}),
      },
      body: JSON.stringify({ provider, callbackURL: returnPath, errorCallbackURL: `${returnPath}&failed=1` }),
    }),
  );
  const target = started.ok ? ((await started.json()) as { url?: unknown }).url : undefined;
  if (typeof target !== "string") return redirect(`${appCallback(requested)}?${new URLSearchParams({ error: "provider_unavailable", state })}`);
  return redirect(target, started.headers.getSetCookie());
};

const oauthReturn = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const challenge = url.searchParams.get("challenge") || "";
  const state = url.searchParams.get("state") || "";
  const callback = appCallback(url.searchParams.get("redirect"));
  const fail = (code: string) => redirect(`${callback}?${new URLSearchParams({ error: code, state })}`);
  if (request.method !== "GET" || !/^[A-Za-z0-9\-_]{43}$/u.test(challenge)) return fail("invalid_request");
  if (url.searchParams.get("failed")) {
    const error = url.searchParams.get("error");
    return fail(error === "access_denied" || error === "account_not_linked" ? error : "provider_unavailable");
  }
  const session = await getAuthSession(request, env, { authoritative: true });
  if (!session?.user?.id) return fail("access_denied");
  const code = await issueCode(env, session.user.id, challenge);
  // The browser only carried the sign-in; the app holds its own session after the exchange.
  const signedOut = await createAuth(request, env).api.signOut({ headers: request.headers, asResponse: true });
  return redirect(`${callback}?${new URLSearchParams({ code, state })}`, signedOut.headers.getSetCookie());
};

const token = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") return error(405, "method_not_allowed", "Method not allowed");
  const body = await readJson(request);
  const code = typeof body?.code === "string" ? body.code : "";
  const verifier = typeof body?.verifier === "string" ? body.verifier : "";
  if (!code || code.length > 64 || !PKCE.test(verifier)) return error(400, "invalid_request", "code and verifier are required");
  // Claim the code once, whatever happens next.
  const row = await env.DB.prepare(
    "DELETE FROM app_auth_code WHERE code_hash = ? RETURNING user_id AS userId, challenge, expires_at AS expiresAt",
  )
    .bind(await sha256(code))
    .first<{ userId: string; challenge: string; expiresAt: number }>();
  if (!row || row.expiresAt < Date.now() || (await sha256(verifier)) !== row.challenge)
    return error(400, "invalid_grant", "The code is invalid or has expired");
  const context = await createAuth(request, env).$context;
  const created = await context.internalAdapter.createSession(row.userId, false, {
    userAgent: (request.headers.get("User-Agent") || "Haneoka app").slice(0, 256),
  });
  return json({ token: created.token, expiresAt: new Date(created.expiresAt).toISOString() });
};

const webSession = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (request.method !== "GET") return error(405, "method_not_allowed", "Method not allowed");
  if (!sameOrigin(request)) return error(403, "cross_origin_request", "Cross-origin requests are not allowed");
  if (!/^Bearer \S+$/iu.test(request.headers.get("Authorization") || ""))
    return error(401, "unauthenticated", "Sign in first");
  let destination: URL;
  try {
    destination = new URL(url.searchParams.get("returnTo") || "/", url.origin);
  } catch {
    return error(400, "invalid_request", "A local return address is required");
  }
  if (destination.origin !== url.origin || destination.username || destination.password)
    return error(400, "invalid_request", "A local return address is required");
  const session = await getAuthSession(request, env, { authoritative: true });
  if (!session?.user?.id) return error(401, "unauthenticated", "Sign in first");
  const context = await createAuth(request, env).$context;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(context.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const token = session.session.token;
  const signature = btoa(String.fromCharCode(...new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  )));
  const lifetime = Math.max(0, Math.floor((new Date(session.session.expiresAt).getTime() - Date.now()) / 1000));
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}; Path=/; Max-Age=${lifetime}; HttpOnly; Secure; SameSite=Lax`;
  return new Response(null, { status: 303, headers: {
    Location: destination.pathname + destination.search + destination.hash,
    "Set-Cookie": cookie,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  } });
};

const PROVIDER = "our-notes";
const SNAPSHOT_SCHEMA = "haneoka-app-save-summary-v1";

interface GameAccountRow {
  id: string;
  region: string;
  playerUid: string;
  displayName: string | null;
  visibility: string;
  verificationStatus: string;
  lastSyncedAt: number | null;
  updatedAt: number;
  summary: string | null;
  capturedAt: number | null;
}

const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;

/** The public summary the app may store: numbers only, never the save. */
const summaryOf = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const clears: Record<string, number[]> = {};
  const rawClears = source.clears && typeof source.clears === "object" ? (source.clears as Record<string, unknown>) : {};
  for (const difficulty of ["easy", "normal", "hard", "expert"]) {
    const row = rawClears[difficulty];
    if (Array.isArray(row) && row.length === 3 && row.every((n) => integer(n, 10_000) !== null))
      clears[difficulty] = row as number[];
  }
  return {
    rank: integer(source.rank, 10_000),
    exp: integer(source.exp),
    rating: integer(source.rating),
    members: integer(source.members, 100_000),
    snapshots: integer(source.snapshots, 100_000),
    favoriteMemberCardId: integer(source.favoriteMemberCardId),
    startedAt: integer(source.startedAt),
    clears,
  };
};

export const listGameAccounts = async (env: Env, userId: string) => {
  const { results } = await env.DB.prepare(
    `SELECT account.id, account.region, account.external_account_id AS playerUid,
            account.display_name AS displayName, account.visibility,
            account.verification_status AS verificationStatus,
            account.last_synced_at AS lastSyncedAt, account.updated_at AS updatedAt,
            snapshot.summary_json AS summary, snapshot.captured_at AS capturedAt
     FROM community_game_account AS account
     LEFT JOIN community_game_account_snapshot AS snapshot ON snapshot.id = (
       SELECT candidate.id FROM community_game_account_snapshot AS candidate
       WHERE candidate.game_account_id = account.id
       ORDER BY candidate.captured_at DESC, candidate.id DESC LIMIT 1)
     WHERE account.user_id = ? AND account.provider = ? AND account.deleted_at IS NULL
     ORDER BY account.updated_at DESC`,
  )
    .bind(userId, PROVIDER)
    .all<GameAccountRow>();
  return results.map(({ summary, ...row }) => ({ ...row, summary: summary ? (JSON.parse(summary) as unknown) : null }));
};

const gameAccounts = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (!sameOrigin(request)) return error(403, "cross_origin_request", "Cross-origin requests are not allowed");
  const session = await getAuthSession(request, env, { authoritative: request.method !== "GET" });
  if (!session?.user?.id) return error(401, "unauthenticated", "Sign in first");
  const userId = session.user.id;
  const rest = url.pathname.slice(GAME_ACCOUNTS_PATH.length).split("/").filter(Boolean);
  const now = Date.now();
  if (request.method === "GET" && !rest.length) return json({ accounts: await listGameAccounts(env, userId) });
  if (request.method === "DELETE" && rest.length === 2) {
    await env.DB.prepare(
      `UPDATE community_game_account SET deleted_at = ?, updated_at = ?, visibility = 'private'
       WHERE user_id = ? AND provider = ? AND region = ? AND external_account_id = ? AND deleted_at IS NULL`,
    )
      .bind(now, now, userId, PROVIDER, rest[0], rest[1])
      .run();
    return json({ accounts: await listGameAccounts(env, userId) });
  }
  if (request.method !== "PUT" || rest.length) return error(405, "method_not_allowed", "Method not allowed");
  const body = await readJson(request);
  const playerUid = typeof body?.profileId === "string" ? body.profileId : "";
  const gameRegion = profileRegion(playerUid);
  const region = gameRegion ? (gameRegion === "jp" ? "jp" : "intl") : "";
  if (!SERVERS.has(region) || (body?.server != null && body.server !== region))
    return error(400, "invalid_player", "Send a valid player ID");
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : null;
  const visibility = body?.visibility === "public" ? "public" : "private";
  const summary = summaryOf(body?.summary);
  if (!summary) return error(400, "invalid_summary", "A player summary is required");
  const capturedAt = integer(body?.savedAt) ?? now;
  const existing = await env.DB.prepare(
    `SELECT id, user_id AS userId, deleted_at AS deletedAt FROM community_game_account
     WHERE provider = ? AND region = ? AND external_account_id = ?`,
  )
    .bind(PROVIDER, region, playerUid)
    .first<{ id: string; userId: string; deletedAt: number | null }>();
  if (existing && existing.userId !== userId && existing.deletedAt === null)
    return error(409, "player_linked", "This player is linked to another account");
  const id = existing?.id ?? crypto.randomUUID();
  await env.DB.batch([
    existing
      ? env.DB.prepare(
          `UPDATE community_game_account
           SET user_id = ?, display_name = ?, visibility = ?, last_synced_at = ?, updated_at = ?, deleted_at = NULL,
               created_at = CASE WHEN user_id = ? THEN created_at ELSE ? END
           WHERE id = ?`,
        ).bind(userId, name, visibility, now, now, userId, now, id)
      : env.DB.prepare(
          `INSERT INTO community_game_account
             (id, user_id, provider, region, external_account_id, display_name, visibility, last_synced_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, userId, PROVIDER, region, playerUid, name, visibility, now, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO community_game_account_snapshot (id, game_account_id, captured_at, summary_json, schema_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), id, capturedAt, JSON.stringify(summary), SNAPSHOT_SCHEMA, now),
  ]);
  return json({ accounts: await listGameAccounts(env, userId) });
};

/** Android App Links: haneoka.org addresses open in the app signed with this key. */
const ASSET_LINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "org.haneoka.haneoka",
      sha256_cert_fingerprints: [
        "46:2F:06:D2:7A:14:59:EF:AC:35:89:6F:C2:E4:46:1B:C8:20:F9:93:76:89:5F:C6:28:54:22:CF:6F:57:5F:80",
      ],
    },
  },
];

export const handleAppAccountRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname === "/.well-known/assetlinks.json")
    return new Response(JSON.stringify(ASSET_LINKS), {
      headers: { "Cache-Control": "public, max-age=3600", "Content-Type": "application/json" },
    });
  if (url.pathname === AUTHORIZE_PATH) return authorize(request, env);
  if (url.pathname === TOKEN_PATH) return token(request, env);
  if (url.pathname === WEB_PATH) return webSession(request, env, url);
  if (url.pathname === OAUTH_PATH) return oauthStart(request, env, url);
  if (url.pathname === OAUTH_RETURN_PATH) return oauthReturn(request, env, url);
  if (url.pathname === GAME_ACCOUNTS_PATH || url.pathname.startsWith(`${GAME_ACCOUNTS_PATH}/`))
    return gameAccounts(request, env, url);
  return null;
};
