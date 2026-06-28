export interface UnityVector2 {
  x: number;
  y: number;
}

export interface UnityVector3 extends UnityVector2 {
  z: number;
}

export interface UnityQuaternion extends UnityVector3 {
  w: number;
}

export interface UnityColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface UnityCurveKey {
  time: number;
  value: number;
  inSlope: number;
  outSlope: number;
  weightedMode: number;
  inWeight: number;
  outWeight: number;
}

export interface UnityAnimationCurve {
  preInfinity: number;
  postInfinity: number;
  rotationOrder: number;
  keys: UnityCurveKey[];
}

export interface UnityMinMaxCurve {
  /** UnityEngine.ParticleSystemCurveMode. */
  mode: 0 | 1 | 2 | 3;
  multiplier: number;
  constantMin: number;
  constantMax: number;
  curveMin: UnityAnimationCurve;
  curveMax: UnityAnimationCurve;
}

export interface UnityGradient {
  mode: number;
  colorSpace: number;
  colorKeys: Array<{ time: number; color: UnityColor }>;
  alphaKeys: Array<{ time: number; alpha: number }>;
}

export interface UnityMinMaxGradient {
  /** UnityEngine.ParticleSystemGradientMode. */
  mode: 0 | 1 | 2 | 3 | 4;
  colorMin: UnityColor;
  colorMax: UnityColor;
  gradientMin: UnityGradient;
  gradientMax: UnityGradient;
}

export interface UnityParticleInitialModule {
  startLifetime: UnityMinMaxCurve;
  startSpeed: UnityMinMaxCurve;
  startColor: UnityMinMaxGradient;
  startSize: UnityMinMaxCurve;
  startSizeY: UnityMinMaxCurve;
  startSizeZ: UnityMinMaxCurve;
  startRotationX: UnityMinMaxCurve;
  startRotationY: UnityMinMaxCurve;
  startRotationZ: UnityMinMaxCurve;
  randomizeRotationDirection: number;
  gravityModifier: UnityMinMaxCurve;
  gravitySource: number;
  maxParticles: number;
  size3D: boolean;
  rotation3D: boolean;
  customEmitterVelocity: UnityVector3;
}

export interface UnityParticleEmissionModule {
  rateOverTime: UnityMinMaxCurve;
  rateOverDistance: UnityMinMaxCurve;
  bursts: Array<{
    time: number;
    count: UnityMinMaxCurve;
    cycleCount: number;
    repeatInterval: number;
    probability: number;
  }>;
}

export interface UnityParticleShapeModule {
  type: number;
  angle: number;
  length: number;
  radius: number;
  radiusThickness: number;
  arc: number;
  boxThickness: UnityVector3;
  position: UnityVector3;
  rotation: UnityVector3;
  scale: UnityVector3;
  placementMode: number;
  meshId: string;
  spriteId: string;
  alignToDirection: boolean;
  randomDirectionAmount: number;
  sphericalDirectionAmount: number;
  randomPositionAmount: number;
}

export interface UnityParticleSizeModule {
  separateAxes: boolean;
  x: UnityMinMaxCurve;
  y: UnityMinMaxCurve;
  z: UnityMinMaxCurve;
}

export type UnityParticleRotationModule = UnityParticleSizeModule;

export interface UnityParticleColorModule {
  color: UnityMinMaxGradient;
}

export interface UnityParticleVelocityModule {
  x: UnityMinMaxCurve;
  y: UnityMinMaxCurve;
  z: UnityMinMaxCurve;
  orbitalX: UnityMinMaxCurve;
  orbitalY: UnityMinMaxCurve;
  orbitalZ: UnityMinMaxCurve;
  orbitalOffsetX: UnityMinMaxCurve;
  orbitalOffsetY: UnityMinMaxCurve;
  orbitalOffsetZ: UnityMinMaxCurve;
  radial: UnityMinMaxCurve;
  speedModifier: UnityMinMaxCurve;
  inWorldSpace: boolean;
}

