import {
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  NearestFilter,
  NoBlending,
  NoColorSpace,
  RGFormat,
  ShaderMaterial,
  Texture,
  Vector2,
  WebGLRenderTarget,
} from "three";
import type { Camera } from "three";
import type { IUniform } from "three";
import type { AdvRenderFullscreen } from "./AdvUrpBloom";
import type { AdvMotionBlurVolume } from "./AdvVolumeStack";

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Hidden/Universal Render Pipeline/CameraMotionVectors, specialized for the
// ADV field. AdvFieldRenderPass allocates no depth attachment and
// the MotionVectors renderer list only contains opaque objects; the ADV
// background, Cubism renderers, and particles are transparent field content.
// Consequently the packaged camera pass derives every field pixel at the
// cleared far plane (NDC z=1 on GLES), then compares current/previous VP.
const CAMERA_MOTION_VECTOR_FRAGMENT = /* glsl */ `
precision highp float;
uniform mat4 uInverseViewProjection;
uniform mat4 uViewProjection;
uniform mat4 uPreviousViewProjection;
varying vec2 vUv;
void main() {
  vec2 currentNdc = vUv * 2.0 - 1.0;
  vec4 world = uInverseViewProjection * vec4(currentNdc, 1.0, 1.0);
  world /= world.w;
  vec4 currentClip = uViewProjection * world;
  vec4 previousClip = uPreviousViewProjection * world;
  vec2 projectedCurrent = currentClip.xy / currentClip.w;
  vec2 projectedPrevious = previousClip.xy / previousClip.w;
  // GLES does not take Unity's UNITY_UV_STARTS_AT_TOP branch. The shader then
  // converts forward NDC velocity to screen-UV velocity with * 0.5.
  gl_FragColor = vec4((projectedCurrent - projectedPrevious) * 0.5, 0.0, 0.0);
}
`;

// CameraMotionBlur passes 3-5. The three CameraAndObjects programs differ only
// in their compile-time sample count (4/6/8).
const MOTION_BLUR_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform sampler2D tMotionVectors;
uniform vec2 uSourceSize;
uniform float uIntensity;
uniform float uSampleCount;
varying vec2 vUv;

float interleavedGradientNoise(vec2 pixel) {
  return fract(52.9829178 * fract(dot(pixel, vec2(0.0671105608, 0.00583714992))));
}

vec4 sampleAt(float offset, vec2 velocity) {
  return texture2D(tInput, clamp(vUv + offset * velocity, vec2(0.0), vec2(1.0)));
}

vec4 blurSamples(float randomValue, vec2 velocity) {
  if (uSampleCount < 5.0) {
    vec4 color = sampleAt(randomValue * 0.25, velocity);
    color = color + sampleAt((randomValue - 1.0) * 0.25, velocity);
    color = sampleAt((randomValue - 2.0) * 0.25, velocity) + color;
    color = sampleAt((randomValue + 1.0) * 0.25, velocity) + color;
    return color * 0.25;
  }
  if (uSampleCount < 7.0) {
    vec4 color = sampleAt(randomValue * 0.166666672, velocity);
    color = color + sampleAt((randomValue - 1.0) * 0.166666672, velocity);
    color = sampleAt((randomValue - 2.0) * 0.166666672, velocity) + color;
    color = color + sampleAt((randomValue + 1.0) * 0.166666672, velocity);
    color = sampleAt((randomValue - 3.0) * 0.166666672, velocity) + color;
    color = sampleAt((randomValue + 2.0) * 0.166666672, velocity) + color;
    return color * 0.166666672;
  }
  vec4 color = sampleAt(randomValue * 0.125, velocity);
  color = color + sampleAt((randomValue - 1.0) * 0.125, velocity);
  color = sampleAt((randomValue - 2.0) * 0.125, velocity) + color;
  color = color + sampleAt((randomValue + 1.0) * 0.125, velocity);
  color = color + sampleAt((randomValue - 3.0) * 0.125, velocity);
  color = sampleAt((randomValue + 2.0) * 0.125, velocity) + color;
  color = sampleAt((randomValue - 4.0) * 0.125, velocity) + color;
  color = sampleAt((randomValue + 3.0) * 0.125, velocity) + color;
  return color * 0.125;
}

