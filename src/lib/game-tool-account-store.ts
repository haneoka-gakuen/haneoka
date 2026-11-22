// L3 — GEB
// Input: Private profiles, cached owner, explicit selection and device-save metadata.
// Output: An owner-scoped account directory and the last account selected on this device.
// Pos: [Map](L2-2.md); shared account directory for the game tools.
// Effects/Dependencies: Credential-free metadata in localStorage and the authenticated account API.
import { appCall, appSupports, type DeviceSave } from "./app-bridge";
import { profileRegion } from "./game-records";
import { gameToolIdFromSave, isGameToolAccount, isGameToolAccountId, isGameToolAccountSettings, legacyToolAccount, type GameTool, type GameToolAccount, type GameToolAccountSettings } from "./game-tool-accounts";
import { isPublicReleaseServer, type PublicReleaseServer } from "./temporary-public-routing";

const PREFIX = "haneoka:game-tool:v1:";
const API = "/api/v1/account/tool-accounts";
export const GAME_TOOL_ACCOUNTS_CHANGED = "haneoka:game-tool-accounts";
let owner: string | null | undefined;
let refreshedAt = 0;
let fetching: Promise<void> | undefined;
let sessionVersion = 0;
let listening = false;
type Directory = { accounts: GameToolAccount[]; pending: string[]; pendingSettings: string[]; pendingPurge: string[]; active: Partial<Record<GameTool, string>>; legacy: PublicReleaseServer[] };

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(PREFIX + key) ?? "null") ?? fallback; }
  catch { return fallback; }
}
function write(key: string, value: unknown) {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}
export function gameToolOwner(): string | null {
  return owner === undefined ? read<string | null>("owner", null) : owner;
}
function directory(scope: string | null = gameToolOwner()): Directory {
  const saved = read<Partial<Directory>>(directoryKey(scope), {});
  return {
    accounts: (Array.isArray(saved.accounts) ? saved.accounts : []).filter(isGameToolAccount),
    pending: Array.isArray(saved.pending) ? saved.pending.filter(isGameToolAccountId) : [],
    pendingSettings: Array.isArray(saved.pendingSettings) ? saved.pendingSettings.filter(isGameToolAccountId) : [],
    pendingPurge: Array.isArray(saved.pendingPurge) ? saved.pendingPurge.filter(isGameToolAccountId) : [],
    active: saved.active && typeof saved.active === "object" ? saved.active : {},
    legacy: (Array.isArray(saved.legacy) ? saved.legacy : []).filter(isPublicReleaseServer),
  };
}
const directoryKey = (scope: string | null) => scope === null ? "directory:local" : `directory:user:${encodeURIComponent(scope)}`;
const versions = ["jp", "intl"] as const;
const tools = ["team", "songs", "history"] as const;
// Legacy tool data retains its old Box address. Reserved directory rows store its management settings.
const legacySettingsId = (tool: GameTool, server: PublicReleaseServer) =>
  (1 + tools.indexOf(tool) * versions.length + versions.indexOf(server)).toString(16).padStart(32, "0");
