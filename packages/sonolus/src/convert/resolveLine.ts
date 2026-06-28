import { NoteOperateType } from "../shared/enums.js";
import type { SsRawNote } from "./types.js";

export interface NoteCoincidenceMatch {
  type: "tap" | "flick" | "trace";
  direction: SsRawNote["dir"];
  critical: boolean;
  visible: boolean;
}

export interface NoteCoincidence {
  has(tick: number, pos: number, size: number): NoteCoincidenceMatch | undefined;
}

function isVisible(node: SsRawNote): boolean {
  return node.visible !== false;
}
function isAuto(node: SsRawNote): boolean {
  return node.pos === "auto";
}
function subType(node: SsRawNote): "tap" | "flick" | "trace" {
  return node.type === "flick" ? "flick" : node.type === "trace" ? "trace" : "tap";
}

export function resolveLineOperateType(
  node: SsRawNote,
  index: number,
  count: number,
  kind: "long" | "guide",
  coincidence?: NoteCoincidence,
): NoteOperateType {
  const begin = index === 0;
  const end = index === count - 1;
  const vis = isVisible(node);
  const auto = isAuto(node);
  const t = subType(node);

  if (kind === "long") {
    if (begin) {
      if (!vis) return NoteOperateType.HiddenSlideBegin;
      return t === "flick"
        ? NoteOperateType.SlideBeginFlick
        : t === "trace"
          ? NoteOperateType.SlideBeginTrace
          : NoteOperateType.SlideBegin;
    }
    if (end) {
      if (!vis) return NoteOperateType.HiddenSlideEnd;
      return t === "flick"
        ? NoteOperateType.SlideEndFlick
        : t === "trace"
          ? NoteOperateType.SlideEndTrace
          : NoteOperateType.SlideEnd;
    }
    // MIDDLE
    if (auto) return NoteOperateType.SlideConnection;
    if (!vis) return NoteOperateType.Hidden;
    return t === "trace" ? NoteOperateType.SlideConnectionTrace : NoteOperateType.SlideConnection;
  }

  // guide
  if (begin) {
    const coincidentType =
      !auto && typeof node.pos === "number" && typeof node.t === "number"
        ? coincidence?.has(node.t, node.pos, node.size ?? 0)?.type
        : undefined;
    if (coincidentType === "tap") return NoteOperateType.GuideBeginNormal;
    if (coincidentType === "flick") return NoteOperateType.GuideBeginFlick;
    if (coincidentType === "trace") return NoteOperateType.GuideBeginTrace;
    return NoteOperateType.GuideBegin;
  }
  if (end) {
    return vis && t === "trace" ? NoteOperateType.GuideEndTrace : NoteOperateType.GuideEnd;
  }
  // MIDDLE
  return vis || auto ? NoteOperateType.SlideConnectionTrace : NoteOperateType.Hidden;
}
