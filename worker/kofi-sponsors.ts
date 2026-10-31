// L3 — GEB
// Input: Ko-fi webhook posts (form field `data`, verified by KOFI_VERIFICATION_TOKEN) and public list reads.
// Output: Stored payments; the public Ko-fi supporter list by T.G.W CARD tier, without amounts.
// Pos: [Map](L2.md); Ko-fi side of the sponsor page's build-time list.
// Effects/Dependencies: Writes D1 `kofi_payment`; keeps a SHA-256 of the email to group payments, never the email.
import { sponsorTier, SPONSOR_TIERS, type SponsorTierId } from "../src/config/sponsor";

const WEBHOOK = "/api/v1/sponsors/kofi/webhook";
const LIST = "/api/v1/sponsors/kofi";
const ACTIVE_SECONDS = 32 * 86_400;

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

/** A Ko-fi membership tier named after a T.G.W CARD, or the amount reached. */
function tierOf(tierName: string | null, amount: number): SponsorTierId {
  const named = SPONSOR_TIERS.find((tier) => tierName?.toLowerCase().includes(tier.id));
  return named?.id ?? sponsorTier(amount, "USD");
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
    .slice(0, 40);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO kofi_payment
       (message_id, supporter, from_name, is_public, type, amount, currency, tier_name, is_subscription, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      messageId,
      await sha256(email || `name:${name}`),
      name,
      data.is_public === false ? 0 : 1,
      String(data.type ?? ""),
      amount,
      String(data.currency ?? "USD"),
      typeof data.tier_name === "string" ? data.tier_name : null,
      data.is_subscription_payment === true ? 1 : 0,
      paidAt,
    )
    .run();
  return respond(200, { ok: true });
}

interface PaymentRow {
  supporter: string;
  from_name: string;
  is_public: number;
  amount: number;
  tier_name: string | null;
  paid_at: number;
}

async function list(env: Env): Promise<Response> {
  if (!env.DB) return respond(503, { error: "kofi_unavailable" });
  const { results } = await env.DB.prepare(
    "SELECT supporter, from_name, is_public, amount, tier_name, paid_at FROM kofi_payment ORDER BY paid_at DESC",
  ).all<PaymentRow>();
  const now = Math.floor(Date.now() / 1000);
  const supporters = new Map<string, { latest: PaymentRow; since: number }>();
  for (const row of results) {
    const known = supporters.get(row.supporter);
    if (known) known.since = row.paid_at;
    else supporters.set(row.supporter, { latest: row, since: row.paid_at });
  }
  const active: { name: string; tier: SponsorTierId; since: number }[] = [];
  const past: { name: string; since: number }[] = [];
  for (const { latest, since } of supporters.values()) {
    // The latest payment carries the supporter's current choice to be listed.
    if (!latest.is_public || !latest.from_name) continue;
    const day = since - (since % 86_400);
    if (now - latest.paid_at <= ACTIVE_SECONDS)
      active.push({ name: latest.from_name, tier: tierOf(latest.tier_name, latest.amount), since: day });
    else past.push({ name: latest.from_name, since: day });
  }
  return respond(200, { active, past }, "public, max-age=300");
}

export async function handleKofiSponsorRequest(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === WEBHOOK)
    return request.method === "POST" ? receive(request, env) : respond(405, { error: "method_not_allowed" });
  if (pathname === LIST) return request.method === "GET" ? list(env) : respond(405, { error: "method_not_allowed" });
  return null;
}
