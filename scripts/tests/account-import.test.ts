import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { parseBoxText, parseBoxFiles } from "../../src/lib/team-builder/box-import/parser";
import { previewBoxImport } from "../../src/lib/team-builder/box-import/preview";
import { applyConfirmedBoxImport } from "../../src/lib/team-builder/box-import/merge";
import { buildBoxImportReview } from "../../src/lib/team-builder/box-review-model";
import { createEmptyInventory } from "../../src/lib/team-builder/inventory";
import { inventoryChanges } from "../../src/lib/team-builder/sync/legacy";
import { readBox, engineInputs } from "../../src/lib/team-builder/sync/box-view";
import {
  previewScreenshotImportBatch,
  applyConfirmedScreenshotImport,
} from "../../src/lib/team-builder/screenshot-import";
import { createScreenshotImportSession } from "../../src/lib/team-builder/screenshot-import-session";
import { compileFromTeamData } from "../../src/lib/team-builder/engine/master";
import { inspectEngineInput } from "../../src/lib/team-builder/engine/input-eligibility";
import { runEngine, evaluateTeam, playerState, ChartCache, type EngineRequest } from "../../src/lib/team-builder/engine/api";
import { readAndroidFiles, type DeviceReader } from "../../src/lib/team-builder/box-import/device/reader";
import { BOX_LIMITS } from "../../src/lib/team-builder/box-import/types";
import { screenshotHeader, cropPixels } from "../../src/lib/team-builder/screenshot-image";
import { decompress } from "../../src/lib/team-builder/box-import/formats";
import { type ScreenshotRecognitionUploadOptions } from "../../packages/community-media/client";

import { data } from "./account-import-fixture";
const context = { ownerId: "local", revision: 0, ...data.identity, sourceId: data.identity.sourceId! } as const;
const empty = () => createEmptyInventory(data.identity);
const parse = async (raw: unknown) => (await parseBoxText(JSON.stringify(raw))).candidates[0]!;
const raw = (extra = {}) => ({
  _player: { _memberCards: [{ _masterId: 1, _exp: "10", ...extra }], _bandItems: [{ _masterId: 1, _level: 0 }] },
});
const confirmation = (preview: ReturnType<typeof previewBoxImport>) => ({
  cards: preview.cards.map((card) => ({ key: card.key, include: true })),
  maps: preview.maps.map((row) => ({ key: row.key, include: true })),
});

