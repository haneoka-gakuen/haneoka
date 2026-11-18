// L3 — GEB
// Input: App-queued imports from the device's own saves.
// Output: Background writes to the current site's Box, song progress and history library.
// Pos: [Map](L2-2.md); app save import handoff.
// Effects/Dependencies: Uses the native bridge and existing import/storage adapters. Never navigates.
import { appCall, type AppSongProgress, type SaveImportAction, type SaveImportJob } from "./app-bridge";
import { clientText } from "../i18n/client";
import { preferredLocale } from "../lit/shared/catalog";
import { snackbar } from "./snackbar";
import { countImportChanges, type CountChanges } from "./song-progress-counts";
import { BoxStore } from "./team-builder/sync/box-store";
import { MAX_BOX_KEYS, validEntry } from "./team-builder/sync/box-doc";

let running = false;

function overwrite(store: BoxStore, changes: CountChanges, matches: (key: string) => boolean) {
  const entries = store.snapshot.entries;
  const next = new Map(changes.map(({ key, value }) => [key, value]));
  for (const [key, entry] of Object.entries(entries))
    if (entry.v !== null && matches(key) && !next.has(key)) next.set(key, null);
  if (Object.keys(entries).length + [...next.keys()].filter((key) => !Object.hasOwn(entries, key)).length > MAX_BOX_KEYS ||
      [...next].some(([key, value]) => !validEntry(key, value)))
    throw new Error("save_import_box");
  store.set([...next].map(([key, value]) => ({ key, value })));
  store.flushNow();
}

async function importTeam(job: SaveImportJob, text: string, store: BoxStore) {
  const [{ fetchTeamBuilderData }, { createEmptyInventory }, { parseBoxText }, { previewBoxImport, applyConfirmedBoxImport }, { inventoryChanges }] =
    await Promise.all([
      import("./team-builder/data/fetch"),
      import("./team-builder/inventory"),
      import("./team-builder/box-import/parser"),
      import("./team-builder/box-import"),
      import("./team-builder/sync/legacy"),
    ]);
  const [parsed, data] = await Promise.all([parseBoxText(text), fetchTeamBuilderData(job.server)]);
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
  const changes = inventoryChanges(confirmed);
  overwrite(store, changes, (key) => /^(m|s|bi|cr)\./u.test(key));
}

function importSongs(progress: AppSongProgress, store: BoxStore) {
  const label = clientText(preferredLocale(), "catalog.songProgress.counts.gameSave", "Game save");
  const counts = countImportChanges(progress.missionCounters, label, new Date().toISOString());
  const changes = Object.entries(progress.marks).map(([key, value]) => ({ key, value }));
  overwrite(store, [...changes, ...counts], (key) => key.startsWith("l.") || (counts.length > 0 && key.startsWith("pref.pc-")));
  if (!counts.length && progress.countError) throw new Error(progress.countError);
}

async function apply(job: SaveImportJob, action: SaveImportAction, stores: Map<string, BoxStore>) {
  const args = { id: job.id, action };
  const result = await appCall("prepareSaveImport", args);
  if (!result) return action !== "link";
  if (!(await appCall("saveImportJobs", {})).some((row) => row.id === job.id && row.actions.includes(action))) return true;
  if (action === "team" || action === "songs") {
    let store = stores.get(job.server);
    if (!store) {
      store = new BoxStore({ server: job.server });
      stores.set(job.server, store);
      await store.start();
    }
    if (action === "team") await importTeam(job, (result as { text: string }).text, store);
    else importSongs(result as AppSongProgress, store);
  }
  else if (action === "history") {
    const { historyStore } = await import("./gacha-history-store");
    for (const file of (result as { files: { name: string; text: string }[] }).files)
      await historyStore.import(JSON.parse(file.text), file.name.replace(/\.json$/u, ""), true);
  }
  return true;
}

export async function runAppSaveImports() {
  if (running) return;
  running = true;
  const stores = new Map<string, BoxStore>();
  try {
    const jobs = await appCall("saveImportJobs", {});
    const options = jobs.length ? await appCall("saveImportOptions", {}) : null;
    const signedIn = options?.link && jobs.some((job) => job.actions.includes("link"))
      ? await fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" })
        .then((response) => response.ok ? response.json() : null)
        .then((session) => Boolean(session?.user?.id))
        .catch(() => false)
      : false;
    let expired = false, failed = false;
    for (const job of jobs) for (const action of job.actions) {
      if (action === "link" && options?.link && !signedIn) continue;
      try {
        if (options?.[action] && !(await apply(job, action, stores))) continue;
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        if (!code.includes("save_import_obsolete")) {
          if (/no_session|history_session_expired|history_missing_session/u.test(code)) expired = true;
          else failed = true;
        }
      }
      await appCall("completeSaveImport", { id: job.id, action });
    }
    const locale = preferredLocale();
    if (expired) snackbar(clientText(locale, "account.page.importSessionExpired", "Game session expired. Read the latest save again."));
    if (failed) snackbar(clientText(locale, "account.page.autoImportFailed", "Some save data could not be imported"), { error: true });
    if (jobs.length) dispatchEvent(new Event("haneoka-save-import-complete"));
  } finally {
    for (const store of stores.values()) store.dispose();
    running = false;
  }
}
