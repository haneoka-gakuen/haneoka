import { getContainer } from "@cloudflare/containers";
import { getAuthSession } from "../../worker/auth";
import { communityAccessState } from "../../worker/access";

export interface RecognitionContext {
  server: string;
  releaseId: string;
  sourceId: string;
}
export interface RecognitionReference extends RecognitionContext {
  referenceId: string;
  byteSize: number;
  openBundle: () => Promise<ReadableStream<Uint8Array>>;
}
export type RecognitionReferenceProvider = (
  env: Env,
  context: RecognitionContext,
) => Promise<RecognitionReference | null>;

const PREFIX = "/api/v1/team-builder/recognition/jobs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const PIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const BUNDLE_LIMIT = 64 * 1024 * 1024;
const json = (request: Request, value: object, status: number) =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
    },
  });
const error = (request: Request, status: number, code: string, message: string) =>
  json(request, { error: { code, message } }, status);
const sameOrigin = (request: Request) => {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "none" && site !== "same-origin") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};
const digest = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const contextHeaders = (context: RecognitionContext, owner: string) => ({
  "X-Recognition-Owner": owner,
  "X-Recognition-Server": context.server,
  "X-Recognition-Release": context.releaseId,
  "X-Recognition-Source": context.sourceId,
});

export async function handleScreenshotRecognitionRequest(
  request: Request,
  env: Env,
  loadReference: RecognitionReferenceProvider,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  if (!sameOrigin(request)) return error(request, 403, "cross_origin_request", "Use the same origin");
  if (!env.DB || !env.MEDIA_PROCESSOR)
    return error(request, 503, "recognition_unavailable", "Recognition is unavailable");
  const id =
    url.pathname === PREFIX ? request.headers.get("Idempotency-Key") || "" : url.pathname.slice(PREFIX.length + 1);
  const create = request.method === "POST" && url.pathname === PREFIX;
  if (!create && !["GET", "HEAD", "DELETE"].includes(request.method))
    return error(request, 405, "method_not_allowed", "Method not allowed");
  if (!UUID.test(id)) return error(request, 422, "invalid_job_id", "Send a UUID job identity");
  const context: RecognitionContext = {
    server: url.searchParams.get("server") || "",
    releaseId: url.searchParams.get("releaseId") || "",
    sourceId: url.searchParams.get("sourceId") || "",
  };
  if (!Object.values(context).every((v) => PIN.test(v)))
    return error(request, 422, "invalid_context", "Send the loaded reference identity");
  const session = await getAuthSession(request, env, { authoritative: true });
  if (!session?.user?.id) return error(request, 401, "authentication_required", "Sign in required");
  if (request.headers.get("X-Haneoka-Expected-User") !== session.user.id)
    return error(request, 409, "account_changed", "The signed-in account changed");
  const access = await communityAccessState(env, session.user.id, ["sign_in", "write", "upload"]);
  if (!access) return error(request, 503, "profile_unavailable", "Account profile is unavailable");
  if (access.status !== "active" || access.restriction)
    return error(request, 403, "account_restricted", "This account cannot recognize screenshots");
  if (!session.user.emailVerified)
    return error(request, 403, "email_verification_required", "Verify the account email first");
  const owner = await digest(`screenshot-recognition-v1:${session.user.id}`);
  const headers = contextHeaders(context, owner);
  const stub = getContainer(env.MEDIA_PROCESSOR, `media-${parseInt(id.slice(-2), 16) % 2}`);
  try {
    if (!create) {
      const response = await stub.fetch(
        new Request(`http://media/recognition/jobs/${id}`, {
          method: request.method === "HEAD" ? "GET" : request.method,
          headers,
          signal: request.signal,
        }),
      );
      return privateResponse(request, response);
    }
    const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() || "";
    const size = Number(request.headers.get("Content-Length"));
    const imageSha = request.headers.get("X-Image-Sha256") || "";
    const cropHeader = request.headers.get("X-Recognition-Crop");
    const kind = request.headers.get("X-Recognition-Kind");
    let crop: { x: number; y: number; width: number; height: number } | null = null;
    try {
      if (cropHeader) {
        if (cropHeader.length > 200) throw new Error();
        const value: unknown = JSON.parse(cropHeader);
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4)
          throw new Error();
        const row = value as Record<string, unknown>;
        if (
          !["x", "y", "width", "height"].every(
            (key) => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0 && Number(row[key]) <= 4096,
          ) ||
          Number(row.width) < 16 ||
          Number(row.height) < 16
        )
          throw new Error();
        crop = { x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height) };
      }
      if (kind && (!crop || !["members", "snapshots"].includes(kind))) throw new Error();
    } catch {
      return error(request, 422, "invalid_crop", "Choose a crop inside the screenshot");
    }

    if (!["image/png", "image/jpeg", "image/webp"].includes(mediaType))
      return error(request, 415, "unsupported_screenshot", "Use a static PNG, JPEG or WebP screenshot");
    if (!request.body || !Number.isSafeInteger(size) || size <= 0 || size > IMAGE_LIMIT)
      return error(request, 413, "screenshot_too_large", "Screenshot must be at most 8 MiB");
    if (!HASH.test(imageSha)) return error(request, 422, "image_checksum_required", "Send the screenshot checksum");
    if (
      env.COMMUNITY_RATE_LIMITER &&
      !(await env.COMMUNITY_RATE_LIMITER.limit({ key: `recognition:${owner}` })).success
    )
      return error(request, 429, "rate_limit_exceeded", "Too many recognition requests");
    const reference = await loadReference(env, context);
    if (!reference || Object.entries(context).some(([k, v]) => reference[k as keyof RecognitionContext] !== v))
      return error(request, 409, "reference_changed", "The loaded reference is no longer available");
    if (
      !HASH.test(reference.referenceId) ||
      !Number.isSafeInteger(reference.byteSize) ||
      reference.byteSize <= 0 ||
      reference.byteSize > BUNDLE_LIMIT
    )
      return error(request, 503, "reference_invalid", "Reference data is unavailable");
    const check = await stub.fetch(
      new Request(`http://media/recognition/references/${reference.referenceId}`, { headers }),
    );
    const missing = check.status === 404;
    await check.body?.cancel();
    if (missing) {
      const body = await reference.openBundle();
      const installed = await stub.fetch(
        new Request(`http://media/recognition/references/${reference.referenceId}`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/zip" },
          body: body.pipeThrough(new FixedLengthStream(reference.byteSize)),
          signal: request.signal,
        }),
      );
      if (!installed.ok) return privateResponse(request, installed);
      await installed.body?.cancel();
    } else if (!check.ok) return error(request, 503, "reference_unavailable", "Reference preparation is busy");
    const response = await stub.fetch(
      new Request(`http://media/recognition/jobs/${id}`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": mediaType,
          "X-Image-Sha256": imageSha,
          "X-Recognition-Reference": reference.referenceId,
          ...(crop ? { "X-Recognition-Crop": JSON.stringify(crop) } : {}),
          ...(kind ? { "X-Recognition-Kind": kind } : {}),
        },
        body: request.body.pipeThrough(new FixedLengthStream(size)),
        signal: request.signal,
      }),
    );
    return privateResponse(request, response);
  } catch {
    return error(request, 503, "recognition_unavailable", "Recognition is temporarily unavailable");
  }
}

async function privateResponse(request: Request, response: Response): Promise<Response> {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    Vary: "Cookie",
  });
  if (response.headers.has("Retry-After")) headers.set("Retry-After", response.headers.get("Retry-After")!);
  if (request.method === "HEAD") {
    await response.body?.cancel();
    return new Response(null, { status: response.status, headers });
  }
  return new Response(response.body, { status: response.status, headers });
}
