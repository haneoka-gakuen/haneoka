// L3 — GEB
// Input: 社区谱面 HTTP、账户、D1、R2 和受信服务器素材解析。
// Output: 私有草稿、不可变版本、发布列表、只读播放数据、服务端统计／推荐难度、素材与含作者简介／发布信息的 Sonolus 关卡投影。
// Pos: [Map](L2.md)；社区谱面持久化、发布及访问控制所有者。
// Effects/Dependencies: 认证／限流、D1 CAS、R2／编译；推荐读取偏好并记录曝光，列表与详情按模型版本缓存分析。
import { getAuthSession } from "./auth";
import { communityAccessState } from "./access";
import { withPrimaryD1 } from "./d1-session";
import { inspectCommunityText } from "./moderation";
import { assertValidProject } from "../packages/chart-editor/src/validation";
import { serializeSsForTarget } from "../packages/chart-editor/src/formats/diagnostics";
import { readAuthorCollections } from "../packages/chart-editor/src/creation/collections";
import { TempoMap } from "../packages/chart-editor/src/timing";
import { analyzeCommunityChart, COMMUNITY_CHART_ANALYSIS_VERSION } from "../src/lib/chart-creation/analysis";
import { chartToLevelData, convertChartAsync } from "@haneoka/sonolus";
import {
  chartLevelName,
  type ChartMediaRef,
  type CommunityChartItem,
  type CommunityChartPlayback,
} from "../src/lib/chart-creation/community-types";
import type { Project } from "../packages/chart-editor/src/model";
import type { ChartCatalogProvider, ChartDataProvider, ChartDescriptor } from "@haneoka/sonolus-core";

import { preserveChartMedia, chartMediaSnapshot, type ChartMediaResolver } from "./community-chart-media";
import { diversifyRecommendationPage, recommendationScoreSql } from "./community-ranking";
import { forumDiscoveryPostSql } from "./community-forums";
import { backgroundWork } from "./request-work";

const PREFIX = "/api/v1/community/charts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_AUDIO = 64 * 1024 * 1024;
const LEGACY_ANALYSIS_VERSIONS = ["ournotes-fc-threshold-v6:community-native-v1", "ournotes-fc-threshold-v6:community-native-v2", "ournotes-fc-threshold-v6:community-native-v3"];
const TRANSITION_ANALYSIS_VERSION = "ournotes-fc-threshold-v6:community-native-v4";
type RecordValue = Record<string, unknown>;
type Resolver = ChartMediaResolver;
interface Row {
  id: string;
  ownerId: string;
  ownerName: string;
  ownerUid: number;
  head: number;
  version: number;
  publishedRevision: number | null;
  visibility: "public" | "unlisted";
  revision: number;
  objectKey: string;
  title: string;
  artist: string;
  charter: string;
  difficulty: string;
  level: string;
  summary: string;
  audioJson: string;
  coverJson: string;
  audioUrl: string;
  coverUrl: string;
  remix: number;
  upstreamId: string | null;
  updatedAt: number;
  createdAt: number;
  publishedAt: number | null;
  dataKey: string | null;
  dataHash: string | null;
  likeCount: number;
  liked: number;
  analysisJson: string | null;
  legacyAnalysisJson: string | null;
  analysisCreatedAt: number | null;
}
const activeOwner = `EXISTS (SELECT 1 FROM community_profile p WHERE p.user_id = c.owner_id AND p.status = 'active')
 AND NOT EXISTS (SELECT 1 FROM community_entity_thread et JOIN community_post discussion ON discussion.id = et.post_id WHERE et.entity_type = 'community-charts' AND et.original_id = c.id AND (discussion.status <> 'published' OR discussion.moderation_status <> 'allow' OR discussion.deleted_at IS NOT NULL OR discussion.archived_at IS NOT NULL))`;
const availableCover = `(r.cover_attachment_id IS NULL OR EXISTS (SELECT 1 FROM community_attachment a WHERE a.id = r.cover_attachment_id AND a.status = 'ready' AND a.moderation_status = 'allow' AND a.deleted_at IS NULL))`;
const columns = `c.id, c.owner_id AS ownerId, COALESCE(p.display_name, '') AS ownerName, identity.uid AS ownerUid,
 c.head, c.version, c.published_revision AS publishedRevision, c.visibility, c.updated_at AS updatedAt,
 r.revision, r.object_key AS objectKey, r.title, r.artist, r.charter, r.difficulty, r.level, r.summary,
 r.audio_json AS audioJson, r.cover_json AS coverJson, r.audio_url AS audioUrl, r.cover_url AS coverUrl,
 analysis.analysis_json AS analysisJson, COALESCE(NULLIF(legacy_v3.analysis_json, 'null'), NULLIF(legacy_v2.analysis_json, 'null'), legacy_v1.analysis_json) AS legacyAnalysisJson, analysis.created_at AS analysisCreatedAt, r.remix, r.upstream_id AS upstreamId, r.created_at AS createdAt, r.published_at AS publishedAt,
 r.data_key AS dataKey, r.data_hash AS dataHash,
 (SELECT count(*) FROM community_chart_like l WHERE l.chart_id = c.id) AS likeCount,
 EXISTS (SELECT 1 FROM community_chart_like l WHERE l.chart_id = c.id AND l.user_id = ?1) AS liked`;
