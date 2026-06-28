import {
  AddEquation,
  BackSide,
  BufferGeometry,
  Camera,
  CustomBlending,
  DataTexture,
  DoubleSide,
  DstAlphaFactor,
  DstColorFactor,
  Float32BufferAttribute,
  FrontSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicMaterial,
  NoColorSpace,
  Object3D,
  OneFactor,
  OneMinusDstAlphaFactor,
  OneMinusDstColorFactor,
  OneMinusSrcAlphaFactor,
  OneMinusSrcColorFactor,
  Quaternion,
  Scene,
  ShaderMaterial,
  SrcAlphaFactor,
  SrcAlphaSaturateFactor,
  SrcColorFactor,
  Texture,
  Uint32BufferAttribute,
  Vector3,
  Vector4,
  ZeroFactor,
} from "three";
import type { BlendingDstFactor, BlendingSrcFactor, Side } from "three";
import { unityEulerDegrees, unityQuaternion, unityScale, unityVector3 } from "../three/UnityTransform";
import {
  evaluateUnityStreamedCurve,
  multiplyUnityColors,
  sampleUnityMinMaxCurve,
  sampleUnityMinMaxGradient,
  stableCompactInPlace,
  unityParticleSimulationDelta,
  UnityRandom,
  writeUnityConeShapeSample,
  writeUnityHighQualityCurlNoise,
  writeUnityLowQualityCurlNoise,
  writeUnityMediumQualityCurlNoise,
  writeUnityParticleNoiseFieldOffset,
  writeUnitySingleSidedEdgeShapeSample,
} from "./UnityParticleMath";
import { SharedAsyncResourceCache } from "./SharedAsyncResourceCache";
import type { SharedResourceLease } from "./SharedAsyncResourceCache";
import { loadCachedImage } from "../cubism/CubismResourceCache";
import { unityStringHash } from "./UnityAnimationHash";
import type {
  UnityColor,
  UnityEffectRuntimeDefinition,
  UnityMaterialDefinition,
  UnityMeshDefinition,
  UnityMinMaxCurve,
  UnityParticleRendererDefinition,
  UnityParticleShapeModule,
  UnityParticleSystemDefinition,
  UnitySpriteRendererDefinition,
} from "./UnityParticleTypes";

const ATTRIBUTE_ACTIVE = unityStringHash("m_IsActive");
const ATTRIBUTE_COLOR_ALPHA = unityStringHash("m_Color.a");

const PARTICLE_VERTEX = /* glsl */ `
attribute vec3 iPosition;
attribute vec3 iVelocity;
attribute vec3 iSize;
attribute vec3 iRotation;
attribute vec4 iColor;
attribute vec4 iUvTransform;
attribute vec3 iFlip;
uniform int uRenderMode;
uniform int uRenderAlignment;
uniform float uLengthScale;
uniform bool uAllowRoll;
uniform vec3 uParticleScale;
uniform vec3 uPivot;
varying vec2 vUv;
varying vec4 vColor;

vec3 safeNormalized(vec3 value, vec3 fallbackValue) {
  float magnitudeSquared = dot(value, value);
  return magnitudeSquared > 0.00000001 ? value * inversesqrt(magnitudeSquared) : fallbackValue;
}

void cameraFacingBasis(vec3 centerWorld, bool verticalOnly, out vec3 right, out vec3 up) {
  vec3 forward = cameraPosition - centerWorld;
  if (verticalOnly) forward.y = 0.0;
  forward = safeNormalized(forward, vec3(0.0, 0.0, 1.0));
  vec3 worldUp = vec3(0.0, 1.0, 0.0);
  right = cross(worldUp, forward);
  right = safeNormalized(right, vec3(1.0, 0.0, 0.0));
  up = verticalOnly ? worldUp : safeNormalized(cross(forward, right), worldUp);
}

vec3 rotateUnityZXY(vec3 threeValue, vec3 radians) {
  float a = cos(radians.x);
  float b = sin(radians.x);
  float c = cos(radians.y);
  float d = sin(radians.y);
  float e = cos(radians.z);
  float f = sin(radians.z);
  float ce = c * e;
  float cf = c * f;
  float de = d * e;
  float df = d * f;
  mat3 unityZXY = mat3(
    ce - df * b, cf + de * b, -a * d,
    -a * f, a * e, b,
    de + cf * b, df - ce * b, a * c
  );
  vec3 unityValue = vec3(threeValue.x, threeValue.y, -threeValue.z);
  vec3 rotated = unityZXY * unityValue;
  return vec3(rotated.x, rotated.y, -rotated.z);
}

void main() {
  float billboardRotation = uAllowRoll ? iRotation.z : 0.0;
  float sine = sin(billboardRotation);
  float cosine = cos(billboardRotation);
  vec2 pivoted = (position.xy - uPivot.xy) * iFlip.xy;
  vec2 corner = vec2(pivoted.x * cosine - pivoted.y * sine, pivoted.x * sine + pivoted.y * cosine);
  vec3 centerWorld = (modelMatrix * vec4(iPosition, 1.0)).xyz;
  vec4 center = viewMatrix * vec4(centerWorld, 1.0);
  vec2 billboardSize = iSize.xy * uParticleScale.xy;
  if (uRenderMode == 1) {
    vec2 viewVelocity = (viewMatrix * vec4(mat3(modelMatrix) * iVelocity, 0.0)).xy;
    vec2 along = length(viewVelocity) > 0.00001 ? normalize(viewVelocity) : vec2(0.0, 1.0);
    vec2 across = vec2(along.y, -along.x);
    center.xy += across * corner.x * billboardSize.x +
      along * corner.y * (billboardSize.y + length(viewVelocity) * uLengthScale);
  } else if (uRenderMode == 2) {
    vec3 worldPosition = centerWorld + vec3(corner.x * billboardSize.x, 0.0, corner.y * billboardSize.y);
    center = viewMatrix * vec4(worldPosition, 1.0);
  } else if (uRenderMode == 3) {
    vec3 right;
    vec3 up;
    cameraFacingBasis(centerWorld, true, right, up);
    vec3 worldPosition = centerWorld + right * corner.x * billboardSize.x + up * corner.y * billboardSize.y;
    center = viewMatrix * vec4(worldPosition, 1.0);
  } else if (uRenderMode == 4) {
    vec3 meshVertex = (position - uPivot) * iFlip * iSize;
    center = modelViewMatrix * vec4(iPosition + rotateUnityZXY(meshVertex, iRotation), 1.0);
  } else if (uRenderAlignment == 2) {
    center = modelViewMatrix * vec4(iPosition + vec3(corner.x * iSize.x, corner.y * iSize.y, 0.0), 1.0);
  } else if (uRenderAlignment == 1) {
    vec3 worldPosition = centerWorld + vec3(corner.x * billboardSize.x, corner.y * billboardSize.y, 0.0);
    center = viewMatrix * vec4(worldPosition, 1.0);
  } else if (uRenderAlignment == 3) {
    vec3 right;
    vec3 up;
    cameraFacingBasis(centerWorld, false, right, up);
    vec3 worldPosition = centerWorld + right * corner.x * billboardSize.x + up * corner.y * billboardSize.y;
    center = viewMatrix * vec4(worldPosition, 1.0);
  } else if (uRenderAlignment == 4) {
    vec3 forward = safeNormalized(cameraPosition - centerWorld, vec3(0.0, 0.0, 1.0));
    vec3 up = safeNormalized(mat3(modelMatrix) * iVelocity, vec3(0.0, 1.0, 0.0));
    vec3 right = safeNormalized(cross(up, forward), vec3(1.0, 0.0, 0.0));
    up = safeNormalized(cross(forward, right), vec3(0.0, 1.0, 0.0));
    vec3 worldPosition = centerWorld + right * corner.x * billboardSize.x + up * corner.y * billboardSize.y;
    center = viewMatrix * vec4(worldPosition, 1.0);
  } else {
    center.xy += corner * billboardSize;
  }
  vUv = uv * iUvTransform.zw + iUvTransform.xy;
  vColor = iColor;
  gl_Position = projectionMatrix * center;
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec4 uBaseColor;
uniform vec4 uTintColor;
uniform vec4 uTextureSampleAdd;
uniform int uShaderMode;
uniform bool uHasMap;
varying vec2 vUv;
varying vec4 vColor;

float roundEvenPositive(float value) {
  float lower = floor(value);
  float fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1.0;
  return mod(lower, 2.0) == 0.0 ? lower : lower + 1.0;
}

void main() {
  vec4 sampled = uHasMap ? texture2D(uMap, vUv) : vec4(1.0);
  if (uShaderMode == 2) {
    float quantizedAlpha = roundEvenPositive(clamp(vColor.a, 0.0, 1.0) * 255.0) * 0.00784313772;
    vec4 doubledVertexColor = vec4(vColor.rgb * 2.0, quantizedAlpha * 2.0);
    gl_FragColor = doubledVertexColor * uTintColor * (sampled + uTextureSampleAdd);
  } else if (uShaderMode == 1) {
    gl_FragColor = sampled * vColor;
  } else {
    gl_FragColor = sampled * uBaseColor * vColor;
  }
}
`;

