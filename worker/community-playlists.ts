/**
 * Community playlists.
 *
 * A playlist is a member's ordered list of song references. Tracks are stored
 * as (provider, server, musicId) and resolved by the client against the same
 * catalogues the official playlists use, so a playlist never goes stale when
 * a catalogue corrects a title or jacket.
 *
 *   GET    /api/v1/community/playlists?scope=public|mine|liked&sort=new|popular&cursor=
 *   POST   /api/v1/community/playlists
 *   GET    /api/v1/community/playlists/:id
 *   PUT    /api/v1/community/playlists/:id          (full replace, optimistic `version`)
 *   DELETE /api/v1/community/playlists/:id
 *   POST   /api/v1/community/playlists/:id/tracks   (append one song)
 *   PUT    /api/v1/community/playlists/:id/like     ({ liked })
 */
import { getAuthSession } from "./auth";
import { communityAccessState } from "./access";
import { avatarUrlSelect } from "./avatar-url";
import { inspectCommunityText } from "./moderation";

const PREFIX = "/api/v1/community/playlists";
const MAX_JSON_BYTES = 64 * 1024;
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 1_000;
const TRACK_MAX = 500;
const PLAYLISTS_PER_OWNER = 200;
const PAGE_SIZE = 24;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SERVER_PATTERN = /^[a-z][a-z0-9-]{0,15}$/u;
const MUSIC_ID_PATTERN = /^[1-9][0-9]{0,11}$/u;

type JsonObject = Record<string, unknown>;
type Session = NonNullable<Awaited<ReturnType<typeof getAuthSession>>>;
type Access = { ok: false; response: Response } | { ok: true; session: Session; role: string };

interface TrackRef {
  provider: "our-notes" | "bestdori";
  server: string;
  musicId: string;
}

interface PlaylistInput {
  title: string;
  description: string | null;
  visibility: "public" | "private";
  coverKind: "auto" | "song" | "upload";
  coverSong: string | null;
  coverAttachmentId: string | null;
  tracks: TrackRef[];
}

interface PlaylistRow {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  coverKind: string;
  coverSong: string | null;
  coverAttachmentId: string | null;
  coverReady: number;
  visibility: string;
  trackCount: number;
  likeCount: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  ownerUid: number;
  ownerName: string | null;
  ownerImage: string | null;
  viewerLiked: number;
  preview: string | null;
}

const json = (request: Request, value: object, status = 200): Response =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });

const error = (request: Request, status: number, code: string, message: string): Response =>
  json(request, { error: { code, message } }, status);

const sameOrigin = (request: Request): boolean => {
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "none" && fetchSite !== "same-origin") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

const readJson = async (request: Request): Promise<JsonObject | null> => {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return null;
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
  } catch {
    return null;
  }
};

const text = (value: unknown, maximum: number): string | null | undefined => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  return [...normalized].length <= maximum ? normalized || null : undefined;
};

const trackRef = (value: unknown): TrackRef | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as JsonObject;
  const provider = row.provider;
  const server = String(row.server ?? "");
  const musicId = String(row.musicId ?? "");
  if (provider !== "our-notes" && provider !== "bestdori") return null;
  if (!SERVER_PATTERN.test(server) || !MUSIC_ID_PATTERN.test(musicId)) return null;
  return { provider, server, musicId };
};

const refKey = (ref: TrackRef) => `${ref.provider}:${ref.server}:${ref.musicId}`;

const parseInput = (body: JsonObject): { ok: true; value: PlaylistInput } | { ok: false; message: string } => {
  const title = text(body.title, TITLE_MAX);
  if (!title) return { ok: false, message: `A title of 1-${TITLE_MAX} characters is required` };
  const description = text(body.description, DESCRIPTION_MAX);
  if (description === undefined)
    return { ok: false, message: `The description is limited to ${DESCRIPTION_MAX} characters` };
  const visibility =
    body.visibility === "private"
      ? "private"
      : body.visibility === undefined || body.visibility === "public"
        ? "public"
        : null;
  if (!visibility) return { ok: false, message: "Visibility must be public or private" };
  if (!Array.isArray(body.tracks) || body.tracks.length > TRACK_MAX)
    return { ok: false, message: `A playlist holds at most ${TRACK_MAX} songs` };
  const tracks: TrackRef[] = [];
  const seen = new Set<string>();
  for (const entry of body.tracks) {
    const ref = trackRef(entry);
    if (!ref) return { ok: false, message: "Every track must reference a catalogue song" };
    if (seen.has(refKey(ref))) continue;
    seen.add(refKey(ref));
    tracks.push(ref);
  }
  const coverKind = body.coverKind === "song" || body.coverKind === "upload" ? body.coverKind : "auto";
  let coverSong: string | null = null;
  let coverAttachmentId: string | null = null;
  if (coverKind === "song") {
    const ref = trackRef(body.coverSong);
    if (!ref) return { ok: false, message: "The cover song must reference a catalogue song" };
    coverSong = refKey(ref);
  }
  if (coverKind === "upload") {
    if (typeof body.coverAttachmentId !== "string" || !UUID_PATTERN.test(body.coverAttachmentId))
      return { ok: false, message: "The cover image is missing" };
    coverAttachmentId = body.coverAttachmentId.toLowerCase();
  }
  return { ok: true, value: { title, description, visibility, coverKind, coverSong, coverAttachmentId, tracks } };
};

