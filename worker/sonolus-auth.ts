// L3 — GEB
// Input: Sonolus-signed authentication requests and an authenticated browser account.
// Output: Confirmed account links and short-lived, origin-bound Sonolus community sessions.
// Pos: [Map](L2.md); account boundary for native Sonolus community.
// Effects/Dependencies: Verifies the service signature over the original bytes and stores links, one-time challenges and hashed tokens in D1.
import { communityAccessState } from "./access";
import { getAuthSession } from "./auth";
import { withPrimaryD1 } from "./d1-session";
import { privateTeamError, privateTeamJson, teamSameOrigin, writableTeamOwner } from "./team-inventory";
import { isLocalHostname, isSiteHostname, siteOrigin } from "../src/lib/site-origin";

const linkPath = "/api/v1/account/sonolus-link";
const callbackPath = "/sonolus/account/link";
const authPath = "/sonolus/authenticate";
const noncePattern = /^[a-f0-9]{64}$/u;
const maxBodyBytes = 16384;
const proofWindow = 2 * 60 * 1000;
const key = {
  kty: "EC",
  crv: "P-256",
  x: "d2B14ZAn-zDsqY42rHofst8rw3XB90-a5lT80NFdXo0",
  y: "Hxzi9DHrlJ4CVSJVRnydxFWBZAgkFxZXbyxPSa8SJQw",
};

export interface SonolusCommunityActor {
  id: string;
  emailVerified: boolean;
  tokenDigest: string;
}

export const writableSonolusOwner = `EXISTS (
  SELECT 1 FROM sonolus_community_session AS native_session
  JOIN community_profile AS profile ON profile.user_id=native_session.user_id
  JOIN "user" AS account ON account.id=profile.user_id
  WHERE native_session.user_id=? AND native_session.digest=? AND native_session.expires_at>?
    AND account.emailVerified=1 AND profile.status='active' AND profile.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM community_user_restriction AS restriction
      WHERE restriction.user_id=profile.user_id AND restriction.kind IN ('sign_in','write')
        AND restriction.revoked_at IS NULL AND (restriction.expires_at IS NULL OR restriction.expires_at>?)
    )
)`;

const hex = (bytes: Uint8Array) => Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const nonce = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async (body: ArrayBuffer | string) => hex(new Uint8Array(await crypto.subtle.digest(
  "SHA-256", typeof body === "string" ? new TextEncoder().encode(body) : body,
)));

export function sonolusAuthRoute(path: string): boolean {
  return path === authPath || path === callbackPath;
}

export function sonolusAuthJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function authenticatedOrigin(url: URL): string | null {
  return isSiteHostname(url.hostname) || isLocalHostname(url.hostname) ? siteOrigin(url) : null;
}

async function readSignedIdentity(request: Request, type: string, address: string) {
  const header = request.headers.get("Sonolus-Signature");
  const stream = request.body;
  if (!header || !/^[A-Za-z0-9+/_-]{86}={0,2}$/u.test(header) || !stream) return null;
  const buffer = new Uint8Array(maxBodyBytes);
  const reader = stream.getReader();
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.byteLength > buffer.length) {
      await reader.cancel();
      return null;
    }
    buffer.set(value, length);
    length += value.byteLength;
  }
  const bytes = buffer.buffer.slice(0, length);
  try {
    const rawSignature = Uint8Array.from(
      atob(header.replace(/-/g, "+").replace(/_/g, "/")),
      (char) => char.charCodeAt(0),
    );
    const publicKey = await crypto.subtle.importKey("jwk", key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, rawSignature, bytes))) return null;
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as {
      type?: unknown;
      address?: unknown;
      url?: unknown;
      time?: unknown;
      userProfile?: { id?: unknown; name?: unknown; handle?: unknown };
    };
    const claimedAddress = type === "authenticateExternal" ? body.url : body.address;
    const id = body.userProfile?.id;
    const name = body.userProfile?.name;
    if (body.type !== type || (claimedAddress !== address && claimedAddress !== address + "/") ||
        typeof body.time !== "number" || !Number.isSafeInteger(body.time) || Math.abs(Date.now() - body.time) > proofWindow ||
        typeof id !== "string" || !/^[A-Za-z0-9._~:/+=-]{1,160}$/u.test(id) ||
        typeof name !== "string" || !name.trim()) return null;
    return { id, name: [...name.trim()].slice(0, 80).join(""), proof: await digest(bytes) };
  } catch {
    return null;
  }
}

