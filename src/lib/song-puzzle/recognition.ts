// L3 — GEB
// Input: 有界截图像素、所选封面、阶数及可选裁剪／目标空格。
// Output: 棋盘区域、完整唯一排列、目标空格、待确认格子与可选相似片校正建议。
// Pos: [Map](../L2-2.md)；封面拼图的本地图像匹配与全局分配。
// Effects/Dependencies: 纯 CPU 像素处理；不读取网络、DOM 或账户。
import { goalBoard, solvable } from "./model";
import { readPuzzleLabels } from "./labels";

export interface PuzzlePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
export interface PuzzleCrop {
  x: number;
  y: number;
  side: number;
}
export interface PuzzleRecognition {
  crop: PuzzleCrop;
  tiles: number[];
  goalBlank: number;
  uncertain: number[];
  error: number;
  repair?: number[];
}
interface Feature {
  color: Float32Array;
  luma: Float32Array;
  edge: Float32Array;
}
interface Match {
  crop: PuzzleCrop;
  gap: number;
  assignment: number[];
  costs: number[][];
  error: number;
}

/** Square minimum-cost assignment, including a row and column for the missing fragment and empty cell. */
function assign(cost: number[][]): number[] {
  const n = cost.length,
    u = new Float64Array(n + 1),
    v = new Float64Array(n + 1),
    p = new Int32Array(n + 1),
    way = new Int32Array(n + 1);
  for (let row = 1; row <= n; row++) {
    p[0] = row;
    const distance = new Float64Array(n + 1).fill(Infinity),
      used = new Uint8Array(n + 1);
    let column = 0;
    do {
      used[column] = 1;
      const current = p[column];
      let delta = Infinity,
        next = 0;
      for (let j = 1; j <= n; j++)
        if (!used[j]) {
          const value = cost[current - 1][j - 1] - u[current] - v[j];
          if (value < distance[j]) {
            distance[j] = value;
            way[j] = column;
          }
          if (distance[j] < delta) {
            delta = distance[j];
            next = j;
          }
        }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else distance[j] -= delta;
      }
      column = next;
    } while (p[column]);
    do {
      const previous = way[column];
      p[column] = p[previous];
      column = previous;
    } while (column);
  }
  const result = new Array<number>(n);
  for (let j = 1; j <= n; j++) result[p[j] - 1] = j - 1;
  return result;
}

function sample(image: PuzzlePixels, x: number, y: number, channel: number): number {
  x = Math.max(0, Math.min(image.width - 1.001, x));
  y = Math.max(0, Math.min(image.height - 1.001, y));
  const left = Math.floor(x),
    top = Math.floor(y),
    dx = x - left,
    dy = y - top,
    offset = (top * image.width + left) * 4 + channel;
  return (
    ((image.data[offset] * (1 - dx) + image.data[offset + 4] * dx) * (1 - dy) +
      (image.data[offset + image.width * 4] * (1 - dx) + image.data[offset + image.width * 4 + 4] * dx) * dy) /
    255
  );
}

function feature(
  image: PuzzlePixels,
  x: number,
  y: number,
  width: number,
  height: number,
  resolution: number,
): Feature {
  const color = new Float32Array(resolution * resolution * 3),
    luma = new Float32Array(resolution * resolution),
    edge = new Float32Array(resolution * resolution * 2);
  for (let row = 0; row < resolution; row++)
    for (let col = 0; col < resolution; col++) {
      // Interior sampling excludes frames; the upper-left label is masked in both images.
      const px = x + width * (0.05 + (0.9 * (col + 0.5)) / resolution),
        py = y + height * (0.05 + (0.9 * (row + 0.5)) / resolution),
        index = row * resolution + col,
        r = sample(image, px, py, 0),
        g = sample(image, px, py, 1),
        b = sample(image, px, py, 2);
      luma[index] = 0.299 * r + 0.587 * g + 0.114 * b;
      color[index * 3] = r;
      color[index * 3 + 1] = g;
      color[index * 3 + 2] = b;
    }
  for (let row = 1; row < resolution - 1; row++)
    for (let col = 1; col < resolution - 1; col++) {
      const index = row * resolution + col;
      edge[index * 2] = luma[index + 1] - luma[index - 1];
      edge[index * 2 + 1] = luma[index + resolution] - luma[index - resolution];
    }
  return { color, luma, edge };
}

