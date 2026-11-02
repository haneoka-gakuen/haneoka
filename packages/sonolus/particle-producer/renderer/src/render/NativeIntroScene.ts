import { Matrix4, Quaternion, Vector3 } from "three";
import { unityStringHash } from "@haneoka/cassiopeia-plugin-our-notes";
import type { NativeIntroBindingSink } from "./NativeIntroTimeline";

interface IntroTransform {
  id: string;
  gameObjectId: string;
  parentId: string;
  name: string;
  active: boolean;
  position: Vector3;
  rotation: Quaternion;
  scale: Vector3;
  local: Matrix4;
  world: Matrix4;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native intro scene record");
  return value as Record<string, unknown>;
};
const float = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid native intro transform number");
  return value;
};
const pointer = (value: unknown): string => {
  const data = record(value);
  if (data.m_FileID !== 0) throw new Error("Native intro requires a resolved local transform pointer");
  if (typeof data.m_PathID !== "string" || !/^-?\d+$/u.test(data.m_PathID))
    throw new Error("Native intro PPtr must retain its decimal 64-bit identity");
  return data.m_PathID;
};

/** Original prefab transform hierarchy and animated local pose, without a Unity runtime. */
export interface NativeIntroMissingBinding { pathHash: number; typeId: number; attribute: number; component: number }

export class NativeIntroScene implements NativeIntroBindingSink {
  private readonly nodes = new Map<string, IntroTransform>();
  private readonly paths = new Map<number, IntroTransform>();
  private readonly missingBindings = new Map<string, NativeIntroMissingBinding>();
  private readonly ancestry = new Set<string>();
  private readonly resolved = new Set<string>();
  private readonly activeAttribute = unityStringHash("m_IsActive");

  constructor(
    values: ReadonlyArray<unknown>,
    readonly target: string,
    animatorTransformId: string,
    private readonly onOtherBinding: (transformId: string, typeId: number, attribute: number, component: number, value: number) => void,
  ) {
    const objects = new Map<string, Record<string, unknown>>();
    for (const value of values) {
      const object = record(value);
      if (object.type !== "GameObject") continue;
      if (typeof object.pathId !== "string") throw new Error("Native intro GameObject identity missing");
      objects.set(object.pathId, record(object.data));
    }
    for (const value of values) {
      const object = record(value);
      if (object.type !== "Transform") continue;
      const data = record(object.data), id = object.pathId;
      if (typeof id !== "string" || this.nodes.has(id)) throw new Error("Native intro transform identity invalid");
      const gameObjectId = pointer(data.m_GameObject), gameObject = objects.get(gameObjectId);
      if (!gameObject || typeof gameObject.m_Name !== "string") throw new Error("Native intro transform GameObject unresolved");
      const position = record(data.m_LocalPosition), rotation = record(data.m_LocalRotation), scale = record(data.m_LocalScale);
      this.nodes.set(id, {
        id, gameObjectId, parentId: pointer(data.m_Father), name: gameObject.m_Name,
        active: gameObject.m_IsActive === true || gameObject.m_IsActive === 1,
        position: new Vector3(float(position.x), float(position.y), float(position.z)),
        rotation: new Quaternion(float(rotation.x), float(rotation.y), float(rotation.z), float(rotation.w)),
        scale: new Vector3(float(scale.x), float(scale.y), float(scale.z)),
        local: new Matrix4(), world: new Matrix4(),
      });
    }
    if (!this.nodes.has(animatorTransformId)) throw new Error("Native intro animator root transform missing");
    for (const node of this.nodes.values()) {
      const path: string[] = [], seen = new Set<string>();
      let current: IntroTransform | undefined = node;
      while (current && current.id !== animatorTransformId) {
        if (seen.has(current.id)) throw new Error("Native intro transform cycle");
        seen.add(current.id);
        path.push(current.name);
        current = this.nodes.get(current.parentId);
      }
      if (!current) continue;
      const hash = path.length ? unityStringHash(path.reverse().join("/")) : 0;
      if (this.paths.has(hash)) throw new Error("Native intro animation path collision");
      this.paths.set(hash, node);
    }
    this.updateWorldMatrices();
  }

  set(target: string, pathHash: number, attribute: number, component: number, value: number, typeId: number): void {
    if (target !== this.target) throw new Error("Native intro animation target differs from bound animator");
    if (!Number.isFinite(value)) throw new Error("Non-finite native intro animation value");
    const hash = pathHash >>> 0, node = this.paths.get(hash);
    if (!node) {
      // A valid Animator can carry an authored curve whose object was removed from its prefab.
      // Unity's absent accessor consumes no write. Source/target and existing-property failures stay strict.
      const key = `${hash}:${typeId}:${attribute}:${component}`;
      this.missingBindings.set(key, { pathHash: hash, typeId, attribute, component });
      return;
    }
    if (typeId === 4 && attribute === 1 && component < 3) node.position.setComponent(component, value);
    else if (typeId === 4 && attribute === 3 && component < 3) node.scale.setComponent(component, value);
    else if (typeId === 4 && attribute === 2 && component < 4) {
      if (component === 0) node.rotation.x = value;
      else if (component === 1) node.rotation.y = value;
      else if (component === 2) node.rotation.z = value;
      else node.rotation.w = value;
    } else if (typeId === 1 && attribute === this.activeAttribute) node.active = value >= 0.5;
    else this.onOtherBinding(node.id, typeId, attribute, component, value);
  }

  get bindingDiagnostics(): ReadonlyArray<NativeIntroMissingBinding> { return [...this.missingBindings.values()]; }

  updateWorldMatrices(): void {
    this.resolved.clear();
    for (const node of this.nodes.values()) this.updateNode(node);
  }
  private updateNode(node: IntroTransform): void {
    if (this.resolved.has(node.id)) return;
    if (this.ancestry.has(node.id)) throw new Error("Native intro transform cycle");
    this.ancestry.add(node.id);
    node.rotation.normalize();
    node.local.compose(node.position, node.rotation, node.scale);
    if (node.parentId === "0") node.world.copy(node.local);
    else {
      const parent = this.nodes.get(node.parentId);
      if (!parent) throw new Error("Native intro parent transform unresolved");
      this.updateNode(parent);
      node.world.multiplyMatrices(parent.world, node.local);
    }
    this.ancestry.delete(node.id);
    this.resolved.add(node.id);
  }
  boneWorldMatrix(transformId: string): ReadonlyArray<number> {
    const node = this.nodes.get(transformId);
    if (!node) throw new Error("Native intro bone transform missing");
    return node.world.elements;
  }
  transformForGameObject(gameObjectId: string): string {
    for (const node of this.nodes.values()) if (node.gameObjectId === gameObjectId) return node.id;
    throw new Error("Original native intro GameObject has no transform");
  }
  isDescendantOf(transformId: string, ancestorTransformId: string): boolean {
    let node = this.nodes.get(transformId);
    if (!node || !this.nodes.has(ancestorTransformId)) throw new Error("Original native intro ancestry endpoint missing");
    while (node) {
      if (node.id === ancestorTransformId) return true;
      if (node.parentId === "0") return false;
      node = this.nodes.get(node.parentId);
    }
    throw new Error("Original native intro ancestry missing");
  }
  isActive(transformId: string): boolean {
    let node = this.nodes.get(transformId);
    if (!node) throw new Error("Native intro active transform missing");
    while (node) {
      if (!node.active) return false;
      if (node.parentId === "0") return true;
      node = this.nodes.get(node.parentId);
    }
    throw new Error("Native intro active parent unresolved");
  }
}