export async function readSonolusActor(request: Request, env: Env): Promise<SonolusCommunityActor | null> {
  const token = request.headers.get("Sonolus-Session");
  if (!token || !noncePattern.test(token)) return null;
  const origin = authenticatedOrigin(new URL(request.url));
  if (!origin) return null;
  const tokenDigest = await digest(token);
  const row = await env.DB.prepare(
    `SELECT native_session.user_id AS id, account.emailVerified AS verified
     FROM sonolus_community_session AS native_session JOIN "user" AS account ON account.id=native_session.user_id
     WHERE native_session.digest=? AND native_session.origin=? AND native_session.expires_at>?`,
  ).bind(tokenDigest, origin, Date.now()).first<{ id: string; verified: number }>();
  return row ? { id: row.id, emailVerified: row.verified === 1, tokenDigest } : null;
}

export async function handleSonolusAuthentication(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return sonolusAuthJson({ message: "Method not allowed" }, 405);
  const url = new URL(request.url);
  const origin = authenticatedOrigin(url);
  if (!origin || !env.DB) return sonolusAuthJson({ message: "Authentication unavailable" }, 503);
  const external = url.pathname === callbackPath;
  const challenge = external ? url.searchParams.get("challenge") : null;
  if (external && (!challenge || !noncePattern.test(challenge) || url.searchParams.getAll("challenge").length !== 1))
    return sonolusAuthJson({ message: "Invalid linking request" }, 401);
  const endpoint = challenge ? `${origin}${callbackPath}?challenge=${challenge}` : origin;
  const identity = await readSignedIdentity(request, external ? "authenticateExternal" : "authenticateServer", endpoint);
  if (!identity) return sonolusAuthJson({ message: "Invalid Sonolus authentication" }, 401);
  return withPrimaryD1(env, async ({ DB }) => {
    const now = Date.now();
    if (challenge) {
      const update = await DB.prepare(
        `UPDATE sonolus_link_challenge SET sonolus_id=?, display_name=?
         WHERE digest=? AND endpoint=? AND expires_at>? AND sonolus_id IS NULL`,
      ).bind(identity.id, identity.name, await digest(challenge), origin + callbackPath, now).run();
      return update.meta.changes
        ? sonolusAuthJson({ message: "Confirm the link in Haneoka." })
        : sonolusAuthJson({ message: "Linking request expired or was already used." }, 401);
    }
    const token = nonce();
    const expiration = now + 20 * 60 * 1000;
    const [, result] = await DB.batch([
      DB.prepare("DELETE FROM sonolus_community_session WHERE expires_at<=?").bind(now),
      DB.prepare(
        `INSERT OR IGNORE INTO sonolus_community_session(digest,user_id,proof,origin,expires_at)
         SELECT ?,link.user_id,?,?,? FROM sonolus_account_link AS link
         JOIN "user" AS account ON account.id=link.user_id
         JOIN community_profile AS profile ON profile.user_id=link.user_id
         WHERE link.sonolus_id=? AND account.emailVerified=1 AND profile.status='active' AND profile.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM community_user_restriction WHERE user_id=link.user_id AND kind='sign_in'
               AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)
           )`,
      ).bind(await digest(token), identity.proof, origin, expiration, identity.id, now),
    ]);
    return result?.meta.changes
      ? sonolusAuthJson({ session: token, expiration })
      : sonolusAuthJson({ message: "Link this Sonolus account under Haneoka account security, then sign in again." }, 401);
  });
}