void main() {
  vec2 authoredVelocity = texture2D(tMotionVectors, vUv).xy;
  vec2 velocity = -authoredVelocity * 2.0;
  velocity *= uIntensity;
  float randomValue = interleavedGradientNoise(vUv * uSourceSize);
  gl_FragColor = blurSamples(randomValue, velocity);
}
`;

// CameraMotionBlur passes 0-2. Unlike CameraAndObjects, these programs compute
// camera velocity inline (without an RG16F motion-vector round trip) and clamp
// its NDC length before applying intensity.
const CAMERA_ONLY_MOTION_BLUR_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform mat4 uInverseViewProjection;
uniform mat4 uViewProjection;
uniform mat4 uPreviousViewProjection;
uniform vec2 uSourceSize;
uniform float uIntensity;
uniform float uClamp;
uniform float uSampleCount;
varying vec2 vUv;

float interleavedGradientNoise(vec2 pixel) {
  return fract(52.9829178 * fract(dot(pixel, vec2(0.0671105608, 0.00583714992))));
}

vec4 sampleAt(float offset, vec2 velocity) {
  return texture2D(tInput, clamp(vUv + offset * velocity, vec2(0.0), vec2(1.0)));
}

vec4 blurSamples(float randomValue, vec2 velocity) {
  if (uSampleCount < 5.0) {
    vec4 color = sampleAt(randomValue * 0.25, velocity);
    color = color + sampleAt((randomValue - 1.0) * 0.25, velocity);
    color = sampleAt((randomValue - 2.0) * 0.25, velocity) + color;
    color = sampleAt((randomValue + 1.0) * 0.25, velocity) + color;
    return color * 0.25;
  }
  if (uSampleCount < 7.0) {
    vec4 color = sampleAt(randomValue * 0.166666672, velocity);
    color = color + sampleAt((randomValue - 1.0) * 0.166666672, velocity);
    color = sampleAt((randomValue - 2.0) * 0.166666672, velocity) + color;
    color = color + sampleAt((randomValue + 1.0) * 0.166666672, velocity);
    color = sampleAt((randomValue - 3.0) * 0.166666672, velocity) + color;
    color = sampleAt((randomValue + 2.0) * 0.166666672, velocity) + color;
    return color * 0.166666672;
  }
  vec4 color = sampleAt(randomValue * 0.125, velocity);
  color = color + sampleAt((randomValue - 1.0) * 0.125, velocity);
  color = sampleAt((randomValue - 2.0) * 0.125, velocity) + color;
  color = color + sampleAt((randomValue + 1.0) * 0.125, velocity);
  color = color + sampleAt((randomValue - 3.0) * 0.125, velocity);
  color = sampleAt((randomValue + 2.0) * 0.125, velocity) + color;
  color = sampleAt((randomValue - 4.0) * 0.125, velocity) + color;
  color = sampleAt((randomValue + 3.0) * 0.125, velocity) + color;
  return color * 0.125;
}

void main() {
  vec2 currentNdc = vUv * 2.0 - 1.0;
  vec4 world = uInverseViewProjection * vec4(currentNdc, 1.0, 1.0);
  world /= world.w;
  vec4 currentClip = uViewProjection * world;
  vec4 previousClip = uPreviousViewProjection * world;
  vec2 velocity = previousClip.xy / previousClip.w - currentClip.xy / currentClip.w;
  float speed = length(velocity);
  velocity = speed > 0.0 ? velocity * (min(speed, uClamp) / speed) : vec2(0.0);
  velocity *= uIntensity;

  float randomValue = interleavedGradientNoise(vUv * uSourceSize);
  gl_FragColor = blurSamples(randomValue, velocity);
}
`;

/** CameraOnly L/M/H are passes 0-2; CameraAndObjects L/M/H are 3-5. */
export function advMotionBlurPass(mode: number, quality: number): 0 | 1 | 2 | 3 | 4 | 5 | null {
  const resolvedMode = Math.trunc(mode);
  const resolvedQuality = Math.trunc(quality);
  if ((resolvedMode !== 0 && resolvedMode !== 1) || resolvedQuality < 0 || resolvedQuality > 2) return null;
  return (resolvedMode * 3 + resolvedQuality) as 0 | 1 | 2 | 3 | 4 | 5;
}

export function advMotionBlurSampleCount(pass: 0 | 1 | 2 | 3 | 4 | 5): 4 | 6 | 8 {
  return [4, 6, 8][pass % 3] as 4 | 6 | 8;
}

/** Scalar coefficient multiplying the resolved velocity for each blob sample. */
export function advMotionBlurSampleOffsets(pass: 0 | 1 | 2 | 3 | 4 | 5, randomValue: number): readonly number[] {
  const count = advMotionBlurSampleCount(pass);
  const scale = count === 4 ? 0.25 : count === 6 ? 0.166666672 : 0.125;
  return Array.from({ length: count }, (_, index) => (index - count * 0.5 + randomValue) * scale);
}

