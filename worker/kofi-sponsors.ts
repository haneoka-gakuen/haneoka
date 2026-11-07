// L3 — GEB
// Input: Ko-fi webhook posts (form field `data`, verified by KOFI_VERIFICATION_TOKEN) and public list reads.
// Output: Stored payments with their public message; the Ko-fi part of the effective sponsor list, without amounts.
// Pos: [Map](L2.md); Ko-fi source of the sponsor list.
// Effects/Dependencies: Writes D1 `kofi_payment`, `kofi_payment_message` (public payments only) and the supporter's `sponsor_entry`, then advances the list revision; keeps a SHA-256 of the email to group payments, never the email.
import { SPONSOR_MESSAGE_LENGTH, SPONSOR_NAME_LENGTH } from "../src/config/sponsor";
import { kofiSponsorList, kofiSponsorStatements, sponsorPlainText } from "./sponsors";

const WEBHOOK = "/api/v1/sponsors/kofi/webhook";
const LIST = "/api/v1/sponsors/kofi";

const respond = (status: number, body: unknown, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of the shared verification token. */
async function sameToken(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function receive(request: Request, env: Env): Promise<Response> {
  if (!env.KOFI_VERIFICATION_TOKEN || !env.DB) return respond(503, { error: "kofi_unavailable" });
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(String((await request.formData()).get("data") ?? ""));
  } catch {
    return respond(400, { error: "invalid_payload" });
  }
  if (
    typeof data.verification_token !== "string" ||
    !(await sameToken(data.verification_token, env.KOFI_VERIFICATION_TOKEN))
  )
    return respond(401, { error: "invalid_token" });
  const messageId = String(data.message_id ?? "");
  const amount = Number(data.amount);
  const paidAt = Math.floor(Date.parse(String(data.timestamp ?? "")) / 1000);
  if (!messageId || !Number.isFinite(amount) || !Number.isFinite(paidAt))
    return respond(400, { error: "invalid_payload" });
  const email = String(data.email ?? "")
    .trim()
    .toLowerCase();
  const name = String(data.from_name ?? "")
    .trim()
    .slice(0, SPONSOR_NAME_LENGTH);
  const isPublic = data.is_public !== false;
  const supporter = await sha256(email || `name:${name}`);
  // Ko-fi shows a supporter's message on the page only for public payments.
  const message =
    isPublic && typeof data.message === "string"
      ? [...sponsorPlainText(data.message)].slice(0, SPONSOR_MESSAGE_LENGTH).join("") || null
      : null;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO kofi_payment
         (message_id, supporter, from_name, is_public, type, amount, currency, tier_name, is_subscription, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      messageId,
      supporter,
      name,
      isPublic ? 1 : 0,
      String(data.type ?? ""),
      amount,
      String(data.currency ?? "USD"),
      typeof data.tier_name === "string" ? data.tier_name : null,
      data.is_subscription_payment === true ? 1 : 0,
      paidAt,
    ),
    ...kofiSponsorStatements(env, supporter, messageId, message),
  ]);
  return respond(200, { ok: true });
}

export async function handleKofiSponsorRequest(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === WEBHOOK)
    return request.method === "POST" ? receive(request, env) : respond(405, { error: "method_not_allowed" });
  if (pathname !== LIST) return null;
  if (request.method !== "GET") return respond(405, { error: "method_not_allowed" });
  if (!env.DB) return respond(503, { error: "kofi_unavailable" });
  return respond(200, await kofiSponsorList(env), "public, max-age=300");
}