export interface UnityParticleLimitVelocityModule {
  separateAxes: boolean;
  x: UnityMinMaxCurve;
  y: UnityMinMaxCurve;
  z: UnityMinMaxCurve;
  magnitude: UnityMinMaxCurve;
  dampen: number;
  drag: UnityMinMaxCurve;
  inWorldSpace: boolean;
  multiplyDragByParticleSize: boolean;
  multiplyDragByParticleVelocity: boolean;
}

export interface UnityParticleNoiseModule {
  separateAxes: boolean;
  strengthX: UnityMinMaxCurve;
  strengthY: UnityMinMaxCurve;
  strengthZ: UnityMinMaxCurve;
  frequency: number;
  damping: boolean;
  octaves: number;
  octaveMultiplier: number;
  octaveScale: number;
  quality: number;
  scrollSpeed: UnityMinMaxCurve;
  remapEnabled: boolean;
  remapX: UnityMinMaxCurve;
  remapY: UnityMinMaxCurve;
  remapZ: UnityMinMaxCurve;
  positionAmount: UnityMinMaxCurve;
  rotationAmount: UnityMinMaxCurve;
  sizeAmount: UnityMinMaxCurve;
}

export interface UnityParticleTextureSheetModule {
  mode: number;
  timeMode: number;
  fps: number;
  frameOverTime: UnityMinMaxCurve;
  startFrame: UnityMinMaxCurve;
  tilesX: number;
  tilesY: number;
  animationType: number;
  rowIndex: number;
  rowMode: number;
  cycles: number;
  flipU: number;
  flipV: number;
  uvChannelMask: number;
  sprites: string[];
}

export interface UnityParticleCustomDataModule {
  streams: Array<{
    mode: number;
    componentCount: number;
    color: UnityMinMaxGradient;
    vector: [UnityMinMaxCurve, UnityMinMaxCurve, UnityMinMaxCurve, UnityMinMaxCurve];
  }>;
}

export interface UnityParticleSystemDefinition {
  id: string;
  nodeId: string;
  source: string;
  duration: number;
  simulationSpeed: number;
  looping: boolean;
  prewarm: boolean;
  playOnAwake: boolean;
  useUnscaledTime: boolean;
  moveWithTransform: number;
  scalingMode: number;
  autoRandomSeed: boolean;
  randomSeed: number;
  startDelay: UnityMinMaxCurve;
  initial: UnityParticleInitialModule;
  emission: UnityParticleEmissionModule | null;
  shape: UnityParticleShapeModule | null;
  sizeOverLifetime: UnityParticleSizeModule | null;
  rotationOverLifetime: UnityParticleRotationModule | null;
  colorOverLifetime: UnityParticleColorModule | null;
  velocityOverLifetime: UnityParticleVelocityModule | null;
  limitVelocityOverLifetime: UnityParticleLimitVelocityModule | null;
  noise: UnityParticleNoiseModule | null;
  textureSheetAnimation: UnityParticleTextureSheetModule | null;
  customData: UnityParticleCustomDataModule | null;
}

export interface UnityMaterialTextureProperty {
  textureId: string;
  fileId: number;
  scale: UnityVector2;
  offset: UnityVector2;
  reference?: UnitySerializedObjectReference | null;
}

export interface UnitySerializedObjectReference {
  fileId: number;
  pathId: string;
  cab: string | null;
  externalReference: string | null;
  name: string | null;
  source: string | null;
}

export interface UnityMaterialDefinition {
  id: string;
  name: string;
  source: string;
  shaderId: string;
  shaderName: string;
  keywords: string[];
  renderQueue: number;
  tags: Record<string, string>;
  properties: {
    textures: Record<string, UnityMaterialTextureProperty>;
    floats: Record<string, number>;
    colors: Record<string, UnityColor>;
  };
  textureUrl: string | null;
  /** Exact Material MainTex/BaseMap PPtr resolution from the source UnityFS bundle. */
  textureReference: UnitySerializedObjectReference | null;
}

