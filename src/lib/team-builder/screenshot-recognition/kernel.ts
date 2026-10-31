// L3 — GEB
// Input: 截图 RGBA、当前 release 的参考图向量与 Lv 字形。
// Output: 卡牌格位、身份候选与可见等级。
// Pos: [Map](../L2-2.md)；截图识别的纯计算核心，app 有同一算法的 Dart 版本。
// Effects/Dependencies: 无副作用。
/** On-device card recognition: grid proposals, identity by masked colour
 * correlation against the release's reference tiles, and the native Lv glyph
 * reader. Pure functions over RGBA rasters so the worker, tests and the app
 * port share one behaviour.
 */
export type CardKind = "members" | "snapshots";
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
export interface ReferenceKind {
  tile: [number, number];
  cardIds: number[];
  vectors: Float32Array[];
}
export interface LocalReference {
  kinds: Record<CardKind, ReferenceKind>;
  glyphs: Record<string, Mask> | null;
  allowedLevels: Record<CardKind, Set<number>> | null;
}
export interface Mask {
  width: number;
  height: number;
  data: Float32Array;
}
export interface Candidate {
  cardId: number;
  variant: "thumbnail";
  score: number;
}
export interface Observation {
  kind: CardKind;
  bbox: [number, number, number, number];
  cardId: number | null;
  status: "recognized" | "needs_confirmation" | "unknown";
  candidates: Candidate[];
  level: { value: number | null; status: "recognized" | "unknown"; reason: string };
}

export const ALGORITHM = "card-tile-glyph-v1";
const WORKING_SIDE = 2048;
const ACCEPT_SCORE = 0.6;
const ACCEPT_MARGIN = 0.06;
const MASK = { top: 0.12, bottom: 0.89, left: 0.09, right: 0.9 };

/** Separable box-filter resample of an RGBA raster region into width × height floats (RGB). */
export function sampleRegion(
  image: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  width: number,
  height: number,
): Float32Array {
  const columns = weights(x, w, width, image.width);
  const rows = weights(y, h, height, image.height);
  const out = new Float32Array(width * height * 3);
  const line = new Float32Array(width * 3);
  for (let ty = 0; ty < height; ty++) {
    out.fill(0, ty * width * 3, (ty + 1) * width * 3);
    const row = rows[ty]!;
    for (let r = 0; r < row.index.length; r++) {
      const sy = row.index[r]!,
        wy = row.weight[r]!;
      line.fill(0);
      for (let tx = 0; tx < width; tx++) {
        const column = columns[tx]!;
        let red = 0,
          green = 0,
          blue = 0;
        for (let c = 0; c < column.index.length; c++) {
          const offset = (sy * image.width + column.index[c]!) * 4,
            wx = column.weight[c]!;
          red += image.data[offset]! * wx;
          green += image.data[offset + 1]! * wx;
          blue += image.data[offset + 2]! * wx;
        }
        line[tx * 3] = red;
        line[tx * 3 + 1] = green;
        line[tx * 3 + 2] = blue;
      }
      const base = ty * width * 3;
      for (let i = 0; i < width * 3; i++) out[base + i]! += line[i]! * wy;
    }
  }
  return out;
}

function weights(start: number, span: number, count: number, limit: number) {
  const step = span / count;
  return Array.from({ length: count }, (_, index) => {
    const from = start + index * step,
      to = from + step;
    const indexList: number[] = [],
      weightList: number[] = [];
    let total = 0;
    for (let p = Math.floor(from); p < Math.ceil(to); p++) {
      const cover = Math.min(to, p + 1) - Math.max(from, p);
      if (cover <= 0) continue;
      indexList.push(Math.min(limit - 1, Math.max(0, p)));
      weightList.push(cover);
      total += cover;
    }
    return { index: indexList, weight: weightList.map((value) => value / total) };
  });
}

