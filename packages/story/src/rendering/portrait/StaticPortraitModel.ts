import type { Matrix4 } from "three";
import type { AdvStaticPortraitPivot } from "../../types/AdvRuntime";
import type { AdvCubismDrawState, CubismDrawableBounds, CubismParameterFrame } from "../cubism/AdvCubismModel";
import type { AdvMotionSyncCoreStatus } from "../cubism/AdvMotionSyncCore";
import { loadCachedImage } from "../cubism/CubismResourceCache";
import type { StoryCharacterModel } from "../StoryCharacterModel";

export type StaticPortraitPivot = Readonly<AdvStaticPortraitPivot>;

export interface StaticPortraitModelOptions {
  readonly gl: WebGL2RenderingContext;
  readonly signal?: AbortSignal;
  readonly imageUrl: string;
  /** Image pixels per model-local story world unit. Takes precedence over `worldHeight`. */
  readonly pixelsPerUnit?: number;
  /** Full image height in model-local story world units. */
  readonly worldHeight?: number;
  /** Normalized lower-left-origin image pivot. Defaults to the image center. */
  readonly pivot?: StaticPortraitPivot;
  readonly anisotropy?: number;
}

interface PortraitTexture {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
}

interface PortraitTextureEntry {
  readonly pending: Promise<PortraitTexture>;
  references: number;
}

interface PortraitTextureLease extends PortraitTexture {
  release(): void;
}

interface PortraitDrawResources {
  readonly program: WebGLProgram;
  readonly vertexArray: WebGLVertexArrayObject;
  readonly vertexBuffer: WebGLBuffer;
  readonly mvpLocation: WebGLUniformLocation;
  readonly boundsLocation: WebGLUniformLocation;
  readonly colorLocation: WebGLUniformLocation;
  readonly textureLocation: WebGLUniformLocation;
  references: number;
}

const DEFAULT_PIXELS_PER_UNIT = 100;
const textureCaches = new WeakMap<WebGL2RenderingContext, Map<string, PortraitTextureEntry>>();
const drawResources = new WeakMap<WebGL2RenderingContext, PortraitDrawResources>();
const QUAD_VERTICES = new Float32Array([0, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0]);

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 aUv;
uniform mat4 uMvp;
uniform vec4 uBounds;
out vec2 vUv;

void main() {
  vec2 localPosition = mix(uBounds.xy, uBounds.zw, aCorner);
  gl_Position = uMvp * vec4(localPosition, 0.0, 1.0);
  vUv = aUv;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec4 uColor;
in vec2 vUv;
out vec4 outColor;

void main() {
  vec4 sampleColor = texture(uTexture, vUv);
  float alpha = sampleColor.a * uColor.a;
  outColor = vec4(sampleColor.rgb * uColor.rgb * alpha, alpha);
}
`;

const positive = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const finite = (value: unknown, fallback: number): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const createTexture = async (
  gl: WebGL2RenderingContext,
  imageUrl: string,
  anisotropy: number,
): Promise<PortraitTexture> => {
  const image = await loadCachedImage(imageUrl);
  const width = Math.max(0, image.naturalWidth || image.width);
  const height = Math.max(0, image.naturalHeight || image.height);
  if (!width || !height) throw new Error(`Static portrait has invalid dimensions: ${imageUrl}`);
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to allocate a static portrait texture");
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    const extension = gl.getExtension("EXT_texture_filter_anisotropic") as {
      readonly TEXTURE_MAX_ANISOTROPY_EXT: number;
      readonly MAX_TEXTURE_MAX_ANISOTROPY_EXT: number;
    } | null;
    if (extension && anisotropy > 1) {
      const maximum = positive(gl.getParameter(extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) ?? 1;
      gl.texParameterf(gl.TEXTURE_2D, extension.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(maximum, anisotropy));
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { texture, width, height };
  } catch (error) {
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteTexture(texture);
    throw error;
  }
};

const waitForTexture = <T>(pending: Promise<T>, signal: AbortSignal | undefined, imageUrl: string): Promise<T> => {
  if (!signal) return pending;
  if (signal.aborted) {
    const error = new Error(`Loading was aborted: ${imageUrl}`);
    error.name = "AbortError";
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void =>
      finish(() => {
        const error = new Error(`Loading was aborted: ${imageUrl}`);
        error.name = "AbortError";
        reject(error);
      });
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

const acquireTexture = async (
  gl: WebGL2RenderingContext,
  imageUrl: string,
  anisotropy: number,
  signal?: AbortSignal,
): Promise<PortraitTextureLease> => {
  let cache = textureCaches.get(gl);
  if (!cache) {
    cache = new Map();
    textureCaches.set(gl, cache);
  }
  const key = `${anisotropy}\u0000${imageUrl}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = { pending: createTexture(gl, imageUrl, anisotropy), references: 0 };
    cache.set(key, entry);
    const createdEntry = entry;
    void createdEntry.pending.then(
      (value) => {
        if (createdEntry.references > 0) return;
        if (cache?.get(key) === createdEntry) cache.delete(key);
        gl.deleteTexture(value.texture);
      },
      () => {
        if (cache?.get(key) === createdEntry) cache.delete(key);
      },
    );
  }
  entry.references += 1;
  let value: PortraitTexture;
  try {
    value = await waitForTexture(entry.pending, signal, imageUrl);
  } catch (error) {
    entry.references = Math.max(0, entry.references - 1);
    if (entry.references === 0 && cache.get(key) === entry) cache.delete(key);
    throw error;
  }
  let released = false;
  return {
    ...value,
    release: () => {
      if (released) return;
      released = true;
      entry.references = Math.max(0, entry.references - 1);
      if (entry.references > 0 || cache.get(key) !== entry) return;
      cache.delete(key);
      gl.deleteTexture(value.texture);
    },
  };
};

