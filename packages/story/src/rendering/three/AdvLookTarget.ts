import { Object3D, Vector3 } from "three";
import type { Vec2, Vec3 } from "./StorySceneTypes";

function finite(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/** Look-target offset, mirroring AdvLookTargetCommand.SetLookTargetOverTime. */
export function computeAdvLookTarget(sourceHead: Vec3, targetHead: Vec3): Vec2 {
  return {
    x: clamp((finite(targetHead.x) - finite(sourceHead.x)) * 0.2),
    y: clamp(finite(targetHead.y) - finite(sourceHead.y)),
  };
}

/** Head world position from the anchor's Transform.position, mirroring Live2DCharacter.GetHeadPosition. */
export function computeAdvCharacterHeadWorldPosition(character: Object3D, headAnchor: Vec3): Vec3 {
  character.updateWorldMatrix(true, false);
  const world = character.localToWorld(new Vector3(finite(headAnchor.x), finite(headAnchor.y), -finite(headAnchor.z)));
  return { x: world.x, y: world.y, z: -world.z };
}