const whiteTexture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
whiteTexture.colorSpace = NoColorSpace;
whiteTexture.needsUpdate = true;

const textureCache = new SharedAsyncResourceCache<string, Texture>(
  async (url) => {
    const texture = new Texture(await loadCachedImage(url));
    // PlayerSettings.m_ActiveColorSpace is Gamma in the shipped player;
    // keep authored samples in the same numeric space as the compiled shader.
    texture.colorSpace = NoColorSpace;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  },
  (texture) => texture.dispose(),
  48,
);

function loadTexture(url: string): Promise<SharedResourceLease<Texture>> {
  return textureCache.acquire(url);
}

const PARTICLE_INSTANCE_ATTRIBUTES = [
  "iPosition",
  "iVelocity",
  "iSize",
  "iRotation",
  "iColor",
  "iUvTransform",
  "iFlip",
] as const;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, finite(value)));
}

function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 0x9e3779b9;
}

function blendFactor(value: number): BlendingSrcFactor | BlendingDstFactor {
  return (
    (
      {
        0: ZeroFactor,
        1: OneFactor,
        2: DstColorFactor,
        3: SrcColorFactor,
        4: OneMinusDstColorFactor,
        5: SrcAlphaFactor,
        6: OneMinusSrcColorFactor,
        7: DstAlphaFactor,
        8: OneMinusDstAlphaFactor,
        9: SrcAlphaSaturateFactor,
        10: OneMinusSrcAlphaFactor,
      } as Record<number, BlendingSrcFactor | BlendingDstFactor>
    )[Math.trunc(value)] ?? OneFactor
  );
}

function materialSide(cull: number): Side {
  if (cull === 0) return DoubleSide;
  if (cull === 1) return BackSide;
  return FrontSide;
}

function color(value: UnityColor | undefined, fallback: UnityColor = { r: 1, g: 1, b: 1, a: 1 }): UnityColor {
  return value ? { r: finite(value.r), g: finite(value.g), b: finite(value.b), a: finite(value.a, 1) } : fallback;
}

function particleShaderMode(definition: UnityMaterialDefinition | null): 0 | 1 | 2 {
  if (definition?.shaderName === "Custom/Mobile/MobileAddHdrColor") return 2;
  if (definition?.shaderName.startsWith("Mobile/Particles/")) return 1;
  return 0;
}

function configureBlend(target: ShaderMaterial | MeshBasicMaterial, definition: UnityMaterialDefinition | null): void {
  const floats = definition?.properties.floats ?? {};
  const shaderName = definition?.shaderName ?? "";
  const fixedAdditive = shaderName === "Mobile/Particles/Additive" || shaderName === "Custom/Mobile/MobileAddHdrColor";
  const fixedAlpha =
    shaderName === "Mobile/Particles/Alpha Blended" ||
    shaderName === "Universal Render Pipeline/2D/Sprite-Unlit-Default" ||
    shaderName === "Sprites/Default" ||
    shaderName === "Sprites/Mask";
  target.transparent = finite(floats._Surface) === 1 || finite(floats._DstBlend) !== 0;
  target.blending = CustomBlending;
  target.blendEquation = AddEquation;
  target.blendSrc =
    fixedAdditive || fixedAlpha ? SrcAlphaFactor : (blendFactor(finite(floats._SrcBlend, 5)) as BlendingSrcFactor);
  target.blendDst = fixedAdditive
    ? OneFactor
    : fixedAlpha
      ? OneMinusSrcAlphaFactor
      : (blendFactor(finite(floats._DstBlend, 10)) as BlendingDstFactor);
  target.blendSrcAlpha =
    fixedAdditive || fixedAlpha ? SrcAlphaFactor : (blendFactor(finite(floats._SrcBlendAlpha, 1)) as BlendingSrcFactor);
  target.blendDstAlpha = fixedAdditive
    ? OneFactor
    : fixedAlpha
      ? OneMinusSrcAlphaFactor
      : (blendFactor(finite(floats._DstBlendAlpha, 10)) as BlendingDstFactor);
  target.depthWrite = finite(floats._ZWrite) > 0.5;
  target.depthTest = shaderName !== "Custom/Mobile/MobileAddHdrColor";
  target.side = fixedAdditive || fixedAlpha ? DoubleSide : materialSide(Math.trunc(finite(floats._Cull, 2)));
  if (fixedAdditive || fixedAlpha) {
    target.transparent = true;
    target.depthWrite = false;
  }
}

interface Particle {
  age: number;
  lifetime: number;
  position: Vector3;
  baseVelocity: Vector3;
  gravityVelocity: Vector3;
  velocity: Vector3;
  startSize: Vector3;
  rotation: Vector3;
  startColor: UnityColor;
  curveRandom: number;
  colorRandom: number;
  flipU: boolean;
  flipV: boolean;
  rendererFlipX: number;
  rendererFlipY: number;
  rendererFlipZ: number;
}

function sortParticlesBackToFront(left: Particle, right: Particle): number {
  return right.position.z - left.position.z;
}

function sortOldestInFront(left: Particle, right: Particle): number {
  return right.age - left.age;
}

function sortYoungestInFront(left: Particle, right: Particle): number {
  return left.age - right.age;
}

interface ShapeSample {
  position: Vector3;
  direction: Vector3;
}

interface ShapeSamplerScratch {
  readonly sample: ShapeSample;
  readonly scale: Vector3;
  readonly translation: Vector3;
  readonly edgeA: Vector3;
  readonly edgeB: Vector3;
  readonly rotation: Quaternion;
}

const meshTriangleWeights = new WeakMap<UnityMeshDefinition, { cumulative: number[]; total: number }>();

function meshWeights(mesh: UnityMeshDefinition): { cumulative: number[]; total: number } {
  const cached = meshTriangleWeights.get(mesh);
  if (cached) return cached;
  const cumulative: number[] = [];
  let total = 0;
  for (let triangle = 0; triangle + 2 < mesh.indices.length; triangle += 3) {
    const ia = (mesh.indices[triangle] ?? 0) * 3;
    const ib = (mesh.indices[triangle + 1] ?? 0) * 3;
    const ic = (mesh.indices[triangle + 2] ?? 0) * 3;
    const abX = (mesh.positions[ib] ?? 0) - (mesh.positions[ia] ?? 0);
    const abY = (mesh.positions[ib + 1] ?? 0) - (mesh.positions[ia + 1] ?? 0);
    const abZ = (mesh.positions[ib + 2] ?? 0) - (mesh.positions[ia + 2] ?? 0);
    const acX = (mesh.positions[ic] ?? 0) - (mesh.positions[ia] ?? 0);
    const acY = (mesh.positions[ic + 1] ?? 0) - (mesh.positions[ia + 1] ?? 0);
    const acZ = (mesh.positions[ic + 2] ?? 0) - (mesh.positions[ia + 2] ?? 0);
    const crossX = abY * acZ - abZ * acY;
    const crossY = abZ * acX - abX * acZ;
    const crossZ = abX * acY - abY * acX;
    total += Math.hypot(crossX, crossY, crossZ) * 0.5;
    cumulative.push(total);
  }
  const weights = { cumulative, total };
  meshTriangleWeights.set(mesh, weights);
  return weights;
}

