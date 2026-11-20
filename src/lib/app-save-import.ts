// L3 — GEB
// Input: App-queued imports from the device's own saves.
// Output: Background writes to the save's server-specific Box and song progress, and the site's history library.
// Pos: [Map](L2-2.md); app save import handoff.
// Effects/Dependencies: Uses the native bridge and existing import/storage adapters. Never navigates.
import { appCall, type AppBoxImport, type AppSongProgress, type SaveImportAction, type SaveImportJob } from "./app-bridge";
import { clientText } from "../i18n/client";
import { preferredLocale } from "../lit/shared/catalog";
import { snackbar } from "./snackbar";
import { countImportChanges, saveClearMarks, type CountChanges } from "./song-progress-counts";
import { saveSongProgressProfile, songProgressProfile } from "./song-progress-profile";
import { BoxStore } from "./team-builder/sync/box-store";
import { MAX_BOX_KEYS, validEntry } from "./team-builder/sync/box-doc";
import { isPublicReleaseServer } from "./temporary-public-routing";
import { captureGameToolSave, gameToolOwner, getGameToolAccount, refreshGameToolAccounts } from "./game-tool-account-store";
import { isGameToolAccountId, legacyToolAccount, type GameToolAccount } from "./game-tool-accounts";
import type { StoredSave } from "./save-workspace/snapshot";

let running = false;
let rerun = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryCount = 0;

function overwrite(store: BoxStore, changes: CountChanges, matches: (key: string) => boolean): CountChanges {
  const entries = store.snapshot.entries;
  const next = new Map(changes.map(({ key, value }) => [key, value]));
  for (const [key, entry] of Object.entries(entries))
    if (entry.v !== null && matches(key) && !next.has(key)) next.set(key, null);
  if (Object.keys(entries).length + [...next.keys()].filter((key) => !Object.hasOwn(entries, key)).length > MAX_BOX_KEYS ||
      [...next].some(([key, value]) => !validEntry(key, value)))
    throw new Error("save_import_box");
  return [...next].map(([key, value]) => ({ key, value }));
}

async function importTeam(text: string, store: BoxStore, account: GameToolAccount, verify: () => Promise<boolean>) {
  const [{ fetchTeamBuilderData }, { createEmptyInventory }, { parseBoxText }, { previewBoxImport, applyConfirmedBoxImport }, { inventoryChanges }] =
    await Promise.all([
      import("./team-builder/data/fetch"),
      import("./team-builder/inventory"),
      import("./team-builder/box-import/parser"),
      import("./team-builder/box-import"),
      import("./team-builder/sync/legacy"),
    ]);
  const [parsed, data] = await Promise.all([parseBoxText(text), fetchTeamBuilderData(account.server)]);
  const candidate = parsed.candidates.length === 1 ? parsed.candidates[0] : undefined;
  const sourceId = data.identity.sourceId;
  if (!candidate || !sourceId) throw new Error("save_import_box");
  const inventory = createEmptyInventory(data.identity);
  const context = { ...data.identity, sourceId, ownerId: "app", revision: 0 };
  const preview = previewBoxImport(candidate, inventory, data, context);
  if (preview.issues.length || !preview.cards.length) throw new Error("save_import_box");
  const confirmed = applyConfirmedBoxImport(inventory, preview, {
    ownership: "replace",
    existingValues: "overwrite",
    cards: preview.cards.map(({ key }) => ({ key, include: true })),
    maps: preview.maps.map(({ key }) => ({ key, include: true })),
    scalars: preview.scalars?.map(({ key }) => ({ key, include: true })),
  }, data, context);
  if (!await verify()) return false;
  const changes = [...inventoryChanges(confirmed), ...saveMarker(account, "team")];
  return applyBox(store, account, overwrite(store, changes, (key) => /^(m|s|bi|cr)\./u.test(key)));
}

async function applyBox(store: BoxStore, account: GameToolAccount, changes: CountChanges) {
  const owner = store.snapshot.owner;
  if (owner === undefined || owner !== gameToolOwner() || !getGameToolAccount(account.id, account.tool, owner)) return false;
  if (isGameToolAccountId(account.id)) return store.applyGameSave(changes, account.savedAt ?? 0);
  store.set(changes);
  return store.flushPending();
}

function saveMarker(account: GameToolAccount, action: "team" | "songs"): CountChanges {
  return isGameToolAccountId(account.id) && account.savedAt ? [{ key: `pref.save-${action}`, value: { savedAt: account.savedAt } }] : [];
}

async function importSongs(progress: AppSongProgress, store: BoxStore, account: GameToolAccount, completeMarks = true) {
  const label = clientText(preferredLocale(), "catalog.songProgress.counts.gameSave", "Game save");
  const counts = countImportChanges(progress.missionCounters, label, new Date(account.savedAt ?? Date.now()).toISOString());
  const changes = Object.entries(progress.marks).map(([key, value]) => ({ key, value }));
  const countError = counts.length ? undefined : progress.countError;
  const applied = await applyBox(store, account, overwrite(store, [...changes, ...counts, ...(!countError ? saveMarker(account, "songs") : [])],
    (key) => completeMarks && key.startsWith("l.") || (counts.length > 0 && key.startsWith("pref.pc-"))));
  if (applied && account.uid) saveSongProgressProfile(account.server, store.snapshot.owner ?? null, songProgressProfile(account),
    isGameToolAccountId(account.id) ? account.id : undefined);
  return { applied, countError };
}

