import { TickConverter, PPQ, type BarPosition } from "../shared/timing.js";
import { laneToX, sizeToWidth } from "../shared/lane.js";
import { NoteDirection, NoteOperateType, NoteLineEaseType } from "../shared/enums.js";
import type { SsRoot, SsRawNote, InternalChart, ResolvedNote, NoteLine, BpmChange } from "./types.js";
import { mapEase, mapDirection, resolveSingleOperateType, resolveJudgementType, isJudged } from "./resolveNote.js";
import { resolveLineOperateType, type NoteCoincidence, type NoteCoincidenceMatch } from "./resolveLine.js";

function buildGuideCoincidence(notes: SsRawNote[]): {
  coincidence: NoteCoincidence;
  consumedSingles: Set<SsRawNote>;
} {
  // Records concrete guide-start overlap keys, then consumes the first
  // matching standalone Tap/Flick/Trace in source order. The consumed note
  // selects GuideBeginNormal/Flick/Trace, so it must not also become a flat
  // note.
  const guideStartKeys = new Set<string>();
  for (const note of notes) {
    if (note.type !== "guide") continue;
    const first = note.node?.[0];
    if (!first || typeof first.t !== "number" || typeof first.pos !== "number") continue;
    guideStartKeys.add(nativeOverlapKey(first.t, first.pos, first.size ?? 0));
  }

  const map = new Map<string, NoteCoincidenceMatch>();
  const consumedSingles = new Set<SsRawNote>();
  for (const nd of notes) {
    if (nd.type === "long" || nd.type === "guide") continue;
    if (typeof nd.t !== "number" || typeof nd.pos !== "number") continue;
    const key = nativeOverlapKey(nd.t, nd.pos, nd.size ?? 0);
    if (!guideStartKeys.has(key) || map.has(key)) continue;
    const t = nd.type === "flick" ? "flick" : nd.type === "trace" ? "trace" : "tap";
    map.set(key, {
      type: t,
      direction: nd.dir,
      critical: nd.crit === true,
      visible: nd.visible !== false,
    });
    consumedSingles.add(nd);
  }
  return {
    coincidence: { has: (t, p, s) => map.get(nativeOverlapKey(t, p, s)) },
    consumedSingles,
  };
}

type LineShape = Pick<ResolvedNote, "pos" | "size">;

function rawEasePair(rawEase: SsRawNote["ease"] | undefined): [string | undefined, string | undefined] {
  if (Array.isArray(rawEase)) return [rawEase[0], rawEase[1]];
  return [rawEase, rawEase];
}

function easePairOf(
  node: SsRawNote,
  fallbackEase: SsRawNote["ease"] | undefined,
): [NoteLineEaseType, NoteLineEaseType] {
  const [easeL, easeR] = rawEasePair(node.ease ?? fallbackEase);
  return [mapEase(easeL), mapEase(easeR)];
}

function applyOriginalLineEase(ease: NoteLineEaseType | null | undefined, s: number): number {
  // Line ease: Linear -> s, enum EaseIn(1) -> (2 - s) * s, enum EaseOut(2)
  // -> s * s.
  if (ease === NoteLineEaseType.EaseIn) return (2 - s) * s;
  if (ease === NoteLineEaseType.EaseOut) return s * s;
  return s;
}

function rawLineShape(node: SsRawNote): LineShape | null {
  if (typeof node.pos !== "number") return null;
  return { pos: node.pos, size: node.size ?? 0 };
}

function isAnchorNode(node: SsRawNote): boolean {
  return typeof node.pos === "number";
}

function interpolateAutoShapes(nodes: SsRawNote[], fallbackEase: SsRawNote["ease"] | undefined): LineShape[] {
  // BuildLongOrGuideNoteInfos interpolates PosAuto by easing left and right edges
  // independently, then derives width as right - left.
  const out = nodes.map((node) => rawLineShape(node) ?? { pos: NaN, size: NaN });

  for (let i = 0; i < out.length; i++) {
    if (isAnchorNode(nodes[i])) continue;

    let a = i - 1;
    while (a >= 0 && !isAnchorNode(nodes[a])) a--;
    let b = i + 1;
    while (b < out.length && !isAnchorNode(nodes[b])) b++;

    if (a < 0 && b >= out.length) {
      out[i] = { pos: 0, size: nodes[i].size ?? 0 };
      continue;
    }
    if (a < 0) {
      out[i] = { pos: out[b].pos, size: nodes[i].size ?? out[b].size };
      continue;
    }
    if (b >= out.length) {
      out[i] = { pos: out[a].pos, size: nodes[i].size ?? out[a].size };
      continue;
    }

    const prev = out[a];
    const next = out[b];
    const ta = nodes[a].t ?? nodes[i].t ?? 0;
    const tb = nodes[b].t ?? nodes[i].t ?? 0;
    const ti = nodes[i].t ?? 0;
    const s = tb === ta ? 0 : (ti - ta) / (tb - ta);
    const [easeL, easeR] = easePairOf(nodes[a], fallbackEase);
    const leftS = applyOriginalLineEase(easeL, s);
    const rightS = applyOriginalLineEase(easeR, s);
    const prevRight = prev.pos + prev.size;
    const nextRight = next.pos + next.size;
    const pos = prev.pos + (next.pos - prev.pos) * leftS;
    const right = prevRight + (nextRight - prevRight) * rightS;
    out[i] = { pos, size: right - pos };
  }

  return out;
}

function roundToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function nativeOverlapKey(tick: number, pos: number, size: number): string {
  return `${tick}:${roundToEven(pos)}:${roundToEven(size)}`;
}

function isMergeableEndpoint(operation: NoteOperateType): boolean {
  return (
    operation === NoteOperateType.SlideBegin ||
    operation === NoteOperateType.SlideEnd ||
    operation === NoteOperateType.SlideBeginFlick ||
    operation === NoteOperateType.SlideEndFlick ||
    operation === NoteOperateType.SlideBeginTrace ||
    operation === NoteOperateType.SlideEndTrace ||
    operation === NoteOperateType.HiddenSlideBegin ||
    operation === NoteOperateType.HiddenSlideEnd ||
    (operation >= NoteOperateType.GuideBegin && operation <= NoteOperateType.GuideEndTrace)
  );
}

function endpointMergeKey(
  tick: number,
  shape: LineShape,
  operation: NoteOperateType,
  critical: boolean,
  direction: NoteDirection,
  easeL: NoteLineEaseType,
  easeR: NoteLineEaseType,
): string {
  return `${nativeOverlapKey(tick, shape.pos, shape.size)}:${operation}:${roundToEven(shape.size)}:${Number(critical)}:${direction}:${easeL}:${easeR}`;
}

function sameBarPosition(a: BarPosition, b: BarPosition): boolean {
  // Equality uses Mathf.Approximately semantics on float-backed BarProgress
  // values.
  if (a.bar !== b.bar) return false;
  const left = Math.fround(a.progress);
  const right = Math.fround(b.progress);
  const tolerance = Math.max(Math.fround(1e-6) * Math.max(Math.abs(left), Math.abs(right)), 1e-45 * 8);
  return Math.abs(left - right) < tolerance;
}

function lineSortKey(op: NoteOperateType): number {
  switch (op) {
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideBeginTrace:
    case NoteOperateType.HiddenSlideBegin:
    case NoteOperateType.GuideBegin:
    case NoteOperateType.GuideBeginNormal:
    case NoteOperateType.GuideBeginFlick:
    case NoteOperateType.GuideBeginTrace:
      return 0;
    case NoteOperateType.SlideEnd:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.SlideEndTrace:
    case NoteOperateType.HiddenSlideEnd:
    case NoteOperateType.GuideEnd:
    case NoteOperateType.GuideEndTrace:
      return 2;
    default:
      return 1;
  }
}

function interpolateLineNote(notes: ResolvedNote[], timeMs: number): LineShape {
  let head = notes[0];
  let tail = notes[notes.length - 1];
  for (let i = 1; i < notes.length; i++) {
    if (notes[i].timeMs < timeMs) continue;
    head = notes[i - 1] ?? notes[i];
    tail = notes[i];
    break;
  }

  const span = tail.timeMs - head.timeMs;
  const s = span <= 0 ? 0 : Math.min(1, Math.max(0, (timeMs - head.timeMs) / span));
  const leftS = applyOriginalLineEase(head.easeL, s);
  const rightS = applyOriginalLineEase(head.easeR, s);
  const headRight = head.pos + head.size;
  const tailRight = tail.pos + tail.size;
  const pos = head.pos + (tail.pos - head.pos) * leftS;
  const right = headRight + (tailRight - headRight) * rightS;
  return {
    pos,
    size: right - pos,
  };
}