function sampleMesh(
  mesh: UnityMeshDefinition,
  random: UnityRandom,
  target: ShapeSample,
  edgeA: Vector3,
  edgeB: Vector3,
): boolean {
  if (mesh.positions.length < 9 || mesh.indices.length < 3) return false;
  const weights = meshWeights(mesh);
  const weightedTarget = random.next() * weights.total;
  let low = 0;
  let high = weights.cumulative.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (weights.cumulative[middle] < weightedTarget) low = middle + 1;
    else high = middle;
  }
  const triangle = low * 3;
  const ia = (mesh.indices[triangle] ?? 0) * 3;
  const ib = (mesh.indices[triangle + 1] ?? 0) * 3;
  const ic = (mesh.indices[triangle + 2] ?? 0) * 3;
  const u = Math.sqrt(random.next());
  const v = random.next();
  const aX = mesh.positions[ia] ?? 0;
  const aY = mesh.positions[ia + 1] ?? 0;
  const aZ = -(mesh.positions[ia + 2] ?? 0);
  const bX = mesh.positions[ib] ?? 0;
  const bY = mesh.positions[ib + 1] ?? 0;
  const bZ = -(mesh.positions[ib + 2] ?? 0);
  const cX = mesh.positions[ic] ?? 0;
  const cY = mesh.positions[ic + 1] ?? 0;
  const cZ = -(mesh.positions[ic + 2] ?? 0);
  target.position.set(
    aX * (1 - u) + bX * u * (1 - v) + cX * u * v,
    aY * (1 - u) + bY * u * (1 - v) + cY * u * v,
    aZ * (1 - u) + bZ * u * (1 - v) + cZ * u * v,
  );
  edgeA.set(bX - aX, bY - aY, bZ - aZ);
  edgeB.set(cX - aX, cY - aY, cZ - aZ);
  target.direction.crossVectors(edgeA, edgeB).normalize();
  return true;
}

function sampleShape(
  shape: UnityParticleShapeModule | null,
  meshes: ReadonlyMap<string, UnityMeshDefinition>,
  random: UnityRandom,
  scratch: ShapeSamplerScratch,
): ShapeSample {
  const { position, direction } = scratch.sample;
  position.set(0, 0, 0);
  // Unity's particle forward is local +Z; reflect once into Three local -Z.
  direction.set(0, 0, -1);
  if (!shape) return scratch.sample;
  const radius = Math.max(0, finite(shape.radius, 1));
  const angleRandom = random.next();
  if (shape.type === 4) {
    writeUnityConeShapeSample(radius, shape.angle, shape.arc, angleRandom, random.next(), position, direction);
  } else if (shape.type === 5) {
    position.set(random.signed() * 0.5, random.signed() * 0.5, random.signed() * 0.5);
  } else if (shape.type === 6) {
    const mesh = meshes.get(shape.meshId);
    if (mesh) sampleMesh(mesh, random, scratch.sample, scratch.edgeA, scratch.edgeB);
  } else if (shape.type === 10) {
    const angle = angleRandom * Math.PI * 2 * (finite(shape.arc, 360) / 360);
    const inner = 1 - clamp01(shape.radiusThickness);
    const radial = radius * Math.sqrt(inner * inner + (1 - inner * inner) * random.next());
    position.set(Math.cos(angle) * radial, Math.sin(angle) * radial, 0);
    direction.copy(position).normalize();
  } else if (shape.type === 12) {
    writeUnitySingleSidedEdgeShapeSample(radius, random.next(), position, direction);
  } else {
    const angle = angleRandom * Math.PI * 2 * (finite(shape.arc, 360) / 360);
    const z = random.signed();
    const radial = Math.sqrt(Math.max(0, 1 - z * z));
    direction.set(Math.cos(angle) * radial, z, Math.sin(angle) * radial);
    position.copy(direction).multiplyScalar(radius * Math.cbrt(random.next()));
  }
  scratch.scale.set(shape.scale.x, shape.scale.y, shape.scale.z);
  position.multiply(scratch.scale);
  scratch.scale.set(shape.scale.x || 1, shape.scale.y || 1, shape.scale.z || 1);
  direction.multiply(scratch.scale).normalize();
  unityEulerDegrees(shape.rotation, scratch.rotation);
  position.applyQuaternion(scratch.rotation).add(unityVector3(shape.position, scratch.translation));
  direction.applyQuaternion(scratch.rotation);
  return scratch.sample;
}

function smoothNoiseCoordinate(value: number): number {
  return value * value * (3 - 2 * value);
}

function valueNoiseHash(x: number, y: number, z: number, seed: number): number {
  let value = Math.imul(x ^ seed, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 2147483648 - 1;
}

function mixNumber(left: number, right: number, amount: number): number {
  return left + (right - left) * amount;
}

function valueNoise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smoothNoiseCoordinate(x - ix);
  const fy = smoothNoiseCoordinate(y - iy);
  const fz = smoothNoiseCoordinate(z - iz);
  const lower = mixNumber(
    mixNumber(valueNoiseHash(ix, iy, iz, seed), valueNoiseHash(ix + 1, iy, iz, seed), fx),
    mixNumber(valueNoiseHash(ix, iy + 1, iz, seed), valueNoiseHash(ix + 1, iy + 1, iz, seed), fx),
    fy,
  );
  const upper = mixNumber(
    mixNumber(valueNoiseHash(ix, iy, iz + 1, seed), valueNoiseHash(ix + 1, iy, iz + 1, seed), fx),
    mixNumber(valueNoiseHash(ix, iy + 1, iz + 1, seed), valueNoiseHash(ix + 1, iy + 1, iz + 1, seed), fx),
    fy,
  );
  return mixNumber(lower, upper, fz);
}

class UnityParticleSystemView {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly node: Object3D;
  private readonly definition: UnityParticleSystemDefinition;
  private readonly renderer: UnityParticleRendererDefinition;
  private readonly meshes: ReadonlyMap<string, UnityMeshDefinition>;
  private readonly random: UnityRandom;
  private readonly fallbackNoiseSeed: number;
  private readonly noiseFieldOffset = new Vector3();
  private readonly textureLease: SharedResourceLease<Texture> | null;
  private readonly particles: Particle[] = [];
  private readonly pool: Particle[] = [];
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly sizes: Float32Array;
  private readonly rotations: Float32Array;
  private readonly colors: Float32Array;
  private readonly uvTransforms: Float32Array;
  private readonly flips: Float32Array;
  private readonly noiseScratch = new Vector3();
  private readonly noisePositionScratch = new Vector3();
  private readonly curlNoiseScratch = {
    first: { x: 0, y: 0 },
    second: { x: 0, y: 0 },
    third: { x: 0, y: 0 },
  };
  private readonly vectorScratchA = new Vector3();
  private readonly vectorScratchB = new Vector3();
  private readonly vectorScratchC = new Vector3();
  private readonly particleScaleScratch = new Vector3(1, 1, 1);
  private readonly shapeScratch: ShapeSamplerScratch = {
    sample: { position: new Vector3(), direction: new Vector3(0, 0, -1) },
    scale: new Vector3(1, 1, 1),
    translation: new Vector3(),
    edgeA: new Vector3(),
    edgeB: new Vector3(),
    rotation: new Quaternion(),
  };
  private readonly lifetimeColorScratch: UnityColor = { r: 1, g: 1, b: 1, a: 1 };
  private readonly gradientColorScratch: UnityColor = { r: 1, g: 1, b: 1, a: 1 };
  private readonly outputColorScratch: UnityColor = { r: 1, g: 1, b: 1, a: 1 };
  private time = 0;
  private delay = 0;
  private rateRemainder = 0;
  private emitting = false;
  private simulationSpeed = 1;
  private burstEpoch = -1;
  private particleDelta = 0;
  private readonly retainParticle = (particle: Particle): boolean => this.updateParticle(particle, this.particleDelta);

  get usesHierarchyScale(): boolean {
    return this.definition.scalingMode === 0;
  }

  static async create(
    definition: UnityParticleSystemDefinition,
    renderer: UnityParticleRendererDefinition,
    node: Object3D,
    meshes: ReadonlyMap<string, UnityMeshDefinition>,
    seed: number,
  ): Promise<UnityParticleSystemView> {
    const material = renderer.material;
    const url = material?.textureUrl;
    const textureLease = url ? await loadTexture(url).catch(() => null) : null;
    return new UnityParticleSystemView(
      definition,
      renderer,
      node,
      meshes,
      textureLease?.value ?? whiteTexture,
      textureLease,
      seed,
    );
  }