test("P0 new import preserves unknowns, exp boundaries and known zero through storage reload", async () => {
  const preview = previewBoxImport(await parse(raw()), empty(), data, context);
  assert.equal(preview.cards[0]!.defaultPractice, null);
  assert.equal(
    buildBoxImportReview(preview, confirmation(preview)).cards[0]!.fields.find((row) => row.field === "training")!
      .source,
    "unknown",
  );
  const next = applyConfirmedBoxImport(empty(), preview, confirmation(preview), data, context);
  assert.equal(next.members[0]!.level, 2);
  assert.equal(next.members[0]!.training, null);
  assert.equal(next.members[0]!.liveSkillLevel, null);
  assert.equal(next.bandItems[1], 0);
  const entries = Object.fromEntries(
    inventoryChanges(next).map((change) => [change.key, { v: change.value, t: 1, c: "fixture", r: 1 }]),
  );
  const view = readBox(entries);
  assert.equal(engineInputs(view).members[0]!.awake, null);
  assert.equal(view.player.bandItems[1], 0);
});
test("P0 lossless exp uses supported tables without floating point rounding", async () => {
  const candidate = await parse({ _memberCards: [{ _masterId: 1, _exp: "9007199254740993" }] });
  assert.equal(candidate.members[0]!.exp, "9007199254740993");
  assert.equal(previewBoxImport(candidate, empty(), data, context).cards[0]!.values.level![0], 3);
  const lower = await parse(raw({ _exp: "9" }));
  assert.equal(previewBoxImport(lower, empty(), data, context).cards[0]!.values.level![0], 1);
});
test("P0 raw, ONPKG1 and local file share field semantics", async () => {
  const r = raw({ _awakeCount: 1, _rank: 1, _liveSkillLevel: 1 });
  const compact = { v: 1, m: [[1, "10", 1, 1, 1, null]], b: [[1, 0]] };
  const a = await parse(r),
    b = (await parseBoxText("ONPKG1:" + gzipSync(JSON.stringify(compact)).toString("base64"))).candidates[0]!;
  const c = (await parseBoxFiles([new Blob([JSON.stringify(r)])])).candidates[0]!;
  assert.deepEqual(a.members, b.members);
  assert.deepEqual(a.members, c.members);
  assert.deepEqual(a.bandItems, b.bandItems);
});
test("P0 explicit updates preserve flags and missing values; decreases require explicit selection; identical reimport is no-op", async () => {
  const first = previewBoxImport(
    await parse(raw({ _awakeCount: 2, _rank: 2, _liveSkillLevel: 2 })),
    empty(),
    data,
    context,
  );
  const current = applyConfirmedBoxImport(empty(), first, confirmation(first), data, context);
  current.members[0]!.locked = true;
  const preview = previewBoxImport(await parse(raw({ _exp: "0" })), current, data, context);
  const keep = { ...confirmation(preview), existingValues: "updates" as const };
  const kept = applyConfirmedBoxImport(current, preview, keep, data, context);
  assert.deepEqual(kept, current);
  const lower = applyConfirmedBoxImport(
    current,
    preview,
    { ...keep, cards: [{ key: preview.cards[0]!.key, include: true, fields: { level: 1 } }] },
    data,
    context,
  );
  assert.equal(lower.members[0]!.level, 1);
  assert.equal(lower.members[0]!.training, 2);
  assert.equal(lower.members[0]!.locked, true);
  const again = previewBoxImport(await parse(raw({ _exp: "0" })), lower, data, context);
  assert.deepEqual(
    inventoryChanges(applyConfirmedBoxImport(lower, again, confirmation(again), data, context)),
    inventoryChanges(lower),
  );
});
test("P0 final merged training/level combination is validated", async () => {
  const preview = previewBoxImport(await parse(raw({ _exp: "20", _awakeCount: 2 })), empty(), data, context);
  const current = applyConfirmedBoxImport(empty(), preview, confirmation(preview), data, context);
  const nextPreview = previewBoxImport(await parse(raw({ _exp: "0", _awakeCount: 1 })), current, data, context);
  assert.throws(() =>
    applyConfirmedBoxImport(
      current,
      nextPreview,
      {
        ...confirmation(nextPreview),
        cards: [{ key: nextPreview.cards[0]!.key, include: true, fields: { level: "keep", training: 1 } }],
      },
      data,
      context,
    ),
  );
});
test("P0 conflict, foreign server, stale context and duplicate confirmations are rejected", async () => {
  const candidate = await parse({
    _memberCards: [
      { _masterId: 1, _exp: "0" },
      { _masterId: 1, _exp: "10" },
    ],
  });
  const preview = previewBoxImport(candidate, empty(), data, context);
  assert.throws(() => applyConfirmedBoxImport(empty(), preview, confirmation(preview), data, context));
  assert.throws(() => previewBoxImport({ ...candidate, declaredIdentity: { server: "jp" } }, empty(), data, context));
  assert.throws(() =>
    applyConfirmedBoxImport(empty(), preview, { cards: [], maps: [] }, data, { ...context, ownerId: "other" }),
  );
  const choices = confirmation(preview);
  choices.cards.push(choices.cards[0]!);
  assert.throws(() => applyConfirmedBoxImport(empty(), preview, choices, data, context));
});
test("P0 canonical modifiers import and p.total survive sync reads", async () => {
  const document = empty();
  document.playerModifiers.characterTotalRank = 6;
  document.playerModifiers.vipRank = 1;
  document.playerModifiers.characterMemoryPoints[1] = 0;
  const preview = previewBoxImport(await parse(document), empty(), data, context);
  const next = applyConfirmedBoxImport(
    empty(),
    preview,
    { cards: [], maps: [], modifiers: preview.modifiers!.map((row) => ({ field: row.field, include: true })) },
    data,
    context,
  );
  const view = readBox(
    Object.fromEntries(
      inventoryChanges(next).map((change) => [change.key, { v: change.value, t: 1, c: "fixture", r: 1 }]),
    ),
  );
  assert.equal(view.player.characterTotalRank, 6);
  assert.equal(view.player.vipRank, 1);
  assert.equal(view.player.characterMemory[1], 0);
});