function difference(a: Feature, b: Feature, resolution: number, small: boolean, labels = true): number {
  let color = 0,
    gradient = 0,
    count = 0,
    structural = 0,
    blocks = 0;
  const block = resolution / 2;
  for (let by = 0; by < 2; by++)
    for (let bx = 0; bx < 2; bx++) {
      let sa = 0,
        sb = 0,
        aa = 0,
        bb = 0,
        ab = 0,
        points = 0;
      for (let y = by * block; y < (by + 1) * block; y++)
        for (let x = bx * block; x < (bx + 1) * block; x++) {
          if (labels && x < resolution * (small ? 2 / 3 : 1 / 3) && y < resolution * (small ? 1 / 2 : 1 / 3)) continue;
          const i = y * resolution + x,
            av = a.luma[i],
            bv = b.luma[i];
          sa += av;
          sb += bv;
          aa += av * av;
          bb += bv * bv;
          ab += av * bv;
          points++;
          for (let c = 0; c < 3; c++) color += Math.min(0.3, Math.abs(a.color[i * 3 + c] - b.color[i * 3 + c]));
          gradient += Math.min(
            0.5,
            Math.abs(a.edge[i * 2] - b.edge[i * 2]) + Math.abs(a.edge[i * 2 + 1] - b.edge[i * 2 + 1]),
          );
          count++;
        }
      if (!points) continue;
      blocks++;
      const ma = sa / points,
        mb = sb / points,
        variance = Math.max(0, aa / points - ma * ma) + Math.max(0, bb / points - mb * mb),
        covariance = ab / points - ma * mb,
        similarity =
          ((2 * ma * mb + 0.0001) * (2 * covariance + 0.0009)) / ((ma * ma + mb * mb + 0.0001) * (variance + 0.0009));
      structural += (1 - Math.max(-1, Math.min(1, similarity))) / 2;
    }
  return (0.55 * structural) / blocks + (0.3 * color) / (count * 0.9) + (0.15 * gradient) / (count * 0.5);
}

function fragments(image: PuzzlePixels, size: number, crop: PuzzleCrop, gap: number, resolution: number): Feature[] {
  const pitch = crop.side / (size - gap),
    width = pitch * (1 - gap);
  return Array.from({ length: size * size }, (_, i) =>
    feature(image, crop.x + (i % size) * pitch, crop.y + Math.floor(i / size) * pitch, width, width, resolution),
  );
}

function emptyCost(feature: Feature, resolution: number, small: boolean): number {
  const indices = Array.from(feature.luma, (_, index) => index).filter((index) => {
    const x = index % resolution,
      y = Math.floor(index / resolution);
    return (
      !small ||
      (!(x < (resolution * 2) / 3 && y < resolution / 2) &&
        (x < resolution / 4 || x >= (resolution * 3) / 4 || y < resolution / 4 || y >= (resolution * 3) / 4))
    );
  });
  const channels = [0, 1, 2].map((channel) =>
    indices.map((index) => feature.color[index * 3 + channel]).sort((a, b) => a - b),
  );
  const median = channels.map((values) => values[Math.floor(values.length / 2)]);
  const distances = indices
    .map(
      (index) =>
        median.reduce((sum, value, channel) => sum + Math.abs(feature.color[index * 3 + channel] - value), 0) / 3,
    )
    .sort((a, b) => a - b);
  // The border ring excludes the blank's center label; trimming tolerates frame and compression residue.
  const count = Math.floor(distances.length * 0.85);
  return Math.min(0.65, Math.sqrt(distances.slice(0, count).reduce((sum, value) => sum + value, 0) / count) * 3);
}

