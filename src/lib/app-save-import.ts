// L3 — GEB
// Input: App-queued imports from the device's own saves.
// Output: Background writes to the save's server-specific Box and song progress, and the site's history library.
// Pos: [Map](L2-2.md); app save import handoff.
// Effects/Dependencies: Uses the native bridge and existing import/storage adapters. Never navigates.
import { appCall, DEFAULT_SAVE_IMPORT, type AppBoxImport, type AppSongProgress, type DeviceSave, type SaveImportAction, type SaveImportJob, type SaveImportOptions } from "./app-bridge";
import { clientText } from "../i18n/client";
import { preferredLocale } from "../lit/shared/catalog";
import { snackbar } from "./snackbar";
import { countImportChanges, saveClearMarks, type CountChanges } from "./song-progress-counts";
import { saveSongProgressProfile, songProgressProfile } from "./song-progress-profile";
import { BoxStore } from "./team-builder/sync/box-store";
import { MAX_BOX_KEYS, validEntry } from "./team-builder/sync/box-doc";
import { isPublicReleaseServer } from "./temporary-public-routing";
import { associateGameToolHistory, captureGameToolSave, gameToolAccounts, gameToolOwner, getGameToolAccount, refreshGameToolAccounts, selectImportedGameToolAccount } from "./game-tool-account-store";
import { historyKeyFromGameToolAccount, isGameToolAccountId, legacyToolAccount, type GameToolAccount } from "./game-tool-accounts";
import type { StoredHistory } from "./gacha-history-store";
import type { StoredSave } from "./save-workspace/snapshot";

let running = false;
let rerun = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryCount = 0;
const importKey = (job: SaveImportJob, suffix: string) => `haneoka:app-save-import:${job.id}:${suffix}`;

function jobBelongsTo(job: SaveImportJob, owner: string | null) {
  if (!job.accountScoped) return true;
  if (job.owner) return job.owner === owner;
  const key = importKey(job, "owner");
  const captured = localStorage.getItem(key);
  if (captured !== null) return captured === owner;
  if (owner) localStorage.setItem(key, owner);
  return true;
}

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

async function syncHistory(records: StoredHistory[], owner: string | null, autoLink: boolean) {
  const { HistoryCloudSync } = await import("./gacha-history-cloud-sync");
  const cloud = new HistoryCloudSync();
  cloud.start(false);
  try { return await cloud.syncImported(records, owner, autoLink); }
  finally { cloud.stop(); }
}

async function importHistory(files: readonly { name: string; text: string }[], account: GameToolAccount | undefined, owner: string | null, autoLink: boolean) {
  const { historyStore } = await import("./gacha-history-store");
  const records = [];
  for (const file of files) {
    if (gameToolOwner() !== owner) return false;
    const record = await historyStore.import(JSON.parse(file.text), file.name.replace(/\.json$/u, ""), true);
    if (account && isGameToolAccountId(account.id)) await associateGameToolHistory(account, record.key, owner);
    records.push(record);
  }
  return syncHistory(records, owner, autoLink);
}

async function bindUnclaimedSave(job: SaveImportJob, save: DeviceSave, owner: string) {
  const endpoint = "/api/v1/account/game-accounts";
  const headers = { "content-type": "application/json", "x-haneoka-expected-user": owner };
  const [response, file, { parseSnapshot }] = await Promise.all([
    fetch(endpoint, { headers, cache: "no-store" }),
    appCall("saveSnapshot", { key: save.key }),
    import("./save-workspace/snapshot"),
  ]);
  if (!response.ok) return false;
  const { accounts } = await response.json() as { accounts: { playerUid: string; region: string; visibility: string; summary?: Record<string, unknown> }[] };
  const previous = accounts.find(account => account.playerUid === save.profileId && account.region === job.server);
  const snapshot = parseSnapshot(file.text);
  if (snapshot.server !== job.server || String(snapshot.player._profileId ?? "") !== save.profileId)
    throw new Error("save_import_server");
  if (!await currentJob(job, "link")) return true;
  if (gameToolOwner() !== owner) return false;
  const player = snapshot.player;
  const result = await fetch(endpoint, {
    method: "PUT", headers,
    body: JSON.stringify({
      server: job.server, profileId: save.profileId, name: save.name, savedAt: save.savedAt,
      visibility: previous?.visibility ?? "private",
      summary: {
        ...previous?.summary,
        rank: save.rank, exp: player._exp, favoriteMemberCardId: save.favoriteCardId,
        members: Array.isArray(player._memberCards) ? player._memberCards.length : undefined,
        snapshots: Array.isArray(player._supportCards) ? player._supportCards.length : undefined,
      },
    }),
  });
  if (result.ok) return true;
  const error = await result.json().catch(() => null) as { error?: { code?: string } } | null;
  // The other owner's link is independent of importing this person's private tool data.
  return error?.error?.code === "player_linked";
}

function repairKey(owner: string, account: GameToolAccount) {
  return `haneoka:app-save-repair:v1:${owner}:${account.id}`;
}