const recognition = () => ({
  schema: "haneoka-card-recognition-result-v1" as const,
  context: { ...data.identity, sourceId: "synthetic", referenceId: "a".repeat(64) },
  algorithmVersion: "fixture",
  image: { width: 256, height: 256, sha256: "b".repeat(64) },
  status: "candidates" as const,
  observations: [
    {
      bbox: [0, 0, 128, 128] as [number, number, number, number],
      kind: "members" as const,
      cardId: 1,
      candidates: [],
      level: { value: 2, reason: "observed" },
    },
  ],
});
test("iOS repeated screenshots deduplicate; observed level survives, unseen practice stays unknown", () => {
  const preview = previewScreenshotImportBatch(
    empty(),
    data,
    context,
    [recognition(), recognition()],
    [
      { image: 0, observation: 0, cardId: 1 },
      { image: 1, observation: 0, cardId: 1 },
    ],
  );
  assert.equal(preview.cards.length, 1);
  const next = applyConfirmedScreenshotImport(preview, empty(), data, context, [
    { key: preview.cards[0]!.key, include: true },
  ]);
  assert.equal(next.members[0]!.level, 2);
  assert.equal(next.members[0]!.training, null);
  assert.equal(next.members[0]!.awakening, null);
});
test("iOS conflicting screenshot levels require review; stale inventory cannot be merged", () => {
  const second = recognition();
  second.observations[0]!.level.value = 1;
  const preview = previewScreenshotImportBatch(
    empty(),
    data,
    context,
    [recognition(), second],
    [
      { image: 0, observation: 0, cardId: 1 },
      { image: 1, observation: 0, cardId: 1 },
    ],
  );
  assert.throws(() =>
    applyConfirmedScreenshotImport(preview, empty(), data, context, [{ key: preview.cards[0]!.key, include: true }]),
  );
  const current = empty();
  current.bandItems[1] = 0;
  assert.throws(() => applyConfirmedScreenshotImport(preview, current, data, context, []));
});

const master = compileFromTeamData(data);
function request(): EngineRequest {
  return {
    members: Array.from({ length: 6 }, (_, i) => ({
      key: `m${i + 1}`,
      cardId: i + 1,
      level: 2,
      awake: 1,
      rank: 1,
      liveSkillLevel: 1,
      gekisoSkillLevel: null,
    })),
    snaps: [],
    player: {
      characterRanks: Object.fromEntries([1, 2, 3, 4, 5, 6].map((id) => [id, 1])),
      characterTotalRank: 6,
      vipRank: 1,
      bandItems: { "1": 0 },
      characterMemory: Object.fromEntries([1, 2, 3, 4, 5, 6].map((id) => [id, 0])),
      musicMemory: {},
    },
    unknownPolicy: "max",
    inputIntent: "actual",
    goal: { kind: "power", song: null, challengeEventId: null },
    constraints: {
      requiredMembers: [],
      requiredSnaps: [],
      excludedMembers: [],
      excludedSnaps: [],
      leader: null,
      bindings: [],
      noSnaps: true,
      minBonusPercent: null,
    },
    k: 1,
    timeLimitMs: null,
  };
}
test("P0 ordinary score ignores unrelated GK level, while GK requires it", () => {
  const r = request();
  r.goal = {
    kind: "score",
    songs: [],
    criterion: "mean",
    play: { great: 0, good: 0, bad: 0, miss: 0 },
    challengeEventId: null,
  };
  assert.deepEqual(inspectEngineInput(master, r).issues, []);
  r.goal = { kind: "gekiso", songs: [], criterion: "mean", accuracy: { great: 0, just: 1 }, rank: 1, seeds: 0 };
  assert.equal(inspectEngineInput(master, r).issues.filter((row) => row.field === "gekisoSkillLevel").length, 6);
});

