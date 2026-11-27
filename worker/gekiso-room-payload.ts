// L3 — GEB
// Input: Room settings, seat inventory or public solver progress from a browser.
// Output: Accept only the fields consumed by the cooperative solver and room results.
// Pos: [Map](L2.md); validated before the Durable Object persists any player data.
// Effects/Dependencies: Validates JSON values without reading storage or making requests.
type JsonObject = Record<string, unknown>;
type Check = (value: unknown) => boolean;
type Fields = Record<string, Check>;
const object = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
function shape(required: Fields, optional: Fields = {}): Check {
  return (v) =>
    object(v) &&
    Object.entries(required).every(([key, check]) => Object.hasOwn(v, key) && check(v[key])) &&
    Object.entries(v).every(
      ([key, value]) => Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key]!(value)),
    );
}
const integer =
  (min = 0, max = Number.MAX_SAFE_INTEGER): Check =>
  (v) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const number: Check = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const rate: Check = (v) => number(v) && (v as number) <= 1;
const boolean: Check = (v) => typeof v === "boolean";
const oneOf =
  (...options: string[]): Check =>
  (v) =>
    typeof v === "string" && options.includes(v);
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const list =
  (check: Check, min: number, max = min): Check =>
  (v) =>
    Array.isArray(v) && v.length >= min && v.length <= max && v.every(check);
const text: Check = (v) => typeof v === "string" && v.length > 0 && v.length <= 256;
const growth = nullable(integer());
const lookup: Check = (v) => object(v) && Object.entries(v).every(([id, n]) => /^\d{1,10}$/u.test(id) && growth(n));
const difficulty = integer(0, 10);
const seed = integer(0, 0xffffffff);
const instance = { key: text, cardId: integer(1) };
const member = shape(instance, {
  level: growth,
  awake: growth,
  rank: growth,
  liveSkillLevel: growth,
  gekisoSkillLevel: growth,
  maximize: boolean,
});
const snap = shape(instance, { level: growth, rank: growth, maximize: boolean });
const player = shape(
  {},
  {
    characterRanks: lookup,
    characterTotalRank: growth,
    bandItems: lookup,
    vipRank: growth,
    characterMemory: lookup,
    musicMemory: lookup,
  },
);
const keys = list(text, 0, 5000);
const roleRange = list(integer(0, 5), 2);
const roles = shape({ count: roleRange, window: roleRange, conversion: roleRange, score: roleRange });
const binding: Check = (v) => Array.isArray(v) && v.length === 2 && text(v[0]) && nullable(text)(v[1]);
const constraints = shape(
  {},
  {
    requiredMembers: keys,
    excludedMembers: keys,
    requiredSnaps: keys,
    excludedSnaps: keys,
    leader: nullable(text),
    bindings: list(binding, 0, 5000),
    noSnaps: boolean,
    minBonusPercent: nullable(number),
    minMissionMembers: list(integer(0, 5), 3),
    skillRoles: shape({ member: roles, snap: roles }),
    skillRoleMissions: list(integer(), 0, 32),
  },
);
const accuracy = shape({ just: rate, great: rate, missEvery: integer() });
export const validRoomSettings = shape(
  {
    server: oneOf("jp", "intl"),
    releaseId: text,
    song: shape({ songId: integer(1), difficulty }),
    objective: oneOf("meanScore", "ssRate"),
  },
  { sourceId: text, sampling: shape({ seed, count: integer(1, 4096), skillOrders: oneOf("fixed", "uniform") }) },
);
export const validRoomPlayer = shape(
  {
    members: list(member, 5, 5000),
    snaps: list(snap, 0, 5000),
    player,
    unknownPolicy: oneOf("min", "max"),
    difficulty,
    constraints,
  },
  {
    lockedTeam: shape({ leader: text, members: list(text, 5), snaps: list(nullable(text), 5) }),
    seed: integer(-2147483648, 2147483647),
    orderIndex: integer(0, 119),
    accuracy,
    allowedDifficulties: list(difficulty, 1, 11),
    accuracyProfiles: list(accuracy, 1, 16),
  },
);
const publicTeam = shape({
  leader: integer(1),
  members: list(integer(1), 5),
  snaps: list(nullable(integer(1)), 5),
  power: number,
  score: number,
  meanScore: number,
});
export const validRoomResult = (v: unknown, seats: number) =>
  shape({
    phase: text,
    evaluated: (n) => integer()(n) || (typeof n === "string" && /^\d{1,64}$/u.test(n)),
    upperBound: number,
    teams: nullable(list(publicTeam, seats)),
    meanTotal: nullable(number),
    ssHits: nullable(integer()),
    ssRate: nullable(rate),
    sampleCount: integer(0, 4096),
    ssThreshold: nullable(number),
  })(v);