const viewer = async (request: Request, env: Env): Promise<Session | null> => {
  const session = await getAuthSession(request, env, { authoritative: true });
  return session?.user?.id ? session : null;
};

const requireWriter = async (request: Request, env: Env): Promise<Access> => {
  const session = await viewer(request, env);
  if (!session)
    return { ok: false, response: error(request, 401, "authentication_required", "Sign in to edit playlists") };
  if (!session.user.emailVerified)
    return {
      ok: false,
      response: error(request, 403, "email_verification_required", "Verify the account email first"),
    };
  const access = await communityAccessState(env, session.user.id, ["sign_in", "write"]);
  if (!access || access.status !== "active")
    return { ok: false, response: error(request, 403, "account_unavailable", "This account is not active") };
  if (access.restriction)
    return {
      ok: false,
      response: error(request, 403, "community_write_restricted", "This account cannot write to the community"),
    };
  if (env.COMMUNITY_RATE_LIMITER) {
    const { success } = await env.COMMUNITY_RATE_LIMITER.limit({ key: session.user.id });
    if (!success)
      return { ok: false, response: error(request, 429, "rate_limit_exceeded", "Too many community writes") };
  }
  const role = await env.DB.prepare("SELECT role FROM community_profile WHERE user_id = ?")
    .bind(session.user.id)
    .first<{ role: string }>();
  return { ok: true, session, role: role?.role ?? "member" };
};

/** Rows a viewer may read: public playlists of active members, and their own. */
const readableWhere = `playlist.deleted_at IS NULL
  AND (playlist.owner_id = ?1 OR (
    playlist.visibility = 'public'
    AND owner_profile.status = 'active'
    AND owner_profile.deleted_at IS NULL
  ))`;

const playlistSelect = `
  SELECT
    playlist.id,
    playlist.owner_id AS ownerId,
    playlist.title,
    playlist.description,
    playlist.cover_kind AS coverKind,
    playlist.cover_song AS coverSong,
    playlist.cover_attachment_id AS coverAttachmentId,
    EXISTS (
      SELECT 1 FROM community_attachment AS cover
      WHERE cover.id = playlist.cover_attachment_id
        AND cover.status = 'ready' AND cover.moderation_status = 'allow' AND cover.deleted_at IS NULL
    ) AS coverReady,
    playlist.visibility,
    playlist.track_count AS trackCount,
    playlist.like_count AS likeCount,
    playlist.version,
    playlist.created_at AS createdAt,
    playlist.updated_at AS updatedAt,
    playlist.published_at AS publishedAt,
    owner_identity.uid AS ownerUid,
    COALESCE(owner_profile.display_name, owner.name) AS ownerName,
    ${avatarUrlSelect("owner")} AS ownerImage,
    EXISTS (
      SELECT 1 FROM community_playlist_like AS mine
      WHERE mine.playlist_id = playlist.id AND mine.user_id = ?1
    ) AS viewerLiked,
    (
      SELECT group_concat(ref, ' ') FROM (
        SELECT track.provider || ':' || track.server || ':' || track.music_id AS ref
        FROM community_playlist_track AS track
        WHERE track.playlist_id = playlist.id
        ORDER BY track.position
        LIMIT 4
      )
    ) AS preview
  FROM community_playlist AS playlist
  JOIN "user" AS owner ON owner.id = playlist.owner_id
  JOIN community_identity AS owner_identity ON owner_identity.user_id = playlist.owner_id
  LEFT JOIN community_profile AS owner_profile ON owner_profile.user_id = playlist.owner_id`;

