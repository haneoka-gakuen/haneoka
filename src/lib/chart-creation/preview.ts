import {
  ChartSession,
  NoteOperateType,
  NoteJudgementType,
  NoteDirection,
  JudgementAreaOffsetType,
  NoteLineEaseType,
  type ChartDocument,
  type ChartNote,
} from "@haneoka/cassiopeia";
import { MediaClock } from "@haneoka/cassiopeia-host-web";
import { TempoMap } from "../../../packages/chart-editor/src/timing";
import {
  resolveLinePointShape,
  type Project,
  type SingleNote,
  type LinePoint,
} from "../../../packages/chart-editor/src/model";
import { assertValidProject } from "../../../packages/chart-editor/src/validation";

/** Presentation projection: original types/extensions remain in Project; every runtime note is unjudged. */
export function creationChartDocument(project: Project, duration: number): ChartDocument {
  assertValidProject(project);
  const map = new TempoMap(project.tempos, { resolution: project.resolution, audioOffset: project.audioOffset });
  const notes: ChartNote[] = [],
    lines: ChartDocument["lines"] = [];
  const add = (note: SingleNote | LinePoint, lane: number, size: number, lineId?: number, index?: number) => {
    const pos = (lane * 24) / project.laneBasis,
      width = (size * 24) / project.laneBasis;
    const id = notes.length;
    notes.push({
      id,
      tick: note.tick,
      beat: note.tick / project.resolution,
      timeMs: map.tickToSeconds(note.tick) * 1000,
      pos,
      size: width,
      laneX: (pos + width / 2) / 12 - 1,
      width: width / 12,
      operateType:
        note.type === "flick"
          ? NoteOperateType.Flick
          : note.type === "trace"
            ? NoteOperateType.Trace
            : NoteOperateType.Normal,
      judgementType: NoteJudgementType.None,
      judgementAreaOffsetType: JudgementAreaOffsetType.Default,
      direction:
        note.direction === "left"
          ? NoteDirection.Left
          : note.direction === "right"
            ? NoteDirection.Right
            : NoteDirection.Normal,
      critical: note.critical,
      judged: false,
      visible: note.visible,
      lineIds: lineId === undefined ? [] : [lineId],
      slideAlong: note.lane === "auto",
      indexInLine: index ?? null,
      easeL:
        "ease" in note
          ? note.ease.left === "in"
            ? NoteLineEaseType.EaseIn
            : note.ease.left === "out"
              ? NoteLineEaseType.EaseOut
              : NoteLineEaseType.Linear
          : null,
      easeR:
        "ease" in note
          ? note.ease.right === "in"
            ? NoteLineEaseType.EaseIn
            : note.ease.right === "out"
              ? NoteLineEaseType.EaseOut
              : NoteLineEaseType.Linear
          : null,
    });
    return id;
  };
  for (const note of project.singles) add(note, note.lane, note.size);
  project.lines.forEach((line, index) => {
    const noteIds = line.points.map((point, at) => {
      const shape = resolveLinePointShape(line.points, at);
      return add(point, shape.lane, shape.size, index, at);
    });
    lines.push({ id: index, kind: line.kind, critical: line.critical ?? false, noteIds });
  });
  notes.sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);
  return {
    version: 1,
    notes,
    lines,
    durationMs: duration * 1000,
    timeline: { skills: [], fever: [], callChanges: [] },
    bpmChanges: project.tempos.map((t) => ({
      tick: t.tick,
      beat: t.tick / project.resolution,
      bpm: t.bpm,
      timeMs: map.tickToSeconds(t.tick) * 1000,
    })),
    signatureChanges: project.meters.map((t) => ({
      tick: t.tick,
      beat: t.tick / project.resolution,
      numerator: t.numerator,
      denominator: t.denominator,
      timeMs: map.tickToSeconds(t.tick) * 1000,
    })),
    timeScaleChanges: project.timeScales
      .map((t) => ({ timeMs: map.tickToSeconds(t.tick) * 1000, scale: t.scale }))
      .sort((a, b) => a.timeMs - b.timeMs),
  };
}