/** Zero-mean, unit-length colour vector over the identity mask. */
export function tileVector(rgb: Float32Array, width: number, height: number): Float32Array {
  const top = Math.round(height * MASK.top),
    bottom = Math.round(height * MASK.bottom);
  const left = Math.round(width * MASK.left),
    right = Math.round(width * MASK.right);
  const out = new Float32Array((bottom - top) * (right - left) * 3);
  const mean = [0, 0, 0];
  let n = 0;
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++)
      for (let c = 0; c < 3; c++) {
        const value = rgb[(y * width + x) * 3 + c]!;
        out[n++] = value;
        mean[c]! += value;
      }
  const pixels = n / 3;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    out[i] = out[i]! - mean[i % 3]! / pixels;
    norm += out[i]! * out[i]!;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < n; i++) out[i] = out[i]! / norm;
  return out;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
};

export function matchIdentity(
  image: Raster,
  bbox: [number, number, number, number],
  reference: ReferenceKind,
): Pick<Observation, "cardId" | "status" | "candidates"> {
  const [tw, th] = reference.tile;
  const [x, y, w, h] = bbox;
  const base = tileVector(sampleRegion(image, x, y, w, h, tw, th), tw, th);
  const coarse = reference.vectors
    .map((vector, index) => ({ index, score: dot(base, vector) }))
    .sort((a, b) => b.score - a.score);
  // Box proposals can sit a few pixels off the art; refine the leaders over small shifts and scales.
  const leaders = coarse.slice(0, 6);
  const shifted: Float32Array[] = [];
  for (const scale of [0.96, 1, 1.04])
    for (const dy of [-0.03, -0.015, 0, 0.015, 0.03])
      for (const dx of [-0.03, -0.015, 0, 0.015, 0.03]) {
        const sw = w * scale,
          sh = h * scale;
        const sx = x + (w - sw) / 2 + dx * w,
          sy = y + (h - sh) / 2 + dy * h;
        if (sx < 0 || sy < 0 || sx + sw > image.width || sy + sh > image.height) continue;
        shifted.push(tileVector(sampleRegion(image, sx, sy, sw, sh, tw, th), tw, th));
      }
  const refined = leaders
    .map(({ index, score }) => ({
      index,
      score: Math.max(score, ...shifted.map((vector) => dot(vector, reference.vectors[index]!))),
    }))
    .sort((a, b) => b.score - a.score);
  const candidates = refined.map(({ index, score }) => ({
    cardId: reference.cardIds[index]!,
    variant: "thumbnail" as const,
    score: Math.round(score * 1e6) / 1e6,
  }));
  const best = refined[0],
    second = refined[1];
  if (!best) return { cardId: null, status: "unknown", candidates: [] };
  const accepted = best.score >= ACCEPT_SCORE && (!second || best.score - second.score >= ACCEPT_MARGIN);
  return {
    cardId: accepted ? candidates[0]!.cardId : null,
    status: accepted ? "recognized" : "needs_confirmation",
    candidates: candidates.slice(0, 5),
  };
}

function gray(image: Raster): Float32Array {
  const out = new Float32Array(image.width * image.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4)
    out[i] = 0.299 * image.data[p]! + 0.587 * image.data[p + 1]! + 0.114 * image.data[p + 2]!;
  return out;
}

/** Canny with a 3×3 Sobel, L1 magnitude and hysteresis, as cv2.Canny(gray, low, high). */
export function canny(image: Raster, low: number, high: number): Uint8Array {
  const { width: W, height: H } = image;
  const g = gray(image);
  const magnitude = new Float32Array(W * H);
  const direction = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = g[i - W + 1]! + 2 * g[i + 1]! + g[i + W + 1]! - g[i - W - 1]! - 2 * g[i - 1]! - g[i + W - 1]!;
      const gy = g[i + W - 1]! + 2 * g[i + W]! + g[i + W + 1]! - g[i - W - 1]! - 2 * g[i - W]! - g[i - W + 1]!;
      magnitude[i] = Math.abs(gx) + Math.abs(gy);
      const ax = Math.abs(gx),
        ay = Math.abs(gy);
      direction[i] = ay <= ax * 0.4142 ? 0 : ay >= ax * 2.4142 ? 2 : gx * gy > 0 ? 3 : 1;
    }
  const state = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x,
        m = magnitude[i]!;
      if (m <= low) continue;
      const d = direction[i]!;
      const [a, b] =
        d === 0 ? [i - 1, i + 1] : d === 2 ? [i - W, i + W] : d === 3 ? [i - W - 1, i + W + 1] : [i - W + 1, i + W - 1];
      if (m <= magnitude[a]! || m < magnitude[b]!) continue;
      state[i] = 1;
      if (m > high) {
        state[i] = 2;
        stack.push(i);
      }
    }
  while (stack.length) {
    const i = stack.pop()!;
    for (const n of [i - W - 1, i - W, i - W + 1, i - 1, i + 1, i + W - 1, i + W, i + W + 1])
      if (state[n] === 1) {
        state[n] = 2;
        stack.push(n);
      }
  }
  const edge = new Uint8Array(W * H);
  for (let i = 0; i < edge.length; i++) edge[i] = state[i] === 2 ? 1 : 0;
  return edge;
}