const splitRef = (value: string): TrackRef | null => {
  const [provider, server, musicId] = value.split(":");
  return trackRef({ provider, server, musicId });
};

const summary = (row: PlaylistRow, viewerId: string | null) => {
  const owner = viewerId !== null && row.ownerId === viewerId;
  // An upload shows once moderation allows it; until then the cover falls
  // back to the track mosaic and the owner sees it marked pending.
  const coverUrl =
    row.coverKind === "upload" && row.coverAttachmentId && row.coverReady
      ? `/api/v1/community/attachments/${row.coverAttachmentId}/content`
      : null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    cover: {
      kind: coverUrl || row.coverKind === "song" ? row.coverKind : "auto",
      song: row.coverSong ? splitRef(row.coverSong) : null,
      attachmentId: owner ? row.coverAttachmentId : null,
      url: coverUrl,
      pending: row.coverKind === "upload" && !row.coverReady,
    },
    preview: (row.preview ?? "").split(" ").flatMap((ref) => splitRef(ref) ?? []),
    trackCount: row.trackCount,
    likeCount: row.likeCount,
    viewerLiked: Boolean(row.viewerLiked),
    viewerOwns: owner,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    owner: { uid: row.ownerUid, name: row.ownerName, image: row.ownerImage },
  };
};

const readPlaylist = (env: Env, id: string, viewerId: string | null) =>
  env.DB.prepare(`${playlistSelect} WHERE playlist.id = ?2 AND ${readableWhere}`)
    .bind(viewerId ?? "", id)
    .first<PlaylistRow>();

const listPlaylists = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const scope = url.searchParams.get("scope") || "public";
  const sort = url.searchParams.get("sort") === "popular" ? "popular" : "new";
  const offset = Math.max(0, Math.min(10_000, Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0));
  const limit = Math.max(
    1,
    Math.min(60, Number.parseInt(url.searchParams.get("limit") || String(PAGE_SIZE), 10) || PAGE_SIZE),
  );
  const session = await viewer(request, env);
  const viewerId = session?.user.id ?? null;
  if ((scope === "mine" || scope === "liked") && !viewerId)
    return error(request, 401, "authentication_required", "Sign in to see your playlists");
  let where: string;
  let order: string;
  if (scope === "mine") {
    where = "playlist.owner_id = ?1 AND playlist.deleted_at IS NULL";
    order = "playlist.updated_at DESC";
  } else if (scope === "liked") {
    where = `${readableWhere} AND EXISTS (SELECT 1 FROM community_playlist_like AS liked WHERE liked.playlist_id = playlist.id AND liked.user_id = ?1)`;
    order = "playlist.updated_at DESC";
  } else if (scope === "public") {
    where = `playlist.deleted_at IS NULL AND playlist.visibility = 'public' AND playlist.track_count > 0
      AND owner_profile.status = 'active' AND owner_profile.deleted_at IS NULL`;
    order = sort === "popular" ? "playlist.like_count DESC, playlist.published_at DESC" : "playlist.published_at DESC";
  } else return error(request, 400, "invalid_scope", "Unknown playlist scope");
  const result = await env.DB.prepare(
    `${playlistSelect} WHERE ${where} ORDER BY ${order}, playlist.id LIMIT ?2 OFFSET ?3`,
  )
    .bind(viewerId ?? "", limit + 1, offset)
    .all<PlaylistRow>();
  const rows = result.results ?? [];
  return json(request, {
    playlists: rows.slice(0, limit).map((row) => summary(row, viewerId)),
    nextCursor: rows.length > limit ? String(offset + limit) : null,
  });
};

const getPlaylist = async (request: Request, env: Env, id: string): Promise<Response> => {
  const session = await viewer(request, env);
  const viewerId = session?.user.id ?? null;
  const row = await readPlaylist(env, id, viewerId);
  if (!row) return error(request, 404, "playlist_not_found", "Playlist not found");
  const tracks = await env.DB.prepare(
    `SELECT provider, server, music_id AS musicId, added_at AS addedAt
     FROM community_playlist_track WHERE playlist_id = ? ORDER BY position`,
  )
    .bind(id)
    .all<TrackRef & { addedAt: number }>();
  return json(request, { playlist: { ...summary(row, viewerId), tracks: tracks.results ?? [] } });
};