/** Repair already imported profiles without reading game files or touching unrelated local saves. */
async function repairImportedProfiles(devices: DeviceSave[], queued: SaveImportJob[], owner: string, options: SaveImportOptions) {
  let retry = false;
  let changed = false;
  let localHistory: Promise<StoredHistory[]> | undefined;
  for (const action of ["team", "songs", "history"] as const) {
    if (!options[action]) continue;
    for (const account of gameToolAccounts(action)) {
      const save = account.uid && devices.find(row => row.profileId === account.uid && row.server === account.server);
      if (!save || queued.some(job => job.key === save.key && job.actions.includes(action))) continue;
      if (gameToolOwner() !== owner) return { retry: true, changed };
      const key = repairKey(owner, account), version = String(save.savedAt ?? 0);
      if (localStorage.getItem(key) === version) continue;
      try {
        let repaired = false;
        if (action === "history") {
          const { historyStore } = await import("./gacha-history-store");
          const known = await historyKeyFromGameToolAccount(account);
          const keys = new Set([...account.historyKeys, known]);
          localHistory ??= historyStore.list();
          const records = (await localHistory).filter(record => keys.has(record.key) || record.aliases?.some(alias => keys.has(alias)));
          if (records.length) repaired = await syncHistory(records, owner, true);
          else if (save.canRefresh) {
            const result = await appCall("gachaHistory", { account: save.key }).catch(error => {
              if (/history_session_expired|no_session|history_missing_session/u.test(String(error))) return null;
              throw error;
            });
            repaired = result ? await importHistory(result.files, account, owner, true) : true;
          } else repaired = true;
        } else {
          const store = new BoxStore({ server: account.server, accountId: account.id, accountOwner: owner });
          try {
            await store.start();
            if (gameToolOwner() !== owner || store.snapshot.owner !== owner) return { retry: true, changed };
            const previous = store.value(`pref.save-${action}`) as { savedAt?: number } | undefined;
            const target = await captureGameToolSave(save, action, owner);
            if (!target || target.settings?.removed) continue;
            if (previous?.savedAt && previous.savedAt >= (save.savedAt ?? 0)) repaired = await store.flushPending();
            else if (action === "team")
              repaired = await importTeam((await appCall("saveSnapshot", { key: save.key, complete: true })).text, store, target, async () => gameToolOwner() === owner);
            else {
              const progress = await appCall("songProgress", { server: account.server, key: save.key });
              if (progress) {
                const result = await importSongs(progress, store, target);
                repaired = result.applied;
              }
            }
          } finally { store.dispose(); }
        }
        if (repaired) {
          localStorage.setItem(key, version);
          selectImportedGameToolAccount(account);
          changed = true;
        } else retry = true;
      } catch { retry = true; }
    }
  }
  return { retry, changed };
}

async function apply(job: SaveImportJob, action: SaveImportAction, stores: Map<string, BoxStore>, owner: string | null, account?: GameToolAccount) {
  if (action === "save" && !owner) return true;
  const args = { id: job.id, action };
  const result = await appCall("prepareSaveImport", args);
  if (!result) return action !== "link" || !job.owner;
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
    return importHistory((result as { files: { name: string; text: string }[] }).files, account, owner, job.accountScoped === true && !!account);
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
    const owner = gameToolOwner();
    const jobs = queued.filter(job => jobBelongsTo(job, owner));
    const canRecover = owner && (["team", "songs", "history"] as const).some(tool => gameToolAccounts(tool).some(account => account.uid));
    if (!jobs.length && !canRecover) return;
    const devices = await appCall("gameAccounts", {});
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
    const options = { ...DEFAULT_SAVE_IMPORT, ...await appCall("saveImportOptions", {}) };
    const signedIn = options.link && jobs.some((job) => job.actions.includes("link"))
      ? fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" })
        .then((response) => response.ok ? response.json() : null)
        .then((session) => Boolean(session?.user?.id))
        .catch(() => false)
      : Promise.resolve(false);
    let expired = false, failed = false;
    const importAction = async (job: SaveImportJob, action: SaveImportAction) => {
      const key = actionKey(job, action);
      const anonymous = job.accountScoped && !job.owner && !owner;
      if (anonymous && options[action] && (action === "save" || action === "link" || localStorage.getItem(importKey(job, action))))
        return;
      if (removed.has(key)) {
        await appCall("completeSaveImport", { id: job.id, action });
        return;
      }
      if (action === "link" && options.link && !await signedIn) return;
      try {
        const skipStale = stale.has(key) && (action === "team" || action === "songs");
        const save = action === "link" && job.accountScoped && !job.owner && owner
          ? devices.find(device => device.key === job.key && device.server === job.server) : undefined;
        if (gameToolOwner() !== owner || options[action] && !skipStale && !(save && owner
          ? await bindUnclaimedSave(job, save, owner) : await apply(job, action, stores, owner, identities.get(key)))) {
          retry = true;
          return;
        }
        const account = identities.get(key);
        if (options[action] && account && isGameToolAccountId(account.id)) {
          selectImportedGameToolAccount(account);
          if (owner) localStorage.setItem(repairKey(owner, account), String(account.savedAt ?? 0));
        }
        if (anonymous && options[action]) {
          localStorage.setItem(importKey(job, action), "1");
          return;
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        if (error instanceof TypeError || /history_(?:network_error|service_unavailable)|temporarily_unavailable/u.test(code)) {
          retry = true;
          return;
        }
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
    const repairs = owner && canRecover ? await repairImportedProfiles(devices, queued, owner, options) : undefined;
    retry ||= repairs?.retry ?? false;
    const locale = preferredLocale();
    if (expired) snackbar(clientText(locale, "account.page.importSessionExpired", "Game session expired. Read the latest save again."));
    if (failed) snackbar(clientText(locale, "account.page.autoImportFailed", "Some save data could not be imported"), { error: true });
    if (jobs.length || repairs?.changed) dispatchEvent(new Event("haneoka-save-import-complete"));
  } catch {
    retry = true;
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
