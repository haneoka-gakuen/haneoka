// L3 — GEB
// Input: Published stage transforms, monitor geometry, song video and optional release-owned Cubism models.
// Output: The chart background render target sampled against the chart transport.
// Pos: [Map](L2-2.md); non-lightweight chart presentation.
// Effects/Dependencies: Owns GPU resources and muted media for the selected stage only.
import {
  AdditiveBlending,
  AlwaysStencilFunc,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  EqualStencilFunc,
  FramebufferTexture,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NoColorSpace,
  PerspectiveCamera,
  Quaternion,
  ReplaceStencilOp,
  Scene,
  TextureLoader,
  VideoTexture,
  Vector3,
  WebGLRenderTarget,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from "three";
import type { CubismModelViewer, CubismModelViewerOptions } from "@haneoka/vega-plugin-cubism/web-runtime/viewer";
import { CUBISM_CORE_URLS, loadCubismWebRuntime } from "../../lib/cubism-runtime";

export type ChartPerformance = "lightweight" | "mv" | "live2d";
type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];
type Pose = { position: Vec3; rotation: Vec4; scale: Vec3 };
type StageNode = Pose & { parent: number; active: boolean; name: string };

interface BufferedShape {
  positions: number[];
  uvs: number[];
  indices: number[];
}
interface StagePass extends BufferedShape {
  node: number;
  order: number;
  group: "stage" | "stencil" | "scene" | "video" | "jacket" | "blur-jacket" | "member-monitor" | "band-logo";
  texture?: string;
  tint?: Vec4;
  stencil?: number | null;
  slot?: number;
  monitorAspect?: number;
  shader?: string;
}
interface StageGeometry {
  nodes: StageNode[];
  passes: StagePass[];
  logo?: (BufferedShape & { texture: string }) | null;
}
interface CommonStage extends StageGeometry {
  mount: number;
  camera: { node: number; fov: number; near: number; far: number; maxAspect: number };
  slots: {
    node: number;
    geometry: BufferedShape;
    monitorAnchors?: [number, number];
    order: number;
    position: Vec3;
    scale: number;
  }[];
  capture: { cameraPosition: Vec3; halfHeight: number; nearClip: number; farClip: number };
}
interface MemberMonitor {
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  anchors: [Object3D, Object3D];
  uvs: readonly number[];
  aspect: number;
  pending: Vec4;
}
type BlendKey = [number, number, number, number, number, number, number];
type CameraBlend = { duration: number; keys: BlendKey[] };
interface CameraFrame {
  start: number;
  duration: number;
  node: number;
  fov: number;
  near: number;
  far: number;
  blendIn: CameraBlend;
  blendOut: CameraBlend;
}
interface CameraTimeline {
  nodes: StageNode[];
  clips: CameraFrame[];
  duration: number;
  wrapMode: 0 | 1 | 2;
}
interface SongStage {
  camera: 0 | 1 | 2;
  videos: Record<string, string>;
}
interface MemberModel {
  standard: string;
  low?: string;
  offset?: [number, number];
  scale?: number;
}

interface StageModelManifest {
  FileReferences: {
    Moc?: string;
    Physics?: string;
    Pose?: string;
    DisplayInfo?: string;
    UserData?: string;
    MotionSync?: string;
    Textures?: string[];
    Expressions?: { File: string }[];
    Motions?: Record<string, { File: string; Sound?: string }[]>;
  };
}
interface StageInput {
  commonUrl: string;
  bandUrl: string;
  lineupUrl: string;
  songsUrl: string;
  cameraUrl(profile: string): string;
  musicId: number;
  stageBand: number;
  performingBand: number;
  tempos: readonly { timeMs: number; bpm: number }[];
  quality: StageTime["quality"];
  jacketUrl?: string;
  resolveMedia(path: string): string;
  requestFrame(): void;
  signal: AbortSignal;
}
interface StageTime {
  seconds: number;
  duration: number;
  playing: boolean;
  playbackRate: number;
  introSeconds?: number;
  introCamera?: Vec3;
  width: number;
  height: number;
  quality: 0 | 1 | 2;
}