const legacySettingsIds = new Set(tools.flatMap(tool => versions.map(server => legacySettingsId(tool, server))));
function legacyProfile(tool: GameTool, server: PublicReleaseServer, scope = gameToolOwner()): GameToolAccount {
  const stored = directory(scope).accounts.find(row => row.id === legacySettingsId(tool, server));
  return { ...legacyToolAccount(server, tool), settings: stored?.settings };
}
function changed(scope: string | null, value: Directory) {
  write(directoryKey(scope), value);
  if (scope === gameToolOwner()) window.dispatchEvent(new Event(GAME_TOOL_ACCOUNTS_CHANGED));
}
export function gameToolAccounts(tool: GameTool, includeRemoved = false) {
  return directory().accounts.filter(account => account.tool === tool && !legacySettingsIds.has(account.id) && (includeRemoved || !account.settings?.removed))
    .sort((a, b) => (a.settings?.position ?? 0) - (b.settings?.position ?? 0) || a.id.localeCompare(b.id));
}
export function legacyGameToolAccountsWithData(tool: GameTool): PublicReleaseServer[] {
  const scope = gameToolOwner(), value = directory(scope);
  const matches = new Set(value.legacy);
  if (tool === "history") matches.clear();
  for (const server of versions)
    if (value.accounts.some(account => account.id === legacySettingsId(tool, server))) matches.add(server);
  if (tool === "history") return [...matches];
  const boxOwner = scope === null ? "anonymous" : `account:${encodeURIComponent(scope)}`;
  const dataKeys = tool === "songs" ? /^(?:l\.|pref\.pc-)/u : /^(?:m|s|bi|cr|br|cm|mm|p|team|plan)\./u;
  for (const server of ["jp", "intl"] as const) {
    try {
      const text = localStorage.getItem(`haneoka:team-box:v1:${boxOwner}:${server}`);
      const replica = text && JSON.parse(text) as { entries?: Record<string, { v: unknown }> };
      if (replica && replica.entries) {
        const managed = value.accounts.some(account => account.id === legacySettingsId(tool, server));
        if (managed || Object.entries(replica.entries).some(([key, entry]) => dataKeys.test(key) && entry.v !== null))
          matches.add(server);
        else matches.delete(server);
      }
      if (!matches.has(server) && tool === "team") {
        const prefix = `haneoka:team-inventory:v1:${boxOwner}:${server}:`;
        for (let index = 0; index < localStorage.length; index++) {
          if (localStorage.key(index)?.startsWith(prefix)) { matches.add(server); break; }
        }
      }
    } catch { /* A cached Box is optional. */ }
  }
  return [...matches];
}
export function legacyGameToolAccounts(tool: GameTool, active?: GameToolAccount, displayed: PublicReleaseServer[] = [], includeRemoved = false): GameToolAccount[] {
  const matches = new Set([...legacyGameToolAccountsWithData(tool), ...displayed]);
  if (active && !isGameToolAccountId(active.id)) matches.add(active.server);
  return [...matches].map(server => legacyProfile(tool, server)).filter(account => includeRemoved || !account.settings?.removed);
}
export function getGameToolAccount(id: string, tool: GameTool, scope = gameToolOwner()): GameToolAccount | undefined {
  if (id === "legacy-jp" || id === "legacy-intl") {
    const profile = legacyProfile(tool, id === "legacy-jp" ? "jp" : "intl", scope);
    return profile.settings?.removed ? undefined : profile;
  }
  if (!legacySettingsIds.has(id))
    return directory(scope).accounts.find(account => account.id === id && account.tool === tool && !account.settings?.removed);
}
export function rememberedGameToolAccount(tool: GameTool, id?: string | null): GameToolAccount | undefined {
  return (id ? getGameToolAccount(id, tool) : undefined) ?? getGameToolAccount(directory().active[tool] ?? "", tool);
}
export function selectedGameToolAccount(tool: GameTool, server: string, id?: string | null): GameToolAccount {
  const selected = rememberedGameToolAccount(tool, id);
  if (selected) return selected;
  const version = server === "jp" ? "jp" : "intl";
  const old = getGameToolAccount(`legacy-${version}`, tool);
  const known = gameToolAccounts(tool);
  if (old && legacyGameToolAccountsWithData(tool).includes(version)) return old;
  return known.find(account => account.server === version) ?? old ?? known[0]
    ?? getGameToolAccount(`legacy-${version === "jp" ? "intl" : "jp"}`, tool)
    ?? legacyToolAccount(version, tool);
}
export function selectGameToolAccount(account: GameToolAccount) {
  if (!getGameToolAccount(account.id, account.tool)) return;
  const scope = gameToolOwner(), value = directory(scope);
  if (value.active[account.tool] === account.id) return;
  changed(scope, { ...value, active: { ...value.active, [account.tool]: account.id } });
}
export function selectImportedGameToolAccount(account: GameToolAccount) {
  const active = rememberedGameToolAccount(account.tool);
  if (!active || (!isGameToolAccountId(active.id) && !legacyGameToolAccountsWithData(account.tool).includes(active.server)))
    selectGameToolAccount(account);
}

function merge(previous: GameToolAccount | undefined, incoming: GameToolAccount): GameToolAccount {
  if (!previous) return incoming;
  const metadata = (incoming.savedAt ?? 0) >= (previous.savedAt ?? 0) ? incoming : previous;
  const settings = (incoming.settings?.changedAt ?? -1) >= (previous.settings?.changedAt ?? -1) ? incoming.settings : previous.settings;
  return { ...metadata, settings, historyKeys: [...new Set([...previous.historyKeys, ...incoming.historyKeys])].slice(0, 64) };
}