export interface UnityParticleRendererDefinition {
  id: string;
  nodeId: string;
  source: string;
  enabled: boolean;
  materialId: string;
  material: UnityMaterialDefinition | null;
  sortingLayerId: number;
  sortingOrder: number;
  /** UnityEngine.ParticleSystemRenderMode. */
  renderMode: number;
  sortMode: number;
  /** UnityEngine.ParticleSystemRenderSpace. */
  renderAlignment: number;
  minParticleSize: number;
  maxParticleSize: number;
  cameraVelocityScale: number;
  velocityScale: number;
  lengthScale: number;
  sortingFudge: number;
  normalDirection: number;
  pivot: UnityVector3;
  flip: UnityVector3;
  allowRoll: boolean;
  meshId: string;
  vertexStreams: number[];
}

export interface UnitySpriteDefinition {
  id: string;
  name: string;
  source: string;
  textureId: string;
  textureUrl: string | null;
  rect: { x: number; y: number; width: number; height: number };
  pivot: UnityVector2;
  pixelsToUnits: number;
}

export interface UnitySpriteRendererDefinition {
  id: string;
  nodeId: string;
  source: string;
  enabled: boolean;
  spriteId: string;
  sprite: UnitySpriteDefinition | null;
  materialId: string;
  color: UnityColor;
  flipX: boolean;
  flipY: boolean;
  sortingLayerId: number;
  sortingOrder: number;
  drawMode: number;
  size: UnityVector2;
}

export interface UnityMeshDefinition {
  id: string;
  name: string;
  source: string;
  positions: number[];
  uvs: number[];
  indices: number[];
  bounds: { center: UnityVector3; extent: UnityVector3 };
}

export interface UnityMeshRendererDefinition {
  id: string;
  nodeId: string;
  source: string;
  enabled: boolean;
  materialId: string;
  meshId: string;
  sortingLayerId: number;
  sortingOrder: number;
}

export interface UnityEffectNodeDefinition {
  id: string;
  transformId: string;
  name: string;
  nameHash: number;
  source: string | null;
  active: boolean;
  parentId: string | null;
  position: UnityVector3;
  rotation: UnityQuaternion;
  scale: UnityVector3;
}

export interface UnityStreamedCurveSegment {
  time: number;
  coefficients: [number, number, number, number];
  value: number;
}

export interface UnityAnimationBinding {
  pathHash: number;
  attributeHash: number;
  typeId: number;
  customType: number;
  isPPtrCurve: boolean;
}

export interface UnityAnimationClipDefinition {
  id: string;
  name: string;
  source: string;
  sampleRate: number;
  startTime: number;
  stopTime: number;
  loop: boolean;
  curves: Array<{
    binding: UnityAnimationBinding | null;
    segments: UnityStreamedCurveSegment[];
  }>;
  pptrMapping: string[];
  /** Exact Sprite PPtr at the corresponding pptrMapping index. */
  pptrReferences: Array<UnitySerializedObjectReference | null>;
  /** URL at the corresponding pptrMapping index; null represents Unity's null PPtr. */
  pptrTextures: Array<string | null>;
}

export interface UnityEffectRuntimeDefinition {
  version: 1;
  source: string;
  rootNodeId: string;
  nodes: UnityEffectNodeDefinition[];
  particleSystems: UnityParticleSystemDefinition[];
  particleRenderers: UnityParticleRendererDefinition[];
  spriteRenderers: UnitySpriteRendererDefinition[];
  meshRenderers: UnityMeshRendererDefinition[];
  materials: UnityMaterialDefinition[];
  sprites: UnitySpriteDefinition[];
  meshes: UnityMeshDefinition[];
  animations: UnityAnimationClipDefinition[];
  evidence?: Record<string, unknown>;
}