export interface PreviewColors {
  surface: string;
  primary: string;
  secondary: string;
  outline: string;
  critical: string;
}
export class CreationPreview {
  readonly clock: MediaClock;
  readonly session: ChartSession;
  private url: string;
  private frame = 0;
  private destroyed = false;
  private observer: ResizeObserver;
  private notes: Map<number, ChartNote>;
  private intent = 0;
  private playingIntent = false;
  constructor(
    private canvas: HTMLCanvasElement,
    chart: ChartDocument,
    file: File,
    private colors: PreviewColors,
    private changed: (seconds: number, playing: boolean) => void,
    private error: (error: unknown) => void,
  ) {
    this.url = URL.createObjectURL(file);
    this.clock = new MediaClock(this.url);
    this.session = new ChartSession(chart, { mode: "chart" });
    this.notes = new Map(chart.notes.map((n) => [n.id, n]));
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(canvas);
    for (const name of ["playing", "pause", "ended", "seeked", "waiting", "stalled"] as const)
      this.clock.addEventListener(name, this.render);
    this.clock.addEventListener("error", this.failed);
    document.addEventListener("visibilitychange", this.visibility);
    this.render();
  }
  private failed = () => {
    this.pause();
    this.error(new Error("audio_decode"));
  };
  private visibility = () => {
    if (document.hidden) this.pause();
  };
  async play() {
    const intent = ++this.intent;
    this.playingIntent = true;
    if (this.clock.audio.ended) this.seek(0);
    await this.clock.play();
    if (this.destroyed || !this.playingIntent) {
      this.clock.pause();
      return;
    }
    if (intent !== this.intent) return;
    this.render();
  }
  pause() {
    this.playingIntent = false;
    ++this.intent;
    this.clock.pause();
    this.render();
  }
  seek(seconds: number) {
    this.clock.seek(seconds * 1000);
    this.session.reset(seconds * 1000);
    this.render();
  }
  private scrollTime(timeMs: number): number {
    let result = 0,
      previous = 0,
      scale = 1;
    for (const change of this.session.chart.timeScaleChanges) {
      if (change.timeMs > timeMs) break;
      result += (change.timeMs - previous) * scale;
      previous = change.timeMs;
      scale = change.scale;
    }
    return result + (timeMs - previous) * scale;
  }
  render = () => {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.destroyed) return;
    const width = this.canvas.clientWidth,
      height = this.canvas.clientHeight,
      ratio = Math.min(devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx || !width || !height) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = this.colors.surface;
    ctx.fillRect(0, 0, width, height);
    const now = this.session.updateReusable(this.clock.timeMs).timeMs,
      judgementY = height - 32;
    const y = (time: number) => judgementY - (this.scrollTime(time) - this.scrollTime(now)) * 0.12;
    ctx.strokeStyle = this.colors.outline;
    ctx.lineWidth = 1;
    for (let lane = 0; lane <= 6; lane++) {
      ctx.beginPath();
      ctx.moveTo((width * lane) / 6, 0);
      ctx.lineTo((width * lane) / 6, height);
      ctx.stroke();
    }
    ctx.strokeStyle = this.colors.primary;
    ctx.beginPath();
    ctx.moveTo(0, judgementY);
    ctx.lineTo(width, judgementY);
    ctx.stroke();
    for (const line of this.session.chart.lines) {
      const points = line.noteIds.map((id) => this.notes.get(id)!);
      ctx.globalAlpha = line.kind === "guide" ? 0.25 : 0.45;
      ctx.fillStyle = line.critical ? this.colors.critical : this.colors.secondary;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
          b = points[i];
        if (b.timeMs < now - 200 || y(a.timeMs) < -32) continue;
        const ease = (value: number, progress: number) =>
          value === NoteLineEaseType.EaseIn
            ? progress * progress
            : value === NoteLineEaseType.EaseOut
              ? (2 - progress) * progress
              : progress;
        ctx.beginPath();
        for (let step = 0; step <= 20; step++) {
          const t = step / 20,
            x = ((a.pos + (b.pos - a.pos) * ease(a.easeL ?? 0, t)) / 24) * width,
            at = y(a.timeMs + (b.timeMs - a.timeMs) * t);
          if (!step) ctx.moveTo(x, at);
          else ctx.lineTo(x, at);
        }
        for (let step = 20; step >= 0; step--) {
          const t = step / 20,
            x = ((a.pos + a.size + (b.pos + b.size - a.pos - a.size) * ease(a.easeR ?? 0, t)) / 24) * width;
          ctx.lineTo(x, y(a.timeMs + (b.timeMs - a.timeMs) * t));
        }
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    for (const note of this.session.chart.notes) {
      const at = y(note.timeMs);
      if (!note.visible || at < -12 || at > height + 12) continue;
      ctx.fillStyle = note.critical
        ? this.colors.critical
        : note.operateType === NoteOperateType.Trace
          ? this.colors.secondary
          : this.colors.primary;
      ctx.fillRect(
        (note.pos / 24) * width,
        at - 4,
        Math.max(2, (note.size / 24) * width),
        note.operateType === NoteOperateType.Trace ? 3 : 8,
      );
      if (note.operateType === NoteOperateType.Flick) {
        const x = ((note.pos + note.size / 2) / 24) * width;
        ctx.strokeStyle = this.colors.primary;
        ctx.beginPath();
        if (note.direction === NoteDirection.Left) {
          ctx.moveTo(x + 3, at - 14);
          ctx.lineTo(x - 3, at - 9);
          ctx.lineTo(x + 3, at - 4);
        } else if (note.direction === NoteDirection.Right) {
          ctx.moveTo(x - 3, at - 14);
          ctx.lineTo(x + 3, at - 9);
          ctx.lineTo(x - 3, at - 4);
        } else {
          ctx.moveTo(x - 5, at - 8);
          ctx.lineTo(x, at - 14);
          ctx.lineTo(x + 5, at - 8);
        }
        ctx.stroke();
      }
    }
    this.changed(now / 1000, this.clock.advancing);
    if (this.clock.advancing) this.frame = requestAnimationFrame(this.render);
  };
  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.playingIntent = false;
    ++this.intent;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    document.removeEventListener("visibilitychange", this.visibility);
    for (const name of ["playing", "pause", "ended", "seeked", "waiting", "stalled"] as const)
      this.clock.removeEventListener(name, this.render);
    this.clock.removeEventListener("error", this.failed);
    this.clock.destroy();
    URL.revokeObjectURL(this.url);
  }
}