async function push(scope: string, account: GameToolAccount) {
  const response = await fetch(API, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json", "x-haneoka-expected-user": scope },
    body: JSON.stringify({ account }),
  });
  if (!response.ok) return;
  const { account: saved } = await response.json() as { account?: unknown };
  if (!isGameToolAccount(saved) || saved.id !== account.id) return;
  const value = directory(scope);
  const latest = value.accounts.find(row => row.id === account.id);
  if (!latest || JSON.stringify(latest) !== JSON.stringify(account)) return;
  changed(scope, {
    ...value, pending: value.pending.filter(id => id !== account.id),
    accounts: value.accounts.map(row => row.id === account.id ? merge(row, saved) : row),
  });
}

async function pushSettings(scope: string) {
  const current = directory(scope);
  const settings = current.accounts.filter(account => current.pendingSettings.includes(account.id) && account.settings)
    .map(account => ({ id: account.id, value: account.settings }));
  if (!settings.length) return;
  const response = await fetch(API, {
    method: "PATCH", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json", "x-haneoka-expected-user": scope },
    body: JSON.stringify({ settings }),
  });
  if (!response.ok) return;
  const body = await response.json() as { settings?: { id: string; value: unknown }[] };
  if (!Array.isArray(body.settings)) return;
  const accepted = new Map(body.settings.filter(row => isGameToolAccountSettings(row.value))
    .map(row => [row.id, row.value as GameToolAccountSettings]));
  const value = directory(scope);
  const finished = new Set<string>();
  const accounts = value.accounts.map(account => {
    const acknowledged = accepted.get(account.id);
    if (!acknowledged || (account.settings?.changedAt ?? 0) > acknowledged.changedAt) return account;
    finished.add(account.id);
    return { ...account, settings: acknowledged };
  });
  changed(scope, { ...value, accounts, pendingSettings: value.pendingSettings.filter(id => !finished.has(id)) });
}

export function refreshGameToolAccounts(force = false): Promise<void> {
  if (!listening) {
    listening = true;
    window.addEventListener("haneoka:session-changed", () => {
      ++sessionVersion;
      owner = null;
      refreshedAt = 0;
      window.dispatchEvent(new Event(GAME_TOOL_ACCOUNTS_CHANGED));
      void refreshGameToolAccounts(true);
    });
    window.addEventListener("online", () => void refreshGameToolAccounts(true));
    window.addEventListener("storage", event => {
      if (event.key === PREFIX + directoryKey(gameToolOwner()))
        window.dispatchEvent(new Event(GAME_TOOL_ACCOUNTS_CHANGED));
    });
  }
  if (fetching && !force) return fetching;
  if (!force && Date.now() - refreshedAt < 15_000) return Promise.resolve();
  const version = ++sessionVersion;
  const task = (async () => {
    const session = await fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" });
    if (!session.ok && session.status !== 401) return;
    const body = session.ok ? await session.json() as { user?: { id?: string } } | null : null;
    if (sessionVersion !== version) return;
    owner = typeof body?.user?.id === "string" ? body.user.id : null;
    refreshedAt = Date.now();
    const scope = owner;
    write("owner", scope);
    if (appSupports("saveAutomationV2")) await appCall("saveImportOwner", { owner: scope }).catch(() => {});
    if (sessionVersion !== version) return;
    window.dispatchEvent(new Event(GAME_TOOL_ACCOUNTS_CHANGED));
    if (!scope) return;
    const response = await fetch(API, {
      credentials: "same-origin", cache: "no-store", headers: { "x-haneoka-expected-user": scope },
    });
    if (!response.ok || sessionVersion !== version) return;
    const { accounts, legacy } = await response.json() as { accounts?: unknown[]; legacy?: unknown[] };
    if (!Array.isArray(accounts) || sessionVersion !== version) return;
    const value = directory(scope);
    const merged = new Map(value.accounts.map(account => [account.id, account]));
    for (const account of accounts) if (isGameToolAccount(account))
      merged.set(account.id, merge(merged.get(account.id), account));
    for (const id of value.pendingPurge) merged.delete(id);
    changed(scope, { ...value, accounts: [...merged.values()], legacy: Array.isArray(legacy) ? legacy.filter(isPublicReleaseServer) : value.legacy });
    for (const id of value.pendingPurge) {
      if (sessionVersion !== version) return;
      if (await purgeOnServer(scope, id)) {
        const latest = directory(scope);
        changed(scope, { ...latest, pendingPurge: latest.pendingPurge.filter(row => row !== id) });
      }
    }
    for (const id of value.pending) {
      if (sessionVersion !== version) return;
      const account = directory(scope).accounts.find(account => account.id === id);
      if (account) await push(scope, account);
    }
    if (sessionVersion === version) await pushSettings(scope);
  })().catch(() => {});
  fetching = task;
  void task.finally(() => { if (fetching === task) fetching = undefined; });
  return task;
}