function match(
  image: PuzzlePixels,
  reference: Feature[],
  size: number,
  crop: PuzzleCrop,
  gap: number,
  resolution: number,
  goalBlank?: number,
  labels = true,
): Match {
  const cells = size * size,
    small = crop.side / size < 80,
    observed = fragments(image, size, crop, gap, resolution),
    costs = observed.map((a) => [
      ...reference.map((b) => difference(a, b, resolution, small, labels)),
      emptyCost(a, resolution, small),
    ]);
  costs.push([...new Array<number>(cells).fill(goalBlank === undefined ? 0 : 10000), 10000]);
  if (goalBlank !== undefined) costs[cells][goalBlank] = 0;
  const assignment = assign(costs),
    error = assignment.reduce((total, column, row) => total + costs[row][column], 0) / (cells - 1);
  return { crop, gap, assignment, costs, error };
}

function boundedCrop(crop: PuzzleCrop, image: PuzzlePixels): PuzzleCrop {
  const side = Math.max(24, Math.min(image.width, image.height, crop.side));
  return {
    x: Math.max(0, Math.min(image.width - side, crop.x)),
    y: Math.max(0, Math.min(image.height - side, crop.y)),
    side,
  };
}

function uncertainCells(match: Match): number[] {
  const cells = match.assignment.length - 1,
    uncertain: number[] = [];
  const total = match.assignment.reduce((sum, column, row) => sum + match.costs[row][column], 0);
  for (let row = 0; row < cells; row++) {
    const column = match.assignment[row],
      original = match.costs[row][column];
    match.costs[row][column] = 10000;
    const alternative = assign(match.costs),
      delta = alternative.reduce((sum, col, i) => sum + match.costs[i][col], 0) - total;
    match.costs[row][column] = original;
    if (original > 0.22 || delta < 0.035) uncertain.push(row);
  }
  return uncertain;
}

function blankRegions(image: PuzzlePixels, size: number): PuzzleCrop[] {
  const scale = Math.min(1, 400 / Math.max(image.width, image.height)),
    width = Math.round(image.width * scale),
    height = Math.round(image.height * scale),
    colors = new Float32Array(width * height * 3),
    mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) colors[(y * width + x) * 3 + c] = sample(image, x / scale, y / scale, c);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x,
        offset = index * 3;
      if (Math.max(colors[offset]!, colors[offset + 1]!, colors[offset + 2]!) > 0.32) continue;
      let variation = 0;
      for (const neighbor of [index - width, index + width, index - 1, index + 1])
        for (let c = 0; c < 3; c++)
          variation = Math.max(variation, Math.abs(colors[offset + c]! - colors[neighbor * 3 + c]!));
      if (variation < 0.055) mask[index] = 1;
    }
  const holes: Array<{ x: number; y: number; width: number; height: number; area: number }> = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const stack = [i];
    let left = width,
      right = 0,
      top = height,
      bottom = 0,
      area = 0;
    mask[i] = 0;
    while (stack.length) {
      const index = stack.pop()!,
        x = index % width,
        y = Math.floor(index / width);
      area++;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (const next of [
        x ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y ? index - width : -1,
        y + 1 < height ? index + width : -1,
      ])
        if (next >= 0 && mask[next]) {
          mask[next] = 0;
          stack.push(next);
        }
    }
    const w = right - left + 1,
      h = bottom - top + 1;
    if (Math.min(w, h) >= 5 && w / h > 0.8 && w / h < 1.25 && area > w * h * 0.8)
      holes.push({ x: left, y: top, width: w, height: h, area });
  }
  const regions: PuzzleCrop[] = [];
  for (const hole of holes.sort((a, b) => b.area - a.area).slice(0, 8))
    for (const padding of [1, 2]) {
      const cell = ((hole.width + hole.height) / 2 + padding * 2) / scale,
        side = cell * size;
      if (side > Math.min(image.width, image.height) || side < Math.min(image.width, image.height) * 0.3) continue;
      for (let row = 0; row < size; row++)
        for (let column = 0; column < size; column++) {
          const x = (hole.x - padding) / scale - column * cell,
            y = (hole.y - padding) / scale - row * cell;
          if (
            x >= -cell * 0.1 &&
            y >= -cell * 0.1 &&
            x + side <= image.width + cell * 0.1 &&
            y + side <= image.height + cell * 0.1
          )
            regions.push(boundedCrop({ x, y, side }, image));
        }
    }
  return regions;
}