/** An uploaded cover must be the writer's own live image upload. */
const validCover = async (env: Env, ownerId: string, input: PlaylistInput): Promise<boolean> => {
  if (input.coverKind !== "upload") return true;
  const cover = await env.DB.prepare(
    `SELECT 1 AS ok FROM community_attachment
     WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL
       AND status NOT IN ('rejected', 'deleted') AND media_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')`,
  )
    .bind(input.coverAttachmentId, ownerId)
    .first<{ ok: number }>();
  return Boolean(cover);
};

const moderationAllows = (input: PlaylistInput) =>
  inspectCommunityText([input.title, input.description ?? ""].join("\n")).verdict === "allow";

const trackStatements = (env: Env, id: string, tracks: TrackRef[], now: number) => [
  env.DB.prepare("DELETE FROM community_playlist_track WHERE playlist_id = ?").bind(id),
  ...tracks.map((track, position) =>
    env.DB.prepare(
      `INSERT INTO community_playlist_track (playlist_id, position, provider, server, music_id, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, position, track.provider, track.server, track.musicId, now),
  ),
];

const createPlaylist = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireWriter(request, env);
  if (!access.ok) return access.response;
  const body = await readJson(request);
  if (!body) return error(request, 400, "invalid_json", "A valid JSON body is required");
  const parsed = parseInput(body);
  if (!parsed.ok) return error(request, 400, "invalid_playlist", parsed.message);
  const input = parsed.value;
  const ownerId = access.session.user.id;
  if (!moderationAllows(input)) return error(request, 422, "content_blocked", "This text cannot be published");
  if (!(await validCover(env, ownerId, input)))
    return error(request, 400, "invalid_cover", "The cover image is unavailable");
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM community_playlist WHERE owner_id = ? AND deleted_at IS NULL",
  )
    .bind(ownerId)
    .first<{ total: number }>();
  if ((count?.total ?? 0) >= PLAYLISTS_PER_OWNER)
    return error(request, 409, "playlist_limit", `An account can keep at most ${PLAYLISTS_PER_OWNER} playlists`);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_playlist
         (id, owner_id, title, description, cover_kind, cover_song, cover_attachment_id, visibility,
          track_count, created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      ownerId,
      input.title,
      input.description,
      input.coverKind,
      input.coverSong,
      input.coverAttachmentId,
      input.visibility,
      input.tracks.length,
      now,
      now,
      input.visibility === "public" ? now : null,
    ),
    ...trackStatements(env, id, input.tracks, now).slice(1),
  ]);
  return getPlaylist(request, env, id).then(
    (response) => new Response(response.body, { status: 201, headers: response.headers }),
  );
};

const ownedPlaylist = (env: Env, id: string) =>
  env.DB.prepare(
    `SELECT owner_id AS ownerId, version, visibility, published_at AS publishedAt, track_count AS trackCount
     FROM community_playlist WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<{ ownerId: string; version: number; visibility: string; publishedAt: number | null; trackCount: number }>();

const updatePlaylist = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireWriter(request, env);
  if (!access.ok) return access.response;
  const current = await ownedPlaylist(env, id);
  if (!current || current.ownerId !== access.session.user.id)
    return error(request, 404, "playlist_not_found", "Playlist not found");
  const body = await readJson(request);
  if (!body) return error(request, 400, "invalid_json", "A valid JSON body is required");
  if (body.version !== current.version)
    return error(request, 409, "version_conflict", "This playlist changed elsewhere; reload it before saving");
  const parsed = parseInput(body);
  if (!parsed.ok) return error(request, 400, "invalid_playlist", parsed.message);
  const input = parsed.value;
  if (!moderationAllows(input)) return error(request, 422, "content_blocked", "This text cannot be published");
  if (!(await validCover(env, current.ownerId, input)))
    return error(request, 400, "invalid_cover", "The cover image is unavailable");
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE community_playlist
       SET title = ?, description = ?, cover_kind = ?, cover_song = ?, cover_attachment_id = ?, visibility = ?,
           track_count = ?, version = version + 1, updated_at = ?, published_at = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    ).bind(
      input.title,
      input.description,
      input.coverKind,
      input.coverSong,
      input.coverAttachmentId,
      input.visibility,
      input.tracks.length,
      now,
      input.visibility === "public" ? (current.publishedAt ?? now) : current.publishedAt,
      id,
      current.version,
    ),
    ...trackStatements(env, id, input.tracks, now),
  ]);
  if (!results[0]?.meta.changes) return error(request, 409, "version_conflict", "This playlist changed elsewhere");
  return getPlaylist(request, env, id);
};