function morph(mask: Uint8Array, W: number, H: number, radius: number, dilate: boolean): Uint8Array {
  const pass = (input: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(input.length);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let hit = dilate ? 0 : 1;
        for (let k = -radius; k <= radius; k++) {
          const xx = horizontal ? x + k : x,
            yy = horizontal ? y : y + k;
          const value = xx < 0 || yy < 0 || xx >= W || yy >= H ? (dilate ? 0 : 1) : input[yy * W + xx]!;
          if (dilate ? value : !value) {
            hit = dilate ? 1 : 0;
            break;
          }
        }
        out[y * W + x] = hit;
      }
    return out;
  };
  return pass(pass(mask, true), false);
}

interface Component {
  label: number;
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
}

function label(mask: Uint8Array, W: number, H: number, value: number, eight: boolean) {
  const labels = new Int32Array(W * H);
  const components: Component[] = [];
  const queue = new Int32Array(W * H);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== value || labels[start]) continue;
    const id = components.length + 1;
    let head = 0,
      tail = 0,
      x0 = W,
      y0 = H,
      x1 = 0,
      y1 = 0;
    queue[tail++] = start;
    labels[start] = id;
    while (head < tail) {
      const i = queue[head++]!,
        x = i % W,
        y = (i - x) / W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!eight && dx && dy)) continue;
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (mask[n] === value && !labels[n]) {
            labels[n] = id;
            queue[tail++] = n;
          }
        }
    }
    components.push({ label: id, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area: tail });
  }
  return { labels, components };
}