export function buildChart(root: SsRoot): InternalChart {
  const conv = new TickConverter(root.bpm, root.sig);
  const bpmChanges: BpmChange[] = (root.bpm.length ? root.bpm : [{ t: 0, bpm: 120 }]).map((b) => ({
    tick: b.t,
    beat: b.t / PPQ,
    timeMs: conv.tickToTimeMs(b.t),
    bpm: b.bpm,
  }));
  const { coincidence, consumedSingles } = buildGuideCoincidence(root.notes);

  const notes: ResolvedNote[] = [];
  const lines: NoteLine[] = [];
  let id = 0;

  const push = (
    tick: number,
    pos: number,
    size: number,
    op: NoteOperateType,
    critical: boolean,
    dir: NoteDirection,
    lineId: number | null,
    indexInLine: number | null,
    easeL: NoteLineEaseType | null,
    easeR: NoteLineEaseType | null,
    visible: boolean,
    timing?: { timeMs?: number; beat?: number; id?: number; slideAlong?: boolean },
  ): ResolvedNote => {
    const noteId = timing?.id ?? id++;
    if (noteId >= id) id = noteId + 1;
    const timeMs = timing?.timeMs ?? conv.tickToTimeMs(tick);
    const beat = timing?.beat ?? tick / PPQ;
    const note: ResolvedNote = {
      id: noteId,
      tick,
      timeMs,
      beat,
      pos,
      size,
      laneX: laneToX(pos, size),
      width: sizeToWidth(size),
      operateType: op,
      judgementType: resolveJudgementType(op, critical),
      direction: dir,
      critical,
      judged: isJudged(op),
      visible,
      lineIds: lineId === null ? [] : [lineId],
      slideAlong: timing?.slideAlong === true,
      indexInLine,
      easeL,
      easeR,
    };
    notes.push(note);
    return note;
  };

  for (const nd of root.notes) {
    if (nd.type === "long" || nd.type === "guide") continue;
    if (consumedSingles.has(nd)) continue;
    const op = resolveSingleOperateType(nd.type);
    const pos = typeof nd.pos === "number" ? nd.pos : 0;
    const size = nd.size ?? 0;
    push(nd.t ?? 0, pos, size, op, nd.crit === true, mapDirection(nd.dir), null, null, null, null, true);
  }

  const mergedEndpoints = new Map<string, ResolvedNote>();
  for (const nd of root.notes) {
    if (nd.type !== "long" && nd.type !== "guide") continue;
    const kind = nd.type;
    const nodes = (nd.node ?? [])
      .map((node, order) => ({ node, order }))
      .sort((a, b) => (a.node.t ?? 0) - (b.node.t ?? 0) || a.order - b.order)
      .map(({ node }) => node);
    const shapes = interpolateAutoShapes(nodes, nd.ease);
    const lineId = lines.length;
    const noteIds: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const op = resolveLineOperateType(node, i, nodes.length, kind, coincidence);
      const [easeL, easeR] = easePairOf(node, nd.ease);
      const coincident =
        kind === "guide" && i === 0 && typeof node.t === "number" && typeof node.pos === "number"
          ? coincidence.has(node.t, node.pos, node.size ?? 0)
          : undefined;
      // GuideBeginNormal/Flick/Trace consumes a coincident standalone note.
      // Preserve that note's judgment-facing metadata on the resolved node;
      // the guide node itself only supplies connector topology.
      const critical = coincident?.critical ?? node.crit === true;
      const direction = mapDirection(coincident ? coincident.direction : node.dir);
      const visible = coincident?.visible ?? node.visible !== false;
      const shape = shapes[i];
      let resolved: ResolvedNote | undefined;

      const mergeKey = endpointMergeKey(node.t ?? 0, shape, op, critical, direction, easeL, easeR);
      if (!resolved && isMergeableEndpoint(op)) resolved = mergedEndpoints.get(mergeKey);
      if (resolved) {
        if (!resolved.lineIds.includes(lineId)) resolved.lineIds.push(lineId);
      } else {
        resolved = push(node.t ?? 0, shape.pos, shape.size, op, critical, direction, lineId, i, easeL, easeR, visible, {
          slideAlong: node.pos === "auto",
        });
      }
      if (isMergeableEndpoint(op) && !mergedEndpoints.has(mergeKey)) mergedEndpoints.set(mergeKey, resolved);
      noteIds.push(resolved.id);
    }
    lines.push({ id: lineId, kind, noteIds });
  }

  const byId = new Map<number, ResolvedNote>();
  const remember = () => {
    byId.clear();
    for (const n of notes) byId.set(n.id, n);
  };
  remember();

  const viewNotesByBegin = new Map<number, Map<number, ResolvedNote>>();
  const comboPathByEndpoints = new Map<
    string,
    {
      line: NoteLine;
      authored: ResolvedNote[];
      begin: ResolvedNote;
      end: ResolvedNote;
    }
  >();
  for (const line of lines) {
    if (line.kind !== "long") continue;
    const authored = line.noteIds
      .map((noteId) => byId.get(noteId)!)
      .filter(Boolean)
      .sort((a, b) => a.timeMs - b.timeMs || (a.indexInLine ?? 0) - (b.indexInLine ?? 0));
    if (authored.length < 2) continue;
    const begin = authored[0];
    const end = authored[authored.length - 1];
    const viewNotes = viewNotesByBegin.get(begin.id) ?? new Map<number, ResolvedNote>();
    for (const note of authored.slice(1)) viewNotes.set(note.id, note);
    viewNotesByBegin.set(begin.id, viewNotes);
    const key = `${begin.id}:${end.id}`;
    if (!comboPathByEndpoints.has(key)) comboPathByEndpoints.set(key, { line, authored, begin, end });
  }

  const comboPaths = [...comboPathByEndpoints.values()].sort(
    (a, b) => a.end.timeMs - b.end.timeMs || a.end.tick - b.end.tick || a.line.id - b.line.id,
  );
  for (const { line, authored, begin, end } of comboPaths) {
    if (end.timeMs <= begin.timeMs) continue;
    const runtimeView = [...(viewNotesByBegin.get(begin.id)?.values() ?? [])]
      .filter((note) => note.id !== end.id && note.timeMs < end.timeMs && note.judged)
      .sort((left, right) => {
        const a = conv.tickToBarPosition(left.tick);
        const b = conv.tickToBarPosition(right.tick);
        return a.bar - b.bar || a.progress - b.progress || left.id - right.id;
      });

    // Combo generation filters the view by the judgement-operation set and
    // additionally removes PosAuto (`SlideAlong`) nodes from combo-generation
    // boundaries.
    const authoredJudgePositions = [...runtimeView, end]
      .filter((n) => n.judged)
      .map((n) => conv.tickToBarPosition(n.tick));
    const visibleMidpoints = runtimeView.filter((n) => !n.slideAlong);
    const boundaries = [begin, ...visibleMidpoints, end];
    const comboPositions: { timeMs: number; bar: BarPosition }[] = [];

    for (let i = 0; i < boundaries.length - 1; i++) {
      const segStart = boundaries[i];
      const segEnd = boundaries[i + 1];
      if (segEnd.timeMs <= segStart.timeMs) continue;

      let currentMs = segStart.timeMs;
      while (true) {
        currentMs += 30000 / conv.bpmAtTimeMs(Math.trunc(currentMs));
        const timeMs = roundToEven(currentMs);
        if (timeMs >= segEnd.timeMs) break;
        comboPositions.push({ timeMs, bar: conv.timeMsToBarPosition(timeMs) });
      }
    }

    const boundaryTimes = visibleMidpoints.map((n) => n.timeMs);
    for (let i = 0; i < comboPositions.length; i++) {
      const combo = comboPositions[i];
      const sixteenthMs = 15000 / conv.bpmAtTimeMs(combo.timeMs);
      const sameAsAuthored = authoredJudgePositions.some((pos) => sameBarPosition(pos, combo.bar));
      const tooCloseToMidpoint = boundaryTimes.some(
        (timeMs) => timeMs - sixteenthMs <= combo.timeMs && combo.timeMs < timeMs,
      );
      const tooCloseToBegin = i === 0 && combo.timeMs - begin.timeMs < sixteenthMs;
      const tooCloseToEnd = i === comboPositions.length - 1 && end.timeMs - combo.timeMs < sixteenthMs;
      const op =
        sameAsAuthored || tooCloseToMidpoint || tooCloseToBegin || tooCloseToEnd
          ? NoteOperateType.ComboSkip
          : NoteOperateType.Combo;
      const shape = interpolateLineNote(authored, combo.timeMs);
      const tick = conv.timeMsToTick(combo.timeMs);
      const rn = push(tick, shape.pos, shape.size, op, false, NoteDirection.Normal, line.id, null, null, null, false, {
        timeMs: combo.timeMs,
        beat: conv.timeMsToBeat(combo.timeMs),
      });
      line.noteIds.push(rn.id);
      byId.set(rn.id, rn);
    }

    line.noteIds.sort((a, b) => {
      const na = byId.get(a)!;
      const nb = byId.get(b)!;
      return na.beat - nb.beat || lineSortKey(na.operateType) - lineSortKey(nb.operateType) || na.id - nb.id;
    });
  }

  notes.sort((a, b) => a.tick - b.tick || a.id - b.id);
  const durationMs = notes.reduce((m, n) => Math.max(m, n.timeMs), 0);
  return {
    version: root.version,
    bpmChanges,
    notes,
    lines,
    durationMs,
    passthrough: { skill: root.skill, fever: root.fever, sig: root.sig, call: root.call },
  };
}
