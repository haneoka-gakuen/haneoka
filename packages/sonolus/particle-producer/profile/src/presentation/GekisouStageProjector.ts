import { parseNativeIntroSprite, type NativeIntroSpriteData } from "../assets/introSprite.js";
import { identity, multiply } from "../authored/sourceTransform.js";
import type { RenderOverlaySprite, RenderOverlayTexture } from "../render/types.js";
import {
  ourNotesGekisouStageState,
  OurNotesGekisouStageScene,
  type OurNotesGekisouEffectMode,
  type OurNotesGekisouEffectProfile,
  type OurNotesGekisouStageState,
  type OurNotesGekisouStagePose,
} from "./GekisouStage.js";
import {
  OurNotesGekisouStageEmitter,
  gekisouStageParticleFrame,
  gekisouStageParticlePosition,
  transformGekisouStagePoint,
  type OurNotesStageParticle,
} from "./GekisouStageParticles.js";
import type { OurNotesGekisouRange } from "./Gekisou.js";

type Raw = Record<string, any>;
interface Shape {
  positions: ArrayLike<number>;
  uv: ArrayLike<number>;
  indices: ArrayLike<number>;
}
interface SubEmitter {
  readonly targetId: string;
  readonly parentId: string;
  readonly particle: OurNotesStageParticle;
  readonly emitter: OurNotesGekisouStageEmitter;
  readonly pose: OurNotesGekisouStagePose;
  first: boolean;
}
export interface OurNotesGekisouStageViewport {
  readonly worldToClip: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}
export interface OurNotesGekisouStageInput {
  readonly timeMs: number;
  readonly mode?: OurNotesGekisouEffectMode;
  readonly lightweightMode?: boolean;
  readonly state?: OurNotesGekisouStageState;
}

/** Full per-range scene producer. GPU backends only consume its final buffers/materials. */
export class OurNotesGekisouStageProjector {
  private scene?: OurNotesGekisouStageScene;
  private mode: OurNotesGekisouEffectMode = 0;
  private rangeIndex = -1;
  private simulationMs = 0;
  private readonly resources: Raw[];
  private readonly byKey: Map<string, Raw>;
  private readonly byPathId: Map<string, Raw>;
  private readonly spriteShapes = new Map<string, NativeIntroSpriteData>();
  private readonly emitters = new Map<string, OurNotesGekisouStageEmitter>();
  private readonly buffers = new Map<string, Float32Array>();
  private readonly indices = new Map<string, Uint16Array>();
  private readonly childTargets = new Set<string>();
  private readonly subLinks = new Map<string, string[]>();
  private readonly children = new Map<string, SubEmitter>();
  private readonly screenWorldToClip = new Float64Array(16);
  private readonly localShaderNames = new Map<string, string>();
  private readonly rendererOrders = new Map<string, number>();
  private currentState: OurNotesGekisouStageState | undefined;

  constructor(
    readonly source: OurNotesGekisouEffectProfile,
    readonly ranges: readonly Pick<OurNotesGekisouRange, "startTimeMs" | "endTimeMs">[],
    private readonly nextLifecycleSeed: () => number,
  ) {
    this.resources = source.resources as Raw[];
    this.byKey = new Map(this.resources.map((resource) => [resource.key, resource]));
    this.byPathId = new Map(this.resources.map((resource) => [resource.key.split(":").at(-1)!, resource]));
  }

  textures(resolve: (path: string) => string): Record<string, RenderOverlayTexture> {
    return Object.fromEntries(
      this.resources
        .filter((resource) => resource.type === "Texture2D")
        .map((resource) => [
          this.textureKey(resource),
          { url: resolve(resource.outputs[0].path), origin: "top-left" as const },
        ]),
    );
  }

