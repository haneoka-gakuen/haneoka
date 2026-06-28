import type {
  SsBpm,
  SsCall,
  SsEase,
  SsFadeType,
  SsFlickDirection,
  SsNoteType,
  SsRawNote,
  SsRoot,
  SsSig,
} from "./types";

// Source scores are remote input. These ceilings are far above normal charts
// but prevent pathological event arrays or deeply populated slide nodes from
// reaching expensive conversion/render paths.
const MAX_TIMING_EVENTS = 4_096;
const MAX_SOURCE_NOTES = 25_000;

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseBpm(value: unknown): SsBpm[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_TIMING_EVENTS) throw new RangeError("score.events.bpm has too many entries");
  return value.map((raw, index) => {
    const item = object(raw, `score.events.bpm[${index}]`);
    const bpm = finite(item.bpm);
    if (bpm <= 0 || bpm > 10_000) {
      throw new TypeError(`score.events.bpm[${index}].bpm must be greater than 0 and at most 10000`);
    }
    return { t: finite(item.t), bpm };
  });
}

function parseSignature(value: unknown): SsSig[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_TIMING_EVENTS) throw new RangeError("score.events.sig has too many entries");
  return value.map((raw, index) => {
    const item = object(raw, `score.events.sig[${index}]`);
    if (item.sig !== undefined && (!Array.isArray(item.sig) || item.sig.length < 2)) {
      throw new TypeError(`score.events.sig[${index}].sig must contain at least two values`);
    }
    const signature = Array.isArray(item.sig) ? item.sig : [];
    const numerator = finite(signature[0]);
    const denominator = finite(signature[1]);
    if (numerator <= 0 || denominator <= 0) {
      throw new TypeError(`score.events.sig[${index}].sig values must be positive`);
    }
    return { t: finite(item.t), sig: [numerator, denominator] };
  });
}

function parseStringEnum<const T extends string>(value: unknown, values: readonly T[], fallback: T, path: string): T {
  if (typeof value !== "string") return fallback;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new TypeError(`${path} has unknown value ${JSON.stringify(value)}`);
}

const NOTE_TYPES = ["tap", "flick", "trace", "long", "guide", "node"] as const;
const FLICK_DIRECTIONS = ["up", "left", "right", "down"] as const;
const EASES = ["linear", "in", "out"] as const;
const FADES = ["none", "in", "out"] as const;

function parseEase(value: unknown, path: string): SsEase | [SsEase, SsEase] {
  if (!Array.isArray(value)) return parseStringEnum(value, EASES, "linear", path);
  if (value.length !== 2 || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${path} must be a string or two strings`);
  }
  return [
    parseStringEnum(value[0], EASES, "linear", `${path}[0]`),
    parseStringEnum(value[1], EASES, "linear", `${path}[1]`),
  ];
}

function parseNote(value: unknown, path: string, budget: { count: number }): SsRawNote {
  budget.count += 1;
  if (budget.count > MAX_SOURCE_NOTES) throw new RangeError("score.notes has too many entries");
  const item = object(value, path);
  const type = parseStringEnum(item.type, NOTE_TYPES, "tap", `${path}.type`) as SsNoteType;
  const direction = parseStringEnum(item.dir, FLICK_DIRECTIONS, "up", `${path}.dir`) as SsFlickDirection;
  const pos = item.pos === "auto" ? "auto" : finite(item.pos);
  const node = Array.isArray(item.node)
    ? item.node.map((entry, index) => parseNote(entry, `${path}.node[${index}]`, budget))
    : undefined;
  return {
    type,
    t: finite(item.t),
    pos,
    size: finite(item.size, 6),
    crit: item.crit === true,
    dir: direction,
    ease: parseEase(item.ease, `${path}.ease`),
    visible: item.visible !== false,
    alpha: parseStringEnum(item.alpha, FADES, "none", `${path}.alpha`) as SsFadeType,
    node,
  };
}

function parseCall(value: unknown): SsCall[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_TIMING_EVENTS) throw new RangeError("score.events.call has too many entries");
  return value.map((raw, index) => {
    const item = object(raw, `score.events.call[${index}]`);
    return {
      t: finite(item.t),
      timing: Array.isArray(item.timing) ? item.timing.map((entry) => finite(entry)) : [],
    };
  });
}

function parseFever(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_TIMING_EVENTS) throw new RangeError("score.events.fever has too many entries");
  return value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new TypeError(`score.events.fever[${index}] must contain at least two values`);
    }
    return [finite(entry[0]), finite(entry[1])];
  });
}

export function parseScore(input: string | ArrayBuffer | unknown): SsRoot {
  let raw: unknown = input;
  if (typeof input === "string") raw = JSON.parse(input.replace(/^\uFEFF/, ""));
  else if (input instanceof ArrayBuffer) raw = JSON.parse(new TextDecoder().decode(input).replace(/^\uFEFF/, ""));
  const root = object(raw, "root");
  const score = object(root.score, "root.score");
  const events =
    score.events && typeof score.events === "object" && !Array.isArray(score.events)
      ? object(score.events, "root.score.events")
      : {};
  const sourceMeta =
    root.meta && typeof root.meta === "object" && !Array.isArray(root.meta)
      ? (root.meta as Record<string, unknown>)
      : undefined;
  const noteBudget = { count: 0 };
  return {
    version: finite(sourceMeta?.version),
    bpm: parseBpm(events.bpm),
    sig: parseSignature(events.sig),
    skill: Array.isArray(events.skill) ? events.skill.map((entry) => finite(entry)) : [],
    fever: parseFever(events.fever),
    call: parseCall(events.call),
    notes: Array.isArray(score.notes)
      ? score.notes.map((entry, index) => parseNote(entry, `score.notes[${index}]`, noteBudget))
      : [],
  };
}