/** Grid seams, outer frames and square blank regions seed reference-based board selection. */
function locate(image: PuzzlePixels, size: number): PuzzleCrop[] {
  const scale = Math.min(1, 360 / Math.max(image.width, image.height)),
    width = Math.max(2, Math.round(image.width * scale)),
    height = Math.max(2, Math.round(image.height * scale)),
    stride = width + 1,
    vertical = new Float32Array((height + 1) * stride),
    horizontal = new Float32Array(vertical.length);
  const luminance = (x: number, y: number) =>
    sample(image, x / scale, y / scale, 0) * 0.299 +
    sample(image, x / scale, y / scale, 1) * 0.587 +
    sample(image, x / scale, y / scale, 2) * 0.114;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = luminance(x, y),
        i = (y + 1) * stride + x + 1,
        dx = Math.abs(value - luminance(x + 1, y)),
        dy = Math.abs(value - luminance(x, y + 1));
      vertical[i] = dx + vertical[i - 1] + vertical[i - stride] - vertical[i - stride - 1];
      horizontal[i] = dy + horizontal[i - 1] + horizontal[i - stride] - horizontal[i - stride - 1];
    }
  const sum = (integral: Float32Array, x: number, y: number, w: number, h: number) => {
    const x1 = Math.max(0, Math.min(width, Math.round(x))),
      y1 = Math.max(0, Math.min(height, Math.round(y))),
      x2 = Math.max(x1, Math.min(width, Math.round(x + w))),
      y2 = Math.max(y1, Math.min(height, Math.round(y + h)));
    return (
      integral[y2 * stride + x2] - integral[y1 * stride + x2] - integral[y2 * stride + x1] + integral[y1 * stride + x1]
    );
  };
  const candidates: Array<PuzzleCrop & { score: number }> = [];
  const frames: Array<PuzzleCrop & { score: number }> = [];
  const keep = (list: typeof candidates, candidate: (typeof candidates)[number]) => {
    if (list.length === 100 && candidate.score <= list[list.length - 1]!.score) return;
    list.push(candidate);
    list.sort((a, b) => b.score - a.score);
    if (list.length > 100) list.pop();
  };
  const limit = Math.min(width, height);
  for (let side = Math.max(size * 7, limit * 0.32); side <= limit; side += Math.max(3, side * 0.045)) {
    const step = Math.max(3, side / (size * 3));
    for (let y = 0; y + side <= height; y += step)
      for (let x = 0; x + side <= width; x += step) {
        let seams = 0;
        for (let line = 1; line < size; line++) {
          seams += sum(vertical, x + (line * side) / size - 1, y, 2, side);
          seams += sum(horizontal, x, y + (line * side) / size - 1, side, 2);
        }
        const texture = (sum(vertical, x, y, side, side) + sum(horizontal, x, y, side, side)) / (side * side);
        const score = seams / (4 * side * (size - 1)) - texture * 0.7;
        keep(candidates, { x, y, side, score });
        const left = sum(vertical, x - 1, y, 2, side),
          right = sum(vertical, x + side - 1, y, 2, side),
          top = sum(horizontal, x, y - 1, side, 2),
          bottom = sum(horizontal, x, y + side - 1, side, 2);
        keep(frames, {
          x,
          y,
          side,
          score: (Math.min(left, right) + Math.min(top, bottom)) / (4 * side) - texture * 0.15,
        });
      }
  }
  const regions: PuzzleCrop[] = [];
  for (const candidate of [...frames.slice(0, 30), ...candidates]) {
    if (
      regions.some(
        (region) =>
          Math.abs(region.x - candidate.x) + Math.abs(region.y - candidate.y) + Math.abs(region.side - candidate.side) <
          candidate.side * 0.12,
      )
    )
      continue;
    regions.push(candidate);
    if (regions.length >= 24) break;
  }
  for (const ratio of [1, 0.8, 0.6]) {
    const side = limit * ratio;
    regions.push({ x: (width - side) / 2, y: (height - side) / 2, side });
  }
  return [
    ...blankRegions(image, size),
    ...regions.map(({ x, y, side }) => boundedCrop({ x: x / scale, y: y / scale, side: side / scale }, image)),
  ];
}

