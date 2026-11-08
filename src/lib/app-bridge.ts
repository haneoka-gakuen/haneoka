// L3 — GEB
// Input: Haneoka App 在文档开始时注入的 window.haneokaApp 与其 User-Agent 标记。
// Output: App 身份、平台与原生方法的 Promise 调用。
// Pos: [Map](L2-2.md)；网页与 App 外壳之间的唯一接口。
// Effects/Dependencies: 调用原生存档读取与存档页、游戏服务器读取、系统浏览器登录及全屏方向控制。

export interface AppMethods {
  /** The chosen save's player document as a `haneoka-game-save-v1` snapshot. */
  saveSnapshot: { args: { key: string }; result: { text: string } };
  /** The chosen game account's card, character and band item progress as `ONPKG1:` text. */
  boxAccount: { args: { server: string; key?: string }; result: { text: string } | null };
  /** Gacha history read from the game server, as companion files (`{key}.json`). */
  gachaHistory: {
    args: { key?: string; account?: string };
    result: { files: { name: string; text: string }[] } | null;
  };
  /** Provider sign-in in the system browser; the page exchanges the code for its session. */
  signIn: { args: { provider: string }; result: { code: string; verifier: string } | null };
  orientation: { args: { orientation: "landscape" | "any" }; result: null };
  /** Game saves read on this device; `haneoka-app-accounts` fires on window when they change. */
  gameAccounts: { args: Record<string, never>; result: DeviceSave[] };
  /** The app's page for one save: progress, cards, clears, export and update. */
  openGameAccount: { args: { key: string }; result: null };
  /** The app's save reading: Shizuku, game folder, USB, backups or files. */
  addGameAccount: { args: Record<string, never>; result: null };
  /** Gacha history the app's save page read from the game server, taken once. */
  pendingGachaHistory: { args: Record<string, never>; result: { files: { name: string; text: string }[] } | null };
  /** Clear marks (1 clear, 2 full combo, 3 all perfect) by `l.{song}.{difficulty}` from a chosen game save. */
  songProgress: { args: { server: string; key?: string }; result: { marks: Record<string, number> } | null };
  /** Song progress the app's save page sent here, taken once. */
  pendingSongProgress: { args: Record<string, never>; result: { marks: Record<string, number> } | null };
  /** A save sent to the team builder from the app's save page, taken once. */
  pendingBoxImport: { args: Record<string, never>; result: { server: string; text: string } | null };
  /** `saveSourcesV1`: where this device can read game saves. */
  saveSources: { args: Record<string, never>; result: { sources: SaveSource[]; releases: string[] } };
  /** Picked files, or a picked folder; null when the reader backs out. */
  readFiles: { args: { folder?: boolean; release?: string }; result: SaveRead | null };
  adbDevices: { args: Record<string, never>; result: AdbDevice[] };
  adbPair: { args: { address: string; code: string }; result: boolean };
  adbConnect: { args: { address: string }; result: boolean };
  adbRead: { args: { serial: string; release?: string }; result: SaveRead };
  /** Backups in the system's folder, or in a picked one. */
  iosBackups: { args: { pick?: boolean }; result: IosBackup[] | null };
  iosBackupRead: { args: { path: string; password?: string }; result: SaveRead };
  deviceStatus: {
    args: Record<string, never>;
    result: {
      status: "notRunning" | "needsPermission" | "unsupported" | "ready";
      canGrantFolder: boolean;
      installed: boolean;
    };
  };
  shizukuRequest: { args: Record<string, never>; result: { granted: boolean } };
  openShizuku: { args: Record<string, never>; result: { opened: boolean } };
  shizukuRead: { args: { release?: string }; result: SaveRead };
  /** A release grants its folder once; without one, every granted folder is read. */
  gameFolder: { args: { release?: string }; result: SaveRead | null };
  refreshGameAccount: { args: { key: string }; result: null };
  exportGameAccount: { args: { key: string }; result: boolean };
  deleteGameAccount: { args: { key: string }; result: null };
}

export type SaveSource = "files" | "folder" | "adb" | "iosBackup" | "shizuku" | "gameFolder";

export interface SaveRead {
  keys: string[];
  unreadable: number;
}

export interface AdbDevice {
  serial: string;
  state: string;
  model: string | null;
  releases: string[];
}

export interface IosBackup {
  path: string;
  deviceName: string | null;
  productType: string | null;
  date: number | null;
  encrypted: boolean;
}

export interface DeviceSave {
  key: string;
  name: string | null;
  profileId: string;
  region: string | null;
  rank: number | null;
  savedAt: number | null;
  server?: string | null;
  canRefresh?: boolean;
}

interface HaneokaApp {
  capabilities?: readonly string[];
  version: string;
  platform: string;
  call<M extends keyof AppMethods>(method: M, args: AppMethods[M]["args"]): Promise<AppMethods[M]["result"]>;
}

/** Synchronous, so the first render already knows; the bridge object arrives at document start. */
export const inApp = (): boolean => typeof navigator !== "undefined" && /\bHaneokaApp\//u.test(navigator.userAgent);

export function appPlatform(): string | undefined {
  return (window as Window & { haneokaApp?: HaneokaApp }).haneokaApp?.platform;
}

export function appCall<M extends keyof AppMethods>(
  method: M,
  args: AppMethods[M]["args"],
): Promise<AppMethods[M]["result"]> {
  const app = (window as Window & { haneokaApp?: HaneokaApp }).haneokaApp;
  if (!app) return Promise.reject(new Error("app_unavailable"));
  return app.call(method, args);
}

export function appSupports(capability: string): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as Window & { haneokaApp?: HaneokaApp }).haneokaApp?.capabilities?.includes(capability)
  );
}

/**
 * `accountKeysV1`: with several saves the app asks the page to choose
 * (`choose_account`); [choose] returns the chosen key, or null to stop.
 */
export async function appAccountCall<M extends "boxAccount" | "songProgress" | "gachaHistory">(
  method: M,
  args: AppMethods[M]["args"],
  choose: (accounts: DeviceSave[]) => Promise<string | null>,
): Promise<AppMethods[M]["result"]> {
  try {
    return await appCall(method, args);
  } catch (error) {
    if (!(error instanceof Error ? error.message : String(error)).includes("choose_account")) throw error;
  }
  const server = "server" in args ? (args.server as string) : undefined;
  const accounts = (await appCall("gameAccounts", {})).filter(
    (account) => !server || !account.server || account.server === server,
  );
  const key = await choose(accounts);
  if (!key) return null;
  return appCall(method, method === "gachaHistory" ? { ...args, account: key } : { ...args, key });
}