/** Share of the bounding box enclosed by the component's outer boundary. */
function enclosedRatio(labels: Int32Array, W: number, c: Component): number {
  const w = c.w + 2,
    h = c.h + 2;
  const seen = new Uint8Array(w * h);
  const inside = (x: number, y: number) => {
    const ix = c.x + x - 1,
      iy = c.y + y - 1;
    return ix >= c.x && iy >= c.y && ix < c.x + c.w && iy < c.y + c.h && labels[iy * W + ix] === c.label;
  };
  const queue = [0];
  seen[0] = 1;
  let outside = 0;
  while (queue.length) {
    const i = queue.pop()!,
      x = i % w,
      y = (i - x) / w;
    if (x > 0 && y > 0 && x < w - 1 && y < h - 1) outside++;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (seen[n] || inside(nx, ny)) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return (c.w * c.h - outside) / (c.w * c.h);
}

const iou = (a: number[], b: number[]) => {
  const x = Math.max(a[0]!, b[0]!),
    y = Math.max(a[1]!, b[1]!);
  const r = Math.min(a[0]! + a[2]!, b[0]! + b[2]!),
    d = Math.min(a[1]! + a[3]!, b[1]! + b[3]!);
  const v = Math.max(0, r - x) * Math.max(0, d - y);
  return v / (a[2]! * a[3]! + b[2]! * b[3]! - v + 1e-8);
};
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Least-squares origin and pitch of positions on a regular lattice. */
function fit(positions: number[], pitch: number): { origin: number; pitch: number } {
  const first = Math.min(...positions);
  const index = positions.map((p) => Math.round((p - first) / pitch));
  if (new Set(index).size < 2) return { origin: first, pitch };
  const n = positions.length,
    mi = index.reduce((a, b) => a + b, 0) / n,
    mp = positions.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    den = 0;
  index.forEach((i, k) => {
    num += (i - mi) * (positions[k]! - mp);
    den += (i - mi) ** 2;
  });
  const slope = num / den;
  return { origin: mp - slope * mi, pitch: slope };
}

interface Proposal {
  kind: CardKind;
  bbox: [number, number, number, number];
}

/** Card cell proposals from closed edge outlines, regularised into the member grid. */
export function grid(image: Raster): Proposal[] {
  const { width: W, height: H } = image;
  const edge = canny(image, 50, 120);
  const closed = morph(morph(edge, W, H, 1, true), W, H, 1, false);
  const candidates: Proposal[] = [];
  const consider = (labels: Int32Array, c: Component) => {
    if (Math.min(c.w, c.h) < 32 || c.w > W * 0.4 || c.h > H * 0.7) return;
    const ratio = c.w / c.h;
    const kind: CardKind | null =
      ratio > 0.68 && ratio < 0.85 ? "members" : ratio > 1.65 && ratio < 1.95 ? "snapshots" : null;
    if (kind && enclosedRatio(labels, W, c) > 0.82) candidates.push({ kind, bbox: [c.x, c.y, c.w, c.h] });
  };
  const outlines = label(closed, W, H, 1, true);
  for (const c of outlines.components) consider(outlines.labels, c);
  const holes = label(closed, W, H, 0, false);
  for (const c of holes.components) if (c.x > 0 && c.y > 0 && c.x + c.w < W && c.y + c.h < H) consider(holes.labels, c);
  const kept: Proposal[] = [];
  for (const box of candidates.sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3]))
    if (!kept.some((other) => iou(box.bbox, other.bbox) > 0.7)) kept.push(box);
  if (!kept.length) return [];
  const groups: Proposal[][] = [];
  for (const box of kept) {
    const group = groups.find(
      (g) =>
        g[0]!.kind === box.kind &&
        Math.abs(g[0]!.bbox[2] - box.bbox[2]) < box.bbox[2] * 0.15 &&
        Math.abs(g[0]!.bbox[3] - box.bbox[3]) < box.bbox[3] * 0.15,
    );
    if (group) group.push(box);
    else groups.push([box]);
  }
  const dominant = groups.reduce((a, b) => (b.length > a.length ? b : a));
  const kind = dominant[0]!.kind;
  let boxes = dominant;
  if (kind === "members" && dominant.length >= 3) {
    const width = Math.trunc(median(dominant.map((b) => b.bbox[2])));
    const height = Math.trunc(median(dominant.map((b) => b.bbox[3])));
    const xs = [...new Set(dominant.map((b) => b.bbox[0]))].sort((a, b) => a - b);
    const ys = [...new Set(dominant.map((b) => b.bbox[1]))].sort((a, b) => a - b);
    const steps = xs
      .slice(1)
      .map((x, i) => x - xs[i]!)
      .filter((d) => d >= width * 0.9 && d < width * 1.5);
    if (steps.length) {
      const fitX = fit(
        dominant.map((b) => b.bbox[0]),
        median(steps),
      );
      const y0 = Math.trunc(median(ys));
      const x0 = Math.round(fitX.origin),
        columns = Math.round((xs.at(-1)! - fitX.origin) / fitX.pitch) + 1;
      const right = Math.min(W, Math.round(fitX.origin + (columns - 1) * fitX.pitch) + width);
      const profile = new Float32Array(H);
      for (let y = 0; y < H; y++) {
        let sum = 0;
        for (let x = Math.max(0, x0); x < right; x++) sum += edge[y * W + x]!;
        profile[y] = sum;
      }
      const smooth = (y: number) => {
        let sum = 0;
        for (let k = -2; k <= 2; k++) sum += profile[y + k] ?? 0;
        return sum / 5;
      };
      let pitchY = 0,
        bestScore = -1;
      for (let candidate = Math.round(height * 1.02); candidate <= Math.round(height * 1.35); candidate++) {
        let score = 0;
        for (let y = y0 % candidate; y <= H - height; y += candidate) score += smooth(Math.min(H - 1, y + height - 1));
        if (score > bestScore) [bestScore, pitchY] = [score, candidate];
      }
      const fitY = fit(
        dominant.map((b) => b.bbox[1]),
        pitchY,
      );
      const rows: number[] = [];
      // Rows above the seeds count too: a screenshot can start mid-list.
      for (let row = Math.floor(-fitY.origin / fitY.pitch); ; row++) {
        const y = Math.round(fitY.origin + row * fitY.pitch);
        if (y + height > H) break;
        if (y >= 0) rows.push(y);
      }
      if (rows.length > 1)
        boxes = rows.flatMap((y) =>
          Array.from({ length: columns }, (_, column): Proposal => {
            const bbox: [number, number, number, number] = [
              Math.round(fitX.origin + column * fitX.pitch),
              y,
              width,
              height,
            ];
            const seed = dominant.find((b) => iou(b.bbox, bbox) > 0.6);
            return { kind, bbox: seed ? seed.bbox : bbox };
          }).filter((b) => b.bbox[0] >= 0 && b.bbox[0] + b.bbox[2] <= W),
        );
    }
  }
  return boxes.sort(
    (a, b) =>
      Math.round(a.bbox[1] / Math.max(1, a.bbox[3] * 0.4)) - Math.round(b.bbox[1] / Math.max(1, b.bbox[3] * 0.4)) ||
      a.bbox[0] - b.bbox[0],
  );
}