const joined = `FROM community_chart c JOIN community_profile p ON p.user_id = c.owner_id JOIN community_identity identity ON identity.user_id = c.owner_id JOIN community_chart_revision r ON r.chart_id = c.id LEFT JOIN community_chart_analysis analysis ON analysis.chart_id = r.chart_id AND analysis.revision = r.revision AND analysis.model_version = '${COMMUNITY_CHART_ANALYSIS_VERSION}'
 LEFT JOIN community_chart_analysis legacy_v1 ON legacy_v1.chart_id = r.chart_id AND legacy_v1.revision = r.revision AND legacy_v1.model_version = '${LEGACY_ANALYSIS_VERSIONS[0]}' AND '${COMMUNITY_CHART_ANALYSIS_VERSION}' = '${TRANSITION_ANALYSIS_VERSION}' AND r.published_at IS NOT NULL
 LEFT JOIN community_chart_analysis legacy_v2 ON legacy_v2.chart_id = r.chart_id AND legacy_v2.revision = r.revision AND legacy_v2.model_version = '${LEGACY_ANALYSIS_VERSIONS[1]}' AND '${COMMUNITY_CHART_ANALYSIS_VERSION}' = '${TRANSITION_ANALYSIS_VERSION}' AND r.published_at IS NOT NULL
 LEFT JOIN community_chart_analysis legacy_v3 ON legacy_v3.chart_id = r.chart_id AND legacy_v3.revision = r.revision AND legacy_v3.model_version = '${LEGACY_ANALYSIS_VERSIONS[2]}' AND '${COMMUNITY_CHART_ANALYSIS_VERSION}' = '${TRANSITION_ANALYSIS_VERSION}' AND r.published_at IS NOT NULL`;