export async function importBrowserSaveToGameTools(record: StoredSave, owner: string | null, options: { team: boolean; songs: boolean }) {
  const { snapshot, profile } = record;
  const uid = profile?.uid || String(snapshot.player._profileId ?? "");
  if (!uid || gameToolOwner() !== owner) return true;
  const save = {
    key: `${snapshot.server}-${uid}`, profileId: uid, server: snapshot.server,
    name: profile?.name || record.label, region: profile?.region ?? null, rank: Number(profile?.rank) || null,
    savedAt: snapshot.savedAt ? Date.parse(snapshot.savedAt) : null,
    favoriteCardId: Number(snapshot.player._favoriteMemberCardId) || null,
  };
  const outcomes = await Promise.allSettled((["team", "songs"] as const).map(async action => {
    if (!options[action]) return true;
    const marks = action === "songs" ? saveClearMarks(snapshot.player) : null;
    const counters = Array.isArray(snapshot.player._missionCounters) ? snapshot.player._missionCounters : undefined;
    if (action === "team" ? !Array.isArray(snapshot.player._memberCards) : !marks && !counters) return true;
    const account = await captureGameToolSave(save, action, owner);
    if (!account || account.settings?.removed || (account.savedAt ?? 0) > (save.savedAt ?? 0)) return true;
    const store = new BoxStore({ server: account.server, accountId: account.id, accountOwner: owner });
    try {
      await store.start();
      if (gameToolOwner() !== owner || store.snapshot.owner !== owner) return false;
      const previous = store.value(`pref.save-${action}`) as { savedAt?: number } | undefined;
      if (previous?.savedAt && (!account.savedAt || previous.savedAt >= account.savedAt)) return true;
      if (action === "team") return importTeam(JSON.stringify(snapshot), store, account, async () => gameToolOwner() === owner);
      return (await importSongs({ marks: marks ?? {}, missionCounters: counters }, store, account, marks !== null)).applied;
    } finally { store.dispose(); }
  }));
  return outcomes.every(result => result.status === "fulfilled" && result.value);
}

const currentJob = async (job: SaveImportJob, action: SaveImportAction) =>
  (await appCall("saveImportJobs", { accountScoped: true })).some(row => row.id === job.id && row.actions.includes(action));

async function apply(job: SaveImportJob, action: SaveImportAction, stores: Map<string, BoxStore>, owner: string | null, account?: GameToolAccount) {
  if (action === "save" && !owner) return true;
  const args = { id: job.id, action };
  const result = await appCall("prepareSaveImport", args);
  if (!result) return action !== "link";
  if (!await currentJob(job, action)) return true;
  if (gameToolOwner() !== owner) return false;
  if (action === "save" && owner) {
    const payload = result as { key?: string; server?: string; text?: string; name?: string; rank?: number };
    if (payload.key !== job.key || payload.server !== job.server || typeof payload.text !== "string")
      throw new Error("save_import_payload");
    const [{ parseSnapshot }, { uploadCloudGameSave }] = await Promise.all([
      import("./save-workspace/snapshot"), import("./save-workspace/cloud"),
    ]);
    const snapshot = parseSnapshot(payload.text);
    return uploadCloudGameSave({ snapshot, label: payload.name || "", profile: songProgressProfile({
      uid: snapshot.player._profileId, name: payload.name, rank: payload.rank, server: snapshot.server,
    }) }, owner);
  }
  if (action === "team" || action === "songs") {
    const payload = result as AppSongProgress | (Pick<AppBoxImport, "text"> & Partial<Pick<AppBoxImport, "server">>);
    if (!isPublicReleaseServer(job.server) || !job.key.startsWith(`${job.server}-`) ||
        (payload.server !== undefined && payload.server !== job.server) ||
        ("key" in payload && payload.key !== undefined && payload.key !== job.key))
      throw new Error("save_import_server");
    if (!job.accountScoped) account ??= legacyToolAccount(job.server, action);
    if (!account || account.server !== job.server) throw new Error("save_import_server");
    let store = stores.get(account.id);
    if (!store) {
      store = new BoxStore({ server: job.server, accountId: isGameToolAccountId(account.id) ? account.id : undefined, accountOwner: owner });
      stores.set(account.id, store);
      await store.start();
    }
    if (gameToolOwner() !== owner || store.snapshot.owner !== owner) return false;
    const previous = store.value(`pref.save-${action}`) as { savedAt?: number } | undefined;
    if (previous?.savedAt && (!account.savedAt || previous.savedAt >= account.savedAt)) return store.flushPending();
    if (action === "team" && "text" in payload) return importTeam(payload.text, store, account,
      async () => gameToolOwner() === owner && await currentJob(job, "team") && gameToolOwner() === owner);
    if (action === "songs" && "marks" in payload) {
      const { applied, countError } = await importSongs(payload, store, account);
      if (applied && countError) throw new Error(countError);
      return applied;
    }
    throw new Error("save_import_payload");
  }
  else if (action === "history") {
    const [{ historyStore }, { HistoryCloudSync }] = await Promise.all([
      import("./gacha-history-store"), import("./gacha-history-cloud-sync"),
    ]);
    const records = [];
    for (const file of (result as { files: { name: string; text: string }[] }).files) {
      records.push(await historyStore.import(JSON.parse(file.text), file.name.replace(/\.json$/u, ""), true));
    }
    const cloud = new HistoryCloudSync();
    cloud.start(false);
    try {
      return await cloud.syncImported(records, owner);
    } finally {
      cloud.stop();
    }
  } else if (action === "link") {
    const status = result as { signedIn?: boolean; link?: unknown };
    return status.signedIn === true && Boolean(status.link);
  }
  return true;
}