test("integrated event rewards require Gekisou practice only in Gekisou mode", () => {
  const r = request();
  r.goal = { kind: "event", route: "live", ranking: "pt-only", measure: "points", eventId: 1,
    songs: [], consumption: 3, play: { great: 0, good: 0, bad: 0, miss: 0 } };
  assert.deepEqual(inspectEngineInput(master, r).issues, []);
  r.goal.gekiso = { just: 1, luckSamples: 1, rank: 1 };
  assert.equal(inspectEngineInput(master, r).issues.filter(row => row.field === "gekisoSkillLevel").length, 6);
});

test("inactive memory fields neither block imported accounts nor affect player bonuses", () => {
  const r = request();
  r.player.characterMemory = {};
  r.player.musicMemory = {};
  r.goal = { kind: "score", songs: [{ songId: 1, difficulty: 0 }], criterion: "mean",
    play: { great: 0, good: 0, bad: 0, miss: 0 }, challengeEventId: null };
  assert.deepEqual(inspectEngineInput(master, r).issues, []);
  const before = playerState(master, r.player);
  r.player.characterMemory = { "1": 999 };
  r.player.musicMemory = { "1": 999 };
  assert.deepEqual(playerState(master, r.player), before);
});

test("TGW rank 1 is valid when the bonus table begins at rank 2", () => {
  const sparse = { ...master, vipBonus: new Map([[2, 100]]) };
  const r = request();
  assert.deepEqual(inspectEngineInput(sparse, r).issues, []);
  r.player.vipRank = null;
  assert(inspectEngineInput(sparse, r).issues.some(row => row.storageKey === "p.vip"));
  r.player.vipRank = 3;
  assert(inspectEngineInput(sparse, r).issues.some(row => row.storageKey === "p.vip"));
});
test("P0 unknown account totals cannot be inferred from partial ranks; simulation remains explicit", () => {
  const r = request();
  r.player.characterTotalRank = null;
  assert(inspectEngineInput(master, r).issues.some((row) => row.storageKey === "p.total"));
  r.inputIntent = "simulation";
  assert.deepEqual(inspectEngineInput(master, r).issues, []);
});
test("P0 known-only shrinks transient candidates but cannot drop leader, locks or binding", () => {
  const r = request();
  r.members[5]!.level = null;
  r.knownOnly = true;
  assert.deepEqual(inspectEngineInput(master, r).omitted, ["m6"]);
  assert.equal(r.members.length, 6);
  for (const constraint of [
    { leader: "m6" },
    { requiredMembers: ["m6"] },
    { bindings: [["m6", null] as [string, null]] },
  ]) {
    const report = inspectEngineInput(master, { ...r, constraints: { ...r.constraints, ...constraint } });
    assert(report.issues.some((row) => row.key === "m6"));
    assert.deepEqual(report.omitted, []);
  }
});
test("P0 excluded or unequipped photos do not block; insufficient characters and missing fixed cards do", () => {
  const r = request();
  r.snaps = [{ key: "s1", cardId: 1, level: null, rank: null }];
  assert.deepEqual(inspectEngineInput(master, r).issues, []);
  r.constraints.noSnaps = false;
  assert(inspectEngineInput(master, r).issues.some((row) => row.key === "s1"));
  r.constraints.excludedSnaps = ["s1"];
  assert.deepEqual(inspectEngineInput(master, r).issues, []);
  r.members = r.members.slice(0, 4);
  r.constraints.leader = "m99";
  assert(inspectEngineInput(master, r).issues.some((row) => row.code === "characters"));
  assert(inspectEngineInput(master, r).issues.some((row) => row.code === "required"));
});
test("P0 engine rejects incomplete actual inputs before chart loading; valid power calculation runs", async () => {
  const cache = new ChartCache(master, async () => {
    throw new Error("must not load charts");
  });
  const bad = request();
  bad.members[0]!.level = null;
  await assert.rejects(runEngine(master, cache, bad), /actual-input-incomplete/);
  const result = await runEngine(master, cache, request());
  assert.equal(result.overall.length, 1);
});
test("P0 direct manual evaluation also validates real inputs", async () => {
  const r = request();
  r.members[0]!.level = null;
  await assert.rejects(
    evaluateTeam(
      master,
      new ChartCache(master, async () => {
        throw Error("chart");
      }),
      {
        ...r,
        team: {
          members: r.members.slice(0, 5).map((row) => row.key),
          snaps: [null, null, null, null, null],
          leader: "m1",
        },
        songs: [],
        play: { great: 0, good: 0, bad: 0, miss: 0 },
        challengeEventId: null,
        event: null,
      },
    ),
    /actual-input-incomplete/,
  );
});