// Level reader: port of scripts/recognize/levels.py.

interface Blob {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  mask: Mask;
}

function resizeMask(mask: Mask, width: number, height: number, linear: boolean): Float32Array {
  const out = new Float32Array(width * height);
  const sx = mask.width / width,
    sy = mask.height / height;
  if (linear) {
    for (let y = 0; y < height; y++) {
      const fy = Math.min(mask.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(fy),
        y1 = Math.min(mask.height - 1, y0 + 1),
        ty = fy - y0;
      for (let x = 0; x < width; x++) {
        const fx = Math.min(mask.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(fx),
          x1 = Math.min(mask.width - 1, x0 + 1),
          tx = fx - x0;
        const top = mask.data[y0 * mask.width + x0]! * (1 - tx) + mask.data[y0 * mask.width + x1]! * tx;
        const bottom = mask.data[y1 * mask.width + x0]! * (1 - tx) + mask.data[y1 * mask.width + x1]! * tx;
        out[y * width + x] = top * (1 - ty) + bottom * ty;
      }
    }
    return out;
  }
  const columns = weights(0, mask.width, width, mask.width),
    rows = weights(0, mask.height, height, mask.height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      const row = rows[y]!,
        column = columns[x]!;
      for (let r = 0; r < row.index.length; r++)
        for (let c = 0; c < column.index.length; c++)
          sum += mask.data[row.index[r]! * mask.width + column.index[c]!]! * row.weight[r]! * column.weight[c]!;
      out[y * width + x] = sum;
    }
  return out;
}

function similarity(patch: Mask, reference: Mask): number {
  const w = patch.width * 4,
    h = patch.height * 4;
  const a = resizeMask(patch, w, h, true),
    b = resizeMask(reference, w, h, false);
  let ma = 0,
    mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= a.length;
  mb /= b.length;
  let ab = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma,
      y = b[i]! - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return ab / (Math.sqrt(aa) * Math.sqrt(bb) + 1e-8);
}

function blobs(roi: Raster, threshold: number): Blob[] {
  const { width: W, height: H, data } = roi;
  const white = new Uint8Array(W * H),
    shadow = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = data[p]!,
      g = data[p + 1]!,
      b = data[p + 2]!;
    const lo = Math.min(r, g, b),
      hi = Math.max(r, g, b);
    white[i] = lo > threshold && hi - lo < 65 ? 1 : 0;
    shadow[i] = b > r + 15 && b > g + 15 && r < 180 && g < 180 ? 1 : 0;
  }
  const near = morph(shadow, W, H, 3, true);
  for (let i = 0; i < white.length; i++) white[i] = white[i]! & near[i]!;
  const { labels, components } = label(white, W, H, 1, true);
  return components
    .filter((c) => c.area >= 3)
    .map((c) => {
      const mask = new Float32Array(c.w * c.h);
      for (let y = 0; y < c.h; y++)
        for (let x = 0; x < c.w; x++) mask[y * c.w + x] = labels[(c.y + y) * W + c.x + x] === c.label ? 1 : 0;
      return { x: c.x, y: c.y, w: c.w, h: c.h, area: c.area, mask: { width: c.w, height: c.h, data: mask } };
    })
    .sort((a, b) => a.x - b.x);
}

function crop(image: Raster, x: number, y: number, w: number, h: number): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++)
    data.set(
      image.data.subarray(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + w) * 4),
      row * w * 4,
    );
  return { width: w, height: h, data };
}

