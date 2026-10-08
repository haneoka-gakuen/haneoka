/** One decoded video frame supplies both colour and opacity. */
export const ALPHA_VIDEO_LAYOUT = "color-left-alpha-right" as const;
export type AlphaVideoLayout = typeof ALPHA_VIDEO_LAYOUT;
export interface AlphaVideoSource {
  url: string;
  alphaPackedUrl?: string;
  alphaLayout?: string;
}

/** Missing packed data for a transparent segment has an explicit still fallback. */
export function alphaVideoSource(
  source: AlphaVideoSource,
  transparent: boolean,
): { url: string; packed: boolean } | undefined {
  if (source.alphaPackedUrl && source.alphaLayout === ALPHA_VIDEO_LAYOUT)
    return { url: source.alphaPackedUrl, packed: true };
  return !transparent && source.url ? { url: source.url, packed: false } : undefined;
}

const VERTEX = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
`;
const FRAGMENT = `
precision highp float;
uniform sampler2D frame;
uniform vec2 size;
uniform float isPacked;
varying vec2 uv;
void main() {
  float width = mix(size.x, size.x * 0.5, isPacked);
  vec2 point = (uv * vec2(width - 1.0, size.y - 1.0) + 0.5) / size;
  vec3 colour = texture2D(frame, point).rgb;
  float opacity = 1.0;
  if (isPacked > 0.5) opacity = texture2D(frame, point + vec2(0.5, 0.0)).r;
  gl_FragColor = vec4(colour * opacity, opacity);
}
`;
type Resources = {
  program: WebGLProgram;
  buffer: WebGLBuffer;
  texture: WebGLTexture;
  position: number;
  size: WebGLUniformLocation;
  packed: WebGLUniformLocation;
};
interface AlphaVideoCallbacks {
  frame(): void;
  lost(): void;
  error(error: Error): void;
}

/** Owns texture/program/frame callbacks; the caller owns media source and playback. */
export class AlphaVideo {
  private readonly gl: WebGLRenderingContext;
  private resources?: Resources;
  private disposed = false;
  private lost = false;
  private resumeAfterRestore = false;
  private packed = false;
  private generation = 0;
  private videoFrame?: number;
  private animationFrame?: number;
  private lastTime?: number;
  private lastPresented?: number;
  private lastQuality?: number;
  private lastUploadAt = -Infinity;
  private uploads = 0;
  get frameUploads(): number {
    return this.uploads;
  }

  constructor(
    private video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: AlphaVideoCallbacks,
  ) {
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error("WebGL video compositing unavailable");
    this.gl = gl;
    this.resources = this.createResources();
    this.bindVideo(video, true);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  /** Stop callbacks from the previous clip while retaining its displayed canvas. */
  configure(packed: boolean): void {
    this.cancelFrames();
    this.packed = packed;
    this.lastTime = this.lastPresented = this.lastQuality = undefined;
    this.lastUploadAt = -Infinity;
    this.resumeAfterRestore = false;
  }
  private bindVideo(video: HTMLVideoElement, attach: boolean): void {
    const events = {
      loadeddata: this.onDecoded,
      seeked: this.onDecoded,
      playing: this.onPlaying,
      seeking: this.onSeeking,
      pause: this.onPaused,
      ended: this.onPaused,
    };
    for (const [name, callback] of Object.entries(events)) {
      if (attach) video.addEventListener(name, callback);
      else video.removeEventListener(name, callback);
    }
  }
  /** Promote a decoded surface without recreating the compositor or displaying a stale frame. */
  setVideo(video: HTMLVideoElement, packed: boolean): void {
    if (this.disposed || video.readyState < 2 || video.seeking)
      throw new Error("Video handoff requires a decoded frame");
    this.configure(packed);
    this.bindVideo(this.video, false);
    this.video = video;
    this.bindVideo(video, true);
    this.draw(video.currentTime, undefined, true);
    this.schedule();
  }
  private createResources(): Resources {
    const gl = this.gl;
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null,
      buffer: WebGLBuffer | null = null,
      texture: WebGLTexture | null = null;
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, VERTEX],
        [gl.FRAGMENT_SHADER, FRAGMENT],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Video shader allocation failed");
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) || "Video shader compilation failed");
      }
      program = gl.createProgram();
      if (!program) throw new Error("Video program allocation failed");
      shaders.forEach((shader) => gl.attachShader(program!, shader));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) || "Video program linking failed");
      buffer = gl.createBuffer();
      texture = gl.createTexture();
      if (!buffer || !texture) throw new Error("Video resource allocation failed");
      const position = gl.getAttribLocation(program, "position");
      const size = gl.getUniformLocation(program, "size"),
        packed = gl.getUniformLocation(program, "isPacked");
      if (position < 0 || !size || !packed) throw new Error("Video shader bindings unavailable");
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, "frame"), 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      return { program, buffer, texture, position, size, packed };
    } catch (error) {
      if (texture) gl.deleteTexture(texture);
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      shaders.forEach((shader) => gl.deleteShader(shader));
    }
  }
  private draw(mediaTime: number, presented?: number, force = false): void {
    const v = this.video,
      gl = this.gl,
      r = this.resources;
    if (this.disposed || this.lost || !r || v.seeking || v.readyState < 2) return;
    const quality =
      presented === undefined && typeof v.getVideoPlaybackQuality === "function"
        ? v.getVideoPlaybackQuality().totalVideoFrames
        : undefined;
    if (
      !force &&
      (presented !== undefined
        ? presented === this.lastPresented
        : quality !== undefined && quality > 0
          ? quality === this.lastQuality
          : mediaTime === this.lastTime)
    )
      return;
    const width = v.videoWidth,
      height = v.videoHeight;
    const colourWidth = this.packed ? width / 2 : width;
    if (
      !width ||
      !height ||
      !Number.isInteger(colourWidth) ||
      width > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
      height > gl.getParameter(gl.MAX_TEXTURE_SIZE)
    )
      throw new Error("Unsupported decoded video dimensions");
    if (this.canvas.width !== colourWidth || this.canvas.height !== height) {
      this.canvas.width = colourWidth;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, colourWidth, height);
    gl.useProgram(r.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, r.buffer);
    gl.enableVertexAttribArray(r.position);
    gl.vertexAttribPointer(r.position, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.texture);
    // The browser's decoded surface is uploaded directly; no CPU pixel copy.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("Decoded video texture upload failed");
    gl.uniform2f(r.size, width, height);
    gl.uniform1f(r.packed, this.packed ? 1 : 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.lastTime = mediaTime;
    this.lastPresented = presented;
    this.lastQuality = quality;
    this.lastUploadAt = performance.now();
    this.uploads++;
    this.callbacks.frame();
  }
  private schedule(): void {
    if (this.disposed || this.lost || this.videoFrame !== undefined || this.animationFrame !== undefined) return;
    const generation = this.generation;
    if (typeof this.video.requestVideoFrameCallback === "function") {
      this.videoFrame = this.video.requestVideoFrameCallback((_now, metadata) => {
        if (this.disposed || this.lost || generation !== this.generation) return;
        this.videoFrame = undefined;
        try {
          this.draw(metadata.mediaTime, metadata.presentedFrames);
        } catch (error) {
          this.fail(error);
          return;
        }
        if (!this.video.paused && !this.video.ended) this.schedule();
      });
    } else {
      this.animationFrame = requestAnimationFrame((now) => {
        if (this.disposed || this.lost || generation !== this.generation) return;
        this.animationFrame = undefined;
        try {
          if (this.video.paused || this.video.ended || now - this.lastUploadAt >= 1000 / 30)
            this.draw(this.video.currentTime);
        } catch (error) {
          this.fail(error);
          return;
        }
        if (!this.video.paused && !this.video.ended) this.schedule();
      });
    }
  }
  private cancelFrames(): void {
    this.generation++;
    if (this.videoFrame !== undefined) this.video.cancelVideoFrameCallback(this.videoFrame);
    if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
    this.videoFrame = this.animationFrame = undefined;
  }
  private onDecoded = (event: Event) => {
    if (this.lost || this.disposed) return;
    if (event.type === "seeked" && this.video.paused) {
      // Some compositors do not present an invisible paused video, so rVFC
      // does not fire. seeked itself confirms the new decoded surface.
      this.cancelFrames();
      try {
        this.draw(this.video.currentTime, undefined, true);
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    if (typeof this.video.requestVideoFrameCallback !== "function") this.lastTime = this.lastQuality = undefined;
    this.schedule();
  };
  private onPlaying = () => this.schedule();
  private onSeeking = () => this.cancelFrames();
  private onPaused = () => {
    if (this.video.ended) this.cancelFrames();
    if (typeof this.video.requestVideoFrameCallback !== "function") {
      this.cancelFrames();
      this.schedule();
    }
  };
  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.resumeAfterRestore = !this.video.paused && !this.video.ended;
    this.lost = true;
    this.cancelFrames();
    this.video.pause();
    this.resources = undefined;
    this.callbacks.lost();
  };
  private onContextRestored = () => {
    if (this.disposed) return;
    try {
      this.resources = this.createResources();
      this.lost = false;
      this.lastTime = this.lastPresented = this.lastQuality = undefined;
      // Context recovery must repopulate the texture even while paused.
      this.draw(this.video.currentTime, undefined, true);
      const generation = this.generation;
      if (this.resumeAfterRestore)
        void this.video.play().catch((error) => {
          if (!this.disposed && generation === this.generation) this.fail(error);
        });
      this.resumeAfterRestore = false;
      this.schedule();
    } catch (error) {
      this.fail(error);
    }
  };
  private fail(error: unknown): void {
    this.dispose();
    this.video.pause();
    this.callbacks.error(error instanceof Error ? error : new Error(String(error)));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelFrames();
    this.bindVideo(this.video, false);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    const r = this.resources;
    if (r) {
      this.gl.deleteTexture(r.texture);
      this.gl.deleteBuffer(r.buffer);
      this.gl.deleteProgram(r.program);
    }
    this.resources = undefined;
    // Release the drawing buffer too, including when a failed canvas remains
    // in the connected gallery behind its static poster.
    this.canvas.width = this.canvas.height = 1;
  }
}