function port(options: { name?: string; size?: number; hang?: boolean; choose?: boolean } = {}) {
  let closed = 0,
    cancelled = 0,
    reads = 0;
  const paths: string[] = [];
  const reader: DeviceReader = {
    open: async () => options.choose !== false,
    type: async (path) => {
      paths.push(path);
      return path.endsWith("/files") ? "directory" : "file";
    },
    async *list() {
      yield { name: options.name ?? "player.json", type: "file" };
    },
    read(path) {
      paths.push(path);
      let finished = false;
      return {
        async read() {
          reads++;
          if (options.hang) return new Promise(() => {});
          if (finished) return { done: true as const, value: undefined };
          finished = true;
          return {
            done: false as const,
            value: options.size ? new Uint8Array(options.size) : new TextEncoder().encode(JSON.stringify(raw())),
          };
        },
        cancel: async () => {
          cancelled++;
        },
        releaseLock() {},
      };
    },
    close: async () => {
      closed++;
    },
  };
  return { reader, state: () => ({ closed, cancelled, reads, paths }) };
}
const channel = "com.bilibili.sirius.official";
test("P1 synthetic USB bytes use existing parser and release device before review", async () => {
  const mock = port();
  const files = await readAndroidFiles(mock.reader, channel, new AbortController().signal);
  assert.equal(mock.state().closed, 1);
  assert(mock.state().paths.every((path) => path.startsWith(`/sdcard/Android/data/${channel}/files`)));
  assert.equal((await parseBoxFiles(files!)).candidates[0]!.members[0]!.cardId, 1);
});
test("P1 chooser cancellation is ordinary cancellation and unknown channel never opens", async () => {
  const mock = port({ choose: false });
  assert.equal(await readAndroidFiles(mock.reader, channel, new AbortController().signal), null);
  await assert.rejects(readAndroidFiles(mock.reader, "foreign.app", new AbortController().signal));
  assert.equal(mock.state().reads, 0);
});
test("P1 rejects traversal/control names before reading", async () => {
  for (const name of ["../secret", "folder/secret", "folder\\secret", "bad\u0000name"]) {
    const mock = port({ name });
    await assert.rejects(readAndroidFiles(mock.reader, channel, new AbortController().signal), /device_path/);
    assert.equal(mock.state().reads, 0);
  }
});
test("P1 actual byte budget stops a dishonest stream and cancels reader", async () => {
  const mock = port({ size: BOX_LIMITS.fileBytes + 1 });
  await assert.rejects(readAndroidFiles(mock.reader, channel, new AbortController().signal), /device_read_budget/);
  assert.equal(mock.state().reads, 1);
  assert.equal(mock.state().cancelled, 1);
  assert.equal(mock.state().closed, 1);
});
test("P1 timeout interrupts a hung stream and closes transport", async () => {
  const mock = port({ hang: true });
  await assert.rejects(readAndroidFiles(mock.reader, channel, new AbortController().signal, 15), /device_timeout/);
  assert(mock.state().closed >= 1);
  assert(mock.state().cancelled >= 1);
});
test("P1 cancellation interrupts authentication and closes before late completion", async () => {
  const mock = port();
  mock.reader.open = () => new Promise(() => {});
  const controller = new AbortController(),
    task = readAndroidFiles(mock.reader, channel, controller.signal);
  controller.abort();
  await assert.rejects(task);
  assert(mock.state().closed >= 1);
});
test("iOS content detection rejects renamed HEIC and oversized dimensions before decoding", () => {
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71]);
  png.set([73, 72, 68, 82], 12);
  const view = new DataView(png.buffer);
  view.setUint32(16, 256);
  view.setUint32(20, 512);
  assert.equal(screenshotHeader(png).type, "image/png");
  view.setUint32(16, 100000);
  assert.throws(() => screenshotHeader(png), /image-budget/);
  const heic = new Uint8Array(24);
  heic.set(new TextEncoder().encode("ftypheic"), 4);
  assert.throws(() => screenshotHeader(heic), /image-heic/);
  assert.throws(() => screenshotHeader(new Uint8Array(30)), /image-format/);
  assert.deepEqual(cropPixels(1000, 1000, { top: 10, right: 20, bottom: 30, left: 10 }), {
    x: 100,
    y: 100,
    width: 700,
    height: 600,
  });
  assert.throws(() => cropPixels(256, 256, { top: 90, right: 0, bottom: 20, left: 0 }), /image-crop/);
});