interface LevelRead {
  value: number | null;
  candidate?: number;
  reason: string;
  digits?: { score: number; margin: number }[];
  quality?: number;
}

function readOne(image: Raster, font: Record<string, Mask>, allowed: Set<number>, threshold: number): LevelRead {
  const { width: W, height: H } = image;
  const y0 = Math.round(H * 0.64);
  const roi = crop(image, 0, y0, Math.round(W * 0.68), H - y0);
  const cs = blobs(roi, threshold);
  const anchors: [number, Blob, Blob][] = [];
  for (const l of cs) {
    if (l.x > W * 0.18 || l.h < 5 || l.h > H * 0.23 || !(l.w / l.h > 0.2 && l.w / l.h < 1)) continue;
    const sl = similarity(l.mask, font.L!);
    if (sl < 0.55) continue;
    for (const v of cs) {
      if (!(v.x >= l.x + l.w && v.x < l.x + l.w + l.h * 0.95 && v.h / l.h > 0.42 && v.h / l.h < 0.86)) continue;
      if (Math.abs(v.y + v.h - (l.y + l.h)) > 2) continue;
      const sv = similarity(v.mask, font.v!);
      if (sv > 0.4) anchors.push([sl + sv, l, v]);
    }
  }
  if (!anchors.length) return { value: null, reason: "Lv-prefix-not-found" };
  const [, l, v] = anchors.reduce((a, b) => (b[0] > a[0] ? b : a));
  const bottom = l.y + l.h;
  const digits: { character: string; score: number; margin: number; x: number; w: number }[] = [];
  for (const c of cs) {
    if (
      c.x < v.x + v.w + 1 ||
      c.h < l.h * 0.8 ||
      c.h > l.h * 1.5 ||
      Math.abs(c.y + c.h - bottom) > 2 ||
      c.w > c.h * 1.1
    )
      continue;
    if (c.y === 0 || c.x + c.w >= roi.width || c.y + c.h >= roi.height)
      return { value: null, reason: "digit-component-touches-roi-boundary" };
    if (digits.length && c.x - digits.at(-1)!.x - digits.at(-1)!.w > l.h * 0.75) break;
    if (!digits.length && c.x - (v.x + v.w) > l.h * 1.35) continue;
    const ranked = "0123456789"
      .split("")
      .map((character) => [character, similarity(c.mask, font[character]!)] as const)
      .sort((a, b) => b[1] - a[1]);
    digits.push({
      character: ranked[0]![0],
      score: ranked[0]![1],
      margin: ranked[0]![1] - ranked[1]![1],
      x: c.x,
      w: c.w,
    });
    if (digits.length >= 3) break;
  }
  if (!digits.length) return { value: null, reason: "no-complete-digit-components" };
  const value = Number(digits.map((d) => d.character).join(""));
  const score = Math.min(...digits.map((d) => d.score)),
    margin = Math.min(...digits.map((d) => d.margin));
  const good = score > 0.63 && margin > 0.07 && allowed.has(value);
  return {
    value: good ? value : null,
    candidate: value,
    reason: good ? "accepted" : "reject-digit-evidence-or-range",
    digits,
    quality: score + margin,
  };
}