/** Sample-add grouping emitted by blobs 1/2/3 and 5/6/7. */
export function advMotionBlurAccumulationOrder(pass: 0 | 1 | 2 | 3 | 4 | 5): readonly number[] {
  switch (advMotionBlurSampleCount(pass)) {
    case 4:
      return [0, -1, -2, 1];
    case 6:
      return [0, -1, -2, 1, -3, 2];
    case 8:
      return [0, -1, -2, 1, -3, 2, -4, 3];
  }
}

/** CPU oracle for the two velocity branches; encoded input is RG motion UV. */
export function advMotionBlurVelocity(
  mode: 0 | 1,
  encodedX: number,
  encodedY: number,
  intensity: number,
  clamp: number,
): readonly [number, number] {
  let x = -encodedX * 2;
  let y = -encodedY * 2;
  if (mode === 0) {
    const speed = Math.hypot(x, y);
    if (speed > 0) {
      const scale = Math.min(speed, Math.max(0, clamp)) / speed;
      x *= scale;
      y *= scale;
    }
  }
  return [x * Math.max(0, intensity), y * Math.max(0, intensity)];
}

interface MotionBlurUniforms extends Record<string, IUniform<unknown>> {
  tInput: IUniform<Texture | null>;
  tMotionVectors: IUniform<Texture | null>;
  uSourceSize: IUniform<Vector2>;
  uIntensity: IUniform<number>;
  uSampleCount: IUniform<number>;
}

interface CameraOnlyBlurUniforms extends Record<string, IUniform<unknown>> {
  tInput: IUniform<Texture | null>;
  uInverseViewProjection: IUniform<Matrix4>;
  uViewProjection: IUniform<Matrix4>;
  uPreviousViewProjection: IUniform<Matrix4>;
  uSourceSize: IUniform<Vector2>;
  uIntensity: IUniform<number>;
  uClamp: IUniform<number>;
  uSampleCount: IUniform<number>;
}

interface CameraMotionUniforms extends Record<string, IUniform<unknown>> {
  uInverseViewProjection: IUniform<Matrix4>;
  uViewProjection: IUniform<Matrix4>;
  uPreviousViewProjection: IUniform<Matrix4>;
}