  private textureKey(resource: Raw): string {
    return `gekisou-stage:${resource.key}`;
  }
  private resource(pointer: Raw, owner: string): Raw | undefined {
    const reference = pointer.reference;
    return reference?.serializedFile && reference?.pathId
      ? this.byKey.get(`${reference.serializedFile}:${reference.pathId}`)
      : pointer.m_FileID === 0
        ? this.byKey.get(`${owner}:${pointer.m_PathID}`)
        : this.byPathId.get(String(pointer.m_PathID));
  }
  private configure(mode: Exclude<OurNotesGekisouEffectMode, 0>): void {
    this.mode = mode;
    this.scene = new OurNotesGekisouStageScene(this.source, mode);
    this.emitters.clear();
    this.children.clear();
    this.childTargets.clear();
    this.subLinks.clear();
    this.localShaderNames.clear();
    this.rendererOrders.clear();
    for (const component of this.scene.variant.components) {
      if (component.type !== "MonoBehaviour") continue;
      const data = component.data as Raw;
      const script = data.m_Script?.reference?.name;
      if (
        !data.m_Enabled ||
        !["LiveRendererOrderInLayerSetter", "LiveParticleOrderInLayerSetter", "LiveCanvasOrderInLayerSetter"].includes(
          script,
        )
      )
        continue;
      const target = data._renderer ?? data._particleSystemRenderer ?? data._canvas;
      const bases = this.source.globalSettings.sortingOrderBases as Readonly<Record<string, number>>;
      this.rendererOrders.set(String(target.m_PathID), bases[String(data._orderInLayer)]! + data._offset);
    }
    for (const component of this.scene.variant.components)
      if (component.type === "Shader")
        this.localShaderNames.set(component.pathId, (component.data as Raw).m_ParsedForm.m_Name);
    this.currentState = undefined;
    this.rangeIndex = -1;
    const systems = this.scene.variant.systems;
    for (const system of systems) {
      const sub = system.raw.SubModule;
      if (!sub.enabled) continue;
      const targets: string[] = [];
      for (const binding of sub.subEmitters) {
        if (binding.type !== 0 || binding.properties !== 0 || binding.emitProbability !== 1)
          throw new Error("Unsupported Gekisou sub-emitter inheritance");
        const target = systems.find((value) => value.id === String(binding.emitter.m_PathID))!;
        this.childTargets.add(target.id);
        targets.push(target.id);
      }
      this.subLinks.set(system.id, targets);
    }
    const gravity = this.source.globalSettings.gravity;
    for (const system of systems) {
      if (this.childTargets.has(system.id)) continue;
      this.emitters.set(
        system.id,
        new OurNotesGekisouStageEmitter(system.raw, [gravity.x, gravity.y, gravity.z], this.nextLifecycleSeed),
      );
    }
  }
  private tick(poses: ReadonlyMap<string, OurNotesGekisouStagePose>, delta: number): void {
    const systems = this.scene!.variant.systems,
      gravity = this.source.globalSettings.gravity;
    for (const system of systems) {
      const emitter = this.emitters.get(system.id);
      if (!emitter) continue;
      emitter.tick(poses.get(system.nodeId)!, delta);
      for (const targetId of this.subLinks.get(system.id) ?? []) {
        const target = systems.find((value) => value.id === targetId)!;
        const targetPose = poses.get(target.nodeId)!;
        if (!targetPose.active) continue;
        for (const particle of emitter.particles) {
          const key = `${system.id}:${particle.seed}:${targetId}`;
          if (this.children.has(key)) continue;
          const childPose = { ...targetPose, world: new Float64Array(targetPose.world) };
          const parentPose = poses.get(system.nodeId)!;
          for (let axis = 0; axis < 3; axis++)
            childPose.world[12 + axis] =
              targetPose.world[12 + axis]! + particle.birthPosition[axis]! - parentPose.world[12 + axis]!;
          const childEmitter = new OurNotesGekisouStageEmitter(
            target.raw,
            [gravity.x, gravity.y, gravity.z],
            this.nextLifecycleSeed,
          );
          childEmitter.tick(childPose, 0);
          this.children.set(key, {
            targetId,
            parentId: system.id,
            particle,
            first: true,
            emitter: childEmitter,
            pose: childPose,
          });
        }
      }
    }
    for (const [key, child] of this.children) {
      const parent = systems.find((value) => value.id === child.parentId)!;
      const target = systems.find((value) => value.id === child.targetId)!;
      const parentPose = poses.get(parent.nodeId)!,
        targetPose = poses.get(target.nodeId)!;
      if (!parentPose.active || !targetPose.active) {
        this.children.delete(key);
        continue;
      }
      const alive = child.particle.age < child.particle.lifetime;
      if (alive) {
        const center = gekisouStageParticlePosition(child.particle, parent.raw, parentPose);
        child.pose.world.set(targetPose.world);
        child.pose.worldRotation = targetPose.worldRotation;
        child.pose.scale = targetPose.scale;
        for (let axis = 0; axis < 3; axis++)
          child.pose.world[12 + axis] = targetPose.world[12 + axis]! + center[axis]! - parentPose.world[12 + axis]!;
      }
      child.pose.active = true;
      child.emitter.tick(child.pose, child.first ? Math.min(delta, child.particle.age) : delta);
      child.first = false;
      if (!alive && !child.emitter.particles.length) this.children.delete(key);
    }
  }