export async function runAppSaveImports() {
  if (running) {
    rerun = true;
    return;
  }
  clearTimeout(retryTimer);
  running = true;
  const stores = new Map<string, BoxStore>();
  let retry = false;
  try {
    await refreshGameToolAccounts();
    const queued = await appCall("saveImportJobs", { accountScoped: true });
    if (!queued.length) return;
    const owner = gameToolOwner();
    const jobs = queued.filter(job => !job.accountScoped || (job.owner ?? null) === owner);
    if (!jobs.length) return;
    const devices = await appCall("gameAccounts", {}).catch(() => []);
    const identities = new Map<string, GameToolAccount>();
    const stale = new Set<string>();
    const removed = new Set<string>();
    const actionKey = (job: SaveImportJob, action: SaveImportAction) => `${job.id}:${action}`;
    for (const job of jobs) {
      const save = devices.find(save => save.key === job.key && save.server === job.server);
      if (!save || !isPublicReleaseServer(job.server)) continue;
      const server = job.server;
      await Promise.all(job.actions.map(async action => {
        if (action === "link" || action === "save") return;
        const key = actionKey(job, action);
        if (!job.accountScoped) {
          identities.set(key, { ...legacyToolAccount(server, action), uid: save.profileId, name: save.name ?? "", rank: save.rank ?? undefined });
          return;
        }
        const identity = await captureGameToolSave(save, action, owner).catch(() => undefined);
        if (identity?.settings?.removed) removed.add(key);
        else if (identity && (identity.savedAt ?? 0) > (save.savedAt ?? 0)) stale.add(key);
        else if (identity) identities.set(key, identity);
      }));
    }
    const options = jobs.length ? await appCall("saveImportOptions", {}) : null;
    const signedIn = options?.link && jobs.some((job) => job.actions.includes("link"))
      ? fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" })
        .then((response) => response.ok ? response.json() : null)
        .then((session) => Boolean(session?.user?.id))
        .catch(() => false)
      : Promise.resolve(false);
    let expired = false, failed = false;
    const importAction = async (job: SaveImportJob, action: SaveImportAction) => {
      const key = actionKey(job, action);
      if (removed.has(key)) {
        await appCall("completeSaveImport", { id: job.id, action });
        return;
      }
      if (action === "link" && options?.link && !await signedIn) return;
      try {
        const skipStale = stale.has(key) && (action === "team" || action === "songs");
        if (gameToolOwner() !== owner || options?.[action] && !skipStale && !(await apply(job, action, stores, owner, identities.get(key)))) {
          retry = true;
          return;
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        if (!code.includes("save_import_obsolete")) {
          if (/no_session|history_session_expired|history_missing_session/u.test(code)) expired = true;
          else failed = true;
        }
      }
      await appCall("completeSaveImport", { id: job.id, action });
    };
    const importActions = async (accept: (action: SaveImportAction) => boolean) => {
      for (const job of jobs) for (const action of job.actions) {
        if (accept(action)) await importAction(job, action);
      }
    };
    const results = await Promise.allSettled([
      importActions((action) => action === "team" || action === "songs"),
      importActions((action) => action === "link"),
      importActions((action) => action === "history"),
      importActions((action) => action === "save"),
    ]);
    retry ||= results.some((result) => result.status === "rejected");
    const locale = preferredLocale();
    if (expired) snackbar(clientText(locale, "account.page.importSessionExpired", "Game session expired. Read the latest save again."));
    if (failed) snackbar(clientText(locale, "account.page.autoImportFailed", "Some save data could not be imported"), { error: true });
    if (jobs.length) dispatchEvent(new Event("haneoka-save-import-complete"));
  } finally {
    for (const store of stores.values()) store.dispose();
    running = false;
    if (rerun) {
      rerun = false;
      queueMicrotask(() => void runAppSaveImports().catch(() => {}));
    } else if (retry) {
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(retryCount++, 5));
      retryTimer = setTimeout(() => void runAppSaveImports().catch(() => {}), delay);
    } else {
      retryCount = 0;
    }
  }
}