const appendTrack = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireWriter(request, env);
  if (!access.ok) return access.response;
  const current = await ownedPlaylist(env, id);
  if (!current || current.ownerId !== access.session.user.id)
    return error(request, 404, "playlist_not_found", "Playlist not found");
  const body = await readJson(request);
  const ref = trackRef(body);
  if (!ref) return error(request, 400, "invalid_track", "The song reference is invalid");
  if (current.trackCount >= TRACK_MAX)
    return error(request, 409, "playlist_full", `A playlist holds at most ${TRACK_MAX} songs`);
  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO community_playlist_track (playlist_id, position, provider, server, music_id, added_at)
     SELECT ?1, COALESCE(MAX(position) + 1, 0), ?2, ?3, ?4, ?5 FROM community_playlist_track WHERE playlist_id = ?1`,
  )
    .bind(id, ref.provider, ref.server, ref.musicId, now)
    .run();
  if (!inserted.meta.changes) return json(request, { added: false, duplicate: true });
  await env.DB.prepare(
    `UPDATE community_playlist
     SET track_count = (SELECT COUNT(*) FROM community_playlist_track WHERE playlist_id = ?1),
         version = version + 1, updated_at = ?2
     WHERE id = ?1`,
  )
    .bind(id, now)
    .run();
  return json(request, { added: true, duplicate: false });
};

const deletePlaylist = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireWriter(request, env);
  if (!access.ok) return access.response;
  const current = await ownedPlaylist(env, id);
  const moderator = access.role === "moderator" || access.role === "admin";
  if (!current || (current.ownerId !== access.session.user.id && !moderator))
    return error(request, 404, "playlist_not_found", "Playlist not found");
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE community_playlist SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(now, now, id)
    .run();
  return json(request, { deleted: true });
};

const setLike = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireWriter(request, env);
  if (!access.ok) return access.response;
  const userId = access.session.user.id;
  const row = await readPlaylist(env, id, userId);
  if (!row || row.visibility !== "public") return error(request, 404, "playlist_not_found", "Playlist not found");
  const body = await readJson(request);
  if (!body || typeof body.liked !== "boolean") return error(request, 400, "invalid_like", "`liked` must be a boolean");
  await env.DB.batch([
    body.liked
      ? env.DB.prepare(
          "INSERT OR IGNORE INTO community_playlist_like (playlist_id, user_id, created_at) VALUES (?, ?, ?)",
        ).bind(id, userId, Date.now())
      : env.DB.prepare("DELETE FROM community_playlist_like WHERE playlist_id = ? AND user_id = ?").bind(id, userId),
    env.DB.prepare(
      "UPDATE community_playlist SET like_count = (SELECT COUNT(*) FROM community_playlist_like WHERE playlist_id = ?1) WHERE id = ?1",
    ).bind(id),
  ]);
  const count = await env.DB.prepare("SELECT like_count AS likeCount FROM community_playlist WHERE id = ?")
    .bind(id)
    .first<{ likeCount: number }>();
  return json(request, { liked: body.liked, likeCount: count?.likeCount ?? 0 });
};

export const handleCommunityPlaylistRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  const method = request.method === "HEAD" ? "GET" : request.method;
  if (method !== "GET" && !sameOrigin(request))
    return error(request, 403, "cross_origin_request", "Cross-origin writes are not allowed");
  const [id, action, extra] = url.pathname.slice(PREFIX.length + 1).split("/");
  if (!id) {
    if (method === "GET") return listPlaylists(request, env, url);
    if (method === "POST") return createPlaylist(request, env);
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }
  if (!UUID_PATTERN.test(id) || extra !== undefined)
    return error(request, 404, "route_not_found", "Playlist route not found");
  const playlistId = id.toLowerCase();
  if (!action) {
    if (method === "GET") return getPlaylist(request, env, playlistId);
    if (method === "PUT") return updatePlaylist(request, env, playlistId);
    if (method === "DELETE") return deletePlaylist(request, env, playlistId);
  }
  if (action === "tracks" && method === "POST") return appendTrack(request, env, playlistId);
  if (action === "like" && method === "PUT") return setLike(request, env, playlistId);
  return error(request, 405, "method_not_allowed", "Method not allowed");
};
