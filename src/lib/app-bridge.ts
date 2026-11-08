// L3 — GEB
// Input: Haneoka App 在文档开始时注入的 window.haneokaApp 与其 User-Agent 标记。
// Output: App 身份、平台与原生方法的 Promise 调用。
// Pos: [Map](L2-2.md)；网页与 App 外壳之间的唯一接口。
// Effects/Dependencies: 调用原生存档读取与存档页、游戏服务器读取、系统浏览器登录及全屏方向控制。

export interface AppMethods {
  saveSnapshot: { args: { key: string }; result: { text: string } };
  /** The chosen game account's card, character and band item progress as `ONPKG1:` text. */
  boxAccount: { args: { server: string }; result: { text: string } | null };
  /** Gacha history read from the game server, as companion files (`{key}.json`). */
  gachaHistory: { args: { key?: string }; result: { files: { name: string; text: string }[] } | null };
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
  songProgress: { args: { server: string }; result: { marks: Record<string, number> } | null };
  /** Song progress the app's save page sent here, taken once. */
  pendingSongProgress: { args: Record<string, never>; result: { marks: Record<string, number> } | null };
  /** A save sent to the team builder from the app's save page, taken once. */
  pendingBoxImport: { args: Record<string, never>; result: { server: string; text: string } | null };
}

export interface DeviceSave {
  key: string;
  name: string | null;
  profileId: string;
  region: string | null;
  rank: number | null;
  savedAt: number | null;
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
