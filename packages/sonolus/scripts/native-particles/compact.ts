// Compact, hand-authored native Sonolus particles for the Our Notes hit
// effects (opt-in: SONOLUS_PARTICLE_MODE=compact in build-original-assets).
//
// The traced compiler (compile.ts) reproduces effect001 frame by frame, which
// costs ~40 MB of particle JSON (≈40k particle groups) and up to ~80 sprites
// per plane per hit. This module instead rebuilds each effect from the
// prefab's own structure (effect-spec digest of effect001/effect001Light):
//
//   ef_wall_center      a gradient wall rising from the judgment line
//   frame               the note frame flash lying on the judgment line
//   ef_particle_point   glow points drifting upward (Perfect, Great)
//   ef_particle_star    star sparkles drifting upward (Perfect only)
//
// with the per-type colours serialized in the prefabs and the per-judgement
// component switches of the tap_perfect/great/good/bad clips (Good keeps the
// wall and frame; Bad greys them). Every effect keeps the engine's existing
// name/id layout (profile × width × plane), so the engine is unchanged; only
// plane P0 carries particles and P1..P3 are empty. A hit spawns at most ~14
// particles from 4 tiny procedurally drawn sprites.

import { deflateSync } from "node:zlib";
import { NATIVE_EFFECT_WIDTHS } from "./compile.ts";

type Json = Record<string, unknown>;
type Rgb = readonly [number, number, number];
type Expr = Partial<Record<"c" | "r1" | "r2" | "r3" | "r4" | "r5" | "r6" | "r7" | "r8", number>>;
type Channel = { from: Expr; to: Expr; ease?: string };

interface Palette {
  wall: Rgb;
  point: Rgb;
  frame: Rgb;
}

// Light-prefab startColor / SpriteRenderer colours (effect-spec digest).
const PALETTES: Record<string, Palette> = {
  Normal: { wall: [0, 0.388, 1], point: [0.08, 0.364, 1], frame: [0.078, 0.234, 0.868] },
  Slide: { wall: [0.325, 0.09, 1], point: [0.32, 0.115, 0.906], frame: [0.29, 0.051, 0.981] },
  Connect: { wall: [0.325, 0.09, 1], point: [0.333, 0.137, 0.886], frame: [0.392, 0.182, 0.991] },
  "Slide Loop": { wall: [0.301, 0.068, 0.962], point: [0.32, 0.115, 0.906], frame: [0.298, 0.052, 1] },
  Flick: { wall: [1, 0.46, 0.175], point: [0.896, 0.392, 0.123], frame: [0.679, 0.306, 0.067] },
  "Flick Left": { wall: [0.099, 0.774, 0.224], point: [0.209, 0.906, 0.34], frame: [0.039, 0.557, 0.145] },
  "Flick Right": { wall: [0.708, 0.137, 0.601], point: [0.915, 0.272, 0.799], frame: [1, 0.156, 0.659] },
};
const BAD_WALL: Rgb = [0.283, 0.283, 0.283];
const BAD_FRAME: Rgb = [0.4, 0.4, 0.4];

const PROFILES = ["Our Notes Light", "Our Notes Native", "Our Notes Simple"] as const;
const JUDGEMENTS = [
  { suffix: "", level: 5 },
  { suffix: " Great", level: 4 },
  { suffix: " Good", level: 3 },
  { suffix: " Bad", level: 2 },
] as const;
const BASES = ["Normal", "Slide", "Flick", "Flick Left", "Flick Right", "Connect"] as const;
const PLANES = ["P0", "P1", "P2", "P3"] as const;

// ------------------------------------------------------------------ sprites
const SPRITE = { wall: 0, frame: 1, dot: 2, star: 3, strip: 4 } as const;
const TILE = 64;
const ATLAS_W = TILE * 5;
const ATLAS_H = TILE;