const json = (request: Request, value: unknown, status = 200) =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const fail = (request: Request, status: number, code: string) => json(request, { error: { code } }, status);
const hash = async (bytes: Uint8Array, algorithm = "SHA-256") =>
  [...new Uint8Array(await crypto.subtle.digest(algorithm, bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
async function bounded(request: Request, max: number): Promise<Uint8Array> {
  if (!request.body || Number(request.headers.get("Content-Length")) > max) throw new Error("file_size");
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  const declared = Number(request.headers.get("Content-Length"));
  const allocated = declared > 0 && declared <= max ? new Uint8Array(declared) : null;
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > max) {
        await reader.cancel();
        throw new Error("file_size");
      }
      if (allocated) {
        if (length > allocated.length) {
          await reader.cancel();
          throw new Error("file_size");
        }
        allocated.set(part.value, length - part.value.length);
      } else chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (allocated) {
    if (length !== allocated.length) throw new Error("file_size");
    return allocated;
  }
  const result = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    result.set(chunk, at);
    at += chunk.length;
  }
  return result;
}
async function body(request: Request) {
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") throw new Error("invalid_chart");
  const bytes = await bounded(request, 4 * 1024 * 1024);
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_chart");
    return value as RecordValue;
  } catch {
    throw new Error("invalid_chart");
  }
}
async function viewer(request: Request, env: Env) {
  return (await getAuthSession(request, env, { authoritative: true }))?.user ?? null;
}
async function writer(request: Request, env: Env) {
  const user = await viewer(request, env);
  if (!user) throw new Error("authentication_required");
  if (!user.emailVerified) throw new Error("email_verification_required");
  const access = await communityAccessState(env, user.id, ["sign_in", "write"]);
  if (access?.status !== "active" || access.restriction) throw new Error("community_write_restricted");
  if (env.COMMUNITY_RATE_LIMITER && !(await env.COMMUNITY_RATE_LIMITER.limit({ key: user.id })).success)
    throw new Error("rate_limit_exceeded");
  return user;
}
function chartAnalysis(row: Row): CommunityChartItem["analysis"] {
  if (row.analysisJson && row.analysisJson !== "null") return JSON.parse(row.analysisJson);
  if (!row.legacyAnalysisJson || row.legacyAnalysisJson === "null") return null;
  const value: unknown = JSON.parse(row.legacyAnalysisJson);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const legacy = value as RecordValue;
  if (typeof legacy.version !== "string" || !LEGACY_ANALYSIS_VERSIONS.includes(legacy.version) || !Number.isSafeInteger(legacy.n) || Number(legacy.n) < 0)
    return null;
  for (const key of ["time", "nps", "firstBpm", "minBpm", "maxBpm"])
    if (typeof legacy[key] !== "number" || !Number.isFinite(legacy[key]) || Number(legacy[key]) < 0) return null;
  return {
    version: legacy.version,
    n: legacy.n as number,
    time: legacy.time as number,
    nps: legacy.nps as number,
    firstBpm: legacy.firstBpm as number,
    minBpm: legacy.minBpm as number,
    maxBpm: legacy.maxBpm as number,
    difficultyEstimate: null,
  };
}
const item = (r: Row, owner = ""): CommunityChartItem => ({
  id: r.id,
  title: r.title,
  artist: r.artist,
  charter: r.charter,
  difficulty: r.difficulty,
  level: r.level,
  summary: r.summary,
  ownerId: r.ownerId === owner ? r.ownerId : "",
  ownerUid: r.ownerUid,
  ownerName: r.ownerName || `#${r.ownerUid}`,
  version: r.ownerId === owner ? r.version : r.revision,
  revision: r.revision,
  publishedRevision: r.publishedRevision,
  publishedAt: r.publishedAt,
  updatedAt: r.updatedAt,
  coverUrl: r.coverUrl,
  audioUrl: r.audioUrl,
  remix: !!r.remix,
  visibility: r.visibility,
  canEdit: r.ownerId === owner,
  likeCount: r.likeCount,
  liked: !!r.liked,
  upstreamId: r.upstreamId,
  analysis: chartAnalysis(r),
});
async function ensureAnalysis(env: Env, row: Row): Promise<void> {
  if (row.analysisJson !== null && row.analysisJson !== "null") return;
  if (row.analysisCreatedAt !== null && row.analysisCreatedAt > Date.now() - 60 * 60 * 1000) return;
  const object = await env.COMMUNITY_UPLOADS.get(row.objectKey);
  if (!object) return;
  const { project } = await object.json<{ project: Project }>();
  let analysis: CommunityChartItem["analysis"] = null;
  try {
    analysis = await analyzeCommunityChart(project, `community:${row.id}:${row.revision}`);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "community.chart_analysis_unavailable",
        error: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }
  row.analysisJson = JSON.stringify(analysis);
  row.analysisCreatedAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO community_chart_analysis(chart_id,revision,model_version,analysis_json,created_at) VALUES(?,?,?,?,?)
     ON CONFLICT(chart_id,revision,model_version) DO UPDATE SET analysis_json=excluded.analysis_json, created_at=excluded.created_at
     WHERE community_chart_analysis.analysis_json = 'null'`,
  )
    .bind(row.id, row.revision, COMMUNITY_CHART_ANALYSIS_VERSION, row.analysisJson, row.analysisCreatedAt)
    .run();
}
async function find(env: Env, id: string, owner = "", draft = false, revision?: number): Promise<Row | null> {
  return env.DB.prepare(
    `SELECT ${columns} ${joined} WHERE c.id = ?2 AND c.deleted_at IS NULL
    AND r.revision = ${revision ? "?3" : draft ? "CASE WHEN c.owner_id = ?1 THEN c.head ELSE c.published_revision END" : "c.published_revision"}
    AND (c.owner_id = ?1 OR (c.published_revision IS NOT NULL AND r.published_at IS NOT NULL AND ${activeOwner} AND ${availableCover}))`,
  )
    .bind(owner, id, ...(revision ? [revision] : []))
    .first<Row>();
}
export async function communityChartRows(env: Env): Promise<Row[]> {
  return (
    await env.DB.prepare(
      `SELECT ${columns} ${joined} WHERE c.deleted_at IS NULL AND c.visibility = 'public'
    AND r.revision = c.published_revision AND ${activeOwner} AND ${availableCover} ORDER BY r.published_at DESC, c.id`,
    )
      .bind("")
      .all<Row>()
  ).results;
}

function communityChartRecommendationQuery(userId: string | null, seed: number, asOf: number) {
  const ranking = recommendationScoreSql({ kind: "chart", userId, seed, asOf });
  const thread = `SELECT entity.post_id FROM community_entity_thread AS entity
    JOIN community_post AS discussion ON discussion.id=entity.post_id
    WHERE entity.entity_type='community-charts' AND entity.original_id=c.id
      AND ${forumDiscoveryPostSql("discussion", "NULLIF(?1,'')")}`;
  const preferences = userId ? `WHERE
    NOT EXISTS(SELECT 1 FROM community_user_mute WHERE muter_user_id=?1 AND muted_user_id=charts.ownerId)
    AND NOT EXISTS(SELECT 1 FROM community_user_block WHERE
      (blocker_user_id=?1 AND blocked_user_id=charts.ownerId) OR (blocker_user_id=charts.ownerId AND blocked_user_id=?1))
    AND NOT EXISTS(SELECT 1 FROM community_post_feedback WHERE user_id=?1 AND post_id=charts.threadId)
    AND NOT EXISTS(SELECT 1 FROM community_post_tag AS muted_post_tag
      JOIN community_tag_preference AS muted_tag ON muted_tag.tag_id=muted_post_tag.tag_id
      WHERE muted_post_tag.post_id=charts.threadId AND muted_tag.user_id=?1 AND muted_tag.kind='mute')` : "";
  const sql = `WITH charts AS (
      SELECT ${columns}, c.created_at AS rankingCreatedAt, (${thread}) AS threadId,
        (SELECT COUNT(*) FROM community_chart_like AS reaction
         JOIN community_profile AS reaction_owner ON reaction_owner.user_id=reaction.user_id
         WHERE reaction.chart_id=c.id AND reaction_owner.status<>'deleted'
           AND reaction_owner.display_name IS NOT NULL) AS rankingLikeCount
      ${joined} WHERE c.deleted_at IS NULL AND c.visibility='public'
        AND r.revision=c.published_revision AND ${activeOwner} AND ${availableCover}
    ), candidate AS (
      SELECT charts.*, (SELECT COUNT(*) FROM community_comment AS comment
        JOIN community_profile AS comment_owner ON comment_owner.user_id=comment.author_id
        WHERE comment.post_id=charts.threadId AND comment.deleted_at IS NULL AND comment.hidden_at IS NULL
          AND comment.moderation_status='allow' AND comment_owner.status<>'deleted'
          AND comment_owner.display_name IS NOT NULL) AS commentCount FROM charts ${preferences}
    ), ranked AS (SELECT candidate.*, ${ranking.sql} AS rankScore FROM candidate)
    SELECT * FROM ranked ORDER BY rankScore DESC, rankingCreatedAt DESC, id DESC`;
  return { sql, values: [userId ?? "", ...ranking.values] };
}

async function recommendedCharts(env: Env, userId: string | null, seed: number, asOf: number): Promise<Row[]> {
  const query = communityChartRecommendationQuery(userId, seed, asOf);
  const rows = (await env.DB.prepare(query.sql).bind(...query.values).all<Row>()).results;
  return diversifyRecommendationPage(rows, (row) => row.ownerId, (row) => row.upstreamId ?? row.id);
}

async function recordChartRecommendations(env: Env, rows: Row[], userId: string, seed: number, asOf: number) {
  const ids = rows.slice(0, 20).map((row) => row.id);
  if (!ids.length) return;
  await backgroundWork(`community-chart-impression:${userId}:${seed}`, async () => {
    try {
      await env.DB.prepare(`WITH selected(id) AS (VALUES ${ids.map(() => "(?)").join(",")})
        INSERT INTO community_chart_impression(user_id,chart_id,first_seen_at,last_seen_at,seen_count)
        SELECT ?,c.id,?,?,1 FROM selected JOIN community_chart AS c ON c.id=selected.id
        JOIN community_chart_revision AS r ON r.chart_id=c.id AND r.revision=c.published_revision
        WHERE c.deleted_at IS NULL AND c.visibility='public' AND ${activeOwner} AND ${availableCover}
        ON CONFLICT(user_id,chart_id) DO UPDATE SET
          last_seen_at=MAX(community_chart_impression.last_seen_at,excluded.last_seen_at),
          seen_count=community_chart_impression.seen_count+1`).bind(...ids, userId, asOf, asOf).run();
    } catch (error) {
      console.warn(JSON.stringify({ event: "community.chart_recommendation_impression_failed", error: error instanceof Error ? error.name : "UnknownError" }));
    }
  });
}
function mediaRef(value: unknown): ChartMediaRef | null {
  if (value === null || value === undefined) return null;
  const r = value as RecordValue;
  if (r.kind === "upload" && typeof r.id === "string" && UUID.test(r.id)) return { kind: "upload", id: r.id };
  if (
    r.kind === "server" &&
    (r.provider === "our-notes" || r.provider === "bestdori") &&
    typeof r.server === "string" &&
    (r.provider === "our-notes"
      ? ["jp", "intl"].includes(r.server)
      : ["jp", "en", "tw", "cn", "kr"].includes(r.server)) &&
    typeof r.songId === "string" &&
    /^[1-9]\d{0,11}$/u.test(r.songId) &&
    (r.sha256 === undefined || (typeof r.sha256 === "string" && /^[0-9a-f]{64}$/u.test(r.sha256))) &&
    (r.provider === "bestdori" || (typeof r.releaseId === "string" && /^r-[a-f0-9]{20}$/u.test(r.releaseId)))
  )
    return {
      kind: "server",
      provider: r.provider,
      server: r.server,
      songId: r.songId,
      ...(r.provider === "our-notes" ? { releaseId: r.releaseId as string } : {}),
      ...(typeof r.sha256 === "string" ? { sha256: r.sha256 } : {}),
    };
  throw new Error("media_missing");
}
async function resolveMedia(
  env: Env,
  owner: string,
  id: string,
  revision: number,
  kind: "audio" | "cover",
  ref: ChartMediaRef | null,
  resolve: Resolver,
  snapshots: { kind: "audio" | "cover"; hash: string }[],
  reuse: readonly string[],
) {
  if (!ref) return "";
  if (ref.kind === "server") {
    const hash = await preserveChartMedia(env, ref, kind, reuse, resolve);
    snapshots.push({ kind, hash });
    return `${PREFIX}/${id}/media/${revision}/${kind}`;
  }
  const found =
    kind === "audio"
      ? await env.DB.prepare("SELECT id FROM community_chart_audio WHERE id = ? AND owner_id = ?")
          .bind(ref.id, owner)
          .first()
      : await env.DB.prepare(
          "SELECT id FROM community_attachment WHERE id = ? AND owner_user_id = ? AND purpose = 'post' AND status = 'ready' AND moderation_status = 'allow' AND deleted_at IS NULL AND media_type IN ('image/png','image/jpeg','image/webp')",
        )
          .bind(ref.id, owner)
          .first();
  if (!found) throw new Error("media_not_ready");
  return `${PREFIX}/${id}/media/${revision}/${kind}`;
}
function wavDuration(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || word(0) !== "RIFF" || word(8) !== "WAVE" || view.getUint32(4, true) !== bytes.length - 8)
    throw new Error("audio_format");
  let rate = 0,
    block = 0,
    data = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true),
      end = at + 8 + size;
    if (end > bytes.length) throw new Error("audio_format");
    if (word(at) === "fmt ") {
      if (size !== 16 || view.getUint16(at + 8, true) !== 1 || view.getUint16(at + 22, true) !== 16)
        throw new Error("audio_format");
      const channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
      block = view.getUint16(at + 20, true);
      if (
        channels < 1 ||
        channels > 2 ||
        rate < 8000 ||
        rate > 48000 ||
        block !== channels * 2 ||
        view.getUint32(at + 16, true) !== rate * block
      )
        throw new Error("audio_format");
    }
    if (word(at) === "data") data += size;
    at = end + (size % 2);
  }
  const duration = data / (rate * block);
  if (!data || !Number.isFinite(duration) || duration <= 0 || duration > 600 || data % block)
    throw new Error("audio_duration");
  return duration;
}
async function uploadAudio(request: Request, env: Env, owner: string) {
  if (request.headers.get("Content-Type") !== "audio/wav") throw new Error("audio_format");
  const bytes = await bounded(request, MAX_AUDIO),
    duration = wavDuration(bytes),
    sha = await hash(bytes);
  const existing = await env.DB.prepare("SELECT id FROM community_chart_audio WHERE owner_id = ? AND sha256 = ?")
    .bind(owner, sha)
    .first<{ id: string }>();
  if (existing) return json(request, { id: existing.id });
  const usage = await env.DB.prepare(
    "SELECT count(*) AS n, COALESCE(sum(byte_size),0) AS bytes FROM community_chart_audio WHERE owner_id = ?",
  )
    .bind(owner)
    .first<{ n: number; bytes: number }>();
  if ((usage?.n ?? 0) >= 200 || (usage?.bytes ?? 0) + bytes.length > 1024 * 1024 * 1024)
    throw new Error("storage_limit");
  const id = crypto.randomUUID(),
    key = `charts/audio/${id}.wav`;
  await env.DB.prepare("INSERT OR IGNORE INTO community_chart_gc(object_key,created_at) VALUES(?,?)")
    .bind(key, Date.now())
    .run();
  await env.COMMUNITY_UPLOADS.put(key, bytes, { httpMetadata: { contentType: "audio/wav" } });
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO community_chart_audio(id,owner_id,object_key,sha256,byte_size,duration,created_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM community_chart_audio WHERE owner_id = ?) < 200 AND (SELECT COALESCE(sum(byte_size),0) FROM community_chart_audio WHERE owner_id = ?) + ? <= 1073741824`,
  )
    .bind(id, owner, key, sha, bytes.length, duration, Date.now(), owner, owner, bytes.length)
    .run();
  if (!inserted.meta.changes) {
    await env.COMMUNITY_UPLOADS.delete(key);
    const row = await env.DB.prepare("SELECT id FROM community_chart_audio WHERE owner_id = ? AND sha256 = ?")
      .bind(owner, sha)
      .first<{ id: string }>();
    if (!row) throw new Error("storage_limit");
    return json(request, { id: row.id });
  }
  await env.DB.prepare("DELETE FROM community_chart_gc WHERE object_key = ?").bind(key).run();
  return json(request, { id }, 201);
}
async function saveChart(request: Request, env: Env, owner: string, id: string, resolve: Resolver) {
  const input = await body(request),
    project = input.project as Project;
  try {
    assertValidProject(project);
    readAuthorCollections(project);
  } catch {
    throw new Error("invalid_chart");
  }
  const title = project.meta.title.trim();
  if (
    !title ||
    [...title].length > 120 ||
    [project.meta.artist, project.meta.charter, project.meta.difficulty, project.meta.level].some((v) => v.length > 200)
  )
    throw new Error("metadata_required");
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (
    summary.length > 1000 ||
    !Number.isSafeInteger(input.version) ||
    Number(input.version) < 0 ||
    typeof input.requestId !== "string" ||
    !UUID.test(input.requestId)
  )
    throw new Error("invalid_chart");
  if (
    !["public", "unlisted"].includes(String(input.visibility)) ||
    typeof input.remix !== "boolean" ||
    typeof input.publish !== "boolean"
  )
    throw new Error("invalid_chart");
  const publish = input.publish,
    expected = Number(input.version);
  const normalized = {
    project,
    audio: mediaRef(input.audio),
    cover: mediaRef(input.cover),
    summary,
    visibility: input.visibility,
    remix: input.remix,
    upstreamId: input.upstreamId ?? null,
  };
  const payload = new TextEncoder().encode(JSON.stringify(normalized)),
    payloadHash = await hash(new TextEncoder().encode(JSON.stringify({ ...normalized, publish })));
  const retry = await env.DB.prepare(
    "SELECT r.payload_hash AS hash, c.owner_id AS owner FROM community_chart_revision r JOIN community_chart c ON c.id = r.chart_id WHERE chart_id = ? AND request_id = ? AND c.deleted_at IS NULL",
  )
    .bind(id, input.requestId)
    .first<{ hash: string; owner: string }>();
  if (retry) {
    if (retry.owner !== owner || retry.hash !== payloadHash) throw new Error("save_conflict");
    const saved = (await find(env, id, owner, true))!;
    await ensureAnalysis(env, saved);
    return json(request, { chart: item(saved, owner) });
  }
  const current = await env.DB.prepare(
    "SELECT owner_id AS owner, head, version, deleted_at AS deleted FROM community_chart WHERE id = ?",
  )
    .bind(id)
    .first<{ owner: string; head: number; version: number; deleted: number | null }>();
  if (current && (current.owner !== owner || current.deleted !== null)) return fail(request, 404, "chart_missing");
  if ((current?.version ?? 0) !== expected) throw new Error("save_conflict");
  const revision = (current?.head ?? 0) + 1;
  if (revision > 1000) throw new Error("storage_limit");
  if (!current) {
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM community_chart WHERE owner_id = ? AND deleted_at IS NULL",
    )
      .bind(owner)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= 200) throw new Error("storage_limit");
  }
  let upstreamId: string | null = null;
  if (input.upstreamId !== undefined && input.upstreamId !== null) {
    if (typeof input.upstreamId !== "string" || !UUID.test(input.upstreamId) || input.upstreamId === id)
      throw new Error("remix_unavailable");
    const previousSource = current
      ? await env.DB.prepare(
          "SELECT upstream_id AS id FROM community_chart_revision WHERE chart_id = ? AND revision = ?",
        )
          .bind(id, current.head)
          .first<{ id: string | null }>()
      : null;
    const upstream = previousSource?.id === input.upstreamId ? null : await find(env, input.upstreamId);
    if (previousSource?.id !== input.upstreamId && !upstream?.remix) throw new Error("remix_unavailable");
    upstreamId = input.upstreamId;
  }
  const snapshots: { kind: "audio" | "cover"; hash: string }[] = [];
  const reuse = [id, ...(upstreamId ? [upstreamId] : [])];
  const audioUrl = await resolveMedia(env, owner, id, revision, "audio", normalized.audio, resolve, snapshots, reuse);
  const coverUrl = await resolveMedia(env, owner, id, revision, "cover", normalized.cover, resolve, snapshots, reuse);
  let dataKey: string | null = null,
    dataHash: string | null = null;
  const now = Date.now(),
    objectKey = `charts/projects/${id}/${crypto.randomUUID()}.json`;
  if (publish) {
    if (!normalized.audio || !normalized.cover) throw new Error("media_missing");
    const inspection = inspectCommunityText([title, project.meta.artist, project.meta.charter, summary].join("\n"));
    if (inspection.verdict !== "allow") throw new Error("text_blocked");
    if (readAuthorCollections(project).groups.some((group) => group.forceNoteSpeed !== undefined))
      throw new Error("sonolus_timescale");
    let chart: Awaited<ReturnType<typeof convertChartAsync>>;
    try {
      chart = await convertChartAsync(serializeSsForTarget(project, false));
    } catch {
      throw new Error("sonolus_chart_invalid");
    }
    if (!chart.notes.length || chart.notes.some((note) => note.judged && (note.pos + note.size <= 0 || note.pos >= 24)))
      throw new Error("sonolus_chart_invalid");
    const level = chartToLevelData(chart, project.audioOffset);
    for (const event of project.timeScales)
      level.entities.push({
        archetype: "#TIMESCALE_CHANGE",
        data: [
          { name: "#BEAT", value: event.tick / project.resolution },
          { name: "#TIMESCALE", value: event.scale },
        ],
      });
    const compressed = await new Response(
      new Blob([JSON.stringify(level)]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    dataHash = await hash(new Uint8Array(compressed), "SHA-1");
    dataKey = `charts/data/${id}/${dataHash}`;
    await env.DB.prepare("INSERT OR IGNORE INTO community_chart_gc(object_key,created_at) VALUES(?,?)")
      .bind(dataKey, now)
      .run();
    await env.COMMUNITY_UPLOADS.put(dataKey, compressed, { httpMetadata: { contentType: "application/gzip" } });
  }
  await env.DB.prepare("INSERT OR IGNORE INTO community_chart_gc(object_key,created_at) VALUES(?,?)")
    .bind(objectKey, now)
    .run();
  await env.COMMUNITY_UPLOADS.put(objectKey, payload, { httpMetadata: { contentType: "application/json" } });
  try {
    const result = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO community_chart(id,owner_id,created_at,updated_at) VALUES(?,?,?,?)").bind(
        id,
        owner,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO community_chart_revision(chart_id,revision,request_id,payload_hash,object_key,title,artist,charter,difficulty,level,summary,audio_json,cover_json,audio_url,cover_url,audio_upload_id,cover_attachment_id,remix,upstream_id,data_key,data_hash,created_at,published_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM community_chart WHERE id = ? AND owner_id = ? AND version = ? AND deleted_at IS NULL`,
      ).bind(
        id,
        revision,
        input.requestId,
        payloadHash,
        objectKey,
        title,
        project.meta.artist,
        project.meta.charter,
        project.meta.difficulty,
        project.meta.level,
        summary,
        JSON.stringify(normalized.audio),
        JSON.stringify(normalized.cover),
        audioUrl,
        coverUrl,
        normalized.audio?.kind === "upload" ? normalized.audio.id : null,
        normalized.cover?.kind === "upload" ? normalized.cover.id : null,
        input.remix ? 1 : 0,
        upstreamId,
        dataKey,
        dataHash,
        now,
        publish ? now : null,
        id,
        owner,
        expected,
      ),
      env.DB.prepare(
        `UPDATE community_chart SET head = ?, version = version + 1, updated_at = ?, published_revision = CASE WHEN ? THEN ? ELSE published_revision END, visibility = CASE WHEN ? THEN ? ELSE visibility END WHERE id = ? AND owner_id = ? AND version = ? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM community_chart_revision WHERE chart_id = ? AND object_key = ?)`,
      ).bind(
        revision,
        now,
        publish ? 1 : 0,
        revision,
        publish ? 1 : 0,
        input.visibility,
        id,
        owner,
        expected,
        id,
        objectKey,
      ),
      env.DB.prepare(
        "DELETE FROM community_chart_gc WHERE object_key IN (?,?) AND EXISTS (SELECT 1 FROM community_chart_revision WHERE object_key = ?)",
      ).bind(objectKey, dataKey, objectKey),
      ...snapshots.map((snapshot) =>
        env.DB.prepare(
          `INSERT INTO community_chart_revision_media(chart_id,revision,kind,asset_hash)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM community_chart_revision WHERE object_key = ?)`,
        ).bind(id, revision, snapshot.kind, snapshot.hash, objectKey),
      ),
    ]);
    if (!result[2]?.meta.changes) throw new Error("save_conflict");
  } catch (error) {
    await env.COMMUNITY_UPLOADS.delete(objectKey);
    throw error;
  }
  const saved = (await find(env, id, owner, true))!;
  await ensureAnalysis(env, saved);
  return json(request, { chart: item(saved, owner) });
}
async function serveMedia(request: Request, env: Env, row: Row, kind: string) {
  const ref = JSON.parse(kind === "audio" ? row.audioJson : row.coverJson) as ChartMediaRef;
  if (!ref) return fail(request, 404, "media_missing");
  const snapshot = ref.kind === "server" ? await chartMediaSnapshot(env, row.id, row.revision, kind) : null;
  if (ref.kind === "server" && !snapshot) {
    const legacyUrl = kind === "audio" ? row.audioUrl : row.coverUrl;
    return legacyUrl.startsWith(PREFIX)
      ? fail(request, 404, "media_missing")
      : new Response(null, { status: 302, headers: { Location: legacyUrl, "Cache-Control": "no-store" } });
  }
  const uploaded =
    ref.kind === "server"
      ? null
      : kind === "audio"
        ? await env.DB.prepare("SELECT object_key AS key, 'audio/wav' AS type FROM community_chart_audio WHERE id = ?")
            .bind(ref.id)
            .first<{ key: string; type: string }>()
        : await env.DB.prepare(
            "SELECT object_key AS key, media_type AS type FROM community_attachment WHERE id = ? AND status = 'ready' AND moderation_status = 'allow' AND deleted_at IS NULL",
          )
            .bind(ref.id)
            .first<{ key: string; type: string }>();
  const source = snapshot ?? uploaded;
  if (!source) return fail(request, 404, "media_missing");
  const object = await env.COMMUNITY_UPLOADS.get(source.key, { range: request.headers });
  if (!object) return fail(request, 404, "media_missing");
  const headers = new Headers({
    "Content-Type": source.type,
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
    ETag: object.httpEtag,
  });
  let status = 200;
  if (request.headers.has("Range") && object.range && "offset" in object.range && "length" in object.range) {
    const { offset, length } = object.range;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    status = 206;
  } else headers.set("Content-Length", String(object.size));
  if (request.method === "HEAD") await object.body.cancel();
  return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}
export async function handleCommunityChartRequest(
  request: Request,
  env: Env,
  resolve: Resolver,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  // Publication and withdrawal must be observed before private R2 bytes leave the Worker.
  return withPrimaryD1(env, async (primary) => {
    if (!primary.DB || !primary.COMMUNITY_UPLOADS) return fail(request, 503, "service_unavailable");
    const method = request.method === "HEAD" ? "GET" : request.method;
    const [id, action, revisionText, kind, extra] = url.pathname.slice(PREFIX.length + 1).split("/");
    try {
      if (method !== "GET") {
        const origin = request.headers.get("Origin"),
          site = request.headers.get("Sec-Fetch-Site");
        if ((origin && origin !== url.origin) || (site && !["same-origin", "none"].includes(site)))
          return fail(request, 403, "cross_origin_request");
      }
      if (id === "audio" && !action && method === "POST")
        return await uploadAudio(request, primary, (await writer(request, primary)).id);
      const user = method === "GET" ? await viewer(request, primary) : await writer(request, primary);
      const owner = user?.id ?? "";
      if (!id && method === "GET") {
        const mine = url.searchParams.get("scope") === "mine";
        if (mine && !owner) return fail(request, 401, "authentication_required");
        const order = url.searchParams.get("order") ?? (mine ? "latest" : "recommended");
        const seedValue = url.searchParams.get("seed");
        if (!["latest", "recommended"].includes(order) ||
          (seedValue !== null && (!/^\d+$/u.test(seedValue) || Number(seedValue) > 2_147_483_647)))
          return fail(request, 400, "invalid_query");
        const seed = seedValue === null ? crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff : Number(seedValue);
        const rankedAt = Date.now();
        const rows = mine
          ? (
              await primary.DB.prepare(
                `SELECT ${columns} ${joined} WHERE c.owner_id = ?1 AND c.deleted_at IS NULL AND r.revision = c.head ORDER BY c.updated_at DESC`,
              )
                .bind(owner)
                .all<Row>()
            ).results
          : order === "recommended"
            ? await recommendedCharts(primary, user?.id ?? null, seed, rankedAt)
            : await communityChartRows(primary);
        for (let index = 0; index < rows.length; index += 2)
          await Promise.all(rows.slice(index, index + 2).map((row) => ensureAnalysis(primary, row)));
        if (!mine && order === "recommended" && owner && request.method !== "HEAD")
          await recordChartRecommendations(primary, rows, owner, seed, rankedAt);
        return json(request, { charts: rows.map((r) => item(r, owner)), ...(!mine && order === "recommended" ? { seed, rankedAt } : {}) });
      }
      if (!UUID.test(id ?? "") || extra !== undefined) return fail(request, 404, "chart_missing");
      if (!action && method === "PUT") return await saveChart(request, primary, owner, id!, resolve);
      const revisionValue = action === "media" ? revisionText : url.searchParams.get("revision");
      const revision =
        /^\d+$/u.test(revisionValue ?? "") && Number(revisionValue) > 0 ? Number(revisionValue) : undefined;
      const row = await find(
        primary,
        id!,
        owner,
        url.searchParams.get("draft") === "1" || (method !== "GET" && action !== "like"),
        revision,
      );
      if (!row) return fail(request, 404, "chart_missing");
      if (action === "media" && revision && ["audio", "cover"].includes(kind ?? "") && method === "GET")
        return serveMedia(request, primary, row, kind!);
      if (!action && method === "GET") {
        await ensureAnalysis(primary, row);
        return json(request, { chart: item(row, owner) });
      }
      if (action === "playback" && method === "GET") {
        const object = await primary.COMMUNITY_UPLOADS.get(row.objectKey);
        if (!object) return fail(request, 404, "chart_missing");
        const { project } = await object.json<{ project: Project }>();
        const tempo = new TempoMap(project.tempos, { resolution: project.resolution });
        return json(request, {
          ss: serializeSsForTarget({ ...project, extensions: {} }, false),
          offsetMs: project.audioOffset * 1000,
          timeScaleChanges: project.timeScales
            .map((event) => ({ timeMs: tempo.tickToSeconds(event.tick) * 1000, scale: event.scale }))
            .sort((a, b) => a.timeMs - b.timeMs),
        } satisfies CommunityChartPlayback);
      }
      if (action === "project" && method === "GET") {
        if (row.ownerId !== owner && !row.remix) return fail(request, 403, "remix_unavailable");
        const object = await primary.COMMUNITY_UPLOADS.get(row.objectKey);
        if (!object) return fail(request, 404, "chart_missing");
        return json(request, {
          chart: item(row, owner),
          document: {
            ...(await object.json<RecordValue>()),
            revision: row.revision,
            audioUrl: row.audioUrl,
            coverUrl: row.coverUrl,
          },
        });
      }
      if (action === "revisions" && method === "GET" && row.ownerId === owner) {
        const rows = await primary.DB.prepare(
          "SELECT revision,title,created_at AS createdAt,published_at AS publishedAt FROM community_chart_revision WHERE chart_id = ? ORDER BY revision DESC",
        )
          .bind(id!)
          .all();
        return json(request, { revisions: rows.results });
      }
      if (action === "like" && method === "PUT") {
        const input = await body(request);
        if (input.liked === true)
          await primary.DB.prepare(
            "INSERT OR IGNORE INTO community_chart_like(chart_id,user_id,created_at) VALUES(?,?,?)",
          )
            .bind(id!, owner, Date.now())
            .run();
        else if (input.liked === false)
          await primary.DB.prepare("DELETE FROM community_chart_like WHERE chart_id = ? AND user_id = ?")
            .bind(id!, owner)
            .run();
        else throw new Error("invalid_chart");
        return json(request, { chart: item((await find(primary, id!, owner))!, owner) });
      }
      if (
        row.ownerId === owner &&
        ((!action && method === "DELETE") || (action === "unpublish" && method === "POST"))
      ) {
        const input = await body(request);
        if (input.version !== row.version) throw new Error("save_conflict");
        const changed = await primary.DB.prepare(
          `UPDATE community_chart SET published_revision = NULL, version = version + 1, updated_at = ?, deleted_at = ${method === "DELETE" ? "?" : "deleted_at"} WHERE id = ? AND owner_id = ? AND version = ?`,
        )
          .bind(Date.now(), ...(method === "DELETE" ? [Date.now()] : []), id!, owner, row.version)
          .run();
        if (!changed.meta.changes) throw new Error("save_conflict");
        return json(request, { version: row.version + 1 });
      }
      return fail(request, 405, "method_not_allowed");
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_chart";
      const known = new Set([
        "authentication_required",
        "email_verification_required",
        "community_write_restricted",
        "rate_limit_exceeded",
        "file_size",
        "audio_format",
        "audio_duration",
        "storage_limit",
        "metadata_required",
        "invalid_chart",
        "save_conflict",
        "media_missing",
        "media_changed",
        "media_not_ready",
        "text_blocked",
        "sonolus_timescale",
        "sonolus_chart_invalid",
        "remix_unavailable",
      ]);
      if (!known.has(code))
        console.error(
          JSON.stringify({
            event: "community.chart_failed",
            error: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      return fail(
        request,
        !known.has(code)
          ? 503
          : code === "authentication_required"
            ? 401
            : code === "save_conflict"
              ? 409
              : code === "rate_limit_exceeded"
                ? 429
                : 422,
        known.has(code) ? code : "service_unavailable",
      );
    }
  });
}

export function communitySonolusProviders(
  env: Env,
  rows: Row[],
  revision: string,
): { catalogProvider: ChartCatalogProvider; dataProvider: ChartDataProvider } {
  const byId = new Map(rows.map((row) => [`community:${row.id}:${row.revision}`, row]));
  return {
    catalogProvider: {
      async load() {
        return {
          revision: { id: revision },
          charts: rows.map((r): ChartDescriptor => ({
            name: chartLevelName(r.id),
            songId: r.id,
            dataId: `community:${r.id}:${r.revision}`,
            title: r.title,
            artists: r.artist,
            author: r.charter || r.ownerName,
            description: [
              ...(r.summary ? [...r.summary.split("\n").map((line) => `##:${line}`), ""] : []),
              ...[
                ["#ARTISTS", r.artist],
                ["#AUTHOR", r.charter || r.ownerName],
                ["#OWNER", r.ownerName || `#${r.ownerUid}`],
                ["#PUBLISHED", r.publishedAt === null ? "" : new Date(r.publishedAt).toISOString()],
              ].flatMap(([label, value]) => value ? [`${label}:#SEPARATOR_COLON:##:${value}`] : []),
            ].join("\n"),
            searchKeywords: [r.summary, r.charter, r.ownerName],
            rating: Number.parseFloat(r.level) || 0,
            difficulty: r.difficulty,
            publishedAt: r.publishedAt ?? 0,
            bgmUrl: r.audioUrl,
            coverUrl: r.coverUrl,
          })),
        };
      },
    },
    dataProvider: {
      async prepare(chart) {
        const r = byId.get(chart.dataId);
        return r?.dataHash ? { hash: r.dataHash, resource: {} } : null;
      },
      async load(chart, expected) {
        let r = byId.get(chart.dataId);
        if (r && r.dataHash !== expected) {
          const previous = await env.DB.prepare(
            "SELECT revision FROM community_chart_revision WHERE chart_id = ? AND data_hash = ? AND published_at IS NOT NULL ORDER BY revision DESC LIMIT 1",
          )
            .bind(r.id, expected)
            .first<{ revision: number }>();
          r = previous ? ((await find(env, r.id, "", false, previous.revision)) ?? undefined) : undefined;
        }
        if (!r?.dataKey || r.dataHash !== expected || !(await find(env, r.id, "", false, r.revision))) return null;
        const object = await env.COMMUNITY_UPLOADS.get(r.dataKey);
        return object
          ? {
              body: await object.arrayBuffer(),
              cacheControl: "no-store",
              contentType: "application/gzip",
              etag: `"${expected}"`,
            }
          : null;
      },
    },
  };
}
export async function communitySonolusRows(env: Env, name?: string) {
  if (name?.startsWith("haneoka-community-")) {
    const id = name.slice("haneoka-community-".length);
    const row = UUID.test(id) ? await find(env, id) : null;
    return row ? [row] : [];
  }
  return communityChartRows(env);
}

