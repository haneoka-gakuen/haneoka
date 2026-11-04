// L3 — GEB
// Input: 已校验的故事音频／SVG、D1 审核任务与 Workers AI。
// Output: 按内容共享的自动审核结果或人工复核项。
// Pos: [Map](L2.md)；故事原始资源的异步自动审核。
// Effects/Dependencies: R2、D1、既有审核队列与策略；租约和来源检查保护人工决定。
import { moderateImageWithAi, moderateTextWithAi, toBase64 } from "./moderation";
import { parseFragment } from "parse5";

const POLICY = "story-resource-v1-content-v2";
const LEASE = 5 * 60_000;
const ATTEMPTS = 3;
const AUDIO_LIMIT = 16 * 1024 ** 2;
const SVG_LIMIT = 1024 ** 2;
interface Check {
  id: string;
  status: string;
  source: string;
  reviewStatus: string;
  attempts: number;
  objectKey: string;
  bytes: number;
  mediaType: string;
  fileName: string;
  hash: string;
  leaseUntil: number | null;
  nextAttemptAt: number;
}

export async function scheduleStoryResourceChecks(env: Env, hash?: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO community_story_resource_check(review_id,status,next_attempt_at,policy_version,created_at,updated_at)
    SELECT r.id,'queued',?,?,?,? FROM community_story_resource_review r JOIN community_story_blob b ON b.hash=r.blob_hash
    WHERE r.status='review' AND r.source='upload' AND b.state='active' ${hash ? "AND b.hash=?" : ""}`,
  )
    .bind(now, POLICY, now, now, ...(hash ? [hash] : []))
    .run();
  await env.DB.prepare(
    `UPDATE community_story_resource_check SET status='queued',lease_token=NULL,lease_until=NULL,
    dispatch_token=NULL,dispatched_at=NULL,updated_at=? WHERE status='processing' AND lease_until<?`,
  )
    .bind(now, now)
    .run();
  if (!env.MODERATION_QUEUE) {
    await env.DB.prepare(
      "UPDATE community_story_resource_check SET status='review',reason_code='queue_unavailable',updated_at=? WHERE status='queued'",
    )
      .bind(now)
      .run();
    return;
  }
  const jobs = await env.DB.prepare(
    `SELECT review_id AS id FROM community_story_resource_check
    WHERE status='queued' AND next_attempt_at<=? AND (dispatched_at IS NULL OR dispatched_at<?) ORDER BY next_attempt_at LIMIT 30`,
  )
    .bind(now, now - LEASE)
    .all<{ id: string }>();
  for (const job of jobs.results) {
    const token = crypto.randomUUID();
    const claimed = await env.DB.prepare(
      `UPDATE community_story_resource_check SET dispatch_token=?,dispatched_at=?,updated_at=?
      WHERE review_id=? AND status='queued' AND (dispatched_at IS NULL OR dispatched_at<?)`,
    )
      .bind(token, now, now, job.id, now - LEASE)
      .run();
    if (!claimed.meta.changes) continue;
    try {
      await env.MODERATION_QUEUE.send({ kind: "story-resource-check", version: 1, id: job.id });
    } catch (error) {
      await env.DB.prepare(
        "UPDATE community_story_resource_check SET dispatch_token=NULL,dispatched_at=NULL WHERE review_id=? AND dispatch_token=?",
      )
        .bind(job.id, token)
        .run();
      console.warn(
        JSON.stringify({
          event: "story.resource.check_dispatch_failed",
          error: error instanceof Error ? error.name : "QueueError",
        }),
      );
    }
  }
}

async function infer(env: Env, check: Check) {
  if (!env.AI) throw new Error("ai_unavailable");
  const limit = check.mediaType === "image/svg+xml" ? SVG_LIMIT : AUDIO_LIMIT;
  if (check.bytes > limit) throw new Error("automatic_check_size_limit");
  const object = await env.COMMUNITY_UPLOADS.get(check.objectKey);
  if (!object || object.size !== check.bytes) throw new Error("resource_missing");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== check.hash) throw new Error("resource_integrity");
  if (check.mediaType === "image/svg+xml") {
    const svg = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    if (/<(?:script|foreignObject|animate\w*|set)\b/iu.test(svg)) throw new Error("svg_dynamic_content");
    const fragment = parseFragment(svg);
    const texts: string[] = [];
    const visit = (node: (typeof fragment.childNodes)[number], depth: number) => {
      if (depth > 64) throw new Error("svg_complexity");
      if (node.nodeName === "#text" && "value" in node) texts.push(String(node.value));
      if ("childNodes" in node) for (const child of node.childNodes) visit(child, depth + 1);
    };
    for (const node of fragment.childNodes) visit(node, 0);
    const textResult = await moderateTextWithAi(env, [check.fileName, ...texts].join("\n"), "text-attachment");
    if (textResult.decision.verdict === "block") return textResult;
    const { rasterizeSvgPreview } = await import("./svg-rasterizer");
    const result = await moderateImageWithAi(env, await rasterizeSvgPreview(svg), "image/png", "post", check.fileName);
    return { ...result, model: [textResult.model, result.model].join(",") };
  }
  const transcription = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: toBase64(bytes),
    task: "transcribe",
    vad_filter: true,
    condition_on_previous_text: false,
  });
  if (
    !transcription ||
    typeof transcription !== "object" ||
    !("text" in transcription) ||
    typeof transcription.text !== "string"
  )
    throw new Error("transcription_invalid");
  const result = await moderateTextWithAi(env, `${check.fileName}\n${transcription.text}`, "text-attachment", {
    contentType: "Audio from a fictional game story; speech may be absent in music and sound effects.",
  });
  return { ...result, model: `@cf/openai/whisper-large-v3-turbo,${result.model}` };
}

export async function handleStoryResourceCheck(env: Env, message: Message<unknown>): Promise<boolean> {
  const body = message.body;
  if (!body || typeof body !== "object" || !("kind" in body) || body.kind !== "story-resource-check") return false;
  if (!("version" in body) || body.version !== 1 || !("id" in body) || typeof body.id !== "string") {
    message.ack();
    return true;
  }
  const check = await env.DB.prepare(
    `SELECT c.review_id AS id,c.status,c.attempts,c.lease_until AS leaseUntil,c.next_attempt_at AS nextAttemptAt,
    r.source,r.status AS reviewStatus,r.media_type AS mediaType,r.file_name AS fileName,b.hash,b.object_key AS objectKey,b.byte_size AS bytes
    FROM community_story_resource_check c JOIN community_story_resource_review r ON r.id=c.review_id JOIN community_story_blob b ON b.hash=r.blob_hash
    WHERE c.review_id=? AND b.state='active'`,
  )
    .bind(body.id)
    .first<Check>();
  if (!check || check.source !== "upload" || check.reviewStatus !== "review") {
    await env.DB.prepare(
      "UPDATE community_story_resource_check SET status='succeeded',lease_token=NULL,lease_until=NULL,reason_code='review_closed',updated_at=? WHERE review_id=? AND status IN ('queued','processing')",
    )
      .bind(Date.now(), body.id)
      .run();
    message.ack();
    return true;
  }
  if (["succeeded", "review"].includes(check.status)) {
    message.ack();
    return true;
  }
  const now = Date.now(),
    token = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE community_story_resource_check SET status='processing',attempts=attempts+1,
    lease_token=?,lease_until=?,dispatch_token=NULL,dispatched_at=NULL,updated_at=?
    WHERE review_id=? AND ((status='queued' AND next_attempt_at<=?) OR (status='processing' AND lease_until<?))`,
  )
    .bind(token, now + LEASE, now, check.id, now, now)
    .run();
  if (!claim.meta.changes) {
    message.retry({ delaySeconds: 30 });
    return true;
  }
  try {
    const result = await infer(env, check),
      completed = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE community_story_resource_check SET status='succeeded',model_id=?,reason_code=?,categories_json=?,lease_until=NULL,updated_at=?
        WHERE review_id=? AND status='processing' AND lease_token=?`,
      ).bind(
        result.model,
        result.decision.reasonCode,
        JSON.stringify(result.decision.categories),
        completed,
        check.id,
        token,
      ),
      env.DB.prepare(
        `UPDATE community_story_resource_review SET status=?,decided_at=?,updated_at=?
        WHERE id=? AND status='review' AND source='upload'
        AND EXISTS(SELECT 1 FROM community_story_resource_check c WHERE c.review_id=? AND c.status='succeeded' AND c.lease_token=?)`,
      ).bind(result.decision.verdict, completed, completed, check.id, check.id, token),
      env.DB.prepare(
        `UPDATE community_story_blob SET moderation_status=(SELECT status FROM community_story_resource_review WHERE id=?),updated_at=?
        WHERE hash=? AND EXISTS(SELECT 1 FROM community_story_resource_review r JOIN community_story_resource_check c ON c.review_id=r.id
          WHERE r.id=? AND r.source='upload' AND c.status='succeeded' AND c.lease_token=?)`,
      ).bind(check.id, completed, check.hash, check.id, token),
    ]);
    message.ack();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "automatic_check_failed";
    const review =
      check.attempts + 1 >= ATTEMPTS ||
      [
        "ai_unavailable",
        "automatic_check_size_limit",
        "svg_external_images",
        "svg_dynamic_content",
        "svg_complexity",
        "resource_integrity",
      ].includes(reason);
    const changed = await env.DB.prepare(
      `UPDATE community_story_resource_check SET status=?,reason_code=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE review_id=? AND status='processing' AND lease_token=?`,
    )
      .bind(review ? "review" : "queued", reason.slice(0, 160), Date.now() + 60_000, Date.now(), check.id, token)
      .run();
    if (review || !changed.meta.changes) message.ack();
    else message.retry({ delaySeconds: 60 });
  }
  return true;
}