/** Exact packaged CameraAndObjects/Low sampling path. */
export class AdvMotionBlur {
  private readonly uniforms: MotionBlurUniforms = {
    tInput: { value: null },
    tMotionVectors: { value: null },
    uSourceSize: { value: new Vector2(1, 1) },
    uIntensity: { value: 0 },
    uSampleCount: { value: 4 },
  };
  private readonly material = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: MOTION_BLUR_FRAGMENT,
    uniforms: this.uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    toneMapped: false,
  });
  private readonly cameraOnlyUniforms: CameraOnlyBlurUniforms = {
    tInput: { value: null },
    uInverseViewProjection: { value: new Matrix4() },
    uViewProjection: { value: new Matrix4() },
    uPreviousViewProjection: { value: new Matrix4() },
    uSourceSize: { value: new Vector2(1, 1) },
    uIntensity: { value: 0 },
    uClamp: { value: 0.05 },
    uSampleCount: { value: 4 },
  };
  private readonly cameraOnlyMaterial = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: CAMERA_ONLY_MOTION_BLUR_FRAGMENT,
    uniforms: this.cameraOnlyUniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    toneMapped: false,
  });
  private readonly cameraMotionUniforms: CameraMotionUniforms = {
    uInverseViewProjection: { value: new Matrix4() },
    uViewProjection: { value: new Matrix4() },
    uPreviousViewProjection: { value: new Matrix4() },
  };
  private readonly cameraMotionMaterial = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: CAMERA_MOTION_VECTOR_FRAGMENT,
    uniforms: this.cameraMotionUniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    toneMapped: false,
  });
  private readonly cameraMotionTarget = new WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
    format: RGFormat,
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    samples: 0,
  });
  private readonly currentViewProjection = new Matrix4();
  private readonly inverseViewProjection = new Matrix4();
  private readonly previousViewProjection = new Matrix4();
  private previousCameraUuid = "";
  private hasPreviousViewProjection = false;

  constructor() {
    this.cameraMotionTarget.texture.name = "adv-camera-motion-vectors";
    this.cameraMotionTarget.texture.colorSpace = NoColorSpace;
    this.cameraMotionTarget.texture.wrapS = ClampToEdgeWrapping;
    this.cameraMotionTarget.texture.wrapT = ClampToEdgeWrapping;
    this.cameraMotionTarget.texture.generateMipmaps = false;
  }

  render(
    source: WebGLRenderTarget,
    destination: WebGLRenderTarget,
    settings: Readonly<AdvMotionBlurVolume>,
    renderFullscreen: AdvRenderFullscreen,
    camera: Camera | null,
    motionVectors: Texture | null = null,
  ): boolean {
    const pass = advMotionBlurPass(settings.mode, settings.quality);
    const mode = Math.trunc(settings.mode);
    const needsMotionBlur = settings.active && settings.intensity > 0 && pass !== null;
    const needsCameraTexture = needsMotionBlur && mode === 1 && motionVectors === null;
    const cameraMotionVectors = camera
      ? this.updateCameraMotionVectors(camera, source.width, source.height, renderFullscreen, needsCameraTexture)
      : null;
    if (!needsMotionBlur) return false;
    source.texture.minFilter = NearestFilter;
    source.texture.magFilter = NearestFilter;
    source.texture.colorSpace = NoColorSpace;
    if (mode === 0) {
      if (!camera) return false;
      this.cameraOnlyUniforms.tInput.value = source.texture;
      this.cameraOnlyUniforms.uSourceSize.value.set(source.width, source.height);
      this.cameraOnlyUniforms.uIntensity.value = Math.max(0, settings.intensity);
      this.cameraOnlyUniforms.uClamp.value = Math.max(0, settings.clamp);
      this.cameraOnlyUniforms.uSampleCount.value = advMotionBlurSampleCount(pass);
      renderFullscreen(this.cameraOnlyMaterial, destination, true);
      return true;
    }
    const resolvedMotionVectors = mode === 0 ? cameraMotionVectors : (motionVectors ?? cameraMotionVectors);
    if (!resolvedMotionVectors) return false;
    this.uniforms.tInput.value = source.texture;
    this.uniforms.tMotionVectors.value = resolvedMotionVectors;
    this.uniforms.uSourceSize.value.set(source.width, source.height);
    this.uniforms.uIntensity.value = Math.max(0, settings.intensity);
    this.uniforms.uSampleCount.value = advMotionBlurSampleCount(pass);
    resolvedMotionVectors.minFilter = LinearFilter;
    resolvedMotionVectors.magFilter = LinearFilter;
    resolvedMotionVectors.wrapS = ClampToEdgeWrapping;
    resolvedMotionVectors.wrapT = ClampToEdgeWrapping;
    renderFullscreen(this.material, destination, true);
    return true;
  }

  private updateCameraMotionVectors(
    camera: Camera,
    width: number,
    height: number,
    renderFullscreen: AdvRenderFullscreen,
    renderTexture: boolean,
  ): Texture | null {
    camera.updateMatrixWorld(true);
    this.currentViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this.hasPreviousViewProjection || this.previousCameraUuid !== camera.uuid) {
      this.previousViewProjection.copy(this.currentViewProjection);
      this.previousCameraUuid = camera.uuid;
      this.hasPreviousViewProjection = true;
    }

    let texture: Texture | null = null;
    if (renderTexture) {
      this.inverseViewProjection.copy(this.currentViewProjection).invert();
      this.cameraMotionUniforms.uInverseViewProjection.value.copy(this.inverseViewProjection);
      this.cameraMotionUniforms.uViewProjection.value.copy(this.currentViewProjection);
      this.cameraMotionUniforms.uPreviousViewProjection.value.copy(this.previousViewProjection);
      this.cameraMotionTarget.setSize(width, height);
      renderFullscreen(this.cameraMotionMaterial, this.cameraMotionTarget, true);
      texture = this.cameraMotionTarget.texture;
    }
    if (!renderTexture) this.inverseViewProjection.copy(this.currentViewProjection).invert();
    this.cameraOnlyUniforms.uInverseViewProjection.value.copy(this.inverseViewProjection);
    this.cameraOnlyUniforms.uViewProjection.value.copy(this.currentViewProjection);
    this.cameraOnlyUniforms.uPreviousViewProjection.value.copy(this.previousViewProjection);
    this.previousViewProjection.copy(this.currentViewProjection);
    return texture;
  }

  dispose(): void {
    this.material.dispose();
    this.cameraOnlyMaterial.dispose();
    this.cameraMotionMaterial.dispose();
    this.cameraMotionTarget.dispose();
  }
}