test("P0 malformed rows and supplied numbers fail explicitly instead of becoming unknown", async () => {
  for (const value of [
    { _memberCards: [null] },
    { _memberCards: [{ _masterId: -1 }] },
    raw({ _exp: "1.5" }),
    raw({ _rank: -1 }),
    { _memberCards: [], _characters: {} },
  ])
    await assert.rejects(parse(value), /box_invalid_json/);
  const candidate = await parse(raw({ _rank: 0 }));
  assert(previewBoxImport(candidate, empty(), data, context).issues.length > 0);
});
test("P0 compressed expansion and caller cancellation are bounded", async () => {
  await assert.rejects(decompress(gzipSync(new Uint8Array(1024 * 1024)), "gzip", 65536), /box_expanded_budget/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(parseBoxText(JSON.stringify(raw()), { signal: controller.signal }));
});
test("P0 potential requires account power bonuses too, while skip does not require live skill", () => {
  const r = request();
  r.goal = { kind: "potential", windowSeconds: 100 };
  r.player.characterTotalRank = null;
  assert(inspectEngineInput(master, r).issues.some((issue) => issue.storageKey === "p.total"));
  const skip = request();
  skip.members[0]!.liveSkillLevel = null;
  skip.goal = {
    kind: "event",
    measure: "points",
    route: "skip",
    songs: [],
    eventId: 1,
    consumption: 1,
    play: { great: 0, good: 0, bad: 0, miss: 0 },
  };
  assert(!inspectEngineInput(master, skip).issues.some((issue) => issue.field === "liveSkillLevel"));
});
test("P1 directory depth, entries, candidates and cumulative bytes are bounded", async () => {
  for (const mode of ["depth", "entries", "files", "bytes"] as const) {
    const mock = port({ size: mode === "bytes" ? BOX_LIMITS.fileBytes : undefined });
    mock.reader.type = async (path) => (mode === "depth" || path.endsWith("/files") ? "directory" : "file");
    mock.reader.list = async function* () {
      if (mode === "depth") {
        yield { name: "nested", type: "directory" };
        return;
      }
      const count = mode === "entries" ? BOX_LIMITS.entries + 1 : mode === "files" ? BOX_LIMITS.candidates + 1 : 3;
      for (let i = 0; i < count; i++) yield { name: `player${i}.json`, type: "file" };
    };
    await assert.rejects(
      readAndroidFiles(mock.reader, channel, new AbortController().signal),
      mode === "bytes" ? /device_read_budget/ : /device_scan_budget/,
    );
    assert(mock.state().closed >= 1);
  }
});
test("P1 symlinks/cache directories are not followed; failed stat cannot read", async () => {
  const mock = port();
  mock.reader.list = async function* () {
    yield { name: "alias", type: "other" };
    yield { name: "Master", type: "directory" };
  };
  await assert.rejects(readAndroidFiles(mock.reader, channel, new AbortController().signal), /device_empty/);
  assert.equal(mock.state().reads, 0);
  const changed = port();
  changed.reader.type = async (path) => (path.endsWith("/files") ? "directory" : "other");
  await assert.rejects(readAndroidFiles(changed.reader, channel, new AbortController().signal), /device_path/);
  assert.equal(changed.state().reads, 0);
});

const readyJob = (id: string) => {
  const jobContext = { ...data.identity, referenceId: "b".repeat(64) };
  return {
    id,
    state: "ready",
    context: jobContext,
    expiresAt: Date.now() + 10000,
    result: {
      schema: "haneoka-card-recognition-result-v1",
      identity: data.identity,
      referenceId: jobContext.referenceId,
      images: [
        {
          id: "image",
          sha256: "c".repeat(64),
          size: [400, 800],
          coordinateSpace: "exif_normalized_original",
          observationIds: ["card"],
          status: "ready",
        },
      ],
      observations: [
        {
          id: "card",
          imageId: "image",
          kind: "members",
          cardId: 1,
          bbox: [0, 0, 128, 128],
          candidates: [],
          fields: { level: { value: 2, status: "recognized" } },
        },
      ],
      engine: { algorithm: "synthetic-test" },
    },
  };
};
test("iOS session deduplicates images, waits for same-account confirmation, and cleans crops/jobs", async () => {
  const deleted: string[] = [],
    revoked: string[] = [];
  const session = createScreenshotImportSession({
    inventory: empty(),
    data,
    context,
    onState: () => {},
    transport: {
      upload: async (_file, options) => readyJob(options.id),
      read: async (id) => readyJob(id),
      delete: async (id) => {
        deleted.push(id);
      },
    },
    crops: async () => ({ "0": `blob:synthetic-${deleted.length}` }),
    revoke: (url) => {
      revoked.push(url);
    },
  });
  const blob = new Blob(["synthetic"], { type: "image/png" });
  await session.files([blob, blob]);
  assert.equal(session.state().phase, "review");
  assert.equal(session.state().preview!.cards.length, 1);
  assert.equal(session.state().canConfirm, false);
  session.bind(true);
  assert.equal(session.state().canConfirm, true);
  const next = session.merge(empty(), data, context);
  assert.equal(next.members[0]!.level, 2);
  assert.equal(next.members[0]!.training, null);
  await session.close();
  assert.equal(deleted.length, 2);
  assert.equal(revoked.length, 2);
});
test("iOS closing during upload rejects late results and repeats cleanup after creation", async () => {
  let finish!: (result: Record<string, unknown>) => void, captured!: ScreenshotRecognitionUploadOptions;
  const deleted: string[] = [],
    states: string[] = [];
  const session = createScreenshotImportSession({
    inventory: empty(),
    data,
    context,
    onState: (state) => states.push(state.phase),
    transport: {
      upload: async (_file, options) => {
        captured = options;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      read: async (id) => readyJob(id),
      delete: async (id) => {
        deleted.push(id);
      },
    },
    crops: async () => {
      throw Error("late result must not decode");
    },
  });
  const pending = session.files([new Blob(["synthetic"], { type: "image/png" })]);
  await session.close();
  const count = states.length;
  assert(captured.signal?.aborted);
  finish(readyJob(captured.id));
  await pending;
  assert.equal(states.length, count);
  assert(deleted.length >= 2);
  assert.equal(session.state().preview, undefined);
  assert.throws(() => session.merge(empty(), data, context));
});
test("iOS invalid service context is sanitized and inventory remains untouched", async () => {
  const original = empty(),
    deleted: string[] = [];
  const session = createScreenshotImportSession({
    inventory: original,
    data,
    context,
    onState: () => {},
    transport: {
      upload: async (_file, options) => ({
        ...readyJob(options.id),
        context: { ...data.identity, server: "foreign", referenceId: "b".repeat(64) },
      }),
      read: async (id) => readyJob(id),
      delete: async (id) => {
        deleted.push(id);
      },
    },
  });
  await session.files([new Blob(["synthetic"], { type: "image/png" })]);
  assert.equal(session.state().phase, "failed");
  assert.equal(session.state().error, "recognition-failed");
  assert.deepEqual(original, empty());
  assert.equal(deleted.length, 1);
  await session.close();
});
