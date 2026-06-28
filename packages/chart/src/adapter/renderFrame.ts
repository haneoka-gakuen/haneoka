import { isPairNoteOperateType, NoteDirection, NoteOperateType, NoteSimulateJudgement } from "../core/enums";
import { applyLineEase, interpolateNoteLine, LANE_COUNT, mirrorLane } from "../core/geometry";
import { VisualTimeMap } from "../core/timing";
import type { ChartDocument, ChartNote, JudgementEvent, LaneInputEffectEvent, SessionSnapshot } from "../core/types";
import { isRenderLaneEffectKind } from "../render/types";
import type {
  RenderDirection,
  RenderFrame,
  RenderHold,
  RenderJudgement,
  RenderLaneEffectKind,
  RenderNote,
  RenderNoteKind,
  RenderParticleEffect,
  RenderPathPoint,
  RenderSimultaneousLine,
} from "../render/types";

export interface RenderSettings {
  noteSpeed: number;
  /** Float32 constant C in GetNoteDisplayOffsetTimeMs. */
  noteSpeedCurve: number;
  mirror: boolean;
  effects: boolean;
  noteSize: number;
  /** Native SlideOpacity option (OptionItemType 106). */
  longAlpha: number;
  /** Native GuideOpacity option (OptionItemType 107). */
  guideAlpha: number;
  graphicsQuality: number;
  guidelineCount: number;
  guidelineOpacity: number;
  laneOpacity: number;
  /** Native DetailSettings.JudgePositionDisplay (OptionItemType 105). */
  showJudgementLine: boolean;
  /** Native SimultaneousLineDisplay (OptionItemType 108). */
  showSimultaneousLine: boolean;
  backgroundBrightness: number;
  /** MasterLiveScoreRank required scores for C/B/A/S/SS. */
  scoreRankScores?: ReadonlyArray<number>;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  // MasterOptionDefault optionItemType=1 preset=1 stores "5.00". The
  // separate MasterLiveSettings note_speed_default=6 is a runtime fallback,
  // not the fresh-user option value shown by the original settings UI.
  noteSpeed: 5,
  noteSpeedCurve: 1.30999994,
  mirror: false,
  effects: true,
  noteSize: 1,
  // MasterOptionDefault: SlideOpacity=100, GuideOpacity=70.
  longAlpha: 1,
  guideAlpha: 0.7,
  // MasterOptionDefault: LiveQuality=1.
  graphicsQuality: 1,
  // MasterOptionDefault: GuidelineCount=2 means LiveLaneSplitCountType.Lane6,
  // not a literal line count. LaneOpacity=80, GuidelineOpacity=40.
  guidelineCount: 6,
  guidelineOpacity: 0.4,
  laneOpacity: 0.8,
  // MasterOptionDefault stores FALSE for option 105 in every preset.
  showJudgementLine: false,
  // MasterOptionDefault stores TRUE for option 108 in every preset.
  showSimultaneousLine: true,
  backgroundBrightness: 0.7,
};

/**
 * effect001 ParticleSystems use `autoRandomSeed=true`. Unity gives a newly
 * played prefab a fresh seed, but that seed must then remain stable while we
 * redraw the same effect across animation frames.
 */
function automaticParticleSeedEntropy(): number {
  const entropy = new Uint32Array(1);
  try {
    globalThis.crypto.getRandomValues(entropy);
    return entropy[0]!;
  } catch {
    const clock = Date.now() ^ Math.trunc((globalThis.performance?.now?.() ?? 0) * 1_000);
    return mixParticleSeed(clock);
  }
}

function mixParticleSeed(value: number): number {
  let state = value >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x21f0aaad);
  state = Math.imul(state ^ (state >>> 15), 0x735a2d97);
  return (state ^ (state >>> 15)) >>> 0;
}

interface PreparedHoldPoint {
  timeMs: number;
  pos: number;
  size: number;
}

interface PreparedLine {
  id: number;
  kind: ChartDocument["lines"][number]["kind"];
  authored: ReadonlyArray<ChartNote>;
  points: ReadonlyArray<PreparedHoldPoint>;
  realStartTimeMs: number;
  realEndTimeMs: number;
  critical: boolean;
  /** Monotonic playback cursors; adjusted backwards safely after option changes. */
  pointStartCursor: number;
  pointEndCursor: number;
  /** Persistent SlideLoop activation state; a new activation needs a new auto seed. */
  particleEffectActive: boolean;
  particleEffectSeed: number | undefined;
}

interface PreparedSimultaneousLine {
  id: string;
  timeMs: number;
  leftCenter: number;
  rightCenter: number;
  firstNoteId: number;
  secondNoteId: number;
}

function samplePreparedLine(line: PreparedLine, timeMs: number, target: PreparedHoldPoint): PreparedHoldPoint {
  const authored = line.authored;
  const nextIndex = lowerBoundTime(authored, timeMs);
  if (nextIndex <= 0) {
    const first = authored[0]!;
    target.timeMs = timeMs;
    target.pos = first.pos;
    target.size = first.size;
    return target;
  }
  if (nextIndex >= authored.length) {
    const last = authored[authored.length - 1]!;
    target.timeMs = timeMs;
    target.pos = last.pos;
    target.size = last.size;
    return target;
  }
  const next = authored[nextIndex]!;
  if (next.timeMs === timeMs) {
    target.timeMs = timeMs;
    target.pos = next.pos;
    target.size = next.size;
    return target;
  }
  const previous = authored[nextIndex - 1]!;
  const duration = next.timeMs - previous.timeMs;
  const progress = duration <= 0 ? 0 : Math.max(0, Math.min(1, (timeMs - previous.timeMs) / duration));
  const leftProgress = applyLineEase(previous.easeL, progress);
  const rightProgress = applyLineEase(previous.easeR, progress);
  target.timeMs = timeMs;
  target.pos = previous.pos + (next.pos - previous.pos) * leftProgress;
  const right = previous.pos + previous.size + (next.pos + next.size - previous.pos - previous.size) * rightProgress;
  target.size = right - target.pos;
  return target;
}

interface MutableRenderHold extends Omit<RenderHold, "points"> {
  points: RenderPathPoint[];
}

interface PooledRenderHold extends MutableRenderHold {
  readonly pointPool: RenderPathPoint[];
}

