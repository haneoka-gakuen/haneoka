// L3 — GEB
// Input: 网页导出模型、release、模型姿势与图片图层。
// Output: 原有网页渲染器生成的 PNG 或分页 ZIP。
// Pos: [Map](../L2-2.md)；设备、私有服务与托管图片 API 共用执行入口。
// Effects/Dependencies: 获取公开素材和字体，创建画布／WebGL；释放模型和临时字体。
import { createHaneokaClient } from "../../../packages/api-client/src/haneoka";
import { ApiClientError } from "../../../packages/api-client/src/index";
import { canvasToPngBlob } from "../canvas-capture";
import type { ResourceImageRequest, ModelImageOptions } from "./image-contract";
import { viewerBufferSize } from "../../lit/runtime/viewer-resolution";
export type * from "./image-contract";
class ImageResourceError extends Error {
  constructor(readonly status: number) { super(`Resource HTTP ${status}`); }
}

let imageQueue: Promise<unknown> = Promise.resolve();
export function renderResourceImage(input: ResourceImageRequest, options: { apiBase?: string; signal?: AbortSignal } = {}) {
  const result = imageQueue.then(async () => {
    const root = document.documentElement, attributes = ["lang", "data-theme", "data-ui-resolved-theme", "data-seed"];
    const previous = attributes.map(name => root.getAttribute(name));
    try { return await renderImage(input, options); }
    finally { attributes.forEach((name, index) => { const value = previous[index]; if (value === null) root.removeAttribute(name); else root.setAttribute(name, value!); }); }
  });
  imageQueue = result.catch(() => undefined);
  return result;
}
async function renderImage(input: ResourceImageRequest, options: { apiBase?: string; signal?: AbortSignal }) {
  const api = new URL(options.apiBase ?? "/api/v1/", location.href); api.pathname = api.pathname.replace(/\/?$/u, "/");
  const apiBase = api.href;
  input = mapImageUrls(input, value => /^\/(?!\/)/u.test(value) ? new URL(value, apiBase).href : value) as ResourceImageRequest;
  const locale = input.locale ?? "en";
  document.documentElement.lang = locale;
  document.documentElement.dataset.theme = input.theme ?? "light";
  document.documentElement.dataset.uiResolvedTheme = input.theme ?? "light";
  document.documentElement.dataset.seed = input.seed ?? "default";
  const font = getComputedStyle(document.body).fontFamily;
  const text = imageFontText(input);
  const fonts = new Set([font]);
  await Promise.all([...fonts].flatMap(family => [400, 500, 600, 700].map(weight => document.fonts.load(`${weight} 24px ${family}`, text))));
  const source = (value: string) => new URL(value, apiBase).href;
  const signal = options.signal ?? AbortSignal.timeout(45000);
  let blob: Blob;
  if (input.kind === "team") {
    const { renderTeamImage } = await import("./team-image");
    blob = await renderTeamImage(input.data, { apiBase, locale, signal });
  } else if (input.kind === "gacha") {
    const { renderGachaImage } = await import("../gacha-simulation-image");
    blob = await renderGachaImage(input.data);
  } else if (input.kind === "gacha-history") {
    const { renderGachaHistoryImages } = await import("../gacha-history-image");
    const pages = await renderGachaHistoryImages(input.data, { signal, page: input.archive ? undefined : input.page ?? 1, assetsBase: apiBase });
    if (input.archive) {
      const { zipSync } = await import("fflate");
      const files: Record<string, Uint8Array> = {};
      for (const [index, page] of pages.entries()) files[`gacha-history-${index + 1}.png`] = new Uint8Array(await page.arrayBuffer());
      blob = new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>], { type: "application/zip" });
    } else blob = pages[0]!;
  } else if (input.kind === "stamp") {
    const { drawStamp, loadStampFont } = await import("../stamp-maker/render");
    const { registerImportedFont, removeImportedFont } = await import("../stamp-maker/fonts");
    const { stampOutputSize } = await import("../stamp-maker/sizes");
    const faces: FontFace[] = [];
    try {
      for (const font of input.data.fonts ?? []) {
        const face = new FontFace(font.family, `url(${JSON.stringify(source(font.source))})`);
        await face.load(); registerImportedFont(face, font.family); faces.push(face);
      }
      for (const layer of input.data.layers.filter(layer => !layer.image)) await loadStampFont(layer.settings, font, new URL("/", apiBase).href);
      const image = new Image(); image.crossOrigin = "anonymous"; image.src = source(input.data.image); await image.decode();
      const size = stampOutputSize(input.data.sourceSize, String(input.data.size ?? 512));
      const canvas = document.createElement("canvas"); canvas.width = size.width; canvas.height = size.height;
      drawStamp(canvas, image, input.data.layers, font, undefined, undefined, input.data.sourceSize);
      blob = await canvasToPngBlob(canvas);
    } finally { for (const face of faces) removeImportedFont(face); }
  } else if (input.kind === "chart") {
    const { loadOurNotesCreationCanvasSkin } = await import("../chart-creation/native-canvas-skin");
    const { drawDetailedChartOverview } = await import("../../lit/runtime/chart-overview-renderer");
    const { composeChartOverviewImage, completeChartOverviewMeta } = await import("../../lit/runtime/chart-image-export");
    const identity = await releaseIdentity(input.data, apiBase, signal);
    const skin = await loadOurNotesCreationCanvasSkin(identity, { apiBase, signal, locale });
    try {
      const { chartCanvasOverviewPresentation } = await import("@haneoka/cassiopeia-ui-vue/overview");
      const height = input.data.height ?? 720, presentation = chartCanvasOverviewPresentation();
      const panels = Math.max(1, Math.ceil(input.data.chart.durationMs / ((height / presentation.heightPerSecond) * 1000)));
      if (panels * presentation.laneWidth * 13 * height > 12_000_000) throw new RangeError("Chart image exceeds the pixel budget");
      const canvas = document.createElement("canvas");
      drawDetailedChartOverview(canvas, input.data.chart, skin.skin, height);
      const labels = await fetch(new URL(`/i18n/${locale}.json`, apiBase), { signal }).then(response => response.json()) as { media: { chartPlayer: Record<string, string> } };
      const meta = completeChartOverviewMeta(input.data.meta, input.data.chart, key => labels.media.chartPlayer[key]!);
      blob = (await composeChartOverviewImage(canvas, meta))!;
      if (!blob) throw new Error("Image drawing failed");
    } finally { await skin.dispose(); }
  } else {
    blob = await renderModelImage(input, apiBase, signal);
  }
  signal.throwIfAborted();
  if (blob.size > 16 * 1024 * 1024) throw new RangeError("Image exceeds 16 MiB");
  let width: number | undefined, height: number | undefined;
  if (blob.type === "image/png") {
    const image = await createImageBitmap(blob); width = image.width; height = image.height; image.close();
  }
  return { blob, width, height, fileName: `${input.kind}.${blob.type === "application/zip" ? "zip" : "png"}` };
}
export async function parseChartScore(score: string) {
  const { buildChart, parseScore } = await import("@haneoka/cassiopeia-plugin-our-notes");
  return buildChart(parseScore(score));
}
export async function requestResourceImage(input: ResourceImageRequest, options: { apiBase?: string; signal?: AbortSignal } = {}) {
  const { RESOURCE_IMAGE_ROUTES } = await import("./image-routes");
  const route = RESOURCE_IMAGE_ROUTES.find(route => route.kind === input.kind && route.path.endsWith(".zip") === ("archive" in input && input.archive === true))!;
  const api = new URL(options.apiBase ?? "/api/v1/", location.href); api.pathname = api.pathname.replace(/\/?$/u, "/");
  const url = new URL(route.path.replace(/^\/api\/v1\//u, "").replace("{id}", "id" in input ? encodeURIComponent(input.id) : ""), api);
  const { kind: _kind, ...body } = input;
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: options.signal });
  if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
  return response.blob();
}
async function releaseIdentity(input: Pick<ModelImageOptions, "server" | "release">, apiBase: string, signal: AbortSignal) {
  const url = new URL(`servers/${input.server ?? "intl"}/release`, apiBase);
  url.searchParams.set("projection", "identity");
  if (input.release) url.searchParams.set("release", input.release);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new ImageResourceError(response.status);
  return await response.json() as import("../../../packages/api-client/src/haneoka").HaneokaReleaseIdentity;
}
async function renderModelImage(input: Extract<ResourceImageRequest, { kind: "live2d" | "spine" }>, apiBase: string, signal: AbortSignal) {
  const identity = await releaseIdentity(input.data, apiBase, signal);
  const client = createHaneokaClient({ baseUrl: apiBase });
  const pin = (value: string) => {
    const url = new URL(value, apiBase);
    if (url.origin === new URL(apiBase).origin && /^\/(assets|runtime|objects)\//u.test(url.pathname)) url.searchParams.set("release", identity.releaseId);
    return url.href;
  };
  const detail = mapImageUrls(await client.entity<Record<string, unknown>>(input.kind, input.id, { server: identity.server, release: identity.releaseId, signal }), value => /^\/|^https?:/u.test(value) ? pin(value) : value) as Record<string, unknown>;
  const width = input.data.width ?? 1024, height = input.data.height ?? 1024;
  const snapshot = document.createElement("canvas"), context = snapshot.getContext("2d")!;
  const copy = (canvas: HTMLCanvasElement) => { snapshot.width = canvas.width; snapshot.height = canvas.height; context.drawImage(canvas, 0, 0); };
  const transform = input.data.transform ?? { offsetX: 0, offsetY: 0, scale: 1 };
  if (input.kind === "spine") {
    const { SpineStage } = await import("../../lit/runtime/spine-stage");
    const host = document.createElement("div"); host.style.width = `${width}px`; host.style.height = `${height}px`; document.body.append(host);
    const stage = new SpineStage(host);
    try {
      await stage.load(detail, signal); stage.setPaused(true);
      stage.setLoop(input.data.loop ?? true);
      if (input.data.skin && !stage.setSkin(input.data.skin)) throw new TypeError("Unknown skin");
      if (input.data.animation && !stage.play(input.data.animation)) throw new TypeError("Unknown animation");
      stage.setPaused(true); stage.setPlaybackRate(input.data.playbackRate ?? 1); stage.seek(input.data.time ?? 0);
      stage.setBackgroundColor(input.data.background ?? null); stage.setTransform(transform);
      if (!stage.captureSupersampled(copy)) throw new Error("Canvas is unavailable");
      return await canvasToPngBlob(snapshot);
    } finally { stage.dispose(); host.remove(); }
  }
  const { CUBISM_CORE_URLS, loadCubismWebRuntime } = await import("../cubism-runtime");
  type Viewer = import("../../lit/live2d-workspace").Viewer;
  const runtime = await loadCubismWebRuntime<{
    CubismModelViewer: new (options: { canvas: HTMLCanvasElement; frameControl: "manual"; onError(error: unknown): void }) => Viewer & { advanceFrame(seconds: number): boolean };
    createCubismWebRuntimeAdapter(options: unknown): { prepare(version: number, signal: AbortSignal): Promise<void> };
  }>();
  const core = Object.fromEntries(Object.entries(CUBISM_CORE_URLS).map(([name, url]) => [name, new URL(url, apiBase).href]));
  await runtime.createCubismWebRuntimeAdapter({ runtime: core }).prepare(3, signal);
  const canvas = document.createElement("canvas"); document.body.append(canvas);
  let fault: unknown;
  const viewer = new runtime.CubismModelViewer({ canvas, frameControl: "manual", onError: error => { fault = error; } });
  const row = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};
  const model = row(detail.runtime), profile = row(detail.profile), runtimeProfile = row(model.profile);
  const defaultMotion = input.data.motion ?? String(profile.defaultMotionName ?? runtimeProfile.defaultMotionName ?? model.defaultMotionName ?? detail.defaultMotionName ?? row((detail.motions as unknown[])?.[0]).name ?? "");
  let descriptorUrl: string | undefined;
  try {
    const modelUrl = String(model.model ?? detail.model ?? "");
    const response = await fetch(modelUrl, { signal });
    if (!response.ok) throw new ImageResourceError(response.status);
    const descriptor = await response.json() as Record<string, unknown>;
    descriptor.FileReferences = mapImageUrls(descriptor.FileReferences, value => /\.(moc3?|json|png|webp|jpe?g|wav|ogg)(?:[?#]|$)/iu.test(value) ? pin(new URL(value, modelUrl).href) : value);
    descriptorUrl = URL.createObjectURL(new Blob([JSON.stringify(descriptor)], { type: "application/json" }));
    viewer.setSize(width, height);
    await viewer.load({
      modelUrl: descriptorUrl,
      textureVariants: model.textureVariants as Parameters<Viewer["load"]>[0]["textureVariants"],
      harmonicMotion: model.harmonicMotion ?? detail.harmonicMotion ?? profile.harmonicMotion ?? runtimeProfile.harmonicMotion,
      defaultMotionName: defaultMotion,
      defaultExpressionName: input.data.expression ?? String(profile.defaultExpressionName ?? runtimeProfile.defaultExpressionName ?? model.defaultExpressionName ?? detail.defaultExpressionName ?? ""),
      autoIdleMotion: false, signal,
    });
    viewer.setBreathEnabled(input.data.breath ?? true); viewer.setEyeBlinkEnabled(input.data.blink ?? true);
    viewer.setLoopMotion(input.data.loop ? defaultMotion : null);
    viewer.setBackgroundColor(input.data.background ?? null); viewer.setTransform(transform);
    if (input.data.look) viewer.setLookPosition(input.data.look.x, input.data.look.y);
    for (let remaining = input.data.time ?? 0; remaining > 0; remaining -= 1 / 60) viewer.advanceFrame(Math.min(remaining, 1 / 60));
    if (input.data.parameters) { viewer.setPoseFrozen(true); viewer.setParameterOverrides(input.data.parameters); }
    for (const [id, opacity] of Object.entries(input.data.parts ?? {})) viewer.setPartOpacity(id, opacity);
    viewer.advanceFrame(1 / 60);
    if (fault) throw fault;
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("Canvas is unavailable");
    const size = viewerBufferSize(canvas.width, canvas.height, gl, 4_000_000);
    const scale = Math.min(size.width / canvas.width, size.height / canvas.height);
    if (!viewer.captureSupersampled(scale, copy)) throw new Error("Canvas is unavailable");
    return await canvasToPngBlob(snapshot);
  } finally { viewer.destroy(); canvas.remove(); if (descriptorUrl) URL.revokeObjectURL(descriptorUrl); }
}
function mapImageUrls(value: unknown, convert: (value: string) => string): unknown {
  if (typeof value === "string") return convert(value);
  if (Array.isArray(value)) return value.map(item => mapImageUrls(item, convert));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapImageUrls(item, convert)]));
  return value;
}
function imageFontText(input: ResourceImageRequest): string {
  const characters = new Set("haneoka.org");
  const visit = (value: unknown) => {
    if (typeof value === "string" && !/^(?:https?:|data:|\/)/u.test(value)) for (const character of value) characters.add(character);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(input);
  return [...characters].join("");
}
export async function renderResourceImageTransport(input: ResourceImageRequest, options: Parameters<typeof renderResourceImage>[1] = {}) {
  try {
    const { blob, ...meta } = await renderResourceImage(input, options);
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { ...meta, contentType: blob.type, base64: btoa(binary) };
  } catch (error) {
    if ((error instanceof ApiClientError || error instanceof ImageResourceError) && error.status && [400, 404, 409, 413, 429].includes(error.status)) return { error: { status: error.status, code: error.status === 404 ? "not_found" : "invalid_request", message: error.status === 404 ? "Resource not found" : "Resource request failed" } };
    throw error;
  }
}