async function put(account: GameToolAccount, scope = gameToolOwner()) {
  if (scope !== gameToolOwner() || !isGameToolAccount(account)) throw new Error("game_tool_account_changed");
  const value = directory(scope);
  const previous = value.accounts.find(row => row.id === account.id);
  const next = merge(previous, account);
  const edited = JSON.stringify(previous) !== JSON.stringify(next);
  if (edited) changed(scope, {
    ...value, accounts: [...value.accounts.filter(row => row.id !== account.id), next],
    pending: scope ? [...new Set([...value.pending, next.id])] : value.pending,
  });
  if (scope && (edited || value.pending.includes(next.id))) await push(scope, next).catch(() => {});
  if (scope !== gameToolOwner()) throw new Error("game_tool_account_changed");
  return directory(scope).accounts.find(row => row.id === next.id) ?? next;
}

export async function createGameToolAccount(tool: GameTool, server: PublicReleaseServer, name: string) {
  await refreshGameToolAccounts();
  const created = await put({ id: crypto.randomUUID().replaceAll("-", ""), tool, server, name: name.trim(), historyKeys: [] });
  const position = Math.max(0, ...gameToolAccounts(tool).map(account => account.settings?.position ?? 0)) + 1000;
  await updateSettings([{ account: created, patch: { position } }]);
  return getGameToolAccount(created.id, tool) ?? created;
}
export async function captureGameToolSave(save: DeviceSave, tool: GameTool, scope = gameToolOwner()) {
  if (!isPublicReleaseServer(save.server) || !profileRegion(save.profileId)) return;
  const id = await gameToolIdFromSave(tool, save.server, save.profileId);
  const existing = directory(scope).accounts.find(row => row.id === id);
  if (existing?.settings?.removed) {
    // A re-import restores the removed profile so its data continues in place.
    await updateSettings([{ account: existing, patch: { removed: false } }]);
    return getGameToolAccount(id, tool, scope) ?? existing;
  }
  return put({
    id, tool, server: save.server, uid: save.profileId,
    name: Array.from((save.name ?? "").replace(/[\p{Cc}\p{Cs}]/gu, "")).slice(0, 80).join(""),
    rank: Number.isSafeInteger(save.rank) && save.rank! >= 0 && save.rank! <= 99_999_999 ? save.rank! : undefined,
    favoriteCardId: Number.isSafeInteger(save.favoriteCardId) && save.favoriteCardId! > 0 && save.favoriteCardId! <= 2_147_483_647 ? save.favoriteCardId! : undefined,
    savedAt: Number.isSafeInteger(save.savedAt) && save.savedAt! >= 0 && save.savedAt! <= 8_640_000_000_000_000 ? save.savedAt! : undefined,
    historyKeys: [],
  }, scope);
}
export async function captureGameToolSaveByKey(key: string, tool: GameTool) {
  await refreshGameToolAccounts();
  const scope = gameToolOwner();
  const account = (await appCall("gameAccounts", {}).catch(() => [])).find(save => save.key === key);
  const captured = account && await captureGameToolSave(account, tool, scope);
  return captured?.settings?.removed ? undefined : captured;
}
export async function associateGameToolHistory(account: GameToolAccount, key: string, scope = gameToolOwner()) {
  const existing = directory(scope).accounts.find(row => row.tool === account.tool && row.id !== account.id && row.historyKeys.includes(key));
  if (existing) throw new Error("game_tool_history_already_assigned");
  return put({ ...account, historyKeys: [...new Set([...account.historyKeys, key])] }, scope);
}

