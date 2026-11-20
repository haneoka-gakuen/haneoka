// L3 — GEB
// Input: Authenticated, bounded and credential-free game snapshot requests.
// Output: Private save metadata and the latest snapshot in each slot.
// Pos: [Map](L2.md); storage shared by the web and App account pages.
// Effects/Dependencies: D1 index and conditional writes to private R2 objects.
import { hashGameToolKey, isGameToolAccountId } from "../src/lib/game-tool-accounts";
import { gameSaveSlot, parseSnapshot } from "../src/lib/save-workspace/schema";
import { songProgressProfile } from "../src/lib/song-progress-profile";
import { privateTeamError as error, privateTeamJson as json, requireTeamAccess, teamSameOrigin, writableTeamOwner } from "./team-inventory";

const PATH = "/api/v1/account/private-game-saves";
const MAX_BYTES = 16 * 1024 * 1024;
async function readSave(request: Request) {
  if (!request.body || Number(request.headers.get("content-length")) > MAX_BYTES) throw new Error("save_too_large");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return JSON.parse(text + decoder.decode()) as Record<string, unknown>;
      bytes += chunk.value.length;
      if (bytes > MAX_BYTES) throw new Error("save_too_large");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function handlePrivateGameSaves(request: Request, env: Env): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname !== PATH && !pathname.startsWith(`${PATH}/`)) return null;
  const id = pathname === PATH ? null : pathname.slice(PATH.length + 1);
  if (id !== null && !isGameToolAccountId(id)) return error(request, 404, "save_not_found", "Save not found");
  if (!teamSameOrigin(request)) return error(request, 403, "cross_origin_request", "Use a same-origin request");
  if (!(request.method === "GET" || request.method === "PUT" && id)) return error(request, 405, "method_not_allowed", "Use GET or PUT");
  if (!env.DB || !env.COMMUNITY_UPLOADS) return error(request, 503, "save_storage_unavailable", "Save storage is unavailable");
  const access = await requireTeamAccess(request, env, request.method === "PUT");
  if (!access.ok) return access.response;
  const { userId, token } = access.value;
  if (!id) {
    const { results } = await env.DB.prepare(
      "SELECT metadata_json FROM account_private_game_save WHERE user_id = ? ORDER BY snapshot_time DESC LIMIT 80",
    ).bind(userId).all<{ metadata_json: string }>();
    return json(request, { saves: results.map(row => JSON.parse(row.metadata_json)) });
  }
  const key = `private/game-saves/v1/${await hashGameToolKey(userId)}/${id}.json`;
  const readIndex = () => env.DB.prepare("SELECT metadata_json, digest FROM account_private_game_save WHERE user_id = ? AND id = ?")
    .bind(userId, id).first<{ metadata_json: string; digest: string }>();
  if (request.method === "GET") {
    if (!await readIndex()) return error(request, 404, "save_not_found", "Save not found");
    const object = await env.COMMUNITY_UPLOADS.get(key);
    return object ? new Response(object.body, {
      headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    }) : error(request, 404, "save_not_found", "Save not found");
  }
  let save: Awaited<ReturnType<typeof readSave>>, snapshot: ReturnType<typeof parseSnapshot>;
  try {
    save = await readSave(request);
    snapshot = parseSnapshot(JSON.stringify(save.snapshot));
  } catch (failure) {
    return error(request, failure instanceof Error && failure.message === "save_too_large" ? 413 : 422, "invalid_game_save", "Invalid game snapshot");
  }
  const now = Date.now(), captured = snapshot.savedAt ? Date.parse(snapshot.savedAt) : 0;
  if (id !== await gameSaveSlot(snapshot)) return error(request, 409, "save_identity_changed", "Save identity does not match its slot");
  if (captured < 0 || captured > now + 86_400_000) return error(request, 422, "invalid_game_save_time", "Invalid save timestamp");
  const profile = songProgressProfile({
    uid: snapshot.player._profileId,
    name: typeof save.label === "string" ? save.label.replace(/[\p{Cc}\p{Cs}]/gu, "") : snapshot.player._name,
    rank: (save.profile as { rank?: unknown } | undefined)?.rank,
    server: snapshot.server,
  });
  const label = profile.name.replace(/[\p{Cc}\p{Cs}]/gu, "") || profile.uid;
  const text = JSON.stringify({ snapshot, label, profile });
  const digest = await hashGameToolKey(text), previous = await readIndex();
  if (previous?.digest === digest) return json(request, { save: JSON.parse(previous.metadata_json) });
  if (!previous) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM account_private_game_save WHERE user_id = ?")
      .bind(userId).first<{ count: number }>();
    if ((count?.count ?? 0) >= 80) return error(request, 409, "save_limit", "Too many saved snapshots");
  }
  const meta = { id, server: snapshot.server, label, profile, savedAt: snapshot.savedAt, stamp: digest };
  const metadata = JSON.stringify(meta);
  let written = false;
  for (let attempt = 0; attempt < 3 && !written; attempt++) {
    const head = await env.COMMUNITY_UPLOADS.head(key);
    const oldTime = Number(head?.customMetadata?.captured ?? -1);
    if (head && oldTime > captured)
      return json(request, { save: previous ? JSON.parse(previous.metadata_json) : null });
    if (head?.customMetadata?.digest === digest) { written = true; break; }
    written = !!await env.COMMUNITY_UPLOADS.put(key, text, {
      onlyIf: head ? { etagMatches: head.etag } : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
      customMetadata: { digest, captured: String(captured) },
    });
  }
  if (!written) return error(request, 503, "save_retry", "Retry save sync");
  const saved = await env.DB.prepare(`
    INSERT INTO account_private_game_save(user_id, id, snapshot_time, digest, metadata_json)
    SELECT ?, ?, ?, ?, ? WHERE ${writableTeamOwner}
    ON CONFLICT(user_id, id) DO UPDATE SET snapshot_time = excluded.snapshot_time,
      digest = excluded.digest, metadata_json = excluded.metadata_json
    WHERE account_private_game_save.snapshot_time <= excluded.snapshot_time
    RETURNING metadata_json
  `).bind(userId, id, captured, digest, metadata, userId, token, new Date(now).toISOString(), now).first<{ metadata_json: string }>();
  return saved ? json(request, { save: JSON.parse(saved.metadata_json) })
    : error(request, 409, "save_scope_changed", "Save scope changed");
}