function drawAtlas(): Buffer {
  const pixels = Buffer.alloc(ATLAS_W * ATLAS_H * 4);
  const put = (tile: number, x: number, y: number, a: number) => {
    const o = (y * ATLAS_W + tile * TILE + x) * 4;
    pixels[o] = 255;
    pixels[o + 1] = 255;
    pixels[o + 2] = 255;
    pixels[o + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
  };
  const smooth = (e0: number, e1: number, v: number) => {
    const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const u = (x + 0.5) / TILE; // 0..1 left→right
      const v = (y + 0.5) / TILE; // 0 top .. 1 bottom (judgment end)
      const edge = smooth(0, 0.12, u) * smooth(0, 0.12, 1 - u);
      // ef_wall: bright at the judgment end, fading toward the top.
      put(SPRITE.wall, x, y, edge * v ** 1.6);
      // ef_tap_line: thin glowing frame.
      const fx = Math.min(u, 1 - u) * 2;
      const fy = Math.min(v, 1 - v) * 2;
      const d = Math.min(fx * 4, fy);
      put(SPRITE.frame, x, y, Math.exp(-((d - 0.18) ** 2) / 0.012) * smooth(0, 0.05, Math.min(fx, fy)));
      // soft glow point
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      put(SPRITE.dot, x, y, Math.exp(-(r * r) * 5) * smooth(1, 0.85, r));
      // four-point sparkle (ef_tap_particle_star)
      const ax = Math.abs(u - 0.5) * 2;
      const ay = Math.abs(v - 0.5) * 2;
      const ray = Math.max(Math.exp(-ax * 14) * (1 - ay), Math.exp(-ay * 14) * (1 - ax));
      put(SPRITE.star, x, y, Math.min(1, ray * 1.4 + Math.exp(-(r * r) * 30)));
      // lane strip: full width, bright at the judgment end.
      put(SPRITE.strip, x, y, smooth(0, 0.06, u) * smooth(0, 0.06, 1 - u) * v ** 1.2);
    }
  }
  return pixels;
}

// ------------------------------------------------------------------ helpers
const hex = (rgb: Rgb, lift = 0) =>
  "#" +
  rgb
    .map((c) => Math.round(Math.min(1, c + (1 - c) * lift) * 255))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("");
const k = (c: number): Expr => (c === 0 ? {} : { c });
const ch = (from: Expr, to: Expr = from, ease = "linear"): Channel => ({ from, to, ease });

function particle(
  sprite: number,
  color: string,
  start: number,
  duration: number,
  p: { x: Channel; y: Channel; w: Channel; h: Channel; a: Channel; r?: Channel },
): Json {
  return { sprite, color, start, duration, ...p, r: p.r ?? { from: {}, to: {} } };
}

/**
 * Hit effect in plane P0's local frame: x ±1 spans the note, the judgment line
 * is y = +1 and negative y points up the screen (matching the traced effects).
 * `aspect` converts a local y length into the x length that looks equal on
 * screen for this width bucket.
 */
function hitEffect(palette: Palette, level: number, width: number, profile: number): Json[] {
  const aspect = 4.4 / width;
  const bad = level === 2;
  const wall = bad ? BAD_WALL : palette.wall;
  const frame = bad ? BAD_FRAME : palette.frame;
  const groups: Json[] = [];
  const wallHeight = profile === 2 ? 1.6 : 2.4;

  // ef_wall_center: grows upward from the line (sizeY curve) and fades.
  groups.push({
    count: 1,
    particles: [
      particle(SPRITE.wall, hex(wall, 0.25), 0, 0.75, {
        x: ch({}),
        w: ch(k(1.02), k(1.04)),
        y: ch(k(1.15 - 0.45), k(1.15 - wallHeight), "outQuad"),
        h: ch(k(0.45), k(wallHeight), "outQuad"),
        a: ch(k(bad ? 0.55 : 0.9), {}, "inQuad"),
      }),
    ],
  });
  // frame: flashes on the judgment line and widens slightly.
  groups.push({
    count: 1,
    particles: [
      particle(SPRITE.frame, hex(frame, 0.35), 0, 1, {
        x: ch({}),
        w: ch(k(1.04), k(1.12), "outQuad"),
        y: ch(k(1)),
        h: ch(k(0.32), k(0.38), "outQuad"),
        a: ch(k(1), {}, "inQuad"),
      }),
    ],
  });
  if (level >= 4) {
    // ef_particle_point: points spread across the note, drifting up.
    const count = profile === 1 ? 10 : profile === 2 ? 4 : 6;
    const size = 0.2;
    groups.push({
      count,
      particles: [
        particle(SPRITE.dot, hex(palette.point, 0.45), 0, 0.85, {
          x: ch({ c: -0.95, r1: 1.9 }),
          y: ch(k(1), { c: 0.6, r2: -2.6 }, "outCubic"),
          w: ch({ c: size * aspect * 0.5, r3: size * aspect }, {}, "inQuad"),
          h: ch({ c: size * 0.5, r3: size }, {}, "inQuad"),
          a: ch(k(1), {}, "inQuad"),
        }),
      ],
    });
  }
  if (level >= 5 && profile !== 2) {
    // ef_particle_star: fewer, larger sparkles.
    const count = profile === 1 ? 5 : 3;
    const size = 0.34;
    groups.push({
      count,
      particles: [
        particle(SPRITE.star, hex(palette.point, 0.6), 0.05, 0.9, {
          x: ch({ c: -0.85, r4: 1.7 }),
          y: ch({ c: 0.9, r5: 0.2 }, { c: 0.2, r6: -1.8 }, "outQuad"),
          w: ch({ c: size * aspect * 0.4, r7: size * aspect }, {}, "inQuad"),
          h: ch({ c: size * 0.4, r7: size }, {}, "inQuad"),
          a: ch(k(1), {}, "inCubic"),
        }),
      ],
    });
  }
  return groups;
}

