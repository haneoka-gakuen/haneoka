import {
  ClampToEdgeWrapping,
  LinearFilter,
  NoBlending,
  NoColorSpace,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector4,
  WebGLRenderTarget,
} from "three";
import type { Camera, IUniform } from "three";
import type { AdvRenderFullscreen } from "./AdvUrpBloom";
import type { AdvPaniniProjectionVolume } from "./AdvVolumeStack";

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const GENERIC_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uSourceTexelSize;
uniform vec4 uParams; // view extents xy, distance, crop scale
varying vec2 vUv;
void main() {
  vec2 projected = (vUv * 2.0 - 1.0) * uParams.xy * uParams.w;
  float distancePlusOne = uParams.z + 1.0;
  float denominator = projected.x * projected.x + distancePlusOne * distancePlusOne;
  float distanceX = projected.x * uParams.z;
  float discriminant = sqrt(denominator - distanceX * distanceX);
  float cylindrical = (-distanceX * projected.x + distancePlusOne * discriminant) / denominator;
  float scale = (cylindrical + uParams.z) / distancePlusOne;
  vec2 uv = ((projected * scale) / cylindrical) / uParams.xy * 0.5 + 0.5;
  uv = min(uv, vec2(1.0) - uSourceTexelSize * 0.5);
  gl_FragColor = texture2D(tInput, uv);
}
`;

const UNIT_DISTANCE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uSourceTexelSize;
uniform vec4 uParams; // view extents xy, distance=1, crop scale
varying vec2 vUv;
void main() {
  vec2 projected = (vUv * 2.0 - 1.0) * uParams.xy * uParams.w;
  float xSquared = projected.x * projected.x;
  float root = sqrt(xSquared + 4.0);
  float scale = xSquared / root;
  scale = -scale + root;
  scale /= root;
  projected = (projected * scale) / (scale * 2.0 - 1.0);
  vec2 uv = projected / uParams.xy * 0.5 + 0.5;
  uv = min(uv, vec2(1.0) - uSourceTexelSize * 0.5);
  gl_FragColor = texture2D(tInput, uv);
}
`;

interface PaniniUniforms extends Record<string, IUniform<unknown>> {
  tInput: IUniform<Texture | null>;
  uSourceTexelSize: IUniform<Vector2>;
  uParams: IUniform<Vector4>;
}

function material(fragmentShader: string, uniforms: PaniniUniforms): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    toneMapped: false,
  });
}

export interface AdvPaniniParameters {
  readonly viewExtentX: number;
  readonly viewExtentY: number;
  readonly distance: number;
  readonly scale: number;
  readonly unitDistance: boolean;
}

/** Panini projection extents and crop factor, mirroring DoPaniniProjection and CalcView/CropExtents. */
export function computeAdvPaniniParameters(
  distance: number,
  cropToFit: number,
  verticalFieldOfViewDegrees: number,
  width: number,
  height: number,
): AdvPaniniParameters {
  const resolvedDistance = Math.max(0, Math.min(1, distance));
  const resolvedCrop = Math.max(0, Math.min(1, cropToFit));
  const viewExtentY = Math.tan(verticalFieldOfViewDegrees * (Math.PI / 180) * 0.5);
  const viewExtentX = (width / height) * viewExtentY;
  const reciprocalLength = 1 / Math.sqrt(viewExtentX * viewExtentX + 1);
  const cropFactor = (resolvedDistance + 1) / (resolvedDistance + reciprocalLength);
  const cropExtentX = viewExtentX * reciprocalLength * cropFactor;
  const cropExtentY = viewExtentY * reciprocalLength * cropFactor;
  const cropScale = Math.min(Math.min(cropExtentX / viewExtentX, cropExtentY / viewExtentY), 1);
  const scale = 1 + (cropScale - 1) * resolvedCrop;
  return {
    viewExtentX,
    viewExtentY,
    distance: resolvedDistance,
    scale,
    unitDistance: resolvedDistance === 1,
  };
}

/** Hidden/Universal Render Pipeline/PaniniProjection generic/unit blobs. */
export class AdvPaniniProjection {
  private readonly uniforms: PaniniUniforms = {
    tInput: { value: null },
    uSourceTexelSize: { value: new Vector2(1, 1) },
    uParams: { value: new Vector4(1, 1, 0, 1) },
  };
  private readonly genericMaterial = material(GENERIC_FRAGMENT, this.uniforms);
  private readonly unitDistanceMaterial = material(UNIT_DISTANCE_FRAGMENT, this.uniforms);

  render(
    source: WebGLRenderTarget,
    destination: WebGLRenderTarget,
    settings: Readonly<AdvPaniniProjectionVolume>,
    renderFullscreen: AdvRenderFullscreen,
    camera: Camera | null,
  ): boolean {
    if (!settings.active || settings.distance <= 0 || !camera) return false;
    const projectionY = camera.projectionMatrix.elements[5];
    const fieldOfView = (2 * Math.atan(1 / projectionY) * 180) / Math.PI;
    const parameters = computeAdvPaniniParameters(
      settings.distance,
      settings.cropToFit,
      fieldOfView,
      source.width,
      source.height,
    );

    source.texture.colorSpace = NoColorSpace;
    source.texture.minFilter = LinearFilter;
    source.texture.magFilter = LinearFilter;
    source.texture.wrapS = ClampToEdgeWrapping;
    source.texture.wrapT = ClampToEdgeWrapping;
    this.uniforms.tInput.value = source.texture;
    this.uniforms.uSourceTexelSize.value.set(1 / source.width, 1 / source.height);
    this.uniforms.uParams.value.set(
      parameters.viewExtentX,
      parameters.viewExtentY,
      parameters.distance,
      parameters.scale,
    );
    renderFullscreen(parameters.unitDistance ? this.unitDistanceMaterial : this.genericMaterial, destination, true);
    return true;
  }

  dispose(): void {
    this.genericMaterial.dispose();
    this.unitDistanceMaterial.dispose();
  }
}
