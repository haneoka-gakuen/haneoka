import {
  ClampToEdgeWrapping,
  LinearFilter,
  NoBlending,
  NoColorSpace,
  ShaderMaterial,
  Texture,
  Vector2,
  WebGLRenderTarget,
} from "three";
import type { IUniform } from "three";
import type { AdvRenderFullscreen } from "./AdvUrpBloom";

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// FinalPost PathID 98, blob 68 (_FXAA + _ENABLE_ALPHA_OUTPUT). Search steps,
// thresholds, subpixel polynomial and endpoint selection follow the expanded
// GLES program; alpha always comes from the unshifted center sample.
const FXAA_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexelSize;
varying vec2 vUv;

float luma(vec3 color) {
  return dot(color, vec3(0.298999995, 0.587000012, 0.114));
}

float sampleLuma(vec2 uv) {
  return luma(texture2D(tInput, uv).rgb);
}

void main() {
  vec4 centerColor = texture2D(tInput, vUv);
  if (centerColor.a <= 0.0) {
    gl_FragColor = centerColor;
    return;
  }

  float center = luma(centerColor.rgb);
  float north = sampleLuma(vUv + vec2(0.0, uTexelSize.y));
  float east = sampleLuma(vUv + vec2(uTexelSize.x, 0.0));
  float south = sampleLuma(vUv - vec2(0.0, uTexelSize.y));
  float west = sampleLuma(vUv - vec2(uTexelSize.x, 0.0));
  float highest = max(max(center, north), max(max(east, south), west));
  float lowest = min(min(center, north), min(min(east, south), west));
  float range = highest - lowest;
  if (range < max(highest * 0.150000006, 0.0299999993)) {
    gl_FragColor = centerColor;
    return;
  }

  float southWest = sampleLuma(vUv - uTexelSize);
  float northEast = sampleLuma(vUv + uTexelSize);
  float southEast = sampleLuma(vUv + vec2(uTexelSize.x, -uTexelSize.y));
  float northWest = sampleLuma(vUv + vec2(-uTexelSize.x, uTexelSize.y));

  float northSouth = north + south;
  float eastWest = east + west;
  float horizontalEdge = abs(northSouth - 2.0 * center) * 2.0
                       + abs(northEast + southEast - 2.0 * east)
                       + abs(northWest + southWest - 2.0 * west);
  float verticalEdge = abs(eastWest - 2.0 * center) * 2.0
                     + abs(southWest + southEast - 2.0 * south)
                     + abs(northEast + northWest - 2.0 * north);
  bool horizontal = horizontalEdge >= verticalEdge;

  float first = horizontal ? south : west;
  float second = horizontal ? north : east;
  float firstGradient = first - center;
  float secondGradient = second - center;
  bool firstSteeper = abs(firstGradient) >= abs(secondGradient);
  float steepestGradient = max(abs(firstGradient), abs(secondGradient));
  float signedStep = horizontal ? uTexelSize.y : uTexelSize.x;
  if (firstSteeper) signedStep = -signedStep;
  float localAverage = 0.5 * (center + (firstSteeper ? first : second));
  float gradientThreshold = steepestGradient * 0.25;

  vec2 edgeUv = vUv;
  if (horizontal) edgeUv.y += signedStep * 0.5;
  else edgeUv.x += signedStep * 0.5;
  vec2 edgeStep = horizontal ? vec2(uTexelSize.x, 0.0) : vec2(0.0, uTexelSize.y);
  vec2 negativeUv = edgeUv - edgeStep;
  vec2 positiveUv = edgeUv + edgeStep;
  float negativeDelta = sampleLuma(negativeUv) - localAverage;
  float positiveDelta = sampleLuma(positiveUv) - localAverage;
  bool negativeDone = abs(negativeDelta) >= gradientThreshold;
  bool positiveDone = abs(positiveDelta) >= gradientThreshold;

  if (!negativeDone) negativeUv -= edgeStep * 1.5;
  if (!positiveDone) positiveUv += edgeStep * 1.5;
  if (!negativeDone) negativeDelta = sampleLuma(negativeUv) - localAverage;
  if (!positiveDone) positiveDelta = sampleLuma(positiveUv) - localAverage;
  negativeDone = negativeDone || abs(negativeDelta) >= gradientThreshold;
  positiveDone = positiveDone || abs(positiveDelta) >= gradientThreshold;

  if (!negativeDone) negativeUv -= edgeStep * 2.0;
  if (!positiveDone) positiveUv += edgeStep * 2.0;
  if (!negativeDone) negativeDelta = sampleLuma(negativeUv) - localAverage;
  if (!positiveDone) positiveDelta = sampleLuma(positiveUv) - localAverage;
  negativeDone = negativeDone || abs(negativeDelta) >= gradientThreshold;
  positiveDone = positiveDone || abs(positiveDelta) >= gradientThreshold;

  if (!negativeDone) negativeUv -= edgeStep * 4.0;
  if (!positiveDone) positiveUv += edgeStep * 4.0;
  if (!negativeDone) negativeDelta = sampleLuma(negativeUv) - localAverage;
  if (!positiveDone) positiveDelta = sampleLuma(positiveUv) - localAverage;
  negativeDone = negativeDone || abs(negativeDelta) >= gradientThreshold;
  positiveDone = positiveDone || abs(positiveDelta) >= gradientThreshold;

  if (!negativeDone) negativeUv -= edgeStep * 12.0;
  if (!positiveDone) positiveUv += edgeStep * 12.0;

  float negativeDistance = horizontal ? vUv.x - negativeUv.x : vUv.y - negativeUv.y;
  float positiveDistance = horizontal ? positiveUv.x - vUv.x : positiveUv.y - vUv.y;
  bool negativeNearest = negativeDistance < positiveDistance;
  float nearestDistance = min(negativeDistance, positiveDistance);
  float edgeOffset = 0.5 - nearestDistance / (negativeDistance + positiveDistance);
  bool centerNegative = center - localAverage < 0.0;
  bool endpointNegative = (negativeNearest ? negativeDelta : positiveDelta) < 0.0;
  if (centerNegative == endpointNegative) edgeOffset = 0.0;

  float subpixel = abs(((north + east + south + west) * 2.0
                      + northWest + northEast + southWest + southEast) * 0.0833333358 - center) / range;
  subpixel = clamp(subpixel, 0.0, 1.0);
  subpixel = subpixel * subpixel * (3.0 - 2.0 * subpixel);
  subpixel = subpixel * subpixel * 0.649999976;
  float offset = max(edgeOffset, subpixel);
  vec2 finalUv = vUv;
  if (horizontal) finalUv.y += offset * signedStep;
  else finalUv.x += offset * signedStep;
  gl_FragColor = vec4(texture2D(tInput, finalUv).rgb, centerColor.a);
}
`;

interface FxaaUniforms extends Record<string, IUniform<unknown>> {
  tInput: IUniform<Texture | null>;
  uTexelSize: IUniform<Vector2>;
}

export function advFxaaRangeThreshold(highestLuma: number): number {
  return Math.max(highestLuma * 0.150000006, 0.0299999993);
}

/** Absolute endpoint distances and whether blob 68 samples at that boundary. */
export function advFxaaSearchSchedule(): readonly (readonly [distance: number, sampled: boolean])[] {
  let distance = 1;
  const result: Array<readonly [number, boolean]> = [[distance, true]];
  for (const increment of [1.5, 2, 4] as const) {
    distance += increment;
    result.push([distance, true]);
  }
  distance += 12;
  result.push([distance, false]);
  return result;
}

/** FinalPost's packaged FXAA resolve, to be run after event-600 renderer features. */
export class AdvFinalPostFxaa {
  private readonly uniforms: FxaaUniforms = {
    tInput: { value: null },
    uTexelSize: { value: new Vector2(1, 1) },
  };
  private readonly material = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: FXAA_FRAGMENT,
    uniforms: this.uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    toneMapped: false,
  });

  render(source: WebGLRenderTarget, destination: WebGLRenderTarget, renderFullscreen: AdvRenderFullscreen): void {
    source.texture.colorSpace = NoColorSpace;
    source.texture.minFilter = LinearFilter;
    source.texture.magFilter = LinearFilter;
    source.texture.wrapS = ClampToEdgeWrapping;
    source.texture.wrapT = ClampToEdgeWrapping;
    this.uniforms.tInput.value = source.texture;
    this.uniforms.uTexelSize.value.set(1 / source.width, 1 / source.height);
    renderFullscreen(this.material, destination, true);
  }

  dispose(): void {
    this.material.dispose();
  }
}