export function readLevel(image: Raster, font: Record<string, Mask>, allowed: Set<number>) {
  const variants = [190, 200, 210].map((t) => readOne(image, font, allowed, t));
  const strong = variants.filter((r) => r.value !== null);
  const weak = variants.filter(
    (r) =>
      r.candidate !== undefined &&
      allowed.has(r.candidate) &&
      r.digits?.length &&
      Math.min(...r.digits.map((d) => d.score)) > 0.45 &&
      Math.min(...r.digits.map((d) => d.margin)) > 0.02,
  );
  const counts = new Map<number, number>();
  for (const r of weak) counts.set(r.candidate!, (counts.get(r.candidate!) ?? 0) + 1);
  const valid = strong.filter((r) => (counts.get(r.value!) ?? 0) >= 2);
  if (!valid.length || counts.size > 1)
    return { value: null, reason: "threshold-variants-disagree-or-no-strong-supported-read" };
  const best = valid.reduce((a, b) => ((b.quality ?? 0) > (a.quality ?? 0) ? b : a));
  return { value: best.value, reason: "accepted" };
}

/** Recognise one screenshot; boxes are returned in the input raster's coordinates. */
export function recognize(input: Raster, reference: LocalReference, options: { kind?: CardKind } = {}): Observation[] {
  const scale = Math.min(1, WORKING_SIDE / Math.max(input.width, input.height));
  const working =
    scale < 1 ? downscale(input, Math.round(input.width * scale), Math.round(input.height * scale)) : input;
  let boxes = grid(working);
  if (options.kind) {
    boxes = boxes.filter((b) => b.kind === options.kind);
    if (!boxes.length) boxes = [{ kind: options.kind, bbox: [0, 0, working.width, working.height] }];
  }
  return boxes.slice(0, 100).map(({ kind, bbox }) => {
    const [x, y, w, h] = bbox;
    const identity = matchIdentity(working, bbox, reference.kinds[kind]);
    let level: Observation["level"] = { value: null, status: "unknown", reason: "level_resources_unavailable" };
    if (reference.glyphs && reference.allowedLevels) {
      const patch = crop(working, x, y, w, Math.min(working.height - y, h + Math.round(h * 0.08)));
      const read = readLevel(patch, reference.glyphs, reference.allowedLevels[kind]);
      level = { value: read.value, status: read.value !== null ? "recognized" : "unknown", reason: read.reason };
    }
    return {
      kind,
      bbox: clampBox(x / scale, y / scale, w / scale, h / scale, input.width, input.height),
      ...identity,
      level,
    };
  });
}

function clampBox(x: number, y: number, w: number, h: number, width: number, height: number): Observation["bbox"] {
  const left = Math.max(0, Math.round(x)),
    top = Math.max(0, Math.round(y));
  return [left, top, Math.min(width - left, Math.round(w)), Math.min(height - top, Math.round(h))];
}

export function downscale(image: Raster, width: number, height: number): Raster {
  const rgb = sampleRegion(image, 0, 0, image.width, image.height, width, height);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[i * 3]!;
    data[i * 4 + 1] = rgb[i * 3 + 1]!;
    data[i * 4 + 2] = rgb[i * 3 + 2]!;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Cut a reference sheet into normalised identity vectors. */
export function referenceKind(
  sheet: Raster,
  tile: [number, number],
  columns: number,
  cardIds: number[],
): ReferenceKind {
  const [tw, th] = tile;
  return {
    tile,
    cardIds,
    vectors: cardIds.map((_, index) =>
      tileVector(sampleRegion(sheet, (index % columns) * tw, Math.floor(index / columns) * th, tw, th, tw, th), tw, th),
    ),
  };
}

export function glyphMasks(glyphs: Record<string, string[]>): Record<string, Mask> {
  return Object.fromEntries(
    Object.entries(glyphs).map(([character, rows]) => {
      const width = rows[0]!.length,
        height = rows.length;
      const data = new Float32Array(width * height);
      rows.forEach((row, y) => {
        for (let x = 0; x < width; x++) data[y * width + x] = row[x] === "1" ? 1 : 0;
      });
      return [character, { width, height, data }];
    }),
  );
}
