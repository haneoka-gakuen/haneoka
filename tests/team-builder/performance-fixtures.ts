/** Deterministic synthetic inventories. These are performance inputs, not game-formula evidence. */
import type { EngineRequest, SongRef } from "../../src/lib/team-builder/engine/api";
import type { ChartSource } from "../../src/lib/team-builder/engine/chart";
import type { EngineMaster } from "../../src/lib/team-builder/engine/master";

export const PERFORMANCE_CASES = {
  "solo-members": { members: 16, snaps: 4, songs: 3, luck: false, gekiso: false, samples: 1 },
  "gekiso-small": { members: 6, snaps: 1, songs: 1, luck: false, gekiso: true, samples: 1 },
  "gekiso-luck-small": { members: 6, snaps: 1, songs: 1, luck: true, gekiso: true, samples: 32 },
  "gekiso-fallback": { members: 6, snaps: 1, songs: 1, luck: true, gekiso: true, samples: 32 },
  "gekiso-members": { members: 16, snaps: 0, songs: 1, luck: false, gekiso: true, samples: 1 },
  "gekiso-photos": { members: 5, snaps: 10, songs: 1, luck: true, gekiso: true, samples: 32 },
  "gekiso-catalog": { members: 8, snaps: 2, songs: 8, luck: true, gekiso: true, samples: 32 },
} as const;

export function performanceFixture(
  base: { master: EngineMaster; request: EngineRequest; charts: (song: SongRef) => ChartSource },
  name: keyof typeof PERFORMANCE_CASES,
) {
  const config = PERFORMANCE_CASES[name];
  if (!config) throw new Error(`Unknown benchmark case: ${name}`);
  const { master, request } = base;
  const members = [...master.members.values()];
  const snapshots = [...master.snaps.values()];
  const songs = [...master.songs.values()];
  const characterCount = Math.min(config.members, 10);
  master.characters = new Map(Array.from({ length: characterCount }, (_, i) => [i + 1, { id: i + 1, bandId: 1 }]));
  master.members = new Map(
    Array.from({ length: config.members }, (_, i) => {
      const template = members[i % members.length]!;
      const id = i + 1;
      return [
        id,
        { ...template, id, characterId: (i % characterCount) + 1, statMax: [1200 + i * 63, 1100, 1000] as const },
      ];
    }),
  );
  master.snaps = new Map(
    Array.from({ length: config.snaps }, (_, i) => {
      const template = snapshots[i % snapshots.length]!;
      const id = i + 1;
      return [
        id,
        { ...template, id, characterIds: [(i % characterCount) + 1], statMax: [500 + i * 31, 600, 700] as const },
      ];
    }),
  );
  master.songs = new Map(
    Array.from({ length: config.songs }, (_, i) => {
      const template = songs[i % songs.length]!;
      const id = i + 1;
      return [id, { ...template, id, gekisoMissions: config.luck ? [2, 3, 1] : [1, 3, 1] }];
    }),
  );
  master.live.justTypes = new Set([1]);
  master.live.judgePercent = new Map([
    [1, 110],
    [2, 100],
  ]);
  master.live.gekiso = {
    gaugeMax: 100,
    gaugeMaxRush: 50,
    rushPercent: 100,
    rankingBonuses: [1, 2, 3].flatMap((pattern) =>
      [1, 2, 3].map((count) => ({ pattern, count, rank: 1, percent: 10 * count })),
    ),
    luckBasePoints: [{ category: 0, judgement: 5, weight: 1, point: 50 }],
    luckBonusLots: [0, 1, 2, 3, 4].flatMap((lotType) => [1, 2, 3].map((result) => ({ lotType, result, weight: 1 }))),
  };
  master.scoreRanks = new Map([
    [
      1,
      [
        { rank: 2, required: 0, battleRequired: 0 },
        { rank: 3, required: 90000, battleRequired: 90000 },
        { rank: 4, required: 200000, battleRequired: 200000 },
      ],
    ],
  ]);
  const event = master.events.get(1)!;
  master.events = new Map([
    [
      1,
      {
        ...event,
        itemId: 9,
        liveRewards: [2, 3, 4].map((scoreRank) => ({
          scoreRank,
          resourceType: 1,
          resourceId: 9,
          count: scoreRank * 5,
          probability: 10000,
        })),
      },
    ],
  ]);
  master.liveChallengePoints = new Map([
    [2, 2],
    [3, 5],
    [4, 8],
  ]);
  request.members = [...master.members.keys()].map((cardId) => ({ ...request.members[0]!, key: `m${cardId}`, cardId }));
  request.snaps = [...master.snaps.keys()].map((cardId) => ({ key: `s${cardId}`, cardId, level: 1, rank: 1 }));
  request.player.characterRanks = Object.fromEntries([...master.characters.keys()].map((id) => [id, 1]));
  request.player.characterMemory = Object.fromEntries([...master.characters.keys()].map((id) => [id, 0]));
  request.player.characterTotalRank = characterCount;
  request.player.musicMemory = Object.fromEntries([...master.songs.keys()].map((id) => [id, 0]));
  request.constraints.noSnaps = config.snaps === 0;
  if (name === "gekiso-fallback") {
    master.conditions = new Map(master.conditions).set(9000, {
      id: 9000,
      type: 7010,
      values: [],
      targetIds: [],
      positive: true,
    });
    master.conditionSets = new Map(master.conditionSets).set(9000, [[9000]]);
    master.cumulative = new Map(master.cumulative).set(9001, {
      id: 9001,
      type: 3002,
      values: [],
      targetIds: [],
      cap: 5,
    });
    const template = master.liveSkills.get(1)![0]!;
    const memberEffect = {
      ...template,
      id: 901,
      type: 2000,
      value: 500,
      level: 1,
      seconds: 20,
      triggerType: 1,
      triggerGroup: 9000,
      conditionGroup: 0,
      releaseGroup: 0,
      cumulativeId: 0,
      executeLimit: 0,
      resetGroup: 0,
      maxValue: 0,
      limitCount: 0,
      targetIds: [],
    };
    master.gekisoSkills = new Map([[901, { missionType: 2, effects: [memberEffect] }]]);
    master.gekisoSupportSkills = new Map([
      [
        902,
        {
          missionType: 2,
          effects: [{ ...memberEffect, id: 902, type: 2001, value: 100, cumulativeId: 9001, maxValue: 1000 }],
        },
      ],
    ]);
    master.members = new Map([...master.members].map(([id, card]) => [id, { ...card, gekisoSkillId: 901 }]));
    master.snaps = new Map([...master.snaps].map(([id, card]) => [id, { ...card, gekisoSupportSkillIds: [902, 0] }]));
    request.members = request.members.map((member) => ({ ...member, gekisoSkillLevel: 1 }));
  }
  if (request.goal.kind !== "event") throw new Error("event fixture required");
  request.goal.songs = [...master.songs.keys()].map((songId) => ({ songId, difficulty: 0 }));
  request.goal.cpExchange = { numerator: 3, denominator: 2 };
  if (config.gekiso) request.goal.gekiso = { just: 0.25, rank: 1, luckSamples: config.samples };
  const charts = (ref: SongRef): ChartSource => {
    const source = base.charts(ref);
    return {
      ...source,
      feverMs: [
        [500, 1600],
        [2500, 3600],
        [4500, 5600],
      ],
      enumeration: source.notes.map((n) => ({ op: n.operateType, timeMs: n.timeMs, judgementType: n.judgementType })),
    };
  };
  return { master, request, charts, config };
}