export async function handleSonolusAccountLink(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== linkPath) return null;
  if (!teamSameOrigin(request)) return privateTeamError(request, 403, "cross_origin_request", "Use the same-origin account API");
  const origin = authenticatedOrigin(url);
  if (!origin || !env.DB) return privateTeamError(request, 503, "link_unavailable", "Sonolus linking is unavailable");
  return withPrimaryD1(env, async (primary) => {
    const session = await getAuthSession(request, primary, { authoritative: true });
    if (!session?.user.emailVerified)
      return privateTeamError(request, 401, "authentication_required", "Sign in with a verified Haneoka account");
    const userId = session.user.id, browserId = session.session.id, now = Date.now(), db = primary.DB;
    if (request.method !== "GET" && request.headers.get("X-Haneoka-Expected-User") !== userId)
      return privateTeamError(request, 409, "account_changed", "Reload the account before changing its Sonolus link");
    const active = await communityAccessState(primary, userId, ["sign_in", "write"]);
    const browserProof = [userId, session.session.token, new Date(now).toISOString(), now] as const;
    if (request.method === "GET") {
      const [link, pending] = await Promise.all([
        db.prepare("SELECT display_name AS name FROM sonolus_account_link WHERE user_id=?").bind(userId).first<{ name: string }>(),
        db.prepare(
          "SELECT display_name AS name, digest FROM sonolus_link_challenge WHERE user_id=? AND browser_session_id=? AND endpoint=? AND expires_at>?",
        ).bind(userId, browserId, origin + callbackPath, now).first<{ name: string | null; digest: string }>(),
      ]);
      return privateTeamJson(request, {
        linkedName: link?.name ?? null,
        pendingName: pending?.name ?? null,
        ...(pending?.name ? { pendingVersion: pending.digest } : {}),
      });
    }
    if (request.method === "DELETE") {
      await db.batch([
        db.prepare("DELETE FROM sonolus_link_challenge WHERE user_id=?").bind(userId),
        db.prepare("DELETE FROM sonolus_account_link WHERE user_id=?").bind(userId),
      ]);
      return privateTeamJson(request, { linkedName: null, pendingName: null });
    }
    if (active?.status !== "active" || active.restriction)
      return privateTeamError(request, 403, "community_write_restricted", "This account cannot link Sonolus");
    if (request.method === "POST") {
      const challenge = nonce();
      const endpoint = origin + callbackPath;
      const [, result] = await db.batch([
        db.prepare("DELETE FROM sonolus_link_challenge WHERE expires_at<=?").bind(now),
        db.prepare(
          `INSERT INTO sonolus_link_challenge(user_id,browser_session_id,digest,endpoint,expires_at)
           SELECT ?,?,?,?,? WHERE ${writableTeamOwner}
             AND NOT EXISTS(SELECT 1 FROM sonolus_account_link WHERE user_id=?)
           ON CONFLICT(user_id) DO UPDATE SET browser_session_id=excluded.browser_session_id,digest=excluded.digest,
             endpoint=excluded.endpoint,expires_at=excluded.expires_at,sonolus_id=NULL,display_name=NULL`,
        ).bind(userId, browserId, await digest(challenge), endpoint, now + 5 * 60 * 1000, ...browserProof, userId),
      ]);
      if (!result?.meta.changes)
        return privateTeamError(request, 409, "already_linked", "Unlink your Sonolus account first");
      return privateTeamJson(request, { url: `sonolus://external-login/${url.host}${callbackPath}?challenge=${challenge}` });
    }
    if (request.method === "PUT") {
      const version = request.headers.get("X-Haneoka-Sonolus-Challenge");
      if (!version || !noncePattern.test(version))
        return privateTeamError(request, 409, "link_not_ready", "Check the Sonolus link before confirming it");
      const [result] = await db.batch([
        db.prepare(
          `INSERT OR IGNORE INTO sonolus_account_link(user_id,sonolus_id,display_name,linked_at)
           SELECT user_id,sonolus_id,display_name,? FROM sonolus_link_challenge
           WHERE user_id=? AND browser_session_id=? AND endpoint=? AND digest=? AND expires_at>? AND sonolus_id IS NOT NULL
             AND ${writableTeamOwner}`,
        ).bind(now, userId, browserId, origin + callbackPath, version, now, ...browserProof),
        db.prepare(
          `DELETE FROM sonolus_link_challenge WHERE user_id=? AND browser_session_id=? AND digest=?
             AND EXISTS(SELECT 1 FROM sonolus_account_link WHERE user_id=? AND sonolus_id=sonolus_link_challenge.sonolus_id)`,
        ).bind(userId, browserId, version, userId),
      ]);
      return result?.meta.changes
        ? privateTeamJson(request, { linked: true })
        : privateTeamError(request, 409, "link_not_ready", "Confirm in Sonolus, or unlink the Sonolus account from its current Haneoka account");
    }
    return privateTeamError(request, 405, "method_not_allowed", "Method not allowed");
  });
}
