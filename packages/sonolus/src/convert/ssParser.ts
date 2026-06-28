import type { SsBpm, SsCall, SsRawNote, SsRoot, SsSig } from "./types.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

interface SsEvents {
  bpm?: SsBpm[];
  sig?: SsSig[];
  skill?: number[];
  fever?: [number, number][];
  call?: SsCall[];
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: JsonValue | undefined): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function isNumberPair(value: JsonValue | undefined): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === "number");
}

function isStringPair(value: JsonValue | undefined): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === "string");
}

function isSsBpm(value: JsonValue): value is JsonObject & SsBpm {
  return isJsonObject(value) && typeof value.t === "number" && typeof value.bpm === "number";
}

function isSsSig(value: JsonValue): value is JsonObject & SsSig {
  return isJsonObject(value) && typeof value.t === "number" && isNumberPair(value.sig);
}

function isSsCall(value: JsonValue): value is JsonObject & SsCall {
  return isJsonObject(value) && typeof value.t === "number" && isNumberArray(value.timing);
}

function isSsRawNote(value: JsonValue): value is JsonObject & SsRawNote {
  if (!isJsonObject(value)) return false;
  if (value.type !== undefined && !["flick", "trace", "long", "guide"].includes(String(value.type))) return false;
  if (value.t !== undefined && typeof value.t !== "number") return false;
  if (value.pos !== undefined && value.pos !== "auto" && typeof value.pos !== "number") return false;
  if (value.size !== undefined && typeof value.size !== "number") return false;
  if (value.crit !== undefined && typeof value.crit !== "boolean") return false;
  if (value.dir !== undefined && value.dir !== "left" && value.dir !== "right") return false;
  if (value.ease !== undefined && typeof value.ease !== "string" && !isStringPair(value.ease)) return false;
  if (value.visible !== undefined && typeof value.visible !== "boolean") return false;
  return value.node === undefined || (Array.isArray(value.node) && value.node.every(isSsRawNote));
}

function isSsEvents(value: JsonValue): value is JsonObject & SsEvents {
  if (!isJsonObject(value)) return false;
  return (
    (value.bpm === undefined || (Array.isArray(value.bpm) && value.bpm.every(isSsBpm))) &&
    (value.sig === undefined || (Array.isArray(value.sig) && value.sig.every(isSsSig))) &&
    (value.skill === undefined || isNumberArray(value.skill)) &&
    (value.fever === undefined || (Array.isArray(value.fever) && value.fever.every(isNumberPair))) &&
    (value.call === undefined || (Array.isArray(value.call) && value.call.every(isSsCall)))
  );
}

function toText(input: string | Uint8Array): string {
  if (typeof input === "string") {
    return input.replace(/^﻿/, "");
  }
  if (input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b) {
    throw new Error("compressed chart input requires parseSsAsync");
  }
  return new TextDecoder("utf-8").decode(input).replace(/^﻿/, "");
}

export async function decodeSsText(input: string | Uint8Array): Promise<string> {
  if (typeof input === "string") return input.replace(/^﻿/, "");
  if (input.length < 2 || input[0] !== 0x1f || input[1] !== 0x8b) return toText(input);
  if (typeof DecompressionStream === "undefined") {
    throw new Error("gzip chart input is unsupported by this runtime");
  }
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).text()).replace(/^﻿/, "");
}

export function parseSs(input: string | Uint8Array): SsRoot {
  const text = toText(input);
  if (text.trimStart()[0] !== "{") {
    throw new Error("unsupported chart format (not Ss JSON; legacy text charts are not supported)");
  }
  const root: JsonValue = JSON.parse(text);
  if (!isJsonObject(root)) throw new Error("not an Ss chart: root must be an object");

  let version = 0;
  if (root.meta !== undefined) {
    if (!isJsonObject(root.meta) || (root.meta.version !== undefined && typeof root.meta.version !== "number")) {
      throw new Error("not an Ss chart: invalid meta.version");
    }
    version = root.meta.version ?? 0;
  }

  const score = root.score;
  if (!isJsonObject(score) || !Array.isArray(score.notes)) {
    throw new Error("not an Ss chart: missing score.notes");
  }
  const notes: SsRawNote[] = [];
  for (const [index, note] of score.notes.entries()) {
    if (!isSsRawNote(note)) throw new Error(`not an Ss chart: invalid score.notes[${index}]`);
    notes.push(note);
  }

  let events: SsEvents = {};
  if (score.events !== undefined) {
    if (!isSsEvents(score.events)) throw new Error("not an Ss chart: invalid score.events");
    events = score.events;
  }

  return {
    version,
    bpm: events.bpm ?? [],
    sig: events.sig ?? [],
    skill: events.skill ?? [],
    fever: events.fever ?? [],
    call: events.call ?? [],
    notes,
  };
}

export async function parseSsAsync(input: string | Uint8Array): Promise<SsRoot> {
  return parseSs(await decodeSsText(input));
}