  private stateAt(time: number): OurNotesGekisouStageState | undefined {
    return ourNotesGekisouStageState(this.source, this.ranges, time);
  }

  project(input: OurNotesGekisouStageInput, viewport: OurNotesGekisouStageViewport): RenderOverlaySprite[] {
    const mode = input.mode ?? (this.source.defaults.modes.standard as OurNotesGekisouEffectMode);
    const state = input.state ?? this.stateAt(input.timeMs);
    if (mode === 0 || input.lightweightMode || !state) {
      for (const emitter of this.emitters.values()) emitter.reset();
      this.children.clear();
      this.currentState = undefined;
      this.rangeIndex = -1;
      return [];
    }
    if (this.mode !== mode || !this.scene) this.configure(mode);
    const scene = this.scene!;
    if (this.rangeIndex !== state.rangeIndex || input.timeMs < this.simulationMs) {
      this.rangeIndex = state.rangeIndex;
      this.simulationMs = state.startTimeMs - this.source.lifecycle.standbyLeadMs;
      for (const emitter of this.emitters.values()) emitter.reset();
      this.children.clear();
    }
    while (this.simulationMs < input.timeMs) {
      const next = Math.min(input.timeMs, this.simulationMs + 1000 / 60);
      const sampled = this.stateAt(next) ?? state;
      const poses = scene.sample(sampled.phase, sampled.phaseSeconds);
      const delta = (next - this.simulationMs) / 1000;
      this.tick(poses, delta);
      this.simulationMs = next;
    }
    this.currentState = state;
    const poses = scene.sample(state.phase, state.phaseSeconds);
    const result: RenderOverlaySprite[] = [];
    const screenCamera = this.source.cameraProfiles["27"];
    const halfHeight = screenCamera.orthographicSize,
      halfWidth = (halfHeight * viewport.width) / viewport.height;
    this.screenWorldToClip.fill(0);
    this.screenWorldToClip[0] = 1 / halfWidth;
    this.screenWorldToClip[5] = 1 / halfHeight;
    this.screenWorldToClip[10] = 2 / (screenCamera.far - screenCamera.near);
    this.screenWorldToClip[14] = -(screenCamera.far + screenCamera.near) / (screenCamera.far - screenCamera.near);
    this.screenWorldToClip[15] = 1;
    for (const component of scene.variant.components) {
      if (component.type !== "SpriteRenderer") continue;
      const renderer = component.data as Raw,
        pose = poses.get(String(renderer.m_GameObject.m_PathID))!;
      if (!pose.active || pose.alpha <= 0 || !renderer.m_Enabled) continue;
      const sprite = this.resource((pose.sprite ?? renderer.m_Sprite) as Raw, scene.variant.owner);
      if (!sprite) throw new Error("Gekisou animated Sprite was not preloaded");
      const texture = this.resource(sprite.raw.m_RD.texture, sprite.key.split(":")[0]!);
      if (!texture) throw new Error("Gekisou Sprite texture was not preloaded");
      let shape = this.spriteShapes.get(sprite.key);
      if (!shape) {
        shape = parseNativeIntroSprite({ type: "Sprite", data: sprite.raw }, texture.raw.m_Width, texture.raw.m_Height);
        this.spriteShapes.set(sprite.key, shape);
      }
      const material = this.resource(renderer.m_Materials[0], scene.variant.owner);
      result.push(
        this.draw(
          `sprite:${component.pathId}`,
          this.textureKey(texture),
          { positions: shape.positions, uv: shape.uv, indices: shape.indices },
          pose.world,
          [renderer.m_Color.r, renderer.m_Color.g, renderer.m_Color.b, pose.alpha],
          pose.layer,
          this.rendererOrders.get(component.pathId) ?? renderer.m_SortingOrder,
          viewport,
          material,
          renderer.m_FlipX,
          renderer.m_FlipY,
        ),
      );
    }
    for (const system of scene.variant.systems) {
      const pose = poses.get(system.nodeId)!;
      const instances = this.childTargets.has(system.id)
        ? [...this.children.values()].filter((child) => child.targetId === system.id)
        : [{ emitter: this.emitters.get(system.id)!, pose }];
      if (!pose.active || !instances.some(({ emitter }) => emitter.particles.length)) continue;
      const renderer = system.renderers[0]!.data as Raw;
      if (!renderer.m_Enabled || !renderer.m_Materials.length) continue;
      const material = this.resource(renderer.m_Materials[0], scene.variant.owner);
      if (!material) throw new Error("Gekisou particle material was not preloaded");
      const binding = material.properties.textures._MainTex;
      const texture = this.byPathId.get(String(binding.textureId));
      if (!texture) throw new Error("Gekisou particle texture was not preloaded");
      const mesh =
        renderer.m_RenderMode === 4
          ? this.resource(renderer.m_Mesh, scene.variant.owner)?.mesh
          : this.resources.find((value) => value.engineBuiltin && value.name === "Quad")?.mesh;
      if (!mesh) throw new Error("Gekisou original particle mesh missing");
      const positions: number[] = [],
        uv: number[] = [],
        triangles: number[] = [],
        colors: number[] = [];
      const count = mesh.positions.length / 3;
      if (renderer.m_RenderAlignment !== 2) throw new Error("Unsupported Gekisou particle alignment");
      for (const instance of instances) {
        const emitter = instance.emitter;
        const frame = gekisouStageParticleFrame(instance.pose, emitter.raw.scalingMode);
        const camera = this.source.cameraProfiles[pose.layer as 25 | 27 | 29];
        for (const particle of emitter.particles) {
          const appearance = emitter.appearance(particle);
          const positionFrame = emitter.raw.moveWithTransform === 1 ? particle.bornWorld : frame;
          const origin = transformGekisouStagePoint(positionFrame, particle.x, particle.y, particle.z);
          for (let axis = 0; axis < 3; axis++) origin[axis]! += particle.gravityPosition[axis]!;
          if (renderer.m_RenderMode !== 4) {
            const projection = pose.layer === 27 ? this.screenWorldToClip : viewport.worldToClip;
            const w =
              projection[3]! * origin[0] + projection[7]! * origin[1] + projection[11]! * origin[2] + projection[15]!;
            const yScale = Math.hypot(projection[1]!, projection[5]!, projection[9]!);
            const span = (2 * (camera.orthographic ? 1 : w)) / yScale;
            const diameter = Math.max(
              Math.abs(appearance.size[0]) * Math.hypot(frame[0]!, frame[1]!, frame[2]!),
              Math.abs(appearance.size[1]) * Math.hypot(frame[4]!, frame[5]!, frame[6]!),
            );
            if (span > 0 && diameter > 0) {
              const limit = Math.max(
                renderer.m_MinParticleSize * span,
                Math.min(renderer.m_MaxParticleSize * span, diameter),
              );
              for (let axis = 0; axis < 3; axis++) appearance.size[axis]! *= limit / diameter;
            }
          }
          const base = positions.length / 3,
            rotation = particle.rotationFrame,
            pivot = renderer.m_Pivot;
          for (let vertex = 0; vertex < count; vertex++) {
            const x = (mesh.positions[vertex * 3] + pivot.x) * appearance.size[0];
            const y = (mesh.positions[vertex * 3 + 1] + pivot.y) * appearance.size[1];
            const z = (mesh.positions[vertex * 3 + 2] + pivot.z) * appearance.size[2];
            const px = rotation[0]! * x + rotation[4]! * y + rotation[8]! * z;
            const py = rotation[1]! * x + rotation[5]! * y + rotation[9]! * z;
            const pz = rotation[2]! * x + rotation[6]! * y + rotation[10]! * z;
            for (let axis = 0; axis < 3; axis++)
              positions.push(origin[axis]! + frame[axis]! * px + frame[4 + axis]! * py + frame[8 + axis]! * pz);
            uv.push(mesh.uvs[vertex * 2], mesh.uvs[vertex * 2 + 1]);
            colors.push(...appearance.color);
          }
          triangles.push(...mesh.indices.map((value: number) => value + base));
        }
      }
      result.push(
        this.draw(
          `particle:${system.id}`,
          this.textureKey(texture),
          { positions, uv, indices: triangles },
          identity,
          [1, 1, 1, 1],
          pose.layer,
          this.rendererOrders.get(system.renderers[0]!.pathId) ?? renderer.m_SortingOrder,
          viewport,
          material,
          false,
          false,
          colors,
        ),
      );
    }
    return result;
  }

