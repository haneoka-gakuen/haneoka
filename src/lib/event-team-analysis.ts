// L3 — GEB
// Input: Related saved activity song decks, pinned rules and attainable character rank caps.
// Output: Up to ten distinct, high-growth configurations with exact witnesses for every song.
// Pos: [Map](L2-2.md); activity inverse search over effective bonuses and bounded historical growth.
// Effects/Dependencies: Local CPU only; cooperative best-first search and full shared-formula verification.
import type { SongRankingRowDto } from "./game-records";
import { dataRows, type TeamBuilderData } from "./team-builder/data";
import { compileFromTeamData } from "./team-builder/engine/master";
import { eventCharacterRankCaps, type EventTeamGrowthSources } from "./event-team-growth-limits";
import {
  memberLevelCap, resolveMember, resolveSnap, snapLevelCap, teamPower, slotBase, snapPoints, leaderPoints,
  leaderPercents, leaderProfile, memberEventPercent, snapEventPercent, pctFloor, points,
  type PlayerState, type MemberState, type SnapState, type MusicView,
} from "./team-builder/engine/power";

export interface EventTeamReading { row: SongRankingRowDto; challengeId: number }
export interface EventTeamWitness {
  challengeId: number;
  levels: number[];
  instruments: number[];
  totalRank: { min: number; max: number };
  totalValue?: number;
}
export interface EventTeamConfiguration {
  characters: Array<{ id: number; level: number; minLevel?: number; cap: number }>;
  instruments: Array<{ id: number; total: number; minTotal?: number; cap: number }>;
  totalRank: { min: number; max: number };
  vipBonus: number;
  matchedChallenges: number[];
  relaxed: boolean;
  changed: boolean;
  witnesses: EventTeamWitness[];
}
export interface EventTeamAnalysis {
  status: "ready" | "missingGrowth" | "missingRules" | "noMatch" | "conflictingRecords";
}
export type EventTeamSearch = Generator<EventTeamConfiguration | null, EventTeamAnalysis>;
export interface EventTeamSearchPage {
  id: number;
  page: number;
  rows: EventTeamConfiguration[];
  count: number;
  complete: boolean;
  status: EventTeamAnalysis["status"];
}
interface Box { lo: number[]; hi: number[]; cost: number; order: number; shift?: number; configuration?: EventTeamConfiguration }
class SearchQueue {
  private items: Box[] = [];
  get size() { return this.items.length; }
  private before(a: Box, b: Box) { return a.cost < b.cost || a.cost === b.cost && a.order < b.order; }
  push(box: Box) {
    let index = this.items.length;
    this.items.push(box);
    while (index) {
      const parent = (index - 1) >>> 1;
      if (this.before(this.items[parent]!, box)) break;
      this.items[index] = this.items[parent]!; index = parent;
    }
    this.items[index] = box;
  }
  pop() {
    const first = this.items[0]!, last = this.items.pop()!;
    if (this.items.length) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.before(this.items[child + 1]!, this.items[child]!)) child++;
        if (this.before(last, this.items[child]!)) break;
        this.items[index] = this.items[child]!; index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

export function createEventTeamAnalyzer(data: TeamBuilderData, sources: EventTeamGrowthSources, asOf: number) {
  const master = compileFromTeamData(data), rankCaps = eventCharacterRankCaps(data, master, sources, asOf);
  const rankRows = [...master.characterRankBonus].sort((a, b) => a[0] - b[0]);
  const rankMinimum = rankRows[0]?.[0] ?? 0;
  const totalCap = [...rankCaps.values()].reduce((sum, value) => sum + value, 0);
  const totals = [...master.totalRankBonus].filter(([threshold]) => threshold <= totalCap).sort((a, b) => a[0] - b[0])
    .map(([min, bonus], index, rows) => ({ min, bonus, max: Math.min(totalCap, (rows[index + 1]?.[0] ?? totalCap + 1) - 1) }));
  const vipRanks = new Map<number, number>([[0, 1]]);
  for (const [rank, bonus] of master.vipBonus) if (!vipRanks.has(bonus)) vipRanks.set(bonus, rank);
  const vipBonuses = [...vipRanks.keys()].sort((a, b) => b - a);
  const memories = Object.entries(data.runtimeRules?.tables ?? {}).filter(([key]) => key.startsWith("memory"));
  const memoryEmpty = memories.length === 5 && memories.every(([, table]) => table.status === "empty");
  const linearRanks = rankRows.length > 1 && rankRows.every(([rank, bonus], index) => rank === rankMinimum + index && bonus === index * 5)
    && totals.every((total) => total.bonus % 5 === 0);
  const level = (kind: "memberCardLevels" | "supportCardLevels", group: number, exp: number) => {
    let found = 0;
    for (const row of data.progression[kind] ?? [])
      if (row.group === group && Number(row.exp) <= exp) found = Math.max(found, Number(row.level));
    return found;
  };
  const emptyPlayer = (): PlayerState => ({ characterRanks: new Map(), totalRank: 0, bandItems: new Map(),
    vipRank: 1, characterMemory: new Map(), musicMemory: new Map() });
  const prepare = (row: SongRankingRowDto, eventId: number, challengeId: number) => {
    if (!row.totalPower || row.cards.length !== 5) return null;
    const team: MemberState[] = [], supports: Array<SnapState | null> = [];
    for (const card of row.cards) {
      const member = card.memberCardId ? master.members.get(card.memberCardId) : undefined;
      if (!member || card.memberExp === null || card.memberAwakeCount === null || card.memberRank === null) return null;
      const resolved = resolveMember(master, String(card.slot), member, {
        level: Math.min(level("memberCardLevels", member.levelGroup, card.memberExp), memberLevelCap(master, member, card.memberAwakeCount)),
        awake: card.memberAwakeCount, rank: card.memberRank, liveSkillLevel: 1, gekisoSkillLevel: 1,
      });
      if (!resolved) return null;
      team.push(resolved);
      if (!card.supportCardId) supports.push(null);
      else {
        const support = master.snaps.get(card.supportCardId);
        if (!support || card.supportExp === null || card.supportRank === null) return null;
        const resolved = resolveSnap(master, String(card.slot), support, {
          level: Math.min(level("supportCardLevels", support.levelGroup, card.supportExp), snapLevelCap(master, support, card.supportRank)), rank: card.supportRank,
        });
        if (!resolved) return null;
        supports.push(resolved);
      }
    }
    const challenge = master.challengeMusics.find((song) => song.id === challengeId && song.eventId === eventId);
    const song = challenge && master.songs.get(challenge.liveMusicId);
    if (!song || new Set(team.map((member) => member.card.characterId)).size !== 5) return null;
    const music: MusicView = { musicType: challenge!.musicType || song.musicType, bestTags: song.bestTags, memoryKey: song.id };
    const percents = leaderPercents(master, leaderProfile(master, team[2]!), team, 2, music);
    const signature = JSON.stringify(team.map((member, index) => [member.card.characterId, member.card.id,
      member.growth.level, member.growth.awake, member.growth.rank, supports[index]?.card.id ?? 0,
      supports[index]?.growth.level ?? 0, supports[index]?.growth.rank ?? 0, percents[index],
      member.card.cardType === 99 || music.musicType === 99 || member.card.cardType === music.musicType,
      member.card.bestTags.some((tag) => music.bestTags.includes(tag)),
    ]).sort((a, b) => Number(a[0]) - Number(b[0])));
    return { row, team, supports, music, percents, challengeId, signature };
  };

  return function* (row: SongRankingRowDto, eventId: number, challengeId: number, _after?: undefined,
    related: EventTeamReading[] = []): EventTeamSearch {
    const result: EventTeamAnalysis = { status: "missingGrowth" };
    const initial = prepare(row, eventId, challengeId);
    if (!initial) return result;
    const event = master.events.get(eventId);
    result.status = "missingRules";
    if (!event || !memoryEmpty || !linearRanks || !rankMinimum) return result;
    const others = related.filter((reading) => reading.challengeId !== challengeId && row.profileId && reading.row.profileId === row.profileId)
      .map((reading) => prepare(reading.row, eventId, reading.challengeId));
    if (others.some((reading) => !reading)) { result.status = "missingGrowth"; return result; }
    const observations = [initial, ...others.filter((reading) => reading !== null)].sort((a, b) => a.challengeId - b.challengeId);
    const unique = observations.filter((reading, index) => !observations.slice(0, index)
      .some((prior) => prior.signature === reading.signature && prior.row.totalPower === reading.row.totalPower));
    const conflict = unique.some((reading, index) => unique.slice(0, index).some((prior) => prior.signature === reading.signature));
    const ids = [...new Set(observations.flatMap((reading) => reading.team.map((member) => member.card.characterId)))].sort((a, b) => a - b);
    const caps = ids.map((id) => rankCaps.get(id)!), size = ids.length, unseenCount = master.characters.size - size;
    const unseenCap = totalCap - caps.reduce((sum, value) => sum + value, 0);
    const bands = [...new Set(observations.flatMap((reading) => reading.team.map((member) => member.card.bandId)))].sort((a, b) => a - b).map((id) => {
      const items = Object.values(data.bandItems).filter((item) => item.bandId === id).map((item) => ({ id: Number(item.bandItemId),
        cap: Math.max(0, ...dataRows(item.levels).map((row) => Number(row.level))), source: item }));
      const linear = items.length > 0 && items.every(({ source, cap }) => {
        const effects = dataRows(source.effects);
        for (let level = 1; level <= cap; level++) {
          const rows = effects.filter((effect) => effect.level === level), effect = rows[0];
          const targets = effect?.targets as Array<{ bandId: number; characterId: number; cardType: number }>;
          if (rows.length !== 1 || effect!.effectType !== 1000 || effect!.effectValue !== level * 10 || targets.length !== 1
            || targets[0]!.bandId !== id || targets[0]!.characterId || targets[0]!.cardType) return false;
        }
        return cap > 0;
      });
      return { id, items, linear, cap: items.reduce((sum, item) => sum + item.cap, 0) };
    });
    if (bands.some((band) => !band.linear)) return result;
    const anchorTeam = unique[0]!.team;
    const distance = (reading: (typeof unique)[number]) => Number(reading.team[2]!.card.id !== anchorTeam[2]!.card.id) * 10
      + reading.team.filter((member) => !anchorTeam.some((other) => other.card.id === member.card.id)).length;
    const ordered = [unique[0]!, ...unique.slice(1).sort((a, b) => distance(b) - distance(a) || a.challengeId - b.challengeId)];
    const compiled = ordered.map((reading) => ({ ...reading, slots: reading.team.map((member, slot) => ({
      character: ids.indexOf(member.card.characterId), band: bands.findIndex((band) => band.id === member.card.bandId), slot,
    })) }));
    const maximumFlat = rankRows.at(-1)![1] / 5 + totals.at(-1)!.bonus / 5;
    const flatSources = new Map<number, { rank: number; total: number }>();
    for (const total of totals) for (const [rank, bonus] of rankRows) flatSources.set((bonus + total.bonus) / 5, { rank, total: total.min });
    const kernelCache = new Map<string, Float64Array>();
    const kernel = (observation: number, slot: number, flat: number, vip: number) => {
      const key = `${observation}/${slot}/${flat}/${vip}`, cached = kernelCache.get(key);
      if (cached) return cached;
      const reading = compiled[observation]!, member = reading.team[slot]!, snap = reading.supports[slot], player = emptyPlayer();
      const source = flatSources.get(flat)!;
      player.characterRanks = new Map([[member.card.characterId, source.rank]]); player.totalRank = source.total; player.vipRank = vipRanks.get(vip)!;
      const base = slotBase(master, player, member, reading.music, memberEventPercent(event.effects, member));
      const fixed = base.fixedPoints + snapPoints(master, base, member, snap ?? null, snap ? snapEventPercent(event.effects, snap) : 0)
        + leaderPoints(base, reading.percents[slot]!);
      const cap = bands[reading.slots[slot]!.band]!.cap;
      const values = Float64Array.from({ length: cap + 1 }, (_, value) => fixed + points(pctFloor(base.common, [value * 10, value * 10, value * 10])));
      kernelCache.set(key, values);
      return values;
    };
    const instrumentMap = (values: number[]) => {
      const items = new Map<number, number>();
      bands.forEach((band, index) => {
        let remaining = values[index]!;
        for (const item of band.items) { const value = Math.min(item.cap, remaining); items.set(item.id, value); remaining -= value; }
      });
      return items;
    };
    let emitted = 0, order = 0;
    const seen = new Set<string>(), displayed = new Set<string>();
    for (const preference of [0.7, 0, -1]) {
      const relaxed = preference < 0, characterMin = relaxed ? rankMinimum : 15, instrumentMin = relaxed ? 0 : 50;
      const minimums = caps.map((cap) => Math.max(characterMin, Math.ceil(cap * Math.max(0, preference))));
      if (caps.some((cap, index) => cap < minimums[index]!) || bands.some((band) => band.cap < instrumentMin)) continue;
      const impossibleLocal = new Set<string>();
      const feasible = (box: Box) => totals.flatMap((total) => {
        const offset = total.bonus / 5;
        const low = ids.map((_, index) => Math.max(minimums[index]!, box.lo[index]! - offset + rankMinimum));
        const high = ids.map((_, index) => Math.min(caps[index]!, box.hi[index]! - offset + rankMinimum));
        if (low.some((value, index) => value > high[index]!)) return [];
        const min = Math.max(total.min, low.reduce((sum, value) => sum + value, 0) + unseenCount * rankMinimum);
        const max = Math.min(total.max, high.reduce((sum, value) => sum + value, 0) + unseenCap);
        return min <= max ? [{ total, low, high, min, max }] : [];
      });
      const quality = (levels: number[], range: { min: number; max: number }) => {
        const sum = levels.reduce((sum, value) => sum + value, 0), normalized = levels.map((value, index) => value / caps[index]!);
        const average = normalized.reduce((sum, value) => sum + value, 0) / size;
        const representative = Math.max(range.min, Math.min(range.max, Math.round(sum + unseenCap * average)));
        const outside = unseenCap ? (representative - sum) / unseenCap : average;
        const height = Math.min(...normalized, outside);
        const spread = normalized.reduce((sum, value) => sum + (value - average) ** 2, (outside - average) ** 2) / (size + 1);
        return (1 - height) * 1000 + spread * 10;
      };
      const lowerCost = (box: Box) => {
        let height = -1;
        for (const option of feasible(box)) {
          const outside = unseenCap ? (option.max - option.low.reduce((sum, value) => sum + value, 0)) / unseenCap : 1;
          height = Math.max(height, Math.min(...option.high.map((value, index) => value / caps[index]!), outside));
        }
        return height < 0 ? Infinity : (1 - height) * 1000;
      };
      const canonical = (flat: number[]) => totals.flatMap((total) => {
        const levels = flat.map((value) => value - total.bonus / 5 + rankMinimum);
        if (levels.some((value, index) => value < minimums[index]! || value > caps[index]!)) return [];
        const sum = levels.reduce((sum, value) => sum + value, 0);
        const range = { min: Math.max(total.min, sum + unseenCount * rankMinimum), max: Math.min(total.max, sum + unseenCap) };
        return range.min <= range.max ? [{ levels, total, range, cost: quality(levels, range) }] : [];
      }).sort((a, b) => a.cost - b.cost || b.range.min - a.range.min);
      for (const vip of vipBonuses) {
        for (const historical of [false, true]) {
          if (!historical && conflict) continue;
          const queue = new SearchQueue();
          const value = (observation: number, box: Box, upper: boolean, variable = -1, candidate = 0) => {
            const reading = compiled[observation]!, drift = historical && observation !== 0;
            // A rank changes by at most two; the account sum can cross nearby bonus steps.
            const shift = drift ? box.shift! : 0;
            let sum = 0;
            for (const slot of reading.slots) {
              const pick = (index: number) => index === variable ? candidate : (upper ? box.hi[index]! : box.lo[index]!);
              const flat = Math.max(0, Math.min(maximumFlat, pick(slot.character) + (upper ? shift : -shift)));
              const gear = Math.max(instrumentMin, Math.min(bands[slot.band]!.cap, pick(size + slot.band) + (drift ? upper ? 10 : -10 : 0)));
              sum += kernel(observation, slot.slot, flat, vip)[gear]!;
            }
            return sum;
          };
          const tighten = (box: Box) => {
            if (!Number.isFinite(lowerCost(box))) return false;
            box.shift = historical ? 2 + Math.max(...feasible(box).map(({ total }) => Math.max(...totals
              .filter((other) => other.min <= total.max + master.characters.size * 2 && other.max >= total.min - master.characters.size * 2)
              .map((other) => Math.abs(other.bonus - total.bonus) / 5)))) : 0;
            for (let pass = 0; pass < 2; pass++) {
              let changed = false;
              for (let observation = 0; observation < compiled.length; observation++) {
                const target = compiled[observation]!.row.totalPower!;
                if (target < value(observation, box, false) || target > value(observation, box, true)) return false;
                for (let variable = size; variable < box.lo.length; variable++) {
                  let left = box.lo[variable]!, right = box.hi[variable]!;
                  while (left < right) {
                    const mid = (left + right) >>> 1;
                    if (value(observation, box, true, variable, mid) < target) left = mid + 1; else right = mid;
                  }
                  if (left > box.lo[variable]!) { box.lo[variable] = left; changed = true; }
                  left = box.lo[variable]!; right = box.hi[variable]!;
                  while (left < right) {
                    const mid = (left + right + 1) >>> 1;
                    if (value(observation, box, false, variable, mid) > target) right = mid - 1; else left = mid;
                  }
                  if (left < box.hi[variable]!) { box.hi[variable] = left; changed = true; }
                }
              }
              if (!changed) break;
            }
            box.cost = lowerCost(box);
            return Number.isFinite(box.cost);
          };
          const root: Box = { lo: [...minimums.map((minimum) => minimum - rankMinimum), ...bands.map(() => instrumentMin)],
            hi: [...caps.map((cap) => cap - rankMinimum + totals.at(-1)!.bonus / 5), ...bands.map((band) => band.cap)], cost: 0, order: order++ };
          if (tighten(root)) queue.push(root);
          const started = performance.now();
          while (queue.size) {
            // The historical domain contains stable states; it can take over without dropping any exact match.
            if (!historical && !emitted && performance.now() - started > 150) break;
            const box = queue.pop();
            if (box.configuration) {
              const key = `${vip}/${box.lo.slice(0, size).join(",")}/${box.lo.slice(size).join(",")}`;
              const visible = JSON.stringify([vip, box.configuration.characters.map(({ level, minLevel }) => [minLevel, level]),
                box.configuration.instruments.map(({ total, minTotal }) => [minTotal, total])]);
              if (!seen.has(key) && !displayed.has(visible)) {
                seen.add(key); displayed.add(visible); yield box.configuration;
                if (++emitted === 10) { result.status = "ready"; return result; }
              }
              continue;
            }
            let split = -1, width = 0;
            for (let index = 0; index < box.lo.length; index++) {
              const extent = box.hi[index]! - box.lo[index]!;
              const weight = index < size ? 1 : 2;
              if (extent * weight > width) { split = index; width = extent * weight; }
            }
            if (split >= 0) {
              const mid = (box.lo[split]! + box.hi[split]!) >>> 1;
              for (const upper of [true, false]) {
                const child: Box = { lo: [...box.lo], hi: [...box.hi], cost: 0, order: order++ };
                if (upper) child.lo[split] = mid + 1; else child.hi[split] = mid;
                if (tighten(child)) queue.push(child);
              }
              yield null;
              continue;
            }
            const flat = box.lo.slice(0, size), gears = box.lo.slice(size);
            const anchor = compiled[0]!;
            if (value(0, box, false) !== anchor.row.totalPower) continue;
            const configurations = canonical(flat);
            let bestCost = Infinity;
            for (const option of configurations) {
              if (option.cost >= bestCost) break;
              const anchorWitness: EventTeamWitness = { challengeId: anchor.challengeId, levels: option.levels,
                instruments: gears, totalRank: option.range };
              let work = 0;
              const local = new Map<number, { values: EventTeamWitness[]; search: Generator<EventTeamWitness | null>; complete: boolean }>();
              const makeWitnesses = function* (index: number): Generator<EventTeamWitness | null> {
                const reading = compiled[index]!, target = reading.row.totalPower!;
                const totalOptions = totals.filter((total) => !historical ? total.bonus === option.total.bonus
                  : total.min <= option.range.max + master.characters.size * 2 && total.max >= option.range.min - master.characters.size * 2)
                  .sort((a, b) => Math.abs(a.bonus - option.total.bonus) - Math.abs(b.bonus - option.total.bonus));
                const localKey = `${vip}/${historical}/${index}/${reading.slots.map((slot) => option.levels[slot.character]).join(",")}/${gears.join(",")}/${totalOptions.map((total) => total.bonus).join(",")}`;
                if (impossibleLocal.has(localKey)) return;
                let integerMatch = false;
                const levels = [...option.levels];
                const minimumGear = bands.map((_, i) => historical ? Math.max(instrumentMin, gears[i]! - 10) : gears[i]!);
                const maximumGear = bands.map((band, i) => historical ? Math.min(band.cap, gears[i]! + 10) : gears[i]!);
                const minimumLevel = ids.map((_, i) => historical ? Math.max(minimums[i]!, option.levels[i]! - 2) : option.levels[i]!);
                const maximumLevel = caps.map((cap, i) => historical ? Math.min(cap, option.levels[i]! + 2) : option.levels[i]!);
                let slotValues: Float64Array[][];
                let bandValues: Array<Map<number, { min: number; values: number[] }>>;
                const visit = function* (position: number, total: (typeof totals)[number]): Generator<EventTeamWitness | null> {
                  let lowerPower = 0, upperPower = 0;
                  for (let slotIndex = 0; slotIndex < reading.slots.length; slotIndex++) {
                    const slot = reading.slots[slotIndex]!, low = slotIndex < position ? levels[slot.character]! : minimumLevel[slot.character]!;
                    const high = slotIndex < position ? low : maximumLevel[slot.character]!;
                    lowerPower += slotValues[slotIndex]![low - minimumLevel[slot.character]!]![0]!;
                    upperPower += slotValues[slotIndex]![high - minimumLevel[slot.character]!]!.at(-1)!;
                  }
                  if (target < lowerPower || target > upperPower) return;
                  if (position < reading.slots.length) {
                    const character = reading.slots[position]!.character;
                    const min = minimumLevel[character]!, max = maximumLevel[character]!;
                    const domain = Array.from({ length: max - min + 1 }, (_, index) => index + min)
                      .sort((a, b) => Math.abs(a - option.levels[character]!) - Math.abs(b - option.levels[character]!) || b - a);
                    for (const level of domain) { levels[character] = level; yield* visit(position + 1, total); }
                    levels[character] = option.levels[character]!;
                    return;
                  }
                  const sum = levels.reduce((sum, level) => sum + level, 0);
                  const range = { min: Math.max(total.min, sum + unseenCount * rankMinimum), max: Math.min(total.max, sum + unseenCap) };
                  const arrays = bands.map((_, bi) => {
                    const slots = reading.slots.flatMap((slot, si) => slot.band === bi ? [{ ...slot, position: si }] : []);
                    const key = slots.reduce((key, slot) => key * 64 + levels[slot.character]!, 0), cached = bandValues[bi]!.get(key);
                    if (cached) return cached;
                    const min = minimumGear[bi]!, max = maximumGear[bi]!;
                    const value = { min, values: Array.from({ length: max - min + 1 }, (_, step) => slots.reduce((sum, slot) =>
                      sum + slotValues[slot.position]![levels[slot.character]! - minimumLevel[slot.character]!]![step]!, 0)) };
                    bandValues[bi]!.set(key, value);
                    return value;
                  });
                  const items = function* (band: number, remaining: number, prefix: number[]): Generator<EventTeamWitness | null> {
                    const array = arrays[band]!;
                    if (band === arrays.length - 1) {
                      let lo = 0, hi = array.values.length - 1;
                      while (lo < hi) { const mid = (lo + hi) >>> 1; if (array.values[mid]! < remaining) lo = mid + 1; else hi = mid; }
                      while (lo < array.values.length && array.values[lo] === remaining) {
                        integerMatch = true;
                        const total = lo++ + array.min;
                        if (range.min <= range.max)
                          yield { challengeId: reading.challengeId, levels: [...levels], instruments: [...prefix, total], totalRank: { ...range } };
                      }
                    } else {
                      const domain = array.values.map((value, i) => ({ value, level: i + array.min }))
                        .sort((a, b) => Math.abs(a.level - gears[band]!) - Math.abs(b.level - gears[band]!) || b.level - a.level);
                      for (const entry of domain) {
                        yield* items(band + 1, remaining - entry.value, [...prefix, entry.level]);
                        if (++work % 64 === 0) yield null;
                      }
                    }
                  };
                  yield* items(0, target, []);
                  if (++work % 64 === 0) yield null;
                };
                for (const total of totalOptions) {
                  slotValues = reading.slots.map((slot) => Array.from({ length: maximumLevel[slot.character]! - minimumLevel[slot.character]! + 1 }, (_, step) =>
                    kernel(index, slot.slot, minimumLevel[slot.character]! + step - rankMinimum + total.bonus / 5, vip)
                      .subarray(minimumGear[slot.band]!, maximumGear[slot.band]! + 1)));
                  bandValues = bands.map(() => new Map());
                  yield* visit(0, total);
                }
                if (!integerMatch) {
                  impossibleLocal.add(localKey);
                  if (impossibleLocal.size > 4096) impossibleLocal.delete(impossibleLocal.values().next().value!);
                }
              };
              const witnesses: EventTeamWitness[] = [anchorWitness];
              const join = function* (index: number, levelMin: number[], levelMax: number[], itemMin: number[], itemMax: number[],
                outsideLow: number, outsideHigh: number): Generator<EventTeamWitness[] | null> {
                if (index === compiled.length) {
                  const sum = option.levels.reduce((sum, value) => sum + value, 0);
                  const upper = Math.max(outsideLow, Math.min(outsideHigh, option.range.max - sum));
                  yield witnesses.map((witness) => {
                    const own = witness.levels.reduce((sum, value) => sum + value, 0);
                    return { ...witness, totalValue: Math.max(witness.totalRank.min, own + upper - unseenCount * 2),
                      totalRank: { min: Math.max(witness.totalRank.min, own + outsideLow - unseenCount * 2),
                        max: Math.min(witness.totalRank.max, own + outsideHigh) } };
                  });
                  return;
                }
                let cached = local.get(index);
                if (!cached) { cached = { values: [], search: makeWitnesses(index), complete: false }; local.set(index, cached); }
                for (let offset = 0;; offset++) {
                  if (offset === cached.values.length && !cached.complete) {
                    let step = cached.search.next();
                    while (!step.done && !step.value) { yield null; step = cached.search.next(); }
                    if (step.done) cached.complete = true; else cached.values.push(step.value!);
                  }
                  const witness = cached.values[offset];
                  if (!witness) return;
                  if (witness.levels.some((value, i) => Math.max(levelMax[i]!, value) - Math.min(levelMin[i]!, value) > 2)
                    || witness.instruments.some((value, i) => Math.max(itemMax[i]!, value) - Math.min(itemMin[i]!, value) > 10)) continue;
                  const own = witness.levels.reduce((sum, value) => sum + value, 0);
                  const low = Math.max(outsideLow, witness.totalRank.min - own);
                  const high = Math.min(outsideHigh, witness.totalRank.max - own + unseenCount * 2);
                  if (low > high) continue;
                  witnesses.push(witness);
                  yield* join(index + 1, levelMin.map((value, i) => Math.min(value, witness.levels[i]!)),
                    levelMax.map((value, i) => Math.max(value, witness.levels[i]!)), itemMin.map((value, i) => Math.min(value, witness.instruments[i]!)),
                    itemMax.map((value, i) => Math.max(value, witness.instruments[i]!)), low, high);
                  witnesses.pop();
                  if (++work % 64 === 0) yield null;
                }
              };
              let accepted: EventTeamWitness[] | undefined;
              const own = option.levels.reduce((sum, value) => sum + value, 0);
              for (const state of join(1, option.levels, option.levels, gears, gears, option.range.min - own,
                Math.min(unseenCap, option.range.max - own + unseenCount * 2))) {
                if (!state) { yield null; continue; } accepted = state; break;
              }
              if (!accepted) continue;
              const minimum = ids.map((_, i) => Math.min(...accepted.map((witness) => witness.levels[i]!)));
              const maximum = ids.map((_, i) => Math.max(...accepted.map((witness) => witness.levels[i]!)));
              const minimumItems = bands.map((_, i) => Math.min(...accepted.map((witness) => witness.instruments[i]!)));
              const maximumItems = bands.map((_, i) => Math.max(...accepted.map((witness) => witness.instruments[i]!)));
              if (maximum.some((level, index) => level - minimum[index]! > 2) || maximumItems.some((level, index) => level - minimumItems[index]! > 10)) continue;
              const expanded = observations.map((observation) => {
                const model = compiled.find((reading) => reading.signature === observation.signature && reading.row.totalPower === observation.row.totalPower)!;
                return { ...accepted!.find((witness) => witness.challengeId === model.challengeId)!, challengeId: observation.challengeId };
              });
              if (expanded.some((witness) => {
                const observation = observations.find((reading) => reading.challengeId === witness.challengeId)!;
                const player = emptyPlayer(); player.characterRanks = new Map(ids.map((id, i) => [id, witness.levels[i]!]));
                player.totalRank = witness.totalValue!; player.bandItems = instrumentMap(witness.instruments); player.vipRank = vipRanks.get(vip)!;
                return teamPower(master, player, observation.team, observation.supports, 2, observation.music, event.effects).total !== observation.row.totalPower;
              })) continue;
              const changed = maximum.some((level, i) => level !== minimum[i]) || maximumItems.some((level, i) => level !== minimumItems[i])
                || accepted.some((witness) => totals.find((total) => total.min <= witness.totalRank.min && total.max >= witness.totalRank.min)?.bonus !== option.total.bonus);
              const configuration: EventTeamConfiguration = { characters: ids.map((id, i) => ({ id, level: maximum[i]!, minLevel: minimum[i], cap: caps[i]! })),
                instruments: bands.map((band, i) => ({ id: band.id, total: maximumItems[i]!, minTotal: minimumItems[i], cap: band.cap })),
                totalRank: accepted[0]!.totalRank, vipBonus: vip, matchedChallenges: observations.map((reading) => reading.challengeId), relaxed, changed, witnesses: expanded };
              const growth = maximum.reduce((sum, level, i) => sum + level - minimum[i]!, 0)
                + maximumItems.reduce((sum, level, i) => sum + (level - minimumItems[i]!) / 5, 0);
              const cost = quality(option.levels, accepted[0]!.totalRank) + growth * .001
                + bands.reduce((sum, band, i) => sum + 1 - maximumItems[i]! / band.cap, 0) * .01;
              queue.push({ ...box, configuration, cost, order: order++ });
              bestCost = Math.min(bestCost, cost);
            }
            yield null;
          }
          if (emitted) { result.status = "ready"; return result; }
        }
      }
    }
    result.status = conflict ? "conflictingRecords" : "noMatch";
    return result;
  };
}