  private constructor(
    definition: UnityParticleSystemDefinition,
    renderer: UnityParticleRendererDefinition,
    node: Object3D,
    meshes: ReadonlyMap<string, UnityMeshDefinition>,
    texture: Texture,
    textureLease: SharedResourceLease<Texture> | null,
    seed: number,
  ) {
    this.definition = definition;
    this.renderer = renderer;
    this.node = node;
    this.meshes = meshes;
    this.textureLease = textureLease;
    const resolvedSeed = definition.randomSeed || seed;
    this.random = new UnityRandom(resolvedSeed);
    this.fallbackNoiseSeed = hashSeed(definition.id);
    // The native noise job independently initializes the four-word stream
    // from ParticleSystem.randomSeed, consumes three values, then multiplies
    // each by 100.
    writeUnityParticleNoiseFieldOffset(resolvedSeed, this.noiseFieldOffset);
    this.delay = Math.max(0, sampleUnityMinMaxCurve(definition.startDelay, 0, this.random.next()));
    const capacity = Math.max(1, Math.min(20000, definition.initial.maxParticles || 1000));
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity * 3);
    this.rotations = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 4);
    this.uvTransforms = new Float32Array(capacity * 4);
    this.flips = new Float32Array(capacity * 3);
    const geometry = new InstancedBufferGeometry();
    if (renderer.renderMode === 4) {
      const sourceGeometry = geometryFromUnityMesh(meshes.get(renderer.meshId));
      for (const name of Object.keys(sourceGeometry.attributes)) {
        geometry.setAttribute(name, sourceGeometry.getAttribute(name).clone());
      }
      const index = sourceGeometry.getIndex();
      if (index) geometry.setIndex(index.clone());
      sourceGeometry.dispose();
    } else {
      geometry.setAttribute(
        "position",
        new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
      );
      geometry.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
    }
    geometry.setAttribute("iPosition", new InstancedBufferAttribute(this.positions, 3));
    geometry.setAttribute("iVelocity", new InstancedBufferAttribute(this.velocities, 3));
    geometry.setAttribute("iSize", new InstancedBufferAttribute(this.sizes, 3));
    geometry.setAttribute("iRotation", new InstancedBufferAttribute(this.rotations, 3));
    geometry.setAttribute("iColor", new InstancedBufferAttribute(this.colors, 4));
    geometry.setAttribute("iUvTransform", new InstancedBufferAttribute(this.uvTransforms, 4));
    geometry.setAttribute("iFlip", new InstancedBufferAttribute(this.flips, 3));
    geometry.instanceCount = 0;
    const materialColor = color(
      renderer.material?.properties.colors._BaseColor ?? renderer.material?.properties.colors._Color,
    );
    const shaderMode = particleShaderMode(renderer.material);
    const tintColor = color(
      renderer.material?.properties.colors._TintColor,
      shaderMode === 2 ? { r: 0.5, g: 0.5, b: 0.5, a: 0.5 } : undefined,
    );
    const textureSampleAdd = color(renderer.material?.properties.colors._TextureSampleAdd, { r: 0, g: 0, b: 0, a: 0 });
    const material = new ShaderMaterial({
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      uniforms: {
        uMap: { value: texture },
        uHasMap: { value: texture !== whiteTexture },
        uBaseColor: { value: new Vector4(materialColor.r, materialColor.g, materialColor.b, materialColor.a) },
        uTintColor: { value: new Vector4(tintColor.r, tintColor.g, tintColor.b, tintColor.a) },
        uTextureSampleAdd: {
          value: new Vector4(textureSampleAdd.r, textureSampleAdd.g, textureSampleAdd.b, textureSampleAdd.a),
        },
        uShaderMode: { value: shaderMode },
        uRenderMode: { value: renderer.renderMode },
        uRenderAlignment: { value: renderer.renderAlignment },
        uLengthScale: { value: renderer.lengthScale },
        uAllowRoll: { value: renderer.allowRoll },
        uParticleScale: { value: new Vector3(1, 1, 1) },
        uPivot: { value: new Vector3(renderer.pivot.x, renderer.pivot.y, -renderer.pivot.z) },
      },
    });
    configureBlend(material, renderer.material);
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = `UnityParticleSystem:${definition.id}`;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderer.sortingOrder;
    node.add(this.mesh);
  }

  play(simulationSpeed: number): void {
    this.clear();
    this.simulationSpeed = Math.max(0, finite(simulationSpeed, 1));
    this.emitting = true;
    if (this.definition.prewarm && this.definition.looping) {
      const step = 1 / 30;
      for (let elapsed = 0; elapsed < this.definition.duration; elapsed += step) this.update(step);
    }
  }

  stop(immediate: boolean): void {
    this.emitting = false;
    if (immediate) this.clear();
  }

  get complete(): boolean {
    return !this.emitting && this.particles.length === 0;
  }

  private hierarchyActive(): boolean {
    let current: Object3D | null = this.node;
    while (current) {
      if (!current.visible) return false;
      current = current.parent;
    }
    return true;
  }

  private clear(): void {
    for (const particle of this.particles) this.pool.push(particle);
    this.particles.length = 0;
    this.time = 0;
    this.rateRemainder = 0;
    this.burstEpoch = -1;
    this.mesh.geometry.instanceCount = 0;
  }

  private acquire(): Particle {
    return (
      this.pool.pop() ?? {
        age: 0,
        lifetime: 1,
        position: new Vector3(),
        baseVelocity: new Vector3(),
        gravityVelocity: new Vector3(),
        velocity: new Vector3(),
        startSize: new Vector3(1, 1, 1),
        rotation: new Vector3(),
        startColor: { r: 1, g: 1, b: 1, a: 1 },
        curveRandom: 0,
        colorRandom: 0,
        flipU: false,
        flipV: false,
        rendererFlipX: 1,
        rendererFlipY: 1,
        rendererFlipZ: 1,
      }
    );
  }

  private spawn(count: number): void {
    const maximum = this.positions.length / 3;
    for (let index = 0; index < count && this.particles.length < maximum; index += 1) {
      const particle = this.acquire();
      const shape = sampleShape(this.definition.shape, this.meshes, this.random, this.shapeScratch);
      particle.age = 0;
      particle.curveRandom = this.random.next();
      particle.colorRandom = this.random.next();
      particle.lifetime = Math.max(
        0.0001,
        sampleUnityMinMaxCurve(this.definition.initial.startLifetime, 0, particle.curveRandom),
      );
      particle.position.copy(shape.position);
      particle.baseVelocity
        .copy(shape.direction)
        .multiplyScalar(sampleUnityMinMaxCurve(this.definition.initial.startSpeed, 0, particle.curveRandom));
      particle.gravityVelocity.set(0, 0, 0);
      particle.velocity.copy(particle.baseVelocity);
      const sizeX = sampleUnityMinMaxCurve(this.definition.initial.startSize, 0, particle.curveRandom);
      particle.startSize.set(
        sizeX,
        this.definition.initial.size3D
          ? sampleUnityMinMaxCurve(this.definition.initial.startSizeY, 0, particle.curveRandom)
          : sizeX,
        this.definition.initial.size3D
          ? sampleUnityMinMaxCurve(this.definition.initial.startSizeZ, 0, particle.curveRandom)
          : sizeX,
      );
      particle.rotation.set(
        sampleUnityMinMaxCurve(this.definition.initial.startRotationX, 0, particle.curveRandom),
        sampleUnityMinMaxCurve(this.definition.initial.startRotationY, 0, particle.curveRandom),
        sampleUnityMinMaxCurve(this.definition.initial.startRotationZ, 0, particle.curveRandom),
      );
      if (this.random.next() < this.definition.initial.randomizeRotationDirection) particle.rotation.multiplyScalar(-1);
      sampleUnityMinMaxGradient(
        this.definition.initial.startColor,
        0,
        particle.colorRandom,
        particle.startColor,
        this.gradientColorScratch,
      );
      const uv = this.definition.textureSheetAnimation;
      particle.flipU = Boolean(uv && this.random.next() < uv.flipU);
      particle.flipV = Boolean(uv && this.random.next() < uv.flipV);
      const rendererFlipX = clamp01(this.renderer.flip.x);
      const rendererFlipY = clamp01(this.renderer.flip.y);
      const rendererFlipZ = clamp01(this.renderer.flip.z);
      particle.rendererFlipX = rendererFlipX > 0 && this.random.next() < rendererFlipX ? -1 : 1;
      particle.rendererFlipY = rendererFlipY > 0 && this.random.next() < rendererFlipY ? -1 : 1;
      particle.rendererFlipZ = rendererFlipZ > 0 && this.random.next() < rendererFlipZ ? -1 : 1;
      this.particles.push(particle);
    }
  }

  private emit(previous: number, current: number): void {
    const emission = this.definition.emission;
    if (!emission || current < this.delay) return;
    const duration = Math.max(0.0001, this.definition.duration);
    const normalized = ((current - this.delay) % duration) / duration;
    const rate = Math.max(0, sampleUnityMinMaxCurve(emission.rateOverTime, normalized, this.random.next()));
    this.rateRemainder += rate * Math.max(0, current - Math.max(previous, this.delay));
    const amount = Math.floor(this.rateRemainder);
    if (amount > 0) {
      this.spawn(amount);
      this.rateRemainder -= amount;
    }
    const firstEpoch = Math.max(0, Math.floor((Math.max(previous, this.delay) - this.delay) / duration));
    const lastEpoch = Math.max(0, Math.floor((current - this.delay) / duration));
    for (let epoch = firstEpoch; epoch <= lastEpoch; epoch += 1) {
      if (!this.definition.looping && epoch > 0) break;
      for (let burstIndex = 0; burstIndex < emission.bursts.length; burstIndex += 1) {
        const burst = emission.bursts[burstIndex];
        for (let cycle = 0; cycle < burst.cycleCount; cycle += 1) {
          const eventTime = this.delay + epoch * duration + burst.time + cycle * burst.repeatInterval;
          const eventId = epoch * 100000 + burstIndex * 1000 + cycle;
          if (eventId <= this.burstEpoch || eventTime < previous || eventTime > current) continue;
          this.burstEpoch = eventId;
          if (this.random.next() <= burst.probability) {
            this.spawn(Math.max(0, Math.round(sampleUnityMinMaxCurve(burst.count, normalized, this.random.next()))));
          }
        }
      }
    }
  }

  update(deltaSeconds: number): void {
    if (!this.hierarchyActive()) {
      // A stopped system under an Animator-deactivated node cannot age on the
      // native side either; release it so graceful effect teardown can finish.
      if (!this.emitting && this.particles.length > 0) this.clear();
      this.mesh.geometry.instanceCount = 0;
      return;
    }
    const delta = unityParticleSimulationDelta(deltaSeconds, this.simulationSpeed, this.definition.simulationSpeed);
    const previous = this.time;
    this.time += delta;
    if (this.emitting) {
      this.emit(previous, this.time);
      if (!this.definition.looping && this.time >= this.delay + this.definition.duration) this.emitting = false;
    }
    this.particleDelta = delta;
    stableCompactInPlace(this.particles, this.retainParticle, this.pool);
    this.upload();
  }

  private updateParticle(particle: Particle, delta: number): boolean {
    particle.age += delta;
    if (particle.age >= particle.lifetime) return false;
    const age = clamp01(particle.age / particle.lifetime);
    particle.velocity.copy(particle.baseVelocity);
    const velocity = this.definition.velocityOverLifetime;
    if (velocity) {
      particle.velocity.add(
        this.vectorScratchA.set(
          this.sampleParticleCurve(velocity.x, age, particle),
          this.sampleParticleCurve(velocity.y, age, particle),
          -this.sampleParticleCurve(velocity.z, age, particle),
        ),
      );
      const offset = this.vectorScratchA.set(
        this.sampleParticleCurve(velocity.orbitalOffsetX, age, particle),
        this.sampleParticleCurve(velocity.orbitalOffsetY, age, particle),
        -this.sampleParticleCurve(velocity.orbitalOffsetZ, age, particle),
      );
      const angular = this.vectorScratchB.set(
        this.sampleParticleCurve(velocity.orbitalX, age, particle),
        this.sampleParticleCurve(velocity.orbitalY, age, particle),
        -this.sampleParticleCurve(velocity.orbitalZ, age, particle),
      );
      this.vectorScratchC.copy(particle.position).sub(offset);
      particle.velocity.add(angular.cross(this.vectorScratchC));
      this.vectorScratchC.copy(particle.position).sub(offset).normalize();
      particle.velocity.addScaledVector(this.vectorScratchC, this.sampleParticleCurve(velocity.radial, age, particle));
      particle.velocity.multiplyScalar(this.sampleParticleCurve(velocity.speedModifier, age, particle));
    }
    const gravity = sampleUnityMinMaxCurve(this.definition.initial.gravityModifier, age, particle.curveRandom);
    particle.gravityVelocity.y -= 9.81 * gravity * delta;
    particle.velocity.add(particle.gravityVelocity);
    const limit = this.definition.limitVelocityOverLifetime;
    if (limit) {
      const dampen = clamp01(limit.dampen);
      if (limit.separateAxes) {
        const limitX = Math.max(0, sampleUnityMinMaxCurve(limit.x, age, particle.curveRandom));
        const limitY = Math.max(0, sampleUnityMinMaxCurve(limit.y, age, particle.curveRandom));
        const limitZ = Math.max(0, sampleUnityMinMaxCurve(limit.z, age, particle.curveRandom));
        particle.velocity.set(
          Math.sign(particle.velocity.x) * Math.min(Math.abs(particle.velocity.x), limitX),
          Math.sign(particle.velocity.y) * Math.min(Math.abs(particle.velocity.y), limitY),
          Math.sign(particle.velocity.z) * Math.min(Math.abs(particle.velocity.z), limitZ),
        );
      } else {
        const maximum = Math.max(0, sampleUnityMinMaxCurve(limit.magnitude, age, particle.curveRandom));
        if (particle.velocity.length() > maximum) {
          this.vectorScratchA.copy(particle.velocity).setLength(maximum);
          particle.velocity.lerp(this.vectorScratchA, dampen);
        }
      }
      const drag = Math.max(0, sampleUnityMinMaxCurve(limit.drag, age, particle.curveRandom));
      particle.velocity.multiplyScalar(Math.max(0, 1 - drag * delta));
    }
    particle.position.addScaledVector(particle.velocity, delta);
    const rotation = this.definition.rotationOverLifetime;
    if (rotation) {
      particle.rotation.x += sampleUnityMinMaxCurve(rotation.x, age, particle.curveRandom) * delta;
      particle.rotation.y += sampleUnityMinMaxCurve(rotation.y, age, particle.curveRandom) * delta;
      particle.rotation.z += sampleUnityMinMaxCurve(rotation.z, age, particle.curveRandom) * delta;
    }
    return true;
  }

  private sampleParticleCurve(curve: UnityMinMaxCurve, age: number, particle: Particle): number {
    return sampleUnityMinMaxCurve(curve, age, particle.curveRandom);
  }

  private sampleNoise(particle: Particle, age: number, target: Vector3): Vector3 {
    const noise = this.definition.noise;
    if (!noise) return target.set(0, 0, 0);
    const frequency = Math.max(Math.fround(0.000001), Math.fround(noise.frequency));
    const scroll = sampleUnityMinMaxCurve(noise.scrollSpeed, age, particle.curveRandom) * this.time;
    let x: number;
    let y: number;
    let z: number;
    if (noise.quality === 0 || noise.quality === 1 || noise.quality === 2) {
      // Particle positions are stored in Three's reflected basis. The native
      // solver runs before C=diag(1,1,-1), so evaluate curl in Unity space and
      // reflect the Z component once on return.
      this.noisePositionScratch.set(particle.position.x, particle.position.y, -particle.position.z);
      if (noise.quality === 0) {
        writeUnityLowQualityCurlNoise(
          this.noisePositionScratch,
          this.noiseFieldOffset,
          scroll,
          frequency,
          noise.octaves,
          noise.octaveMultiplier,
          noise.octaveScale,
          target,
        );
      } else if (noise.quality === 1) {
        writeUnityMediumQualityCurlNoise(
          this.noisePositionScratch,
          this.noiseFieldOffset,
          scroll,
          frequency,
          noise.octaves,
          noise.octaveMultiplier,
          noise.octaveScale,
          target,
          this.curlNoiseScratch,
        );
      } else {
        writeUnityHighQualityCurlNoise(
          this.noisePositionScratch,
          this.noiseFieldOffset,
          scroll,
          frequency,
          noise.octaves,
          noise.octaveMultiplier,
          noise.octaveScale,
          target,
          this.curlNoiseScratch,
        );
      }
      x = target.x;
      y = target.y;
      z = target.z;
    } else {
      // Keep malformed/future enum values isolated from the proven native
      // Low/Medium/High dispatch.
      let octaveFrequency = frequency;
      let amplitude = 1;
      x = 0;
      y = 0;
      z = 0;
      for (let octave = 0; octave < Math.max(1, noise.octaves); octave += 1) {
        const px = (particle.position.x + this.noiseFieldOffset.x + scroll) * octaveFrequency;
        const py = (particle.position.y + this.noiseFieldOffset.y) * octaveFrequency;
        const pz = (-particle.position.z + this.noiseFieldOffset.z) * octaveFrequency;
        x += valueNoise(px, py, pz, this.fallbackNoiseSeed + octave * 3) * amplitude;
        y += valueNoise(px, py, pz, this.fallbackNoiseSeed + octave * 3 + 1) * amplitude;
        z += valueNoise(px, py, pz, this.fallbackNoiseSeed + octave * 3 + 2) * amplitude;
        octaveFrequency *= noise.octaveScale;
        amplitude *= noise.octaveMultiplier;
      }
    }
    if (noise.remapEnabled) {
      const normalize = 0.5 / frequency;
      const restore = frequency * 2;
      x = sampleUnityMinMaxCurve(noise.remapX, clamp01(x * normalize + 0.5), particle.curveRandom) * restore;
      y = sampleUnityMinMaxCurve(noise.remapY, clamp01(y * normalize + 0.5), particle.curveRandom) * restore;
      z = sampleUnityMinMaxCurve(noise.remapZ, clamp01(z * normalize + 0.5), particle.curveRandom) * restore;
    }
    const damping = noise.damping ? 1 / frequency : 1;
    const strengthX = sampleUnityMinMaxCurve(noise.strengthX, age, particle.curveRandom);
    const strengthY = noise.separateAxes
      ? sampleUnityMinMaxCurve(noise.strengthY, age, particle.curveRandom)
      : strengthX;
    const strengthZ = noise.separateAxes
      ? sampleUnityMinMaxCurve(noise.strengthZ, age, particle.curveRandom)
      : strengthX;
    return target.set(x * strengthX * damping, y * strengthY * damping, -z * strengthZ * damping);
  }

  private upload(): void {
    if (this.definition.scalingMode === 0) this.node.getWorldScale(this.particleScaleScratch);
    else if (this.definition.scalingMode === 1) this.particleScaleScratch.copy(this.node.scale);
    else this.particleScaleScratch.set(1, 1, 1);
    this.particleScaleScratch.set(
      Math.abs(this.particleScaleScratch.x),
      Math.abs(this.particleScaleScratch.y),
      Math.abs(this.particleScaleScratch.z),
    );
    (this.mesh.material.uniforms.uParticleScale.value as Vector3).copy(this.particleScaleScratch);
    if (this.renderer.sortMode === 1 || this.renderer.sortMode === 4) {
      this.particles.sort(sortParticlesBackToFront);
    } else if (this.renderer.sortMode === 2) {
      this.particles.sort(sortOldestInFront);
    } else if (this.renderer.sortMode === 3) {
      this.particles.sort(sortYoungestInFront);
    }
    for (let index = 0; index < this.particles.length; index += 1) {
      const particle = this.particles[index];
      const age = clamp01(particle.age / particle.lifetime);
      const noise = this.sampleNoise(particle, age, this.noiseScratch);
      const positionAmount = this.definition.noise
        ? sampleUnityMinMaxCurve(this.definition.noise.positionAmount, age, particle.curveRandom)
        : 0;
      const vectorOffset = index * 3;
      this.positions[vectorOffset] = particle.position.x + noise.x * positionAmount;
      this.positions[vectorOffset + 1] = particle.position.y + noise.y * positionAmount;
      this.positions[vectorOffset + 2] = particle.position.z + noise.z * positionAmount;
      this.velocities[vectorOffset] = particle.velocity.x;
      this.velocities[vectorOffset + 1] = particle.velocity.y;
      this.velocities[vectorOffset + 2] = particle.velocity.z;
      const sizeModule = this.definition.sizeOverLifetime;
      const sizeX =
        particle.startSize.x * (sizeModule ? sampleUnityMinMaxCurve(sizeModule.x, age, particle.curveRandom) : 1);
      const sizeY =
        particle.startSize.y *
        (sizeModule
          ? sampleUnityMinMaxCurve(sizeModule.separateAxes ? sizeModule.y : sizeModule.x, age, particle.curveRandom)
          : 1);
      const sizeZ =
        particle.startSize.z *
        (sizeModule
          ? sampleUnityMinMaxCurve(sizeModule.separateAxes ? sizeModule.z : sizeModule.x, age, particle.curveRandom)
          : 1);
      const sizeNoise = this.definition.noise
        ? 1 + noise.x * sampleUnityMinMaxCurve(this.definition.noise.sizeAmount, age, particle.curveRandom)
        : 1;
      const sizeOffset = index * 3;
      this.sizes[sizeOffset] = Math.max(0, sizeX * sizeNoise);
      this.sizes[sizeOffset + 1] = Math.max(0, sizeY * sizeNoise);
      this.sizes[sizeOffset + 2] = Math.max(0, sizeZ * sizeNoise);
      const rotationOffset = index * 3;
      this.rotations[rotationOffset] = particle.rotation.x;
      this.rotations[rotationOffset + 1] = particle.rotation.y;
      this.rotations[rotationOffset + 2] =
        particle.rotation.z +
        (this.definition.noise
          ? noise.z * sampleUnityMinMaxCurve(this.definition.noise.rotationAmount, age, particle.curveRandom)
          : 0);
      const lifetimeColor = this.lifetimeColorScratch;
      if (this.definition.colorOverLifetime) {
        sampleUnityMinMaxGradient(
          this.definition.colorOverLifetime.color,
          age,
          particle.colorRandom,
          lifetimeColor,
          this.gradientColorScratch,
        );
      } else {
        lifetimeColor.r = 1;
        lifetimeColor.g = 1;
        lifetimeColor.b = 1;
        lifetimeColor.a = 1;
      }
      const outputColor = multiplyUnityColors(particle.startColor, lifetimeColor, this.outputColorScratch);
      const colorOffset = index * 4;
      this.colors[colorOffset] = outputColor.r;
      this.colors[colorOffset + 1] = outputColor.g;
      this.colors[colorOffset + 2] = outputColor.b;
      this.colors[colorOffset + 3] = outputColor.a;
      const sheet = this.definition.textureSheetAnimation;
      if (sheet) {
        const columns = Math.max(1, sheet.tilesX);
        const rows = Math.max(1, sheet.tilesY);
        const frameCount = columns * rows;
        const start = sampleUnityMinMaxCurve(sheet.startFrame, age, particle.curveRandom) * frameCount;
        const frame =
          Math.floor(
            start + sampleUnityMinMaxCurve(sheet.frameOverTime, age, particle.curveRandom) * sheet.cycles * frameCount,
          ) % frameCount;
        const column = ((frame % columns) + columns) % columns;
        const row = Math.floor(frame / columns) % rows;
        const scaleX = (particle.flipU ? -1 : 1) / columns;
        const scaleY = (particle.flipV ? -1 : 1) / rows;
        const offsetX = (column + (particle.flipU ? 1 : 0)) / columns;
        const offsetY = (rows - row - 1 + (particle.flipV ? 1 : 0)) / rows;
        this.uvTransforms[colorOffset] = offsetX;
        this.uvTransforms[colorOffset + 1] = offsetY;
        this.uvTransforms[colorOffset + 2] = scaleX;
        this.uvTransforms[colorOffset + 3] = scaleY;
      } else {
        this.uvTransforms[colorOffset] = 0;
        this.uvTransforms[colorOffset + 1] = 0;
        this.uvTransforms[colorOffset + 2] = 1;
        this.uvTransforms[colorOffset + 3] = 1;
      }
      const flipOffset = index * 3;
      this.flips[flipOffset] = particle.rendererFlipX;
      this.flips[flipOffset + 1] = particle.rendererFlipY;
      this.flips[flipOffset + 2] = particle.rendererFlipZ;
    }
    const liveCount = this.particles.length;
    this.mesh.geometry.instanceCount = liveCount;
    for (const name of PARTICLE_INSTANCE_ATTRIBUTES) {
      const attribute = this.mesh.geometry.getAttribute(name);
      if (!(attribute instanceof InstancedBufferAttribute)) continue;
      attribute.clearUpdateRanges();
      if (liveCount > 0) {
        // Attribute storage is sized to maxParticles (up to 20k), but only the
        // live prefix is consumed by this draw. Upload that prefix instead of
        // resending every unused instance slot for all seven attributes.
        attribute.addUpdateRange(0, liveCount * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.textureLease?.release();
  }
}

interface SpriteView {
  renderer: UnitySpriteRendererDefinition;
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  baseAlpha: number;
  frameTextures: ReadonlyMap<string, Texture>;
  textureLease: SharedResourceLease<Texture> | null;
}

interface StaticMeshView {
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  textureLease: SharedResourceLease<Texture> | null;
}

function geometryFromUnityMesh(definition: UnityMeshDefinition | undefined): BufferGeometry {
  const geometry = new BufferGeometry();
  if (definition?.positions.length) {
    const positions = [...definition.positions];
    for (let index = 2; index < positions.length; index += 3) positions[index] = -positions[index];
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute(
      "uv",
      new Float32BufferAttribute(
        definition.uvs.length ? definition.uvs : new Array((positions.length / 3) * 2).fill(0),
        2,
      ),
    );
    if (definition.indices.length) geometry.setIndex(new Uint32BufferAttribute(definition.indices, 1));
  } else {
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    geometry.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export interface UnityParticleEffectPlayOptions {
  simulationSpeed?: number;
  anchor?: Object3D | null;
  /** AdvEffectCommand.SetSortOrder is absolute, not an authored-order bias. */
  sortingOrderOverride?: number;
  targetScene?: Scene;
}

export class UnityParticleEffect {
  readonly root = new Object3D();
  private readonly asset: UnityEffectRuntimeDefinition;
  private readonly nodes: Map<string, Object3D>;
  private readonly nodesByHash = new Map<number, Object3D>();
  private readonly systems: UnityParticleSystemView[];
  private readonly sprites: SpriteView[];
  private readonly staticMeshes: StaticMeshView[];
  private readonly animationTextureLeases: SharedResourceLease<Texture>[];
  readonly usesHierarchyScale: boolean;
  private readonly spriteByPathHash = new Map<number, SpriteView[]>();
  private readonly animation: UnityEffectRuntimeDefinition["animations"][number] | null;
  private readonly clip = { time: 0, index: 0 };
  private anchor: Object3D | null = null;
  private simulationSpeed = 1;
  private stopping = false;
  private stoppedImmediate = false;
  private playing = false;
  private elapsedSeconds = 0;

  static async create(asset: UnityEffectRuntimeDefinition, seed: number): Promise<UnityParticleEffect> {
    const nodes = new Map<string, Object3D>();
    for (const definition of asset.nodes) {
      const node = new Object3D();
      node.name = definition.name;
      node.visible = definition.active;
      unityVector3(definition.position, node.position);
      unityQuaternion(definition.rotation, node.quaternion);
      unityScale(definition.scale, node.scale);
      nodes.set(definition.id, node);
    }
    const root = nodes.get(asset.rootNodeId);
    if (!root) throw new Error(`Unity particle prefab is missing root ${asset.rootNodeId}`);
    for (const definition of asset.nodes) {
      const node = nodes.get(definition.id);
      const parent = definition.parentId ? nodes.get(definition.parentId) : null;
      if (node && parent) parent.add(node);
    }
    const meshes = new Map(asset.meshes.map((mesh) => [mesh.id, mesh]));
    const renderers = new Map(asset.particleRenderers.map((renderer) => [renderer.nodeId, renderer]));
    const systems = await Promise.all(
      asset.particleSystems.map(async (definition, index) => {
        const node = nodes.get(definition.nodeId);
        const renderer = renderers.get(definition.nodeId);
        if (!node || !renderer || !renderer.enabled || renderer.renderMode === 5) return null;
        return UnityParticleSystemView.create(definition, renderer, node, meshes, seed + index * 977);
      }),
    );
    const animationTextureUrls = [
      ...new Set(asset.animations.flatMap((clip) => clip.pptrTextures).filter((url): url is string => Boolean(url))),
    ];
    const animationTextureEntries = await Promise.all(
      animationTextureUrls.map(async (url) => [url, await loadTexture(url).catch(() => null)] as const),
    );
    const animationTextures = new Map(
      animationTextureEntries.map(([url, lease]) => [url, lease?.value ?? whiteTexture] as const),
    );
    const animationTextureLeases = animationTextureEntries
      .map(([, lease]) => lease)
      .filter((lease): lease is SharedResourceLease<Texture> => lease !== null);
    const sprites = await Promise.all(
      asset.spriteRenderers.map(async (renderer): Promise<SpriteView | null> => {
        const node = nodes.get(renderer.nodeId);
        if (!node || !renderer.enabled) return null;
        const url =
          renderer.sprite?.textureUrl || asset.animations.flatMap((clip) => clip.pptrTextures).find(Boolean) || null;
        const textureLease = url ? await loadTexture(url).catch(() => null) : null;
        const map = textureLease?.value ?? whiteTexture;
        const width =
          renderer.sprite?.rect.width && renderer.sprite.pixelsToUnits
            ? renderer.sprite.rect.width / renderer.sprite.pixelsToUnits
            : renderer.size.x || 1;
        const height =
          renderer.sprite?.rect.height && renderer.sprite.pixelsToUnits
            ? renderer.sprite.rect.height / renderer.sprite.pixelsToUnits
            : renderer.size.y || 1;
        const geometry = new BufferGeometry();
        geometry.setAttribute(
          "position",
          new Float32BufferAttribute(
            [
              -width / 2,
              -height / 2,
              0,
              width / 2,
              -height / 2,
              0,
              width / 2,
              height / 2,
              0,
              -width / 2,
              height / 2,
              0,
            ],
            3,
          ),
        );
        geometry.setAttribute(
          "uv",
          new Float32BufferAttribute(
            [
              renderer.flipX ? 1 : 0,
              renderer.flipY ? 1 : 0,
              renderer.flipX ? 0 : 1,
              renderer.flipY ? 1 : 0,
              renderer.flipX ? 0 : 1,
              renderer.flipY ? 0 : 1,
              renderer.flipX ? 1 : 0,
              renderer.flipY ? 0 : 1,
            ],
            2,
          ),
        );
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        const material = new MeshBasicMaterial({
          map,
          color: 0xffffff,
          opacity: renderer.color.a,
          transparent: true,
          depthWrite: false,
          side: DoubleSide,
        });
        material.color.setRGB(renderer.color.r, renderer.color.g, renderer.color.b);
        configureBlend(material, asset.materials.find((entry) => entry.id === renderer.materialId) || null);
        const mesh = new Mesh(geometry, material);
        mesh.name = `UnitySpriteRenderer:${renderer.id}`;
        mesh.renderOrder = renderer.sortingOrder;
        node.add(mesh);
        return { renderer, mesh, baseAlpha: renderer.color.a, frameTextures: animationTextures, textureLease };
      }),
    );
    const staticMeshes = await Promise.all(
      asset.meshRenderers.map(async (renderer) => {
        const node = nodes.get(renderer.nodeId);
        if (!node || !renderer.enabled) return null;
        const definition = asset.materials.find((entry) => entry.id === renderer.materialId) || null;
        const textureLease = definition?.textureUrl ? await loadTexture(definition.textureUrl).catch(() => null) : null;
        const map = textureLease?.value ?? null;
        const baseColor = color(definition?.properties.colors._BaseColor ?? definition?.properties.colors._Color);
        const material = new MeshBasicMaterial({
          map,
          color: 0xffffff,
          opacity: baseColor.a,
          transparent: baseColor.a < 1,
        });
        material.color.setRGB(baseColor.r, baseColor.g, baseColor.b);
        configureBlend(material, definition);
        const mesh = new Mesh(geometryFromUnityMesh(meshes.get(renderer.meshId)), material);
        mesh.name = `UnityMeshRenderer:${renderer.id}`;
        mesh.renderOrder = renderer.sortingOrder;
        node.add(mesh);
        return { mesh, textureLease } satisfies StaticMeshView;
      }),
    );
    return new UnityParticleEffect(
      asset,
      root,
      nodes,
      systems.filter((entry): entry is UnityParticleSystemView => Boolean(entry)),
      sprites.filter((entry): entry is SpriteView => Boolean(entry)),
      staticMeshes.filter((entry): entry is StaticMeshView => Boolean(entry)),
      animationTextureLeases,
    );
  }

  private constructor(
    asset: UnityEffectRuntimeDefinition,
    root: Object3D,
    nodes: Map<string, Object3D>,
    systems: UnityParticleSystemView[],
    sprites: SpriteView[],
    staticMeshes: StaticMeshView[],
    animationTextureLeases: SharedResourceLease<Texture>[],
  ) {
    this.asset = asset;
    this.root.add(root);
    this.nodes = nodes;
    this.systems = systems;
    this.usesHierarchyScale = systems.some((system) => system.usesHierarchyScale);
    this.sprites = sprites;
    this.staticMeshes = staticMeshes;
    this.animationTextureLeases = animationTextureLeases;
    const nodeHashById = new Map<string, number>();
    const firstNodeIdByHash = new Map<number, string>();
    for (const definition of asset.nodes) {
      const node = nodes.get(definition.id);
      const pathHash = definition.nameHash >>> 0;
      if (node) this.nodesByHash.set(pathHash, node);
      nodeHashById.set(definition.id, pathHash);
      if (!firstNodeIdByHash.has(pathHash)) firstNodeIdByHash.set(pathHash, definition.id);
    }
    for (const sprite of sprites) {
      const pathHash = nodeHashById.get(sprite.renderer.nodeId);
      // Preserve Unity's first name-hash match when sibling nodes share a
      // name; the old lookup used asset.nodes.find rather than all matches.
      if (pathHash == null || firstNodeIdByHash.get(pathHash) !== sprite.renderer.nodeId) continue;
      const list = this.spriteByPathHash.get(pathHash) || [];
      list.push(sprite);
      this.spriteByPathHash.set(pathHash, list);
    }
    const rootName = asset.nodes.find((entry) => entry.id === asset.rootNodeId)?.name;
    this.animation = asset.animations.find((clip) => clip.name === rootName) || asset.animations[0] || null;
    this.root.matrixAutoUpdate = false;
  }

  play(options: UnityParticleEffectPlayOptions = {}): void {
    this.anchor = options.anchor ?? null;
    this.simulationSpeed = Math.max(0, finite(options.simulationSpeed ?? 1, 1));
    this.stopping = false;
    this.stoppedImmediate = false;
    this.playing = true;
    this.elapsedSeconds = 0;
    this.clip.time = 0;
    this.systems.forEach((system) => system.play(this.simulationSpeed));
    this.root.traverse((object) => {
      if (object instanceof Mesh && options.sortingOrderOverride != null) {
        object.renderOrder = Math.trunc(finite(options.sortingOrderOverride));
      }
    });
    this.syncAnchor();
  }

  stop(immediate = false): void {
    this.playing = false;
    this.stopping = true;
    this.stoppedImmediate = immediate;
    this.systems.forEach((system) => system.stop(immediate));
  }

  get complete(): boolean {
    return this.stopping && this.systems.every((system) => system.complete);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** A zero-time effect can be rebuilt exactly from its source prefab. */
  get hasAdvanced(): boolean {
    return !this.stoppedImmediate && (this.stopping || this.elapsedSeconds > 0.000001);
  }

  syncAnchor(): void {
    if (this.anchor) {
      this.anchor.updateWorldMatrix(true, false);
      this.root.matrix.copy(this.anchor.matrixWorld);
    } else {
      this.root.matrix.identity();
    }
    this.root.matrixWorldNeedsUpdate = true;
  }

  update(deltaSeconds: number): void {
    const delta = Math.max(0, finite(deltaSeconds)) * this.simulationSpeed;
    this.elapsedSeconds += delta;
    this.systems.forEach((system) => system.update(deltaSeconds));
    const animation = this.animation;
    if (animation) {
      this.clip.time += delta;
      const duration = Math.max(0.0001, animation.stopTime - animation.startTime);
      const time = animation.loop
        ? animation.startTime + (this.clip.time % duration)
        : Math.min(animation.stopTime, animation.startTime + this.clip.time);
      for (const curve of animation.curves) {
        const binding = curve.binding;
        if (!binding || !curve.segments.length) continue;
        const node = this.nodesByHash.get(binding.pathHash >>> 0);
        if (!node) continue;
        const value = evaluateUnityStreamedCurve(curve.segments, time);
        if (binding.isPPtrCurve) {
          const textureUrl = animation.pptrTextures[Math.max(0, Math.round(value))];
          if (!textureUrl) continue;
          for (const sprite of this.spriteByPathHash.get(binding.pathHash >>> 0) || []) {
            const texture = sprite.frameTextures.get(textureUrl);
            if (texture) sprite.mesh.material.map = texture;
          }
        } else if (binding.attributeHash === ATTRIBUTE_ACTIVE) node.visible = value >= 0.5;
        else if (binding.attributeHash === ATTRIBUTE_COLOR_ALPHA) {
          for (const sprite of this.spriteByPathHash.get(binding.pathHash >>> 0) || []) {
            sprite.mesh.material.opacity = sprite.baseAlpha * value;
          }
        }
      }
    }
  }

  dispose(): void {
    this.systems.forEach((system) => system.dispose());
    for (const sprite of this.sprites) {
      sprite.mesh.removeFromParent();
      sprite.mesh.geometry.dispose();
      sprite.mesh.material.dispose();
      sprite.textureLease?.release();
    }
    for (const view of this.staticMeshes) {
      view.mesh.removeFromParent();
      view.mesh.geometry.dispose();
      view.mesh.material.dispose();
      view.textureLease?.release();
    }
    for (const lease of this.animationTextureLeases) lease.release();
    this.root.removeFromParent();
  }
}

interface ActiveEffect {
  key: string;
  effect: UnityParticleEffect;
}

export class UnityParticleEffectController {
  readonly scene = new Scene();
  private readonly effects = new Map<string, ActiveEffect>();
  private readonly versions = new Map<string, number>();
  private readonly pending = new Set<string>();
  private readonly creations = new Map<string, Promise<UnityParticleEffect>>();
  private cachedLayer: { scene: Scene; camera: Camera } | null = null;

  constructor(private readonly onNaturalComplete?: (key: string) => void) {}

  async play(
    key: string,
    asset: UnityEffectRuntimeDefinition,
    options: UnityParticleEffectPlayOptions = {},
  ): Promise<void> {
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    this.remove(key);
    this.pending.add(key);
    let effect: UnityParticleEffect;
    const creation = UnityParticleEffect.create(asset, hashSeed(`${key}:${asset.source}`));
    this.creations.set(key, creation);
    try {
      effect = await creation;
    } finally {
      if (this.creations.get(key) === creation) this.creations.delete(key);
      if (this.versions.get(key) === version) {
        this.pending.delete(key);
      }
    }
    if (this.versions.get(key) !== version) {
      effect.dispose();
      return;
    }
    effect.play(options);
    (options.targetScene ?? this.scene).add(effect.root);
    this.effects.set(key, { key, effect });
  }

  isPlaying(key: string): boolean {
    return this.pending.has(key) || Boolean(this.effects.get(key)?.effect.isPlaying);
  }

  get hasActiveEffects(): boolean {
    return this.pending.size > 0 || this.effects.size > 0;
  }

  get hasPendingEffects(): boolean {
    return this.pending.size > 0;
  }

  get hasAdvancedEffects(): boolean {
    for (const active of this.effects.values()) {
      if (active.effect.hasAdvanced) return true;
    }
    return false;
  }

  async waitForPending(): Promise<void> {
    while (this.creations.size) {
      await Promise.allSettled([...this.creations.values()]);
    }
  }

  stop(key?: string, immediate = false): void {
    if (key) {
      this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
      this.pending.delete(key);
      this.effects.get(key)?.effect.stop(immediate);
      return;
    }
    for (const effectKey of this.versions.keys()) {
      this.versions.set(effectKey, (this.versions.get(effectKey) ?? 0) + 1);
    }
    this.pending.clear();
    this.creations.clear();
    for (const active of this.effects.values()) active.effect.stop(immediate);
  }

  update(deltaSeconds: number): void {
    for (const [key, active] of this.effects) {
      // World-hierarchy scaling is sampled while particle attributes upload.
      // Keep that uncommon mode current without restoring duplicate anchor
      // work for the common local/shape scaling modes.
      if (active.effect.usesHierarchyScale) active.effect.syncAnchor();
      active.effect.update(deltaSeconds);
      if (active.effect.complete) {
        this.remove(key);
        this.onNaturalComplete?.(key);
      }
    }
  }

  syncAnchors(): void {
    for (const active of this.effects.values()) active.effect.syncAnchor();
  }

  private remove(key: string): void {
    const active = this.effects.get(key);
    if (!active) return;
    active.effect.dispose();
    this.effects.delete(key);
  }

  dispose(): void {
    this.stop(undefined, true);
    for (const key of [...this.effects.keys()]) this.remove(key);
    this.versions.clear();
    this.pending.clear();
  }

  layer(camera: Camera): { scene: Scene; camera: Camera } | null {
    if (!this.effects.size) return null;
    if (!this.cachedLayer || this.cachedLayer.camera !== camera) this.cachedLayer = { scene: this.scene, camera };
    return this.cachedLayer;
  }
}