export function recognizePuzzle(
  image: PuzzlePixels,
  cover: PuzzlePixels,
  size: number,
  crop?: PuzzleCrop,
  missing?: number,
): PuzzleRecognition {
  if (!Number.isInteger(size) || size < 3 || size > 8) throw new RangeError("size");
  const coverCrop = { x: 0, y: 0, side: Math.min(cover.width, cover.height) },
    coarse = fragments(cover, size, coverCrop, 0, 6),
    fine = fragments(cover, size, coverCrop, 0, 12);
  const candidates = (crop ? [boundedCrop(crop, image)] : locate(image, size))
    .map(
      (region) =>
        [0, 0.04, 0.09]
          .map((gap) => match(image, coarse, size, region, gap, 6, missing))
          .sort((a, b) => a.error - b.error)[0]!,
    )
    .sort((a, b) => a.error - b.error)
    .slice(0, crop ? 1 : 3);
  let best: Match | undefined;
  for (const candidate of candidates) {
    let current = match(image, fine, size, candidate.crop, candidate.gap, 12, missing);
    for (let step = (candidate.crop.side / size) * 0.12; step >= 0.5; step /= 2) {
      for (let pass = 0; pass < 2; pass++)
        for (const axis of ["x", "y", "side"] as const)
          for (const direction of [-1, 1]) {
            const region = boundedCrop({ ...current.crop, [axis]: current.crop[axis] + step * direction }, image),
              next = match(image, fine, size, region, current.gap, 12, missing);
            if (next.error < current.error) current = next;
          }
      for (const gap of [0, 0.02, 0.04, 0.06, 0.085]) {
        const next = match(image, fine, size, current.crop, gap, 12, missing);
        if (next.error < current.error) current = next;
      }
    }
    if (!best || current.error < best.error) best = current;
  }
  if (!best || best.error > 0.36) throw new Error("no-match");
  // Refine spacing continuously as well as the crop; a pixel of bias hides fine text on small tiles.
  for (const step of [0.5, 0.25])
    for (let pass = 0; pass < 2; pass++) {
      for (const axis of ["x", "y", "side"] as const)
        for (const direction of [-1, 1]) {
          const region = boundedCrop({ ...best.crop, [axis]: best.crop[axis] + step * direction }, image),
            next = match(image, fine, size, region, best.gap, 12, missing);
          if (next.error < best.error) best = next;
        }
      for (const direction of [-1, 1]) {
        const gap = Math.max(0, Math.min(0.15, best.gap + (direction * step * size) / best.crop.side)),
          next = match(image, fine, size, best.crop, gap, 12, missing);
        if (next.error < best.error) best = next;
      }
    }
  const visualReference = fragments(cover, size, coverCrop, 0, 24),
    observed = fragments(image, size, best.crop, best.gap, 24),
    labelEvidence = best.assignment
      .slice(0, size * size)
      .flatMap((source, row) => {
        if (source >= size * size || best!.costs[row]![source]! > 0.18) return [];
        const a = observed[row]!,
          b = visualReference[source]!,
          small = best!.crop.side / size < 80;
        return [difference(a, b, 24, small, false) - difference(a, b, 24, small, true)];
      })
      .sort((a, b) => a - b),
    labels = labelEvidence.length >= 4 && labelEvidence[Math.floor(labelEvidence.length / 2)]! > 0.012;
  best = match(image, visualReference, size, best.crop, best.gap, 24, missing, labels);
  const detail = match(image, fragments(cover, size, coverCrop, 0, 36), size, best.crop, best.gap, 36, missing, labels),
    scaleDisagreement = best.assignment
      .slice(0, size * size)
      .flatMap((source, row) => (source === detail.assignment[row] ? [] : [row])),
    combined = best.costs.map((row, i) => row.map((value, j) => value * 0.65 + detail.costs[i]![j]! * 0.35)),
    combinedAssignment = assign(combined);
  best = {
    ...best,
    costs: combined,
    assignment: combinedAssignment,
    error: combinedAssignment.reduce((sum, column, row) => sum + combined[row]![column]!, 0) / (size * size - 1),
  };
  if (best.error > 0.36) throw new Error("no-match");
  let uncertain = uncertainCells(best);
  const anchors = best.assignment
    .slice(0, size * size)
    .flatMap((source, row) =>
      source < size * size && !uncertain.includes(row) && best!.costs[row][source] < 0.18 ? [{ row, source }] : [],
    );
  const hints = labels
    ? readPuzzleLabels(image, size, best.crop, best.gap, anchors, goalBoard(size, best.assignment[size * size]))
    : new Map<number, number>();
  if (hints.size) {
    const visual = best.costs,
      costs = visual.map((row) => [...row]),
      ambiguousSources = new Set(uncertain.map((row) => best!.assignment[row]));
    ambiguousSources.add(best.assignment[size * size]);
    for (const [row, source] of hints) {
      if (visual[row][source] > 0.22) continue;
      if (source !== best.assignment[row] && (!uncertain.includes(row) || !ambiguousSources.has(source))) continue;
      for (let col = 0; col < costs[row].length; col++) if (col !== source) costs[row][col] += 0.5;
    }
    const assignment = assign(costs),
      error = assignment.reduce((sum, col, row) => sum + visual[row][col], 0) / (size * size - 1);
    best = { ...best, costs, assignment, error };
    uncertain = uncertainCells(best);
  }
  const cells = size * size,
    goalBlank = best.assignment[cells],
    goal = goalBoard(size, goalBlank),
    tiles = best.assignment.slice(0, cells).map((source) => (source === cells ? 0 : goal[source]));
  uncertain = [...new Set([...uncertain, ...scaleDisagreement.filter((row) => !hints.has(row))])].sort((a, b) => a - b);
  let repair: number[] | undefined,
    repairCost = 0.025;
  if (best.error < 0.12 && !solvable({ size, tiles, goal }))
    for (let i = 0; i < uncertain.length; i++)
      for (let j = i + 1; j < uncertain.length; j++) {
        const a = uncertain[i]!,
          b = uncertain[j]!,
          sourceA = best.assignment[a]!,
          sourceB = best.assignment[b]!;
        if (!tiles[a] || !tiles[b] || hints.has(a) || hints.has(b)) continue;
        const first = best.costs[a]![sourceB]!,
          second = best.costs[b]![sourceA]!,
          cost = first + second - best.costs[a]![sourceA]! - best.costs[b]![sourceB]!;
        if (first > 0.1 || second > 0.1 || cost >= repairCost) continue;
        repairCost = cost;
        repair = [...tiles];
        [repair[a], repair[b]] = [repair[b]!, repair[a]!];
      }
  return { crop: best.crop, tiles, goalBlank, uncertain, error: best.error, repair };
}