export interface ChartPerformanceLayer {
  readonly texture: Texture;
  render(renderer: WebGLRenderer, values: StageTime): boolean;
  pause(): void;
  dispose(): void;
}

const qualityProfiles = [
  { fps: 30, stageScale: 0.72, capturePixels: 512 },
  { fps: 25, stageScale: 0.68, capturePixels: 448 },
  { fps: 20, stageScale: 0.52, capturePixels: 384 },
] as const;
const stageMotions = { idle: "mtn_idle_01", play: "mtn_play02_01", finish: "mtn_finish_01" } as const;
const fullStageCrop: Vec4 = [0, 0, 1, 1];
const monitorWorldMargin = 1;
const monitorMinimumViewportSpan = 0.01;

async function json<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Live stage ${response.status}: ${url}`);
  return (await response.json()) as T;
}

function shapeGeometry(shape: BufferedShape): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute(
      shape.positions.map((v, i) => (i % 3 === 2 ? -v : v)),
      3,
    ),
  );
  if (shape.uvs.length === (shape.positions.length / 3) * 2)
    geometry.setAttribute("uv", new Float32BufferAttribute(shape.uvs, 2));
  geometry.setIndex(shape.indices);
  return geometry;
}

function blendCurve(keys: readonly BlendKey[], at: number, incoming: boolean): number {
  if (!keys.length) {
    const value = at * at * (3 - 2 * at);
    return incoming ? value : 1 - value;
  }
  if (at <= keys[0]![0]) return keys[0]![1];
  const right = keys.findIndex(([time]) => time >= at);
  if (right < 0) return keys.at(-1)![1];
  const [start, a, , slopeA, , outWeight, modeA] = keys[right - 1]!;
  const [end, b, slopeB, , inWeight, , modeB] = keys[right]!;
  const span = end - start;
  const normalized = (at - start) / span;
  const left = modeA & 2 ? outWeight : 1 / 3;
  const rightWeight = modeB & 1 ? inWeight : 1 / 3;
  let t = normalized;
  if (modeA & 2 || modeB & 1) {
    let low = 0,
      high = 1;
    for (let step = 0; step < 12; step++) {
      t = (low + high) / 2;
      const u = 1 - t;
      if (3 * u * u * t * left + 3 * u * t * t * (1 - rightWeight) + t ** 3 < normalized) low = t;
      else high = t;
    }
  }
  const u = 1 - t;
  return Math.min(
    1,
    Math.max(
      0,
      u ** 3 * a +
        3 * u * u * t * (a + slopeA * span * left) +
        3 * u * t * t * (b - slopeB * span * rightWeight) +
        t ** 3 * b,
    ),
  );
}

function stageNodes(source: readonly StageNode[], parent: Group | Scene): Group[] {
  const groups: Group[] = [];
  for (const value of source) {
    const node = new Group();
    node.name = value.name;
    node.position.set(value.position[0], value.position[1], -value.position[2]);
    node.quaternion.set(-value.rotation[0], -value.rotation[1], value.rotation[2], value.rotation[3]);
    node.scale.fromArray(value.scale);
    node.visible = value.active;
    (value.parent < 0 ? parent : groups[value.parent]!).add(node);
    groups.push(node);
  }
  return groups;
}

class ChartPerformanceVideo {
  readonly video = document.createElement("video");
  readonly texture = new VideoTexture(this.video);
  private readonly controller = new AbortController();
  private pendingPlay?: Promise<void>;

  constructor(url: string, loop: boolean, signal: AbortSignal, requestFrame: () => void) {
    signal.throwIfAborted();
    const { video } = this;
    const events = { signal: this.controller.signal };
    this.texture.colorSpace = NoColorSpace;
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.loop = loop;
    video.preload = "auto";
    const updateFrame = () => {
      this.texture.needsUpdate = true;
      requestFrame();
    };
    video.addEventListener("loadeddata", updateFrame, events);
    video.addEventListener("seeked", updateFrame, events);
    video.addEventListener("resize", requestFrame, events);
    signal.addEventListener("abort", () => this.dispose(), { ...events, once: true });
    video.src = url;
  }

  sync(values: StageTime): void {
    const { video } = this;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const time = Math.max(0, values.seconds);
    const desired = video.loop ? time % video.duration : Math.min(time, video.duration);
    const running = values.playing && values.introSeconds === undefined && (video.loop || desired < video.duration);
    if (video.playbackRate !== values.playbackRate) video.playbackRate = values.playbackRate;
    if (!video.seeking && Math.abs(video.currentTime - desired) > (running ? 0.14 : 0.02)) video.currentTime = desired;
    if (!running) this.pause();
    else if (video.paused && !this.pendingPlay) {
      this.pendingPlay = video
        .play()
        .catch(() => undefined)
        .finally(() => {
          this.pendingPlay = undefined;
        });
    }
  }

  pause(): void {
    this.video.pause();
  }

  dispose(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.texture.dispose();
  }
}

export async function createChartMovie(
  url: string,
  signal: AbortSignal,
  requestFrame: () => void,
): Promise<ChartPerformanceLayer> {
  const movie = new ChartPerformanceVideo(url, false, signal, requestFrame);
  try {
    if (movie.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      const listeners = new AbortController();
      try {
        await new Promise<void>((resolve, reject) => {
          const events = { signal: listeners.signal, once: true };
          movie.video.addEventListener("loadeddata", () => resolve(), events);
          movie.video.addEventListener("error", () => reject(new Error("Unable to decode the music video")), events);
          signal.addEventListener("abort", () => reject(signal.reason), events);
        });
      } finally {
        listeners.abort();
      }
    }
    signal.throwIfAborted();
  } catch (error) {
    movie.dispose();
    throw error;
  }
  let width = 0,
    height = 0;
  return {
    texture: movie.texture,
    render(_renderer, values) {
      movie.sync(values);
      const changed = width !== movie.video.videoWidth || height !== movie.video.videoHeight;
      width = movie.video.videoWidth;
      height = movie.video.videoHeight;
      return changed;
    },
    pause: () => movie.pause(),
    dispose: () => movie.dispose(),
  };
}

export class ChartLiveStage implements ChartPerformanceLayer {
  private readonly scene = new Scene();
  private readonly target = new WebGLRenderTarget(1, 1, { stencilBuffer: true });
  private readonly monitorFrame = new FramebufferTexture(1, 1);
  private readonly monitors: MemberMonitor[] = [];
  private readonly monitorLower = new Vector3();
  private readonly monitorUpper = new Vector3();
  private readonly meshes: Mesh<BufferGeometry, MeshBasicMaterial>[] = [];
  private readonly textures = new Map<string, Promise<Texture>>();
  private readonly modelUrls: string[] = [];
  private readonly members: {
    viewer: CubismModelViewer;
    texture: CanvasTexture;
    motion: string;
    seconds: number;
  }[] = [];
  private readonly controller = new AbortController();
  private readonly camera: PerspectiveCamera;
  private readonly baseCameraPosition = new Vector3();
  private readonly baseCameraRotation = new Quaternion();
  private readonly baseFov: number;
  private readonly baseNear: number;
  private readonly baseFar: number;
  private readonly maxCameraAspect: number;
  private readonly motionRates: { seconds: number; position: number; rate: number }[];
  private cameraTrack?: {
    clips: (CameraFrame & { position: Vector3; rotation: Quaternion })[];
    duration: number;
    wrapMode: CameraTimeline["wrapMode"];
  };
  private readonly video?: ChartPerformanceVideo;
  private lastFrame = Number.NaN;
  private lastPlaying = false;
  private dirty = true;
  private disposed = false;
  private captureSize = 0;

  static async load(input: StageInput): Promise<ChartLiveStage> {
    const { signal } = input;
    const [common, band, lineup, songs] = await Promise.all([
      json<CommonStage>(input.commonUrl, signal),
      json<StageGeometry>(input.bandUrl, signal),
      json<Record<string, MemberModel[]>>(input.lineupUrl, signal),
      json<Record<string, SongStage>>(input.songsUrl, signal),
    ]);
    signal.throwIfAborted();
    const song = songs[String(input.musicId)];
    const videoUrl = song?.videos[String(input.stageBand)];
    const stage = new ChartLiveStage(input, common, videoUrl);
    try {
      const room = stageNodes(common.nodes, stage.scene);
      const cameraMount = room[common.camera.node]!;
      cameraMount.getWorldPosition(stage.baseCameraPosition);
      cameraMount.getWorldQuaternion(stage.baseCameraRotation);
      stage.scene.add(stage.camera);
      stage.sampleCamera(0, true);
      const bandNodes = stageNodes(band.nodes, room[common.mount]!);
      const jacketMask = room.find((node) => node.name === "jacket_base");
      if (jacketMask) jacketMask.visible = false;
      await Promise.all([
        ...common.passes.map((pass) => stage.addPass(pass, room[pass.node]!, band.logo)),
        ...band.passes.map((pass) => stage.addPass(pass, bandNodes[pass.node]!)),
        stage.loadMembers(common, room, lineup[String(input.performingBand)]),
        stage.loadCamera(input.cameraUrl(["low", "mid", "high"][song?.camera ?? 0]!)),
      ]);
      signal.throwIfAborted();
      return stage;
    } catch (error) {
      stage.dispose();
      throw error;
    }
  }

  private constructor(
    private readonly input: StageInput,
    common: CommonStage,
    videoUrl?: string,
  ) {
    const { fov, near, far } = common.camera;
    this.camera = new PerspectiveCamera(fov, 1, near, far);
    this.baseFov = fov;
    this.baseNear = near;
    this.baseFar = far;
    this.maxCameraAspect = common.camera.maxAspect || Infinity;
    // Live motion clock follows the original BPM response independently of stage FPS.
    this.motionRates = [];
    for (const { timeMs, bpm } of input.tempos) {
      const seconds = timeMs / 1000;
      const previous = this.motionRates.at(-1);
      const position = previous ? previous.position + (seconds - previous.seconds) * previous.rate : seconds;
      this.motionRates.push({ seconds, position, rate: Math.max(0.01, 1 + (bpm - 190) * 0.0025) });
    }
    this.scene.background = null;
    this.target.texture.colorSpace = NoColorSpace;
    this.monitorFrame.minFilter = LinearFilter;
    this.monitorFrame.magFilter = LinearFilter;
    input.signal.addEventListener("abort", () => this.dispose(), { signal: this.controller.signal, once: true });
    if (videoUrl) {
      this.video = new ChartPerformanceVideo(input.resolveMedia(videoUrl), true, this.controller.signal, () => {
        this.dirty = true;
        input.requestFrame();
      });
    }
  }

  get texture(): Texture {
    return this.target.texture;
  }

  private loadTexture(path: string): Promise<Texture> {
    const url = this.input.resolveMedia(path);
    let promise = this.textures.get(url);
    if (!promise) {
      promise = new TextureLoader().loadAsync(url).then((texture) => {
        if (this.controller.signal.aborted) {
          texture.dispose();
          this.controller.signal.throwIfAborted();
        }
        texture.colorSpace = NoColorSpace;
        return texture;
      });
      this.textures.set(url, promise);
    }
    return promise;
  }

  private async addPass(pass: StagePass, node: Group, bandLogo?: StageGeometry["logo"]): Promise<void> {
    const video = pass.group === "video";
    const jacket = pass.group === "jacket" || pass.group === "blur-jacket";
    const isLogo = pass.group === "band-logo";
    if (isLogo && !bandLogo) {
      node.visible = false;
      return;
    }
    if (pass.group === "member-monitor" || (video && !this.video) || (jacket && (!this.input.jacketUrl || this.video)))
      return;
    const path = isLogo ? bandLogo?.texture : jacket ? this.input.jacketUrl : pass.texture;
    const map = video ? this.video?.texture : path ? await this.loadTexture(path) : undefined;
    this.controller.signal.throwIfAborted();
    const geometry = shapeGeometry(isLogo && bandLogo ? bandLogo : pass);
    const material = new MeshBasicMaterial({
      map: map ?? null,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    });
    const [red, green, blue, alpha] = pass.tint ?? [1, 1, 1, 1];
    material.color.setRGB(red, green, blue);
    material.opacity = alpha;
    if (pass.shader === "Live/Light/Additive" || pass.shader === "Custom/Mobile/MobileAddHdrColor")
      material.blending = AdditiveBlending;
    if (pass.stencil != null) {
      material.colorWrite = false;
      material.stencilWrite = true;
      material.stencilRef = pass.stencil;
      material.stencilFunc = AlwaysStencilFunc;
      material.stencilZPass = ReplaceStencilOp;
    }
    const mesh = new Mesh(geometry, material);
    mesh.renderOrder = pass.order;
    mesh.name = pass.group;
    node.add(mesh);
    this.meshes.push(mesh);
  }

  private async loadCamera(url: string) {
    const profile = await json<CameraTimeline>(url, this.controller.signal);
    const groups = stageNodes(profile.nodes, new Group());
    this.cameraTrack = {
      duration: profile.duration,
      wrapMode: profile.wrapMode,
      clips: profile.clips.map((clip) => ({
        ...clip,
        position: groups[clip.node]!.getWorldPosition(new Vector3()),
        rotation: groups[clip.node]!.getWorldQuaternion(new Quaternion()),
      })),
    };
  }

  private sampleCamera(seconds: number, intro: boolean, introCamera?: Vec3) {
    const camera = this.camera;
    camera.position.copy(this.baseCameraPosition);
    camera.quaternion.copy(this.baseCameraRotation);
    let fov = this.baseFov,
      near = this.baseNear,
      far = this.baseFar;
    const track = this.cameraTrack;
    if (intro && introCamera) camera.position.set(introCamera[0], introCamera[1], -introCamera[2]);
    if (track && !intro) {
      const time =
        track.wrapMode === 1
          ? seconds % track.duration
          : track.wrapMode === 0
            ? Math.min(seconds, track.duration - 1e-6)
            : seconds;
      let total = 0;
      for (const clip of track.clips) {
        const local = time - clip.start;
        if (local < 0 || local >= clip.duration) continue;
        let weight = 1;
        if (local < clip.blendIn.duration) weight *= blendCurve(clip.blendIn.keys, local / clip.blendIn.duration, true);
        const remaining = clip.duration - local;
        if (remaining < clip.blendOut.duration)
          weight *= blendCurve(clip.blendOut.keys, 1 - remaining / clip.blendOut.duration, false);
        if (weight <= 0) continue;
        total += weight;
        const mix = weight / total;
        camera.position.lerp(clip.position, mix);
        camera.quaternion.slerp(clip.rotation, mix);
        fov += (clip.fov - fov) * mix;
        near += (clip.near - near) * mix;
        far += (clip.far - far) * mix;
      }
    }
    if (camera.fov !== fov || camera.near !== near || camera.far !== far) {
      camera.fov = fov;
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  }

  private async loadMembers(common: CommonStage, groups: Group[], lineup: MemberModel[] | undefined) {
    if (lineup?.length !== common.slots.length) throw new Error("The lineup has no complete stage model set");
    const runtime = await loadCubismWebRuntime<typeof import("@haneoka/vega-plugin-cubism/web-runtime")>();
    const signal = this.controller.signal;
    const adapter = runtime.createCubismWebRuntimeAdapter({ runtime: CUBISM_CORE_URLS });
    if (!adapter.prepare) throw new Error("The Cubism runtime cannot prepare stage models");
    await adapter.prepare(3, signal);
    for (const [index, slot] of common.slots.entries()) {
      signal.throwIfAborted();
      const entry = lineup[index]!;
      const canvas = document.createElement("canvas");
      const capture = common.capture;
      const viewer = new runtime.CubismModelViewer({
        canvas,
        frameControl: "manual",
        orthographicCapture: {
          ...capture,
          modelPosition: entry.offset ? [entry.offset[0], entry.offset[1], slot.position[2]] : slot.position,
          modelScale: entry.scale ?? slot.scale,
        },
      } satisfies CubismModelViewerOptions);
      const texture = new CanvasTexture(canvas);
      texture.generateMipmaps = false;
      const material = new MeshBasicMaterial({
        map: texture,
        side: DoubleSide,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        toneMapped: false,
      });
      const mesh = new Mesh(shapeGeometry(slot.geometry), material);
      mesh.renderOrder = slot.order;
      const display = groups[slot.node]!;
      display.add(mesh);
      this.meshes.push(mesh);
      for (const pass of common.passes) {
        if (pass.group !== "member-monitor" || pass.slot !== index) continue;
        const [face, body] = slot.monitorAnchors
          ? slot.monitorAnchors.map((node) => groups[node])
          : [display.parent?.getObjectByName("face"), display.parent?.getObjectByName("body")];
        if (!face || !body) throw new Error("The stage package is missing the member monitor anchors");
        const [width, height] = common.nodes[pass.node]!.scale;
        const monitorMaterial = material.clone();
        monitorMaterial.map = this.monitorFrame;
        if (pass.stencil != null) {
          monitorMaterial.stencilWrite = true;
          monitorMaterial.stencilRef = pass.stencil;
          monitorMaterial.stencilFunc = EqualStencilFunc;
        }
        const monitor = new Mesh(shapeGeometry(pass), monitorMaterial);
        monitor.renderOrder = pass.order;
        groups[pass.node]!.add(monitor);
        this.meshes.push(monitor);
        this.monitors.push({
          mesh: monitor,
          anchors: [face, body],
          aspect: pass.monitorAspect ?? width / height,
          uvs: pass.uvs,
          pending: fullStageCrop,
        });
      }
      this.members.push({ viewer, texture, motion: "", seconds: Number.NaN });
      await viewer.load({
        modelUrl: await this.pinModel(this.input.quality === 0 ? entry.standard : (entry.low ?? entry.standard)),
        signal,
        physics: false,
        defaultMotionName: stageMotions.idle,
      });
      const prepared = await Promise.all(Object.values(stageMotions).map((motion) => viewer.prepareMotion(motion)));
      if (!prepared.every(Boolean)) throw new Error(`Incomplete stage motions for ${entry.standard}`);
      // Character display quads start disabled in the prefab and need their bound texture.
      display.visible = true;
    }
  }

  private async pinModel(path: string): Promise<string> {
    const base = new URL(this.input.resolveMedia(path), location.href);
    if (!base.searchParams.has("release")) return base.href;
    const signal = this.controller.signal;
    const model = await json<StageModelManifest>(base.href, signal);
    signal.throwIfAborted();
    const references = model.FileReferences;
    const resolve = (file: string) => new URL(this.input.resolveMedia(new URL(file, base).href), location.href).href;
    for (const key of ["Moc", "Physics", "Pose", "DisplayInfo", "UserData", "MotionSync"] as const) {
      const file = references[key];
      if (file) references[key] = resolve(file);
    }
    references.Textures = references.Textures?.map(resolve);
    for (const expression of references.Expressions ?? []) expression.File = resolve(expression.File);
    for (const motion of Object.values(references.Motions ?? {}).flat()) {
      motion.File = resolve(motion.File);
      if (motion.Sound) motion.Sound = resolve(motion.Sound);
    }
    const protectedUrl = URL.createObjectURL(new Blob([JSON.stringify(model)], { type: "application/json" }));
    this.modelUrls.push(protectedUrl);
    return protectedUrl;
  }

  pause(): void {
    this.video?.pause();
  }

  private monitorCrop({ anchors }: MemberMonitor): Vec4 {
    const a = anchors[0].getWorldPosition(this.monitorLower);
    const b = anchors[1].getWorldPosition(this.monitorUpper);
    const lowX = Math.min(a.x, b.x) - monitorWorldMargin;
    const lowY = Math.min(a.y, b.y) - monitorWorldMargin;
    const highX = Math.max(a.x, b.x) + monitorWorldMargin;
    const highY = Math.max(a.y, b.y) + monitorWorldMargin;
    const nearZ = Math.max(a.z, b.z);
    const farZ = Math.min(a.z, b.z);
    const view = this.camera.matrixWorldInverse;
    a.set(lowX, lowY, nearZ).applyMatrix4(view);
    b.set(highX, highY, farZ).applyMatrix4(view);
    if (a.z >= 0 || b.z >= 0) return fullStageCrop;
    const projection = this.camera.projectionMatrix;
    a.applyMatrix4(projection);
    b.applyMatrix4(projection);
    const { viewport, width, height } = this.target;
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    const left = clamp((viewport.x + (Math.min(a.x, b.x) + 1) * 0.5 * viewport.z) / width);
    const right = clamp((viewport.x + (Math.max(a.x, b.x) + 1) * 0.5 * viewport.z) / width);
    const bottom = clamp((viewport.y + (Math.min(a.y, b.y) + 1) * 0.5 * viewport.w) / height);
    const top = clamp((viewport.y + (Math.max(a.y, b.y) + 1) * 0.5 * viewport.w) / height);
    const spanX = right - left;
    const spanY = top - bottom;
    if (spanX <= 0 || spanY <= 0 || Math.hypot(spanX, spanY) < monitorMinimumViewportSpan) return fullStageCrop;
    return [left, bottom, spanX, spanY];
  }

  private applyMonitorCrop(monitor: MemberMonitor, [x, y, w, h]: Vec4): void {
    const captureAspect = this.target.width / this.target.height;
    const ratio = monitor.aspect / ((w / h) * captureAspect);
    const width = ratio < 1 ? w * ratio : w;
    const height = ratio > 1 ? h / ratio : h;
    const left = x + (w - width) * 0.5;
    const bottom = y + (h - height) * 0.5;
    const uvs = monitor.mesh.geometry.getAttribute("uv");
    for (let i = 0; i < uvs.count; i++) {
      uvs.setXY(i, left + monitor.uvs[i * 2]! * width, bottom + monitor.uvs[i * 2 + 1]! * height);
    }
    uvs.needsUpdate = true;
  }

  private drawStage(renderer: WebGLRenderer): void {
    renderer.clear(true, true, true);
    renderer.render(this.scene, this.camera);
  }

  render(renderer: WebGLRenderer, values: StageTime): boolean {
    if (this.disposed || renderer.getContext().isContextLost()) return false;
    const quality = qualityProfiles[values.quality];
    const scale = Math.min(quality.stageScale, 1280 / Math.max(values.width, values.height));
    const width = Math.max(1, Math.round(values.width * scale));
    const height = Math.max(1, Math.round(values.height * scale));
    const resized = width !== this.target.width || height !== this.target.height;
    if (resized) {
      this.target.setSize(width, height);
      this.monitorFrame.dispose();
      this.monitorFrame.image.width = width;
      this.monitorFrame.image.height = height;
      this.monitorFrame.needsUpdate = true;
      const innerWidth = Math.min(width, Math.round(height * this.maxCameraAspect));
      this.target.viewport.set(Math.floor((width - innerWidth) / 2), 0, innerWidth, height);
      this.camera.aspect = innerWidth / height;
      this.camera.updateProjectionMatrix();
    }
    this.video?.sync(values);
    const introSeconds = values.introSeconds;
    const intro = introSeconds !== undefined;
    const frame = Math.floor((intro ? -1 - introSeconds : values.seconds) * quality.fps);
    if (!resized && !this.dirty && frame === this.lastFrame && this.lastPlaying === values.playing) return false;
    const motion =
      intro || values.seconds === 0
        ? stageMotions.idle
        : values.duration > 0 && values.seconds >= values.duration
          ? stageMotions.finish
          : stageMotions.play;
    const motionTime = introSeconds ?? values.seconds;
    const tempo = intro ? undefined : this.motionRates.findLast(({ seconds }) => seconds <= motionTime);
    const motionPosition = tempo ? tempo.position + (motionTime - tempo.seconds) * tempo.rate : motionTime;
    for (const member of this.members) {
      if (this.captureSize !== quality.capturePixels) {
        member.viewer.setTargetFrameRate(quality.fps);
        member.viewer.setSize(quality.capturePixels, quality.capturePixels);
      }
      const delta = motionTime - member.seconds;
      member.viewer.setPlaybackSpeed(tempo?.rate ?? 1);
      const seek = !Number.isFinite(delta) || delta < 0 || delta > 0.25 || (!values.playing && delta !== 0);
      if (motion !== member.motion || seek) {
        member.viewer.playMotionAt(motion, motion === stageMotions.finish ? 0 : motionPosition, 0, {
          loop: motion !== stageMotions.finish,
        });
        member.motion = motion;
      }
      member.viewer.advanceFrame(seek ? 1 / quality.fps : Math.max(0, delta));
      if (member.viewer.captureFrame(false)) member.texture.needsUpdate = true;
      member.seconds = motionTime;
    }
    this.captureSize = quality.capturePixels;
    this.sampleCamera(values.seconds, intro, values.introCamera);
    const seedMonitors =
      resized ||
      !Number.isFinite(this.lastFrame) ||
      frame < 0 !== this.lastFrame < 0 ||
      (!intro &&
        (frame < this.lastFrame ||
          frame - this.lastFrame > quality.fps / 4 ||
          (!values.playing && frame !== this.lastFrame)));
    this.lastFrame = frame;
    this.lastPlaying = values.playing;
    this.dirty = false;

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    try {
      if (seedMonitors && this.monitors.length) {
        for (const monitor of this.monitors) monitor.mesh.visible = false;
        try {
          this.drawStage(renderer);
          renderer.copyFramebufferToTexture(this.monitorFrame);
        } finally {
          for (const monitor of this.monitors) monitor.mesh.visible = true;
        }
        for (const monitor of this.monitors) {
          monitor.pending = this.monitorCrop(monitor);
          this.applyMonitorCrop(monitor, monitor.pending);
        }
      }
      this.drawStage(renderer);
      if (this.monitors.length) renderer.copyFramebufferToTexture(this.monitorFrame);
      // The stage camera draws first. Monitor rectangles are applied from the previous stage update.
      for (const monitor of this.monitors) {
        this.applyMonitorCrop(monitor, monitor.pending);
        monitor.pending = this.monitorCrop(monitor);
      }
    } finally {
      renderer.setRenderTarget(previousTarget);
    }
    return resized;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    for (const texture of this.textures.values())
      void texture.then(
        (value) => value.dispose(),
        () => undefined,
      );
    for (const member of this.members) {
      member.viewer.destroy();
      member.texture.dispose();
    }
    for (const url of this.modelUrls) URL.revokeObjectURL(url);
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.scene.clear();
    this.monitorFrame.dispose();
    this.target.dispose();
  }
}