  private draw(
    id: string,
    textureKey: string,
    shape: Shape,
    world: ArrayLike<number>,
    tint: readonly number[],
    layer: number,
    sortingOrder: number,
    viewport: OurNotesGekisouStageViewport,
    material?: Raw,
    flipX = false,
    flipY = false,
    colors?: readonly number[],
  ): RenderOverlaySprite {
    const key = `gekisou-stage:${id}`,
      count = shape.positions.length / 3;
    let vertices = this.buffers.get(key);
    if (!vertices || vertices.length < count * 10) {
      vertices = new Float32Array(2 ** Math.ceil(Math.log2(count)) * 10);
      this.buffers.set(key, vertices);
    }
    vertices = vertices.subarray(0, count * 10);
    let indices = this.indices.get(key);
    if (!indices || indices.length < shape.indices.length) {
      indices = new Uint16Array(2 ** Math.ceil(Math.log2(shape.indices.length)));
      this.indices.set(key, indices);
    }
    indices.set(shape.indices);
    indices = indices.subarray(0, shape.indices.length);
    const transform = multiply(layer === 27 ? this.screenWorldToClip : viewport.worldToClip, world);
    for (let vertex = 0; vertex < count; vertex++) {
      const x = shape.positions[vertex * 3]! * (flipX ? -1 : 1),
        y = shape.positions[vertex * 3 + 1]! * (flipY ? -1 : 1),
        z = shape.positions[vertex * 3 + 2]!;
      const offset = vertex * 10;
      for (let row = 0; row < 4; row++)
        vertices[offset + row] =
          transform[row]! * x + transform[4 + row]! * y + transform[8 + row]! * z + transform[12 + row]!;
      vertices[offset + 4] = shape.uv[vertex * 2]!;
      vertices[offset + 5] = 1 - shape.uv[vertex * 2 + 1]!;
      for (let channel = 0; channel < 4; channel++)
        vertices[offset + 6 + channel] = colors?.[vertex * 4 + channel] ?? tint[channel]!;
    }
    const properties = material?.properties;
    const shader = material?.raw?.m_Shader;
    const shaderName = shader?.reference?.name ?? this.localShaderNames.get(String(shader?.m_PathID));
    const hdr = shaderName === "Custom/Mobile/MobileAddHdrColor";
    const ordinary = shaderName === "Universal Render Pipeline/2D/Sprite-Unlit-Default";
    const value = hdr ? properties.colors._TintColor : properties?.colors?._Color;
    const rendererColor = properties?.colors?._RendererColor;
    const tintValue = value ? [value.r, value.g, value.b, value.a] : [1, 1, 1, 1];
    if (ordinary && rendererColor)
      for (let channel = 0; channel < 4; channel++)
        tintValue[channel]! *= [rendererColor.r, rendererColor.g, rendererColor.b, rendererColor.a][channel]!;
    const st = properties?.textures?._MainTex;
    return {
      id: key,
      textureKey,
      vertices,
      indices,
      sortingOrder,
      pass: layer === 27 ? "underlay" : layer === 29 ? "effects" : "game",
      blend: hdr ? "source-alpha-additive" : "alpha",
      ...(hdr || ordinary
        ? {
            material: {
              shader: hdr ? ("mobile-add-hdr" as const) : ("texture-tint" as const),
              tint: tintValue as [number, number, number, number],
              textureTransform: [st.scale.x, st.scale.y, st.offset.x, 1 - st.scale.y - st.offset.y] as const,
            },
          }
        : {}),
    };
  }

  get diagnostics(): { rangeIndex: number; phase?: string; particleCount: number; activeSystems: number } {
    const counts = [...this.emitters.values(), ...[...this.children.values()].map((child) => child.emitter)].map(
      (emitter) => emitter.particles.length,
    );
    return {
      rangeIndex: this.rangeIndex,
      ...(this.currentState ? { phase: this.currentState.phase } : {}),
      particleCount: counts.reduce((a, b) => a + b, 0),
      activeSystems: counts.filter(Boolean).length,
    };
  }
}