async function updateSettings(edits: readonly { account: GameToolAccount; patch: Partial<GameToolAccountSettings> }[]) {
  const scope = gameToolOwner(), value = directory(scope), now = Date.now();
  const newLegacy: GameToolAccount[] = [];
  const next = new Map(edits.map(({ account, patch }) => {
    const legacy = account.id === `legacy-${account.server}`;
    const id = legacy ? legacySettingsId(account.tool, account.server) : account.id;
    if (!value.accounts.some(row => row.id === id && row.tool === account.tool)) {
      if (!legacy) throw new Error("game_tool_account_changed");
      newLegacy.push({ id, tool: account.tool, server: account.server, name: "", historyKeys: [] });
    }
    return [id, patch] as const;
  }));
  const accounts = [...value.accounts, ...newLegacy].map(account => {
    const patch = next.get(account.id);
    if (!patch) return account;
    const settings = { alias: "", position: 0, removed: false, ...account.settings,
      ...patch, changedAt: Math.max(now, (account.settings?.changedAt ?? 0) + 1) };
    if (!isGameToolAccountSettings(settings)) throw new Error("invalid_game_tool_settings");
    return { ...account, settings };
  });
  const active = { ...value.active };
  for (const { account, patch } of edits)
    if (patch.removed && active[account.tool] === account.id) delete active[account.tool];
  changed(scope, { ...value, accounts, active,
    pending: scope ? [...new Set([...value.pending, ...newLegacy.map(row => row.id)])] : value.pending,
    pendingSettings: scope ? [...new Set([...value.pendingSettings, ...next.keys()])] : value.pendingSettings,
  });
  if (scope) {
    for (const row of newLegacy) {
      const account = directory(scope).accounts.find(value => value.id === row.id);
      if (account) await push(scope, account).catch(() => {});
    }
    await pushSettings(scope).catch(() => {});
  }
}
export const renameGameToolAccount = (account: GameToolAccount, alias: string) =>
  updateSettings([{ account, patch: { alias: alias.trim() } }]);
/** Cloud half of a purge; false leaves the id queued for the next refresh. */
async function purgeOnServer(scope: string, id: string) {
  const response = await fetch(API, {
    method: "DELETE", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json", "x-haneoka-expected-user": scope },
    body: JSON.stringify({ id }),
  }).catch(() => null);
  return response !== null && response.ok;
}

const boxReplicaKey = (server: string, owner: string | null, accountId: string) =>
  `haneoka:team-box:v1:${owner === null ? "anonymous" : `account:${encodeURIComponent(owner)}`}:${encodeURIComponent(server)}:${accountId}`;

/**
 * Really deletes a manual (temporary) profile and its tool data. Save-linked
 * accounts keep the recoverable removal: a re-import restores them and their
 * box continues from its saved markers.
 */
export async function purgeGameToolAccount(account: GameToolAccount) {
  if (!isGameToolAccountId(account.id) || account.uid) throw new Error("game_tool_account_purge");
  const scope = gameToolOwner();
  const value = directory(scope);
  const active = { ...value.active };
  if (active[account.tool] === account.id) delete active[account.tool];
  changed(scope, {
    ...value,
    accounts: value.accounts.filter(row => row.id !== account.id),
    pending: value.pending.filter(id => id !== account.id),
    pendingSettings: value.pendingSettings.filter(id => id !== account.id),
    pendingPurge: scope ? [...new Set([...value.pendingPurge, account.id])] : value.pendingPurge,
    active,
  });
  try { localStorage.removeItem(boxReplicaKey(account.server, scope, account.id)); } catch {}
  if (scope && await purgeOnServer(scope, account.id)) {
    const latest = directory(scope);
    changed(scope, { ...latest, pendingPurge: latest.pendingPurge.filter(id => id !== account.id) });
  }
}

export async function removeGameToolAccount(account: GameToolAccount, removed: boolean) {
  const lastLegacy = removed && account.id === `legacy-${account.server}` && !gameToolAccounts(account.tool).length &&
    versions.every(server => server === account.server || !getGameToolAccount(`legacy-${server}`, account.tool));
  const fallback = lastLegacy ? await createGameToolAccount(account.tool, account.server, "") : undefined;
  await updateSettings([{ account, patch: { removed } }]);
  if (fallback) selectGameToolAccount(fallback);
}
export async function moveGameToolAccount(account: GameToolAccount, delta: -1 | 1, visible = gameToolAccounts(account.tool)) {
  const accounts = [...visible];
  const index = accounts.findIndex(row => row.id === account.id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= accounts.length) return;
  [accounts[index], accounts[target]] = [accounts[target]!, accounts[index]!];
  await updateSettings(accounts.flatMap((row, index) => row.settings?.position === (index + 1) * 1000 ? [] :
    [{ account: row, patch: { position: (index + 1) * 1000 } }]));
}