interface MutableRankResult {
  rank: (typeof SCORE_RANK_LABELS)[number];
  progress: number;
}

interface ReusableFrameBuffers {
  readonly frame: RenderFrame;
  readonly notes: RenderNote[];
  readonly notePool: RenderNote[];
  readonly simultaneousLines: RenderSimultaneousLine[];
  readonly simultaneousLinePool: RenderSimultaneousLine[];
  readonly holds: MutableRenderHold[];
  readonly holdPool: PooledRenderHold[];
  readonly particles: RenderParticleEffect[];
  readonly particlePool: RenderParticleEffect[];
  readonly rank: MutableRankResult;
}

// MasterLiveMusic 100001 -> group 1100001. Fallback for callers which do
// not supply their song's rank group.
const FALLBACK_SCORE_RANK_SCORES = [553_524, 2_136_175, 4_548_528, 9_150_398, 12_945_117] as const;
const SCORE_RANK_LABELS = ["D", "C", "B", "A", "S", "SS"] as const;
const HUD_RANK_LABELS = ["C", "B", "A", "S", "SS"] as const;
// These serialized anchored positions are read by UIFreeLiveHeaderView.Awake;
// the final field is the right edge of the 502px gauge.
const SCORE_RANK_POSITIONS = [88, 177, 264, 352, 439] as const;
const SCORE_GAUGE_MAX_POSITION = 502;