const compileShader = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate a static portrait shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const message = gl.getShaderInfoLog(shader) || "Unknown shader compilation error";
  gl.deleteShader(shader);
  throw new Error(`Static portrait shader compilation failed: ${message}`);
};

const requiredUniform = (gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation => {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`Static portrait shader is missing uniform ${name}`);
  return location;
};

const createDrawResources = (gl: WebGL2RenderingContext): PortraitDrawResources => {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  let fragmentShader: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  let vertexArray: WebGLVertexArrayObject | null = null;
  let vertexBuffer: WebGLBuffer | null = null;
  try {
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram();
    if (!program) throw new Error("Unable to allocate a static portrait shader program");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Static portrait shader link failed: ${gl.getProgramInfoLog(program) || "unknown error"}`);
    }
    vertexArray = gl.createVertexArray();
    vertexBuffer = gl.createBuffer();
    if (!vertexArray || !vertexBuffer) throw new Error("Unable to allocate static portrait geometry");
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return {
      program,
      vertexArray,
      vertexBuffer,
      mvpLocation: requiredUniform(gl, program, "uMvp"),
      boundsLocation: requiredUniform(gl, program, "uBounds"),
      colorLocation: requiredUniform(gl, program, "uColor"),
      textureLocation: requiredUniform(gl, program, "uTexture"),
      references: 0,
    };
  } catch (error) {
    if (vertexArray) gl.deleteVertexArray(vertexArray);
    if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
};

const acquireDrawResources = (gl: WebGL2RenderingContext): PortraitDrawResources => {
  let resources = drawResources.get(gl);
  if (!resources) {
    resources = createDrawResources(gl);
    drawResources.set(gl, resources);
  }
  resources.references += 1;
  return resources;
};

const releaseDrawResources = (gl: WebGL2RenderingContext, resources: PortraitDrawResources): void => {
  resources.references = Math.max(0, resources.references - 1);
  if (resources.references > 0 || drawResources.get(gl) !== resources) return;
  drawResources.delete(gl);
  gl.deleteVertexArray(resources.vertexArray);
  gl.deleteBuffer(resources.vertexBuffer);
  gl.deleteProgram(resources.program);
};

/** A static image character rendered in the same world-space pass as Cubism characters. */
export class StaticPortraitModel implements StoryCharacterModel {
  readonly format = "static-portrait" as const;
  readonly modelUrl: string;
  readonly pixelsPerUnit: number;
  readonly motionSyncStatus: AdvMotionSyncCoreStatus | "unconfigured" = "unconfigured";
  readonly isMotionPlaying = false;

  get isOperational(): boolean {
    return !this.released;
  }

  get updateSerial(): number {
    return this.updateSerialValue;
  }

  get drawSerial(): number {
    return this.drawSerialValue;
  }

  private readonly gl: WebGL2RenderingContext;
  private readonly textureLease: PortraitTextureLease;
  private readonly resources: PortraitDrawResources;
  private readonly bounds: CubismDrawableBounds;
  private readonly drawMatrix = new Float32Array(16);
  private updateSerialValue = 0;
  private drawSerialValue = 0;
  private released = false;

  private constructor(
    options: StaticPortraitModelOptions,
    textureLease: PortraitTextureLease,
    resources: PortraitDrawResources,
  ) {
    this.gl = options.gl;
    this.modelUrl = options.imageUrl;
    this.textureLease = textureLease;
    this.resources = resources;
    const worldHeight = positive(options.worldHeight);
    this.pixelsPerUnit =
      positive(options.pixelsPerUnit) ?? (worldHeight ? textureLease.height / worldHeight : DEFAULT_PIXELS_PER_UNIT);
    const width = textureLease.width / this.pixelsPerUnit;
    const height = textureLease.height / this.pixelsPerUnit;
    const pivotX = finite(options.pivot?.x, 0.5);
    const pivotY = finite(options.pivot?.y, 0.5);
    this.bounds = { x: -pivotX * width, y: -pivotY * height, width, height };
  }

  static async create(options: StaticPortraitModelOptions): Promise<StaticPortraitModel> {
    const imageUrl = String(options.imageUrl || "").trim();
    if (!imageUrl) throw new TypeError("StaticPortraitModel requires an imageUrl");
    const normalized = { ...options, imageUrl };
    const textureLease = await acquireTexture(options.gl, imageUrl, positive(options.anisotropy) ?? 1, options.signal);
    let resources: PortraitDrawResources | null = null;
    try {
      resources = acquireDrawResources(options.gl);
      return new StaticPortraitModel(normalized, textureLease, resources);
    } catch (error) {
      textureLease.release();
      if (resources) releaseDrawResources(options.gl, resources);
      throw error;
    }
  }

  setPaused(_paused: boolean): void {
    // Static portraits have no time-dependent state.
  }

  setMotionSpeed(_speed: number): void {
    // Static portraits have no motion clock.
  }

  setEyeBlinkEnabled(_enabled: boolean): void {
    // Static portraits have no parameter graph.
  }

  resetExpressionParametersToDefault(): void {
    // Static portraits have no expression channel.
  }

  hasMotion(_name: string): boolean {
    return false;
  }

  stopMotions(): void {
    // Static portraits have no motion channel.
  }

  drawableBounds(_visibleOnly = true): CubismDrawableBounds | null {
    return { ...this.bounds };
  }

  canvasBounds(): CubismDrawableBounds {
    return { ...this.bounds };
  }

  resetMotionSync(): void {
    // Static portraits do not consume voice motion-sync samples.
  }

  playMotion(_name: string, _fadeInSeconds?: number): boolean {
    return false;
  }

  playExpression(_name: string, _fadeInSeconds?: number): boolean {
    return false;
  }

  prepareMotion(_name: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  prepareExpression(_name: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  isCurrentExpression(_name: string): boolean {
    return false;
  }

  refreshCurrentExpressionFadeIn(_name: string, _fadeInSeconds?: number): void {
    // Static portraits have no expression channel.
  }

  primeInitialFrame(_frame: CubismParameterFrame): void {
    // The uploaded image is already the complete initial frame.
  }

  setParameter(_id: string, _value: number, _weight?: number): void {
    // Static portraits have no parameter graph.
  }

  parameterRange(_id: string): { minimum: number; maximum: number } | null {
    return null;
  }

  eyeBallPosition(): { x: number; y: number } {
    return { x: 0, y: 0 };
  }

  setEyeBallPosition(_x: number, _y: number): void {
    // Static portraits have no parameter graph.
  }

  forceEyeBallPosition(_x: number, _y: number): void {
    // Static portraits have no parameter graph.
  }

  update(_deltaSeconds: number, _frame: CubismParameterFrame): void {
    if (!this.released) this.updateSerialValue += 1;
  }

  draw(
    mvp: Matrix4,
    framebuffer: WebGLFramebuffer | null,
    viewport: readonly [number, number, number, number],
    color: readonly [number, number, number, number],
    _drawState?: AdvCubismDrawState,
  ): void {
    if (this.released) return;
    const alpha = Math.max(0, Math.min(1, finite(color[3], 1)));
    if (alpha <= 0) return;
    const gl = this.gl;
    const resources = this.resources;
    this.drawMatrix.set(mvp.elements);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.colorMask(true, true, true, true);
    gl.useProgram(resources.program);
    gl.bindVertexArray(resources.vertexArray);
    gl.uniformMatrix4fv(resources.mvpLocation, false, this.drawMatrix);
    gl.uniform4f(
      resources.boundsLocation,
      this.bounds.x,
      this.bounds.y,
      this.bounds.x + this.bounds.width,
      this.bounds.y + this.bounds.height,
    );
    gl.uniform4f(resources.colorLocation, finite(color[0], 1), finite(color[1], 1), finite(color[2], 1), alpha);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindSampler(0, null);
    gl.bindTexture(gl.TEXTURE_2D, this.textureLease.texture);
    gl.uniform1i(resources.textureLocation, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.drawSerialValue += 1;
    gl.bindVertexArray(null);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.textureLease.release();
    releaseDrawResources(this.gl, this.resources);
  }
}