export async function cleanupCommunityCharts(env: Env) {
  const retryBefore = Date.now() - 60 * 60 * 1000;
  for (const row of (await communityChartRows(env))
    .filter((row) => row.analysisJson === null || (row.analysisJson === "null" && (row.analysisCreatedAt ?? 0) <= retryBefore))
    .sort((a, b) => (a.analysisCreatedAt ?? 0) - (b.analysisCreatedAt ?? 0)).slice(0, 5))
    await ensureAnalysis(env, row);
  const now = Date.now(),
    day = 24 * 60 * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO community_chart_gc SELECT a.object_key, ? FROM community_chart_audio a WHERE a.created_at < ? AND NOT EXISTS (SELECT 1 FROM community_chart_revision r WHERE r.audio_upload_id = a.id) LIMIT 50`,
    ).bind(now, now - day),
    env.DB.prepare(
      `DELETE FROM community_chart_audio WHERE object_key IN (SELECT object_key FROM community_chart_gc) AND created_at < ? AND NOT EXISTS (SELECT 1 FROM community_chart_revision r WHERE r.audio_upload_id = community_chart_audio.id)`,
    ).bind(now - day),
    env.DB.prepare(
      `INSERT OR IGNORE INTO community_chart_gc SELECT r.object_key, ? FROM community_chart_revision r JOIN community_chart c ON c.id = r.chart_id WHERE c.deleted_at < ? LIMIT 100`,
    ).bind(now, now - 30 * day),
    env.DB.prepare(
      `INSERT OR IGNORE INTO community_chart_gc SELECT r.data_key, ? FROM community_chart_revision r JOIN community_chart c ON c.id = r.chart_id WHERE c.deleted_at < ? AND r.data_key IS NOT NULL AND r.object_key IN (SELECT object_key FROM community_chart_gc)`,
    ).bind(now, now - 30 * day),
    env.DB.prepare(
      `DELETE FROM community_chart_revision WHERE object_key IN (SELECT object_key FROM community_chart_gc) AND chart_id IN (SELECT id FROM community_chart WHERE deleted_at < ?)`,
    ).bind(now - 30 * day),
  ]);
  const jobs = await env.DB.prepare(
    `SELECT object_key AS key FROM community_chart_gc gc WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM community_chart_revision r WHERE r.object_key = gc.object_key OR r.data_key = gc.object_key) AND NOT EXISTS (SELECT 1 FROM community_chart_audio a WHERE a.object_key = gc.object_key) AND NOT EXISTS (SELECT 1 FROM community_chart_media_asset a JOIN community_chart_revision_media m ON m.asset_hash = a.hash WHERE a.object_key = gc.object_key) ORDER BY created_at LIMIT 100`,
  )
    .bind(now - day)
    .all<{ key: string }>();
  for (const job of jobs.results) {
    try {
      if (job.key.startsWith("charts/media/")) {
        await env.DB.prepare(
          `DELETE FROM community_chart_media_asset WHERE object_key = ?
          AND NOT EXISTS(SELECT 1 FROM community_chart_revision_media WHERE asset_hash = community_chart_media_asset.hash)`,
        )
          .bind(job.key)
          .run();
        if (
          await env.DB.prepare("SELECT 1 FROM community_chart_media_asset WHERE object_key = ?").bind(job.key).first()
        )
          continue;
      }
      await env.COMMUNITY_UPLOADS.delete(job.key);
      await env.DB.prepare("DELETE FROM community_chart_gc WHERE object_key = ?").bind(job.key).run();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "community.chart_cleanup_failed",
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
  }
}
