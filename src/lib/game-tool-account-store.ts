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
type Directory = { accounts: GameToolAccount[]; pending: string[]; pendingSettings: string[]; active: Partial<Record<GameTool, string>>; legacy: PublicReleaseServer[] };

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
    active: saved.active && typeof saved.active === "object" ? saved.active : {},
    legacy: (Array.isArray(saved.legacy) ? saved.legacy : []).filter(isPublicReleaseServer),
  };
}
const directoryKey = (scope: string | null) => scope === null ? "directory:local" : `directory:user:${encodeURIComponent(scope)}`;
function changed(scope: string | null, value: Directory) {
  write(directoryKey(scope), value);
  if (scope === gameToolOwner()) window.dispatchEvent(new Event(GAME_TOOL_ACCOUNTS_CHANGED));
}
export function gameToolAccounts(tool: GameTool, includeRemoved = false) {
  return directory().accounts.filter(account => account.tool === tool && (includeRemoved || !account.settings?.removed))
    .sort((a, b) => (a.settings?.position ?? 0) - (b.settings?.position ?? 0) || a.id.localeCompare(b.id));
}
export function legacyGameToolAccounts(tool: GameTool, active?: GameToolAccount): GameToolAccount[] {
  const scope = gameToolOwner(), value = directory(scope);
  if (tool === "history") return (gameToolAccounts(tool).length ? [] : ["jp", "intl"] as const).map(server => legacyToolAccount(server, tool));
  if (!gameToolAccounts(tool).length) return [legacyToolAccount("jp", tool), legacyToolAccount("intl", tool)];
  const matches = new Set(value.legacy);
  const boxOwner = scope === null ? "anonymous" : `account:${encodeURIComponent(scope)}`;
  for (const server of ["jp", "intl"] as const) {
    try {
      const text = localStorage.getItem(`haneoka:team-box:v1:${boxOwner}:${server}`);
      const replica = text && JSON.parse(text) as { entries?: Record<string, { v: unknown }> };
      if (replica && replica.entries && Object.values(replica.entries).some(entry => entry.v !== null)) matches.add(server);
      if (!matches.has(server)) {
        const prefix = `haneoka:team-inventory:v1:${boxOwner}:${server}:`;
        for (let index = 0; index < localStorage.length; index++) {
          if (localStorage.key(index)?.startsWith(prefix)) { matches.add(server); break; }
        }
      }
    } catch { /* A cached Box is optional. */ }
  }
  if (active && !isGameToolAccountId(active.id)) matches.add(active.server);
  if (value.active[tool] === "legacy-jp") matches.add("jp");
  if (value.active[tool] === "legacy-intl") matches.add("intl");
  return [...matches].map(server => legacyToolAccount(server, tool));
}
export function getGameToolAccount(id: string, tool: GameTool, scope = gameToolOwner()): GameToolAccount | undefined {
  if (id === "legacy-jp" || id === "legacy-intl") return legacyToolAccount(id === "legacy-jp" ? "jp" : "intl", tool);
  return directory(scope).accounts.find(account => account.id === id && account.tool === tool && !account.settings?.removed);
}
export function rememberedGameToolAccount(tool: GameTool, id?: string | null): GameToolAccount | undefined {
  return (id ? getGameToolAccount(id, tool) : undefined) ?? getGameToolAccount(directory().active[tool] ?? "", tool);
}
export function selectedGameToolAccount(tool: GameTool, server: string, id?: string | null): GameToolAccount {
  return rememberedGameToolAccount(tool, id) ?? legacyToolAccount(server === "jp" ? "jp" : "intl", tool);
}
export function selectGameToolAccount(account: GameToolAccount) {
  if (!getGameToolAccount(account.id, account.tool)) return;
  const scope = gameToolOwner(), value = directory(scope);
  if (value.active[account.tool] === account.id) return;
  changed(scope, { ...value, active: { ...value.active, [account.tool]: account.id } });
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
    changed(scope, { ...value, accounts: [...merged.values()], legacy: Array.isArray(legacy) ? legacy.filter(isPublicReleaseServer) : value.legacy });
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
  if (existing?.settings?.removed) return existing;
  return put({
    id, tool, server: save.server, uid: save.profileId,
    name: Array.from((save.name ?? "").replace(/[\p{Cc}\p{Cs}]/gu, "")).slice(0, 80).join(""),
    rank: save.rank ?? undefined, favoriteCardId: save.favoriteCardId ?? undefined, savedAt: save.savedAt ?? undefined, historyKeys: [],
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
  const next = new Map(edits.map(({ account, patch }) => [account.id, patch]));
  const accounts = value.accounts.map(account => {
    const patch = next.get(account.id);
    if (!patch) return account;
    const settings = { alias: "", position: 0, removed: false, ...account.settings,
      ...patch, changedAt: Math.max(now, (account.settings?.changedAt ?? 0) + 1) };
    if (!isGameToolAccountSettings(settings)) throw new Error("invalid_game_tool_settings");
    return { ...account, settings };
  });
  const active = { ...value.active };
  for (const account of accounts) if (account.settings?.removed && active[account.tool] === account.id) delete active[account.tool];
  changed(scope, { ...value, accounts, active,
    pendingSettings: scope ? [...new Set([...value.pendingSettings, ...next.keys()])] : value.pendingSettings,
  });
  if (scope) await pushSettings(scope).catch(() => {});
}
export const renameGameToolAccount = (account: GameToolAccount, alias: string) =>
  updateSettings([{ account, patch: { alias: alias.trim() } }]);
export const removeGameToolAccount = (account: GameToolAccount, removed: boolean) =>
  updateSettings([{ account, patch: { removed } }]);
export async function moveGameToolAccount(account: GameToolAccount, delta: -1 | 1) {
  const accounts = gameToolAccounts(account.tool);
  const index = accounts.findIndex(row => row.id === account.id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= accounts.length) return;
  [accounts[index], accounts[target]] = [accounts[target]!, accounts[index]!];
  await updateSettings(accounts.flatMap((row, index) => row.settings?.position === (index + 1) * 1000 ? [] :
    [{ account: row, patch: { position: (index + 1) * 1000 } }]));
}
