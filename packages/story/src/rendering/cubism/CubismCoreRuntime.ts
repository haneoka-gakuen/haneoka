import { storyRuntime } from "../../runtime";
import { CubismFramework, LogLevel, Option } from "../../vendor/cubism/live2dcubismframework";

interface CubismGlobalState {
  corePromise: Promise<void> | null;
  cubism2Promise: Promise<void> | null;
  motionSyncPromise: Promise<unknown> | null;
  frameworkReady: boolean;
}

const globalKey = "__haneokaStoryCubismRuntime";

function globalState(): CubismGlobalState {
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const current = target[globalKey] as CubismGlobalState | undefined;
  if (current) return current;
  const created: CubismGlobalState = {
    corePromise: null,
    cubism2Promise: null,
    motionSyncPromise: null,
    frameworkReady: false,
  };
  target[globalKey] = created;
  return created;
}

function loadClassicScript(url: string, ready: () => boolean, label: string): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const selector = `script[data-story-runtime="${label}"]`;
    const existing = document.querySelector<HTMLScriptElement>(selector);
    const script = existing || document.createElement("script");
    let settled = false;
    const cleanup = (): void => {
      script.removeEventListener("load", finish);
      script.removeEventListener("error", failed);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      script.remove();
      reject(error);
    };
    const finish = (): void => {
      if (ready()) succeed();
      else fail(new Error(`${label} loaded without creating its global API`));
    };
    const failed = (): void => fail(new Error(`Failed to load ${label} from ${url}`));
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (existing) return;
    script.src = url;
    script.async = true;
    script.dataset.storyRuntime = label;
    document.head.appendChild(script);
  });
}

export async function ensureCubismFramework(): Promise<void> {
  const state = globalState();
  if (!state.corePromise) {
    const globals = globalThis as typeof globalThis & { Live2DCubismCore?: unknown };
    state.corePromise = loadClassicScript(
      storyRuntime().cubismCoreUrl,
      () => Boolean(globals.Live2DCubismCore),
      "live2d-cubism-core",
    ).catch((error: unknown) => {
      state.corePromise = null;
      throw error;
    });
  }
  await state.corePromise;
  if (state.frameworkReady) return;

  const option = new Option();
  option.loggingLevel = LogLevel.LogLevel_Warning;
  option.logFunction = (message: string) => console.warn(`[Cubism] ${message}`);
  CubismFramework.startUp(option);
  CubismFramework.initialize(64 * 1024 * 1024);
  state.frameworkReady = true;
}

export async function ensureCubism2Framework(): Promise<void> {
  const state = globalState();
  if (!state.cubism2Promise) {
    const globals = globalThis as typeof globalThis & { Live2D?: { init?: () => void } };
    state.cubism2Promise = loadClassicScript(
      storyRuntime().live2d2CoreUrl,
      () => Boolean(globals.Live2D),
      "live2d-2-core",
    )
      .then(() => {
        if (!globals.Live2D) throw new Error("Live2D (Cubism 2) core is unavailable");
        globals.Live2D.init?.();
      })
      .catch((error: unknown) => {
        state.cubism2Promise = null;
        throw error;
      });
  }
  await state.cubism2Promise;
}

export async function ensureMotionSyncCore(errorMessage = "Live2D MotionSync Core is unavailable"): Promise<unknown> {
  const state = globalState();
  const globals = globalThis as typeof globalThis & { Live2DCubismMotionSyncCore?: unknown };
  if (globals.Live2DCubismMotionSyncCore) return globals.Live2DCubismMotionSyncCore;
  if (!state.motionSyncPromise) {
    state.motionSyncPromise = loadClassicScript(
      storyRuntime().motionSyncCoreUrl,
      () => Boolean(globals.Live2DCubismMotionSyncCore),
      "live2d-motion-sync-core",
    )
      .then(() => {
        if (!globals.Live2DCubismMotionSyncCore) throw new Error(errorMessage);
        return globals.Live2DCubismMotionSyncCore;
      })
      .catch((error: unknown) => {
        state.motionSyncPromise = null;
        throw error;
      });
  }
  return state.motionSyncPromise;
}