function lowerBoundTime<T extends { timeMs: number }>(items: ReadonlyArray<T>, timeMs: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.timeMs < timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function adjustLowerBoundCursor<T extends { timeMs: number }>(
  items: ReadonlyArray<T>,
  timeMs: number,
  cursor: number,
): number {
  let index = Math.max(0, Math.min(items.length, cursor));
  while (index < items.length && items[index]!.timeMs < timeMs) index++;
  while (index > 0 && items[index - 1]!.timeMs >= timeMs) index--;
  return index;
}

function adjustUpperBoundCursor<T extends { timeMs: number }>(
  items: ReadonlyArray<T>,
  timeMs: number,
  cursor: number,
): number {
  let index = Math.max(0, Math.min(items.length, cursor));
  while (index < items.length && items[index]!.timeMs <= timeMs) index++;
  while (index > 0 && items[index - 1]!.timeMs > timeMs) index--;
  return index;
}

const NATIVE_MAX_NOTE_SPEED = 12;
const EXTENDED_MAX_NOTE_SPEED = 14;
const NATIVE_MIN_VIEW_TIME_SECONDS = 0.35;

function nativeNoteViewTimeSeconds(noteSpeed: number, curveExponent: number): number {
  const normalized = (Math.max(1, Math.min(NATIVE_MAX_NOTE_SPEED, noteSpeed)) - 1) / 11;
  if (normalized <= 0) return 4;
  if (normalized >= 1) return NATIVE_MIN_VIEW_TIME_SECONDS;
  const eased = Math.max(0, Math.min(1, 1 - Math.pow(1 - normalized, Math.max(0.01, curveExponent))));
  return Math.ceil(1000 * (4 + (NATIVE_MIN_VIEW_TIME_SECONDS - 4) * eased)) / 1000;
}

/**
 * Note display offset view time: ease the normalized note-speed approach
 * [0,1] across a 4..0.35 s window using exponent C=1.30999994.
 *
 * The native option range ends at 12. The website's requested 12..14 range is
 * deliberately isolated here: 1..12 retains the exact curve, while the
 * extension continues the geometric view-time ratio from native 11→12.
 */
export function noteViewTimeSeconds(noteSpeed: number, curveExponent = 1.30999994): number {
  const speed = Math.max(1, Math.min(EXTENDED_MAX_NOTE_SPEED, Number(noteSpeed) || 1));
  if (speed <= NATIVE_MAX_NOTE_SPEED) return nativeNoteViewTimeSeconds(speed, curveExponent);

  const previousViewTime = nativeNoteViewTimeSeconds(NATIVE_MAX_NOTE_SPEED - 1, curveExponent);
  const continuationRatio = NATIVE_MIN_VIEW_TIME_SECONDS / previousViewTime;
  const extendedViewTime = NATIVE_MIN_VIEW_TIME_SECONDS * Math.pow(continuationRatio, speed - NATIVE_MAX_NOTE_SPEED);
  return Math.ceil(1000 * extendedViewTime) / 1000;
}

function renderKind(note: ChartNote): RenderNoteKind {
  switch (note.operateType) {
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.GuideBeginFlick:
      return note.direction === NoteDirection.Left
        ? "flick-left"
        : note.direction === NoteDirection.Right
          ? "flick-right"
          : "flick";
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideBeginTrace:
    case NoteOperateType.HiddenSlideBegin:
      return "slide-start";
    case NoteOperateType.SlideEnd:
    case NoteOperateType.SlideEndTrace:
    case NoteOperateType.HiddenSlideEnd:
      return "slide-end";
    case NoteOperateType.SlideConnection:
    case NoteOperateType.SlideConnectionTrace:
    case NoteOperateType.Combo:
      return "slide-node";
    case NoteOperateType.Trace:
    case NoteOperateType.GuideBeginTrace:
    case NoteOperateType.GuideEndTrace:
      return "trace";
    case NoteOperateType.GuideBegin:
    case NoteOperateType.GuideEnd:
      return "guide";
    default:
      return "tap";
  }
}

function renderDirection(note: ChartNote, mirror: boolean): RenderDirection {
  if (note.direction === NoteDirection.Left) return mirror ? "right" : "left";
  if (note.direction === NoteDirection.Right) return mirror ? "left" : "right";
  return renderKind(note) === "flick" ? "up" : "none";
}

function isGuideStart(note: ChartNote): boolean {
  return (
    note.operateType === NoteOperateType.GuideBegin ||
    note.operateType === NoteOperateType.GuideBeginNormal ||
    note.operateType === NoteOperateType.GuideBeginFlick ||
    note.operateType === NoteOperateType.GuideBeginTrace
  );
}

function judgementName(value: NoteSimulateJudgement): RenderJudgement | undefined {
  if (value === NoteSimulateJudgement.Just) return "just";
  if (value === NoteSimulateJudgement.Perfect) return "perfect";
  if (value === NoteSimulateJudgement.Great) return "great";
  if (value === NoteSimulateJudgement.Good) return "good";
  if (value === NoteSimulateJudgement.Bad) return "bad";
  if (value === NoteSimulateJudgement.Miss) return "miss";
  return undefined;
}

function normalizedRankScores(
  values: ReadonlyArray<number> | undefined,
): readonly [number, number, number, number, number] {
  const candidate = values?.length === 5 ? values : FALLBACK_SCORE_RANK_SCORES;
  let previous = 0;
  for (let index = 0; index < 5; index++) {
    const value = candidate[index]!;
    if (!Number.isFinite(value) || value <= previous) return FALLBACK_SCORE_RANK_SCORES;
    previous = value;
  }
  return candidate as unknown as readonly [number, number, number, number, number];
}

function writeNativeScoreRank(
  simulatorScore: number,
  values: ReadonlyArray<number> | undefined,
  target: MutableRankResult,
): MutableRankResult {
  const thresholds = normalizedRankScores(values);
  // The constructor sets the SS scaling field to 1.2f; Initialize rounds SS * that value.
  const maximumScore = Math.max(thresholds[4], Math.round(thresholds[4] * 1.2));
  // ChartSession is intentionally deck-independent and emits 0..1,000,000.
  // Project it onto the song's native score domain before running native UI
  // interpolation, preserving all song-specific threshold ratios.
  const score = Math.max(0, Math.min(1_000_000, Number.isFinite(simulatorScore) ? simulatorScore : 0));
  const nativeScore = (score / 1_000_000) * maximumScore;
  let rankIndex = 0;
  while (rankIndex < thresholds.length && nativeScore >= thresholds[rankIndex]!) rankIndex++;

  const segment = Math.min(rankIndex, SCORE_RANK_POSITIONS.length);
  const lowScore = segment === 0 ? 0 : thresholds[segment - 1]!;
  const highScore = segment < thresholds.length ? thresholds[segment]! : maximumScore;
  const lowPosition = segment === 0 ? 0 : SCORE_RANK_POSITIONS[segment - 1]!;
  const highPosition =
    segment < SCORE_RANK_POSITIONS.length ? SCORE_RANK_POSITIONS[segment]! : SCORE_GAUGE_MAX_POSITION;
  const amount =
    highScore <= lowScore ? 1 : Math.max(0, Math.min(1, (nativeScore - lowScore) / (highScore - lowScore)));
  const position = lowPosition + (highPosition - lowPosition) * amount;
  target.rank = SCORE_RANK_LABELS[Math.min(rankIndex, SCORE_RANK_LABELS.length - 1)]!;
  target.progress = Math.max(0, Math.min(1, position / (SCORE_GAUGE_MAX_POSITION + 0.0001)));
  return target;
}

/** UIFreeLiveHeaderView.Initialize/UpdateScore. */
export function nativeScoreRank(
  simulatorScore: number,
  values?: ReadonlyArray<number>,
): { rank: (typeof SCORE_RANK_LABELS)[number]; progress: number } {
  return writeNativeScoreRank(simulatorScore, values, { rank: "D", progress: 0 });
}

/**
 * Guide line MonoBehaviour alpha curve: keys (0,1) and (1,0), unweighted
 * Hermite tangents -0.950166225 and -0.88311684, applied during the final
 * `_fadeStartBeforeEndMs=100` milliseconds.
 */
function nativeGuideEndAlpha(timeMs: number, endTimeMs: number): number {
  if (timeMs <= endTimeMs - 100) return 1;
  if (timeMs >= endTimeMs) return 0;
  const t = Math.max(0, Math.min(1, (timeMs - (endTimeMs - 100)) / 100));
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h11 = t3 - t2;
  return Math.max(0, Math.min(1, h00 + h10 * -0.9501662254333496 + h11 * -0.8831168413162231));
}

/** LiveNoteEffectViewUtility.ConvertToLiveNoteEffectViewType. */
export function nativeParticleEffectKind(note: ChartNote): RenderParticleEffect["kind"] | null {
  switch (note.operateType) {
    case NoteOperateType.Normal:
    case NoteOperateType.GuideBeginNormal:
      return "tap";
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideEnd:
      // The effect mapping for operate types 20..22 is [Slide, Connect, Slide].
      return "slide";
    case NoteOperateType.SlideConnection:
    case NoteOperateType.Trace:
    case NoteOperateType.SlideBeginTrace:
    case NoteOperateType.SlideEndTrace:
    case NoteOperateType.SlideConnectionTrace:
    case NoteOperateType.GuideBeginTrace:
    case NoteOperateType.GuideEndTrace:
      return "connect";
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.GuideBeginFlick:
      return "flick";
    default:
      return null;
  }
}

/** LiveLaneEffectViewUtility.ConvertToLiveNoteEffectViewType (non-Gekisou path). */
export function nativeLaneEffectKind(note: ChartNote): RenderLaneEffectKind | null {
  switch (note.operateType) {
    case NoteOperateType.Normal:
    case NoteOperateType.GuideBeginNormal:
      return "lane-effect-normal";
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideEnd:
      return "lane-effect-slide";
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.GuideBeginFlick:
      return "lane-effect-flick";
    default:
      // Slide connections and trace/guide nodes explicitly return None.
      return null;
  }
}

function directedLaneEffectKind(
  kind: RenderParticleEffect["kind"],
  direction: RenderDirection,
): RenderParticleEffect["kind"] {
  if (kind !== "lane-effect-flick") return kind;
  if (direction === "left") return "lane-effect-flick-left";
  if (direction === "right") return "lane-effect-flick-right";
  return kind;
}

/** System.Math.Round(float), whose default midpoint mode is ToEven. */
function nativeRoundToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

// All six selected lane ParticleSystems serialize startLifetime=.45 and
// simulationSpeed=2, so their visible real-time lifetime is .225 seconds.
const NATIVE_LANE_EFFECT_LIFETIME = 0.44999998807907104 / 2;

/**
 * Animator stop times from the tap/slide/flick judgement clips selected by
 * ConvertAnimType. Miss/Wait/Pass map to AnimType.None.
 */
export function nativeParticleEffectLifetime(
  kind: RenderParticleEffect["kind"],
  judgement: NoteSimulateJudgement,
): number {
  if (
    judgement !== NoteSimulateJudgement.Bad &&
    judgement !== NoteSimulateJudgement.Good &&
    judgement !== NoteSimulateJudgement.Great &&
    judgement !== NoteSimulateJudgement.Perfect &&
    judgement !== NoteSimulateJudgement.Just
  )
    return 0;
  if (kind === "slide-loop") return Number.POSITIVE_INFINITY;
  const perfect = judgement === NoteSimulateJudgement.Perfect || judgement === NoteSimulateJudgement.Just;
  if (kind === "flick") return perfect ? 5 / 12 : 2 / 3;
  if (kind === "slide" || kind === "connect" || kind === "trace") {
    return perfect ? 7 / 12 : 5 / 12;
  }
  return 5 / 12;
}

interface QueuedJudgementEffect {
  event: JudgementEvent;
  spawnedAtMs: number;
  id: string;
  kind: RenderParticleEffect["kind"];
  lifetime: number;
  /** Assigned once at native autoRandomSeed activation time. */
  seed?: number;
}

interface QueuedLaneInputEffect {
  event: LaneInputEffectEvent;
  id: string;
  lifetime: number;
}

export class RenderFrameBuilder {
  private readonly visualTimeMap: VisualTimeMap;
  private readonly renderableNotes: ReadonlyArray<ChartNote>;
  private readonly preparedSimultaneousLines: ReadonlyArray<PreparedSimultaneousLine>;
  private readonly preparedLines: ReadonlyArray<PreparedLine>;
  private readonly effects: QueuedJudgementEffect[] = [];
  private readonly latestLaneEffects = new Map<string, QueuedJudgementEffect>();
  /** Raw input feedback is never inserted into the judgement/score pipeline. */
  private readonly laneInputEffects: QueuedLaneInputEffect[] = [];
  private readonly latestLaneInputEffects = new Map<number, QueuedLaneInputEffect>();
  private readonly sampleStart: PreparedHoldPoint = { timeMs: 0, pos: 0, size: 0 };
  private readonly sampleEnd: PreparedHoldPoint = { timeMs: 0, pos: 0, size: 0 };
  private readonly particleSeedEntropy = automaticParticleSeedEntropy();
  private effectHead = 0;
  private laneInputEffectHead = 0;
  private nextLaneInputEffectId = 0;
  /** Deliberately survives a timeline reset: the next Play gets a new seed. */
  private nextParticleEffectActivation = 0;
  private firstVisibleNoteCursor = 0;
  private lastVisibleNoteCursor = 0;
  private firstVisibleSimultaneousLineCursor = 0;
  private lastVisibleSimultaneousLineCursor = 0;
  private reusable?: ReusableFrameBuffers;
  private lastTimeMs = 0;

  constructor(private readonly chart: ChartDocument) {
    this.visualTimeMap = new VisualTimeMap(chart.timeScaleChanges);
    const sourceNoteById = new Map(chart.notes.map((note) => [note.id, note]));
    const visualNoteById = new Map(
      chart.notes.map((note) => [note.id, { ...note, timeMs: this.visualTimeMap.toScaledTimeMs(note.timeMs) }]),
    );
    this.renderableNotes = [...visualNoteById.values()]
      .filter((note) => note.visible && !isGuideStart(note))
      .sort((left, right) => left.timeMs - right.timeMs || left.id - right.id);
    const simultaneousCandidates = this.renderableNotes.filter((note) => isPairNoteOperateType(note.operateType));
    const simultaneousLines: PreparedSimultaneousLine[] = [];
    const pairGroups = new Map<number, ChartNote[]>();
    for (const note of simultaneousCandidates) {
      const group = pairGroups.get(note.tick);
      if (group) group.push(note);
      else pairGroups.set(note.tick, [note]);
    }
    for (const group of pairGroups.values()) {
      group.sort((left, right) => left.id - right.id);
      for (let index = 1; index < group.length; index++) {
        const first = group[index - 1]!;
        const second = group[index]!;
        const firstCenter = first.pos + first.size / 2;
        const secondCenter = second.pos + second.size / 2;
        if (firstCenter === secondCenter) continue;
        simultaneousLines.push({
          id: `${first.id}:${second.id}`,
          timeMs: second.timeMs,
          leftCenter: Math.min(firstCenter, secondCenter),
          rightCenter: Math.max(firstCenter, secondCenter),
          firstNoteId: first.id,
          secondNoteId: second.id,
        });
      }
    }
    simultaneousLines.sort((left, right) => left.timeMs - right.timeMs || left.id.localeCompare(right.id));
    this.preparedSimultaneousLines = simultaneousLines;
    this.preparedLines = chart.lines.map((line) => {
      const authored = line.noteIds
        .map((id) => visualNoteById.get(id))
        .filter((note): note is ChartNote => Boolean(note) && note!.indexInLine !== null)
        .sort((left, right) => left.timeMs - right.timeMs);
      const sourceAuthored = line.noteIds
        .map((id) => sourceNoteById.get(id))
        .filter((note): note is ChartNote => Boolean(note) && note!.indexInLine !== null)
        .sort((left, right) => left.timeMs - right.timeMs);
      const points: PreparedHoldPoint[] = [];
      for (let index = 0; index < authored.length - 1; index++) {
        const head = authored[index]!;
        const tail = authored[index + 1]!;
        const steps = Math.max(1, Math.ceil((tail.timeMs - head.timeMs) / 45));
        for (let step = 0; step <= steps; step++) {
          if (index > 0 && step === 0) continue;
          const timeMs = head.timeMs + ((tail.timeMs - head.timeMs) * step) / steps;
          const shape = interpolateNoteLine(head, tail, timeMs);
          points.push({ timeMs, pos: shape.pos, size: shape.size });
        }
      }
      return {
        id: line.id,
        kind: line.kind,
        authored,
        points,
        realStartTimeMs: sourceAuthored[0]?.timeMs ?? 0,
        realEndTimeMs: sourceAuthored[sourceAuthored.length - 1]?.timeMs ?? 0,
        critical: line.critical,
        pointStartCursor: 0,
        pointEndCursor: 0,
        particleEffectActive: false,
        particleEffectSeed: undefined,
      };
    });
  }

  addJudgement(event: JudgementEvent, timeMs: number): void {
    // Compact outside the rAF build path. copyWithin retains the backing
    // storage and avoids the allocation/copy churn of per-frame splice.
    if (this.effectHead > 64 && this.effectHead * 2 >= this.effects.length) {
      this.effects.copyWithin(0, this.effectHead);
      this.effects.length -= this.effectHead;
      this.effectHead = 0;
    }
    const kind = nativeParticleEffectKind(event.note);
    if (kind) {
      const lifetime = nativeParticleEffectLifetime(kind, event.judgement);
      if (lifetime > 0) {
        const activation = this.nextParticleEffectActivation++;
        this.effects.push({
          event,
          spawnedAtMs: timeMs,
          // `id` is an active-instance identity, not a chart-note identity:
          // the same note can be played again after a seek/restart.
          id: `${event.note.id}:${timeMs}:note:${activation}`,
          kind,
          lifetime,
          seed: mixParticleSeed(this.particleSeedEntropy ^ Math.imul(activation + 1, 0x9e3779b9)),
        });
      }
    }
    const laneKind = nativeLaneEffectKind(event.note);
    if (laneKind && event.judgement >= NoteSimulateJudgement.Bad && event.judgement <= NoteSimulateJudgement.Just)
      this.effects.push({
        event,
        spawnedAtMs: timeMs,
        id: `${event.note.id}:${timeMs}:lane`,
        kind: laneKind,
        lifetime: NATIVE_LANE_EFFECT_LIFETIME,
      });
  }

  addLaneInput(event: LaneInputEffectEvent): void {
    if (!Number.isFinite(event.lane) || !Number.isFinite(event.width) || event.width <= 0) return;
    if (this.laneInputEffectHead > 64 && this.laneInputEffectHead * 2 >= this.laneInputEffects.length) {
      this.laneInputEffects.copyWithin(0, this.laneInputEffectHead);
      this.laneInputEffects.length -= this.laneInputEffectHead;
      this.laneInputEffectHead = 0;
    }
    this.laneInputEffects.push({
      event,
      id: `lane-input:${event.pointerId}:${this.nextLaneInputEffectId++}`,
      lifetime: NATIVE_LANE_EFFECT_LIFETIME,
    });
  }

  reset(): void {
    this.effects.length = 0;
    this.effectHead = 0;
    this.latestLaneEffects.clear();
    this.laneInputEffects.length = 0;
    this.latestLaneInputEffects.clear();
    this.laneInputEffectHead = 0;
    this.nextLaneInputEffectId = 0;
    this.firstVisibleNoteCursor = 0;
    this.lastVisibleNoteCursor = 0;
    this.firstVisibleSimultaneousLineCursor = 0;
    this.lastVisibleSimultaneousLineCursor = 0;
    for (const line of this.preparedLines) {
      line.pointStartCursor = 0;
      line.pointEndCursor = 0;
      line.particleEffectActive = false;
      line.particleEffectSeed = undefined;
    }
    this.lastTimeMs = 0;
  }

  build(timeMs: number, snapshot: SessionSnapshot, partialSettings: Partial<RenderSettings> = {}): RenderFrame {
    return this.buildFrame(timeMs, snapshot, partialSettings, false);
  }

  /**
   * Allocation-bounded rAF path. The returned DTO and its nested arrays are
   * overwritten by the next call and must be rendered synchronously.
   */
  buildReusable(timeMs: number, snapshot: SessionSnapshot, partialSettings: Partial<RenderSettings> = {}): RenderFrame {
    return this.buildFrame(timeMs, snapshot, partialSettings, true);
  }

  private buildFrame(
    timeMs: number,
    snapshot: SessionSnapshot,
    partialSettings: Partial<RenderSettings>,
    reuse: boolean,
  ): RenderFrame {
    if (timeMs + 5 < this.lastTimeMs) this.reset();
    const visualTimeMs = this.visualTimeMap.toScaledTimeMs(timeMs);
    const settings = partialSettings;
    const noteSpeed = settings.noteSpeed ?? DEFAULT_RENDER_SETTINGS.noteSpeed;
    const noteSpeedCurve = settings.noteSpeedCurve ?? DEFAULT_RENDER_SETTINGS.noteSpeedCurve;
    const mirror = settings.mirror ?? DEFAULT_RENDER_SETTINGS.mirror;
    const noteSize = Math.max(0.1, Math.min(2, settings.noteSize ?? DEFAULT_RENDER_SETTINGS.noteSize));
    const viewTimeMs = noteViewTimeSeconds(noteSpeed, noteSpeedCurve) * 1000;
    const inverseViewTimeMs = 1 / viewTimeMs;
    const earliestVisibleTime = visualTimeMs - viewTimeMs * 0.16;
    const latestVisibleTime = visualTimeMs + viewTimeMs * 1.1;
    this.firstVisibleNoteCursor = adjustLowerBoundCursor(
      this.renderableNotes,
      earliestVisibleTime,
      this.firstVisibleNoteCursor,
    );
    this.lastVisibleNoteCursor = adjustUpperBoundCursor(
      this.renderableNotes,
      latestVisibleTime,
      this.lastVisibleNoteCursor,
    );
    const buffers = reuse ? this.reusableBuffers() : undefined;
    const notes: RenderNote[] = buffers?.notes ?? [];
    notes.length = 0;
    for (let index = this.firstVisibleNoteCursor; index < this.lastVisibleNoteCursor; index++) {
      const note = this.renderableNotes[index]!;
      // After judgement, UpdaterBase.SetLastJudgement sets
      // NoteSimulateState.Done (6). On the next view update,
      // LiveAllNoteView.CleanupNoteView calls TryReleaseNote, which
      // deactivates the GameObject, resets it and returns it to the pool. A
      // consumed note therefore must not keep moving below the judgement line
      // while its impact effect is playing.
      if (snapshot.noteState.isProcessed(note.id)) continue;
      const approach = (note.timeMs - visualTimeMs) * inverseViewTimeMs;
      const outputIndex = notes.length;
      const output = buffers
        ? (buffers.notePool[outputIndex] ??= { id: note.id, kind: "tap", lane: 0, width: 0, approach: 0 })
        : ({ id: note.id, kind: "tap", lane: 0, width: 0, approach: 0 } satisfies RenderNote);
      output.id = note.id;
      output.kind = renderKind(note);
      output.lane = mirror ? mirrorLane(note.pos, note.size) : note.pos;
      output.width = note.size;
      output.approach = approach;
      output.direction = renderDirection(note, mirror);
      output.critical = note.critical;
      output.scale = noteSize;
      output.alpha = approach < 0 ? Math.max(0, 1 + approach / 0.16) : 1;
      notes.push(output);
    }

    const simultaneousLines: RenderSimultaneousLine[] = buffers?.simultaneousLines ?? [];
    simultaneousLines.length = 0;
    if (settings.showSimultaneousLine ?? DEFAULT_RENDER_SETTINGS.showSimultaneousLine) {
      // Pair lines share note view progress, but the SpriteRenderer's
      // serialized 0.025-unit Y size remains fixed; only X is resized by
      // LivePairNoteLineView.SetProgress.
      const firstLineTime = Math.max(visualTimeMs, earliestVisibleTime);
      this.firstVisibleSimultaneousLineCursor = adjustLowerBoundCursor(
        this.preparedSimultaneousLines,
        firstLineTime,
        this.firstVisibleSimultaneousLineCursor,
      );
      this.lastVisibleSimultaneousLineCursor = adjustUpperBoundCursor(
        this.preparedSimultaneousLines,
        latestVisibleTime,
        this.lastVisibleSimultaneousLineCursor,
      );
      for (
        let index = this.firstVisibleSimultaneousLineCursor;
        index < this.lastVisibleSimultaneousLineCursor;
        index++
      ) {
        const line = this.preparedSimultaneousLines[index]!;
        if (snapshot.noteState.isProcessed(line.firstNoteId) || snapshot.noteState.isProcessed(line.secondNoteId))
          continue;
        const outputIndex = simultaneousLines.length;
        const output = buffers
          ? (buffers.simultaneousLinePool[outputIndex] ??= {
              id: line.id,
              leftCenter: 0,
              rightCenter: 0,
              approach: 0,
            })
          : ({ id: line.id, leftCenter: 0, rightCenter: 0, approach: 0 } satisfies RenderSimultaneousLine);
        output.id = line.id;
        output.leftCenter = mirror ? LANE_COUNT - line.rightCenter : line.leftCenter;
        output.rightCenter = mirror ? LANE_COUNT - line.leftCenter : line.rightCenter;
        output.approach = (line.timeMs - visualTimeMs) * inverseViewTimeMs;
        simultaneousLines.push(output);
      }
    }

    const holds: MutableRenderHold[] = buffers?.holds ?? [];
    holds.length = 0;
    for (const line of this.preparedLines) {
      const authored = line.authored;
      if (
        authored.length < 2 ||
        authored[authored.length - 1]!.timeMs < earliestVisibleTime ||
        authored[0]!.timeMs > latestVisibleTime
      )
        continue;

      // LiveNoteLineViewBase.SetupAllMesh clamps each BeginProgress/EndProgress
      // to 1 before building a trapezoid. In raw simulator progress, 1 is
      // exactly the judgement line. Keeping older samples behind that point
      // lets the WebGL near plane cut a hole through the ribbon, which is why
      // an active hold used to look like two separate pieces. Clip at the
      // current music time and synthesize the exact intersecting cross-section,
      // as the native mesh builder does.
      const visibleStartTime = Math.max(authored[0]!.timeMs, visualTimeMs);
      const visibleEndTime = Math.min(authored[authored.length - 1]!.timeMs, latestVisibleTime);
      if (visibleEndTime <= visibleStartTime) continue;

      const outputIndex = holds.length;
      const output: MutableRenderHold = buffers
        ? (buffers.holdPool[outputIndex] ??= {
            id: line.id,
            kind: "slide",
            points: [],
            pointPool: [],
          })
        : ({ id: line.id, kind: "slide", points: [] } satisfies MutableRenderHold);
      const points = output.points;
      points.length = 0;
      const pointPool = buffers ? (output as PooledRenderHold).pointPool : undefined;
      this.appendHoldPoint(
        points,
        pointPool,
        samplePreparedLine(line, visibleStartTime, this.sampleStart),
        visualTimeMs,
        inverseViewTimeMs,
        mirror,
      );
      line.pointStartCursor = adjustUpperBoundCursor(line.points, visibleStartTime, line.pointStartCursor);
      line.pointEndCursor = adjustLowerBoundCursor(line.points, visibleEndTime, line.pointEndCursor);
      for (let pointIndex = line.pointStartCursor; pointIndex < line.pointEndCursor; pointIndex++) {
        this.appendHoldPoint(points, pointPool, line.points[pointIndex]!, visualTimeMs, inverseViewTimeMs, mirror);
      }
      this.appendHoldPoint(
        points,
        pointPool,
        samplePreparedLine(line, visibleEndTime, this.sampleEnd),
        visualTimeMs,
        inverseViewTimeMs,
        mirror,
      );
      if (points.length < 2) continue;
      output.id = line.id;
      output.kind = line.kind === "guide" ? "guide" : "slide";
      output.active = timeMs >= line.realStartTimeMs && timeMs <= line.realEndTimeMs;
      output.alpha =
        line.kind === "guide"
          ? Math.max(0.1, Math.min(1, settings.guideAlpha ?? DEFAULT_RENDER_SETTINGS.guideAlpha)) *
            nativeGuideEndAlpha(timeMs, line.realEndTimeMs)
          : Math.max(0.1, Math.min(1, settings.longAlpha ?? DEFAULT_RENDER_SETTINGS.longAlpha));
      output.critical = line.critical;
      holds.push(output);
    }

    while (
      this.effectHead < this.effects.length &&
      timeMs - this.effects[this.effectHead]!.spawnedAtMs > this.effects[this.effectHead]!.lifetime * 1000
    ) {
      this.effectHead++;
    }
    if (this.effectHead === this.effects.length && this.effectHead > 0) {
      this.effects.length = 0;
      this.effectHead = 0;
    }
    while (
      this.laneInputEffectHead < this.laneInputEffects.length &&
      timeMs - this.laneInputEffects[this.laneInputEffectHead]!.event.timeMs >
        this.laneInputEffects[this.laneInputEffectHead]!.lifetime * 1000
    ) {
      this.laneInputEffectHead++;
    }
    if (this.laneInputEffectHead === this.laneInputEffects.length && this.laneInputEffectHead > 0) {
      this.laneInputEffects.length = 0;
      this.laneInputEffectHead = 0;
    }
    const particles: RenderParticleEffect[] = buffers?.particles ?? [];
    particles.length = 0;
    if (settings.effects ?? DEFAULT_RENDER_SETTINGS.effects) {
      // There is exactly one native LiveGameLaneEffectBase per resolved
      // (viewType, lane). Play stops/clears an already-playing instance before
      // restarting it, so a newer judgement replaces rather than adds to the
      // older quad. Build that ownership table before emitting this frame.
      this.latestLaneEffects.clear();
      for (let index = this.effectHead; index < this.effects.length; index++) {
        const effect = this.effects[index]!;
        const age = (timeMs - effect.spawnedAtMs) / 1000;
        if (age < 0 || age > effect.lifetime) continue;
        const note = effect.event.note;
        const kind = directedLaneEffectKind(effect.kind, renderDirection(note, mirror));
        if (!isRenderLaneEffectKind(kind)) continue;
        const laneStart = nativeRoundToEven(mirror ? mirrorLane(note.pos, note.size) : note.pos);
        const laneEnd = laneStart + Math.max(1, nativeRoundToEven(note.size)) - 1;
        for (let lane = laneStart; lane <= laneEnd; lane += 1) {
          this.latestLaneEffects.set(`${kind}:${lane}`, effect);
        }
      }

      for (let index = this.effectHead; index < this.effects.length; index++) {
        const effect = this.effects[index]!;
        const age = (timeMs - effect.spawnedAtMs) / 1000;
        if (age < 0 || age > effect.lifetime) continue;
        const note = effect.event.note;
        const direction = renderDirection(note, mirror);
        const kind = directedLaneEffectKind(effect.kind, direction);

        if (isRenderLaneEffectKind(kind)) {
          // PlayEffect treats laneFromIndex..laneToIndex as an inclusive range.
          // NoteBase stores the inclusive end as start + roundedWidth - 1, so a
          // size-2 note drives two of the 24 pre-initialized lane instances.
          const laneStart = nativeRoundToEven(mirror ? mirrorLane(note.pos, note.size) : note.pos);
          const laneEnd = laneStart + Math.max(1, nativeRoundToEven(note.size)) - 1;
          for (let lane = laneStart; lane <= laneEnd; lane += 1) {
            if (this.latestLaneEffects.get(`${kind}:${lane}`) !== effect) continue;
            const outputIndex = particles.length;
            const id = `${effect.id}:${lane}`;
            const output = buffers
              ? (buffers.particlePool[outputIndex] ??= { id, kind, lane, age: 0 })
              : ({ id, kind, lane, age: 0 } satisfies RenderParticleEffect);
            output.id = id;
            output.kind = kind;
            output.lane = lane;
            output.width = 1;
            output.approach = undefined;
            output.age = age;
            output.judgement = judgementName(effect.event.judgement);
            output.lifetime = effect.lifetime;
            output.intensity = noteSize;
            output.direction = direction;
            output.color = undefined;
            // Authored lane ParticleSystems disable autoRandomSeed and store 0,
            // so Stop/Clear + Play repeats the same deterministic sequence.
            output.seed = 0;
            particles.push(output);
          }
          continue;
        }

        const outputIndex = particles.length;
        const output = buffers
          ? (buffers.particlePool[outputIndex] ??= { id: effect.id, kind: effect.kind, lane: 0, age: 0 })
          : ({ id: effect.id, kind: effect.kind, lane: 0, age: 0 } satisfies RenderParticleEffect);
        output.id = effect.id;
        output.kind = kind;
        output.lane = mirror ? mirrorLane(note.pos, note.size) : note.pos;
        output.width = note.size;
        output.approach = undefined;
        output.age = age;
        output.judgement = judgementName(effect.event.judgement);
        output.lifetime = effect.lifetime;
        output.intensity = noteSize;
        output.direction = direction;
        output.color = undefined;
        // Source effect001 ParticleSystems use autoRandomSeed=true. Store one
        // fresh seed at Play time so the same effect is stable across frames,
        // yet a replayed note receives a new particle layout. Lane effects
        // intentionally remain seed 0 because their native systems disable
        // autoRandomSeed.
        output.seed = effect.seed;
        particles.push(output);
      }
      // SetInVainLane marks both members of the selected two-lane input pair.
      // Each member owns a separate width-1 effect view, and a later Play
      // stops, clears, and restarts that same lane instance.
      this.latestLaneInputEffects.clear();
      for (let index = this.laneInputEffectHead; index < this.laneInputEffects.length; index++) {
        const effect = this.laneInputEffects[index]!;
        const age = (timeMs - effect.event.timeMs) / 1000;
        if (age < 0 || age > effect.lifetime) continue;
        const laneStart = nativeRoundToEven(
          mirror ? mirrorLane(effect.event.lane, effect.event.width) : effect.event.lane,
        );
        const laneEnd = laneStart + Math.max(1, nativeRoundToEven(effect.event.width)) - 1;
        for (let lane = laneStart; lane <= laneEnd; lane += 1) this.latestLaneInputEffects.set(lane, effect);
      }
      for (let index = this.laneInputEffectHead; index < this.laneInputEffects.length; index++) {
        const effect = this.laneInputEffects[index]!;
        const age = (timeMs - effect.event.timeMs) / 1000;
        if (age < 0 || age > effect.lifetime) continue;
        const laneStart = nativeRoundToEven(
          mirror ? mirrorLane(effect.event.lane, effect.event.width) : effect.event.lane,
        );
        const laneEnd = laneStart + Math.max(1, nativeRoundToEven(effect.event.width)) - 1;
        for (let lane = laneStart; lane <= laneEnd; lane += 1) {
          if (this.latestLaneInputEffects.get(lane) !== effect) continue;
          const outputIndex = particles.length;
          const id = `${effect.id}:${lane}`;
          const output = buffers
            ? (buffers.particlePool[outputIndex] ??= {
                id,
                kind: "lane-input-blank-miss",
                lane,
                age: 0,
              })
            : ({
                id,
                kind: "lane-input-blank-miss",
                lane,
                age: 0,
              } satisfies RenderParticleEffect);
          output.id = id;
          output.kind = "lane-input-blank-miss";
          output.lane = lane;
          output.width = 1;
          output.approach = undefined;
          output.age = age;
          output.judgement = undefined;
          output.lifetime = effect.lifetime;
          output.intensity = 1;
          output.direction = "none";
          output.color = undefined;
          output.seed = 0;
          particles.push(output);
        }
      }
      // UpdateFrame keeps one SlideLoop prefab per Playing long-line ID in
      // _lineNoteEffectDictionary, updates its interpolated width/position,
      // and stops/removes it when that line is no longer active. Session's
      // allocation-free lineState additionally preserves pointer ownership in
      // play mode instead of lighting every overlapping chart line.
      for (const line of this.preparedLines) {
        if (line.kind !== "long" || !snapshot.lineState.isActive(line.id) || line.authored.length < 2) {
          line.particleEffectActive = false;
          line.particleEffectSeed = undefined;
          continue;
        }
        if (!line.particleEffectActive || line.particleEffectSeed === undefined) {
          const activation = this.nextParticleEffectActivation++;
          line.particleEffectActive = true;
          line.particleEffectSeed = mixParticleSeed(this.particleSeedEntropy ^ Math.imul(activation + 1, 0x9e3779b9));
        }
        const point = samplePreparedLine(line, visualTimeMs, this.sampleStart);
        const outputIndex = particles.length;
        const id = `line:${line.id}`;
        const output = buffers
          ? (buffers.particlePool[outputIndex] ??= { id, kind: "slide-loop", lane: 0, age: 0 })
          : ({ id, kind: "slide-loop", lane: 0, age: 0 } satisfies RenderParticleEffect);
        output.id = id;
        output.kind = "slide-loop";
        output.lane = mirror ? mirrorLane(point.pos, point.size) : point.pos;
        output.width = point.size;
        output.age = Math.max(0, (timeMs - line.realStartTimeMs) / 1000);
        output.judgement = "perfect";
        output.lifetime = undefined;
        output.intensity = noteSize;
        output.direction = "none";
        // SlideLoop stays stable while held, but its source ParticleSystems
        // have autoRandomSeed=true and therefore receive a fresh sequence
        // after the line is stopped and activated again.
        output.seed = line.particleEffectSeed;
        particles.push(output);
      }
    }

    const rank = buffers
      ? writeNativeScoreRank(snapshot.score, settings.scoreRankScores, buffers.rank)
      : nativeScoreRank(snapshot.score, settings.scoreRankScores);
    const last = snapshot.lastJudgement;
    const hud = buffers?.frame.hud ?? {};
    hud.score = snapshot.score;
    // UICountAdditionInfoElement positive/negative clips are both 0.45 s.
    hud.scoreDelta = last && timeMs - last.judgedAtMs < 450 ? last.scoreDelta : undefined;
    hud.combo = snapshot.combo;
    hud.comboAge =
      last && snapshot.combo >= 2 && last.combo === snapshot.combo
        ? Math.max(0, (timeMs - last.judgedAtMs) / 1000)
        : undefined;
    hud.perfectCombo = snapshot.perfectCombo;
    hud.life = snapshot.life;
    hud.maxLife = 1000;
    hud.rank = rank.rank;
    hud.rankProgress = rank.progress;
    hud.rankLabels = HUD_RANK_LABELS;
    hud.judgement = last ? judgementName(last.judgement) : undefined;
    hud.judgementAge = last ? Math.max(0, (timeMs - last.judgedAtMs) / 1000) : undefined;
    hud.fastSlow = last?.timing === 1 ? "FAST" : last?.timing === 2 ? "SLOW" : null;
    hud.showPause = true;

    const stage = buffers?.frame.stage ?? {};
    stage.laneOpacity = settings.laneOpacity ?? DEFAULT_RENDER_SETTINGS.laneOpacity;
    stage.guidelineOpacity = settings.guidelineOpacity ?? DEFAULT_RENDER_SETTINGS.guidelineOpacity;
    stage.judgementLineOpacity = (settings.showJudgementLine ?? DEFAULT_RENDER_SETTINGS.showJudgementLine) ? 1 : 0;
    stage.guidelineCount = settings.guidelineCount ?? DEFAULT_RENDER_SETTINGS.guidelineCount;
    stage.backgroundBrightness = settings.backgroundBrightness ?? DEFAULT_RENDER_SETTINGS.backgroundBrightness;

    const deltaTime = Math.max(0, timeMs - this.lastTimeMs) / 1000;
    this.lastTimeMs = timeMs;
    if (buffers) {
      buffers.frame.time = timeMs / 1000;
      buffers.frame.deltaTime = deltaTime;
      return buffers.frame;
    }
    return { time: timeMs / 1000, deltaTime, notes, simultaneousLines, holds, particles, hud, stage };
  }

  private appendHoldPoint(
    points: RenderPathPoint[],
    pool: RenderPathPoint[] | undefined,
    point: PreparedHoldPoint,
    timeMs: number,
    inverseViewTimeMs: number,
    mirror: boolean,
  ): void {
    const index = points.length;
    const output = pool
      ? (pool[index] ??= { lane: 0, width: 0, approach: 0, leftEasing: "linear", rightEasing: "linear" })
      : ({ lane: 0, width: 0, approach: 0, leftEasing: "linear", rightEasing: "linear" } satisfies RenderPathPoint);
    output.lane = mirror ? mirrorLane(point.pos, point.size) : point.pos;
    output.width = point.size;
    output.approach = (point.timeMs - timeMs) * inverseViewTimeMs;
    points.push(output);
  }

  private reusableBuffers(): ReusableFrameBuffers {
    if (this.reusable) return this.reusable;
    const notes: RenderNote[] = [];
    const simultaneousLines: RenderSimultaneousLine[] = [];
    const holds: MutableRenderHold[] = [];
    const particles: RenderParticleEffect[] = [];
    this.reusable = {
      frame: { time: 0, deltaTime: 0, notes, simultaneousLines, holds, particles, hud: {}, stage: {} },
      notes,
      notePool: [],
      simultaneousLines,
      simultaneousLinePool: [],
      holds,
      holdPool: [],
      particles,
      particlePool: [],
      rank: { rank: "D", progress: 0 },
    };
    return this.reusable;
  }
}