/** Held-slide loop (spawned looping for one second): a soft wall pulse and a couple of points. */
function loopEffect(palette: Palette, width: number, profile: number): Json[] {
  const aspect = 4.4 / width;
  const groups: Json[] = [
    {
      count: 1,
      particles: [
        particle(SPRITE.wall, hex(palette.wall, 0.25), 0, 0.5, {
          x: ch({}),
          w: ch(k(1)),
          y: ch(k(1.15 - 0.8), k(1.15 - 1.0), "inOutSine"),
          h: ch(k(0.8), k(1.0), "inOutSine"),
          a: ch(k(0.45), k(0.65), "inOutSine"),
        }),
        particle(SPRITE.wall, hex(palette.wall, 0.25), 0.5, 0.5, {
          x: ch({}),
          w: ch(k(1)),
          y: ch(k(1.15 - 1.0), k(1.15 - 0.8), "inOutSine"),
          h: ch(k(1.0), k(0.8), "inOutSine"),
          a: ch(k(0.65), k(0.45), "inOutSine"),
        }),
      ],
    },
  ];
  if (profile !== 2) {
    groups.push({
      count: profile === 1 ? 4 : 2,
      particles: [0, 0.5].map((start) =>
        particle(SPRITE.dot, hex(palette.point, 0.45), start, 0.5, {
          x: ch({ c: -0.9, r1: 1.8 }),
          y: ch(k(1), { c: 0.2, r2: -1.2 }, "outQuad"),
          w: ch({ c: 0.05 * aspect, r3: 0.06 * aspect }, {}, "inQuad"),
          h: ch({ c: 0.05, r3: 0.06 }, {}, "inQuad"),
          a: ch(k(1), {}, "inQuad"),
        }),
      ),
    });
  }
  return groups;
}

/** LiveLaneEffectView fill: one strip per lit lane, rising and fading. */
function laneEffect(color: Rgb, alpha: number): Json[] {
  return [
    {
      count: 1,
      particles: [
        particle(SPRITE.strip, hex(color, 0.2), 0, 1, {
          x: ch({}),
          w: ch(k(1)),
          y: ch(k(1 - 3), k(1 - 4), "outQuad"),
          h: ch(k(3), k(4), "outQuad"),
          a: ch(k(alpha), {}, "inQuad"),
        }),
      ],
    },
  ];
}

const identityTransform = {
  x1: { x1: 1 },
  y1: { y1: 1 },
  x2: { x2: 1 },
  y2: { y2: 1 },
  x3: { x3: 1 },
  y3: { y3: 1 },
  x4: { x4: 1 },
  y4: { y4: 1 },
};

export function compileCompactParticles(): {
  effects: Json[];
  atlas: { width: number; height: number; sprites: Json[]; pixels: Buffer };
} {
  const effects: Json[] = [];
  const add = (name: string, groups: Json[]) => effects.push({ name, transform: identityTransform, groups });

  add("Our Notes Lane In Vain", laneEffect([0.45, 0.45, 0.55], 0.35));
  add("Our Notes Lane Normal", laneEffect(PALETTES.Normal!.wall, 0.6));
  add("Our Notes Lane Slide", laneEffect(PALETTES.Slide!.wall, 0.6));
  add("Our Notes Lane Flick", laneEffect(PALETTES.Flick!.wall, 0.6));
  add("Our Notes Lane Flick Left", laneEffect(PALETTES["Flick Left"]!.wall, 0.6));
  add("Our Notes Lane Flick Right", laneEffect(PALETTES["Flick Right"]!.wall, 0.6));

  PROFILES.forEach((prefix, profile) => {
    for (const base of BASES) {
      for (const { suffix, level } of JUDGEMENTS) {
        for (const width of NATIVE_EFFECT_WIDTHS) {
          for (const plane of PLANES) {
            add(
              `${prefix} ${base}${suffix} W${width} ${plane}`,
              plane === "P0" ? hitEffect(PALETTES[base]!, level, width, profile) : [],
            );
          }
        }
      }
    }
    for (const width of NATIVE_EFFECT_WIDTHS) {
      for (const plane of PLANES) {
        add(
          `${prefix} Slide Loop W${width} ${plane}`,
          plane === "P0" ? loopEffect(PALETTES["Slide Loop"]!, width, profile) : [],
        );
      }
    }
  });

  const sprites = Object.values(SPRITE).map((index) => ({ x: index * TILE + 1, y: 1, w: TILE - 2, h: TILE - 2 }));
  return { effects, atlas: { width: ATLAS_W, height: ATLAS_H, sprites, pixels: drawAtlas() } };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal RGBA8 PNG encoder for the compact atlas. */
export function encodeCompactAtlasPng(width: number, height: number, pixels: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
