import { advCharacterExpressions, advCharacterMotions, hasAdvCharacterModel } from "../types/AdvRuntime";
import type { AdvCharacterVariant, AdvCommand, AdvRuleTransitionEntry, AdvStory } from "../types/AdvRuntime";
import type { StoryResourceBackend } from "../rendering/StorySceneBackend";
import { isCanonicalStoryResourceUrl, requireCanonicalStoryResourceUrl } from "../runtime";
import { advCommandGroupCommands } from "./AdvCommandGroup";
import { ADV_COMMAND } from "./AdvConstants";
import { splitAdvTargetNames } from "./AdvCommandText";
import { sortAdvTimelineSignals } from "./AdvPlayableDirector";

const sharedFetchedUrls = new Map<string, Promise<void>>();
const MAX_SHARED_FETCH_KEYS = 512;

function resourceRequestError(name: "AbortError", message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function fetchUrl(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  await response.arrayBuffer();
}

function waitForSharedFetch(pending: Promise<void>, signal: AbortSignal | undefined, url: string): Promise<void> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(resourceRequestError("AbortError", `Loading was aborted: ${url}`));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(resourceRequestError("AbortError", `Loading was aborted: ${url}`)));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

const rememberSharedFetch = (url: string, request: Promise<void>) => {
  sharedFetchedUrls.delete(url);
  sharedFetchedUrls.set(url, request);
  while (sharedFetchedUrls.size > MAX_SHARED_FETCH_KEYS) {
    const oldest = sharedFetchedUrls.keys().next().value;
    if (typeof oldest !== "string") break;
    sharedFetchedUrls.delete(oldest);
  }
};

type PreloadTask = { key: string; label: string; index: number; run: () => Promise<void> };

export interface AdvEpisodeResourceSnapshot {
  readonly characterVariants: Array<[string, AdvCharacterVariant]>;
  readonly characterAssetIndices: Array<[string, number]>;
  readonly playbackIndex: number;
}

export class AdvEpisodeResourceLoader {
  sceneRoot: StoryResourceBackend;
  state: Record<string, unknown>;
  characterVariants: Map<string, AdvCharacterVariant>;
  characterAssetIndices: Map<string, number>;
  backgroundWarm: Promise<void> | null;
  private backgroundTasks: PreloadTask[];
  private backgroundPump: Promise<void> | null;
  private completedTaskKeys: Set<string>;
  private scheduledTaskKeys: Set<string>;
  private preloadSignal?: AbortSignal;
  private preloadAheadCommands: number;
  private preloadBehindCommands: number;
  private backgroundConcurrency: number;
  private playbackIndex: number;
  constructor(sceneRoot: StoryResourceBackend, state: Record<string, unknown>) {
    this.sceneRoot = sceneRoot;
    this.state = state;
    this.characterVariants = new Map<string, AdvCharacterVariant>();
    this.characterAssetIndices = new Map<string, number>();
    this.backgroundWarm = null;
    this.backgroundTasks = [];
    this.backgroundPump = null;
    this.completedTaskKeys = new Set();
    this.scheduledTaskKeys = new Set();
    this.preloadAheadCommands = 192;
    this.preloadBehindCommands = 24;
    this.backgroundConcurrency = 6;
    this.playbackIndex = 0;
  }

  async preload(story: AdvStory | null | undefined, signal?: AbortSignal) {
    assertNestedCanonicalResourceUrls(story);
    const commands = story?.commands || [];
    // Pre-scan the script to attribute each referenced motion/expression to the
    // specific model that plays it, by replaying the placement state machine
    // (Character registers a variant, In/Costume set the active variant). Motion
    // names are generic and collide across every character's catalog, so a global
    // name set would warm ~N× too many URLs; per-model attribution is required.
    // This uses local state only — it never touches the loader's shared
    // characterVariants/characterAssetIndices, which playback populates itself.
    const referencedAnimations = collectReferencedAnimations(commands);
    const textureUrls = new Set<string>();
    const fileUrls = new Map<string, string>();
    const firstCmdIndex = new Map<string, number>();
    const noteIndex = (url: string, index: number) => {
      if (!firstCmdIndex.has(url)) firstCmdIndex.set(url, index);
    };
    const addFile = (label: string, url: string, index: number) => {
      assertLocalRuntimeUrl(label, url);
      if (!isLocalRuntimeUrl(url)) return;
      fileUrls.set(url, label);
      noteIndex(url, index);
    };
    const addTexture = (url: string, index: number) => {
      assertLocalRuntimeUrl("image", url);
      if (!isLocalRuntimeUrl(url)) return;
      textureUrls.add(url);
      fileUrls.set(url, "image");
      noteIndex(url, index);
    };
    const defaultRule = story?.runtime?.defaultRuleTransition as AdvRuleTransitionEntry | undefined;
    if (defaultRule?.texture) addTexture(defaultRule.texture, 0);
    else if (defaultRule?.maskTexture) addTexture(defaultRule.maskTexture, 0);
    for (let i = 0; i < commands.length; i += 1) {
      for (const cmd of commandsIncludingTimelineEpisodes(commands[i])) {
        addTexture(cmd.background?.url || "", i);
        addTexture(cmd.still?.url || "", i);
        addTexture(cmd.frame?.texture || "", i);
        for (const url of Object.values(cmd.frame?.textures || {})) addTexture(String(url), i);
        for (const edge of cmd.frame?.edges || []) addTexture(edge?.texture || "", i);
        for (const element of cmd.frame?.elements || []) addTexture(element?.texture || "", i);
        for (const url of Object.values(cmd.effect?.textures || {})) addTexture(String(url), i);
        if (cmd.ruleTransition?.texture) addTexture(cmd.ruleTransition.texture, i);
        if (cmd.ruleTransition?.maskTexture) addTexture(cmd.ruleTransition.maskTexture, i);
        addFile("bgm", cmd.bgm?.playableUrl || "", i);
        addFile("se", cmd.se?.playableUrl || "", i);
        for (const voice of cmd.voices || []) addFile("voice", voice?.playableUrl || "", i);
        addFile(
          "video",
          cmd.video?.playableUrl ||
            cmd.video?.src ||
            cmd.video?.url ||
            cmd.movie?.playableUrl ||
            cmd.movie?.src ||
            cmd.movie?.url ||
            cmd.clip?.playableUrl ||
            cmd.clip?.src ||
            cmd.clip?.url ||
            "",
          i,
        );
        if (cmd.live2d) {
          this.collectLive2DManifest(
            cmd.live2d,
            (label, url) => addFile(label, url, i),
            (url) => addTexture(url, i),
            referencedAnimations.motions.get(cmd.live2dKey || ""),
            referencedAnimations.expressions.get(cmd.live2dKey || ""),
          );
        }
      }
    }
    // Some story exports keep assets in metadata or opcode-specific extension
    // fields. Include every declared canonical resource URL, not only the
    // fields understood by the current renderer.
    collectDeclaredResourceUrls(story, (url) => addFile("asset", url, 0));
    const tasks: PreloadTask[] = [
      ...[...textureUrls].map((url) => ({
        key: `texture:${url}`,
        label: "image",
        index: firstCmdIndex.get(url) ?? 0,
        run: async () => {
          if (typeof this.sceneRoot.preloadTexture === "function") {
            await this.sceneRoot.preloadTexture(url);
          } else {
            await this.sceneRoot.loadTexture(url);
          }
        },
      })),
      ...[...fileUrls.entries()]
        .filter(([url]) => !textureUrls.has(url))
        .map(([url, label]) => ({
          key: `file:${url}`,
          label,
          index: firstCmdIndex.get(url) ?? 0,
          run: () => this.fetchUrl(url),
        })),
    ];
    const workerCount = preloadConcurrency(story?.runtime?.preloadConcurrency);
    this.preloadSignal = signal;
    this.preloadAheadCommands = preloadWindow(story?.runtime?.preloadAheadCommands, 192, 8, 384);
    this.preloadBehindCommands = preloadWindow(story?.runtime?.preloadBehindCommands, 24, 0, 64);
    this.backgroundConcurrency = preloadConcurrency(story?.runtime?.preloadBackgroundConcurrency, 6, 8);
    // Entering a story is gated on its complete declared asset manifest.  Do
    // not leave a later playback window that could trigger network loading.
    this.backgroundTasks = [];
    this.completedTaskKeys.clear();
    this.scheduledTaskKeys.clear();

    // The full manifest is blocking. A failure prevents entry into the story.
    const preloadState = this.state.preload as Record<string, unknown> | undefined;
    if (preloadState) {
      preloadState.total = tasks.length;
      preloadState.done = 0;
      preloadState.failures = [];
    }
    await this.runPreloadTasks(tasks, signal, workerCount, true);
    if (!signal?.aborted && preloadState && Array.isArray(preloadState.failures) && preloadState.failures.length) {
      throw new Error(`ADV preload failed:\n${preloadState.failures.join("\n")}`);
    }

    if (!this.backgroundWarm) this.backgroundWarm = Promise.resolve();
  }

  private async runPreloadTasks(
    tasks: PreloadTask[],
    signal: AbortSignal | undefined,
    baseConcurrency: number,
    tracked: boolean,
  ) {
    if (!tasks.length) return;
    const workerCount = Math.min(tasks.length, baseConcurrency);
    let nextTaskIndex = 0;
    const runWorker = async () => {
      while (!signal?.aborted) {
        const task = tasks[nextTaskIndex];
        nextTaskIndex += 1;
        if (!task) return;
        if (tracked) {
          const preloadState = this.state.preload as Record<string, unknown> | undefined;
          if (preloadState) preloadState.label = task.label;
        }
        try {
          await task.run();
        } catch (err) {
          if (!signal?.aborted && tracked) {
            const preloadState = this.state.preload as Record<string, unknown> | undefined;
            if (preloadState && Array.isArray(preloadState.failures)) {
              preloadState.failures.push(errorMessage(err));
            }
          }
        }
        this.completedTaskKeys.add(task.key);
        this.scheduledTaskKeys.delete(task.key);
        if (tracked) {
          const preloadState = this.state.preload as Record<string, unknown> | undefined;
          if (preloadState)
            (preloadState as Record<string, number>).done = ((preloadState as Record<string, number>).done || 0) + 1;
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, runWorker));
  }

  advanceTo(commandIndex: number) {
    this.playbackIndex = Math.max(0, Math.floor(Number(commandIndex) || 0));
    if (this.backgroundPump || this.preloadSignal?.aborted) return;
    const pump = this.runBackgroundPump().catch(() => {});
    this.backgroundPump = pump;
    this.backgroundWarm = pump;
    void pump.finally(() => {
      if (this.backgroundPump !== pump) return;
      this.backgroundPump = null;
    });
  }

  async waitForBackgroundWarm() {
    let pending = this.backgroundWarm;
    while (pending) {
      await pending;
      if (pending === this.backgroundWarm) return;
      pending = this.backgroundWarm;
    }
  }

  private async runBackgroundPump() {
    while (!this.preloadSignal?.aborted) {
      const minIndex = Math.max(0, this.playbackIndex - this.preloadBehindCommands);
      const maxIndex = this.playbackIndex + this.preloadAheadCommands;
      const tasks = this.backgroundTasks.filter(
        (task) =>
          task.index >= minIndex &&
          task.index <= maxIndex &&
          !this.completedTaskKeys.has(task.key) &&
          !this.scheduledTaskKeys.has(task.key),
      );
      if (!tasks.length) return;
      for (const task of tasks) this.scheduledTaskKeys.add(task.key);
      await this.runPreloadTasks(tasks, this.preloadSignal, this.backgroundConcurrency, false);
    }
  }

  /**
   * Warm every Phase-2 resource whose command index falls in [startIndex, endIndex]
   * at background concurrency, independently of the rolling playback pump. Used by
   * seek so resources load in parallel while the deterministic replay loop re-applies
   * command state serially. Safe to fire without awaiting: it shares the pump's
   * completed/scheduled key sets, so nothing double-loads and the pump picks up any
   * tasks this pass did not finish.
   */
  warmRange(startIndex: number, endIndex: number): Promise<void> {
    const min = Math.max(0, Math.floor(Number(startIndex) || 0));
    const max = Math.max(min, Math.floor(Number(endIndex) || 0));
    const tasks = this.backgroundTasks.filter(
      (task) =>
        task.index >= min &&
        task.index <= max &&
        !this.completedTaskKeys.has(task.key) &&
        !this.scheduledTaskKeys.has(task.key),
    );
    if (!tasks.length) return Promise.resolve();
    for (const task of tasks) this.scheduledTaskKeys.add(task.key);
    return this.runPreloadTasks(tasks, this.preloadSignal, this.backgroundConcurrency, false);
  }

  /**
   * Collect the Live2D assets this story actually uses. Core files
   * (model/moc/physics/textures) are always declared — they are needed the
   * moment a character is placed. Motions and expressions are filtered to the
   * per-model referenced sets computed by collectReferencedAnimations; any name
   * not pre-warmed here is fetched lazily by the model on first play. Each
   * model's default idle motion is always included so placement is instant.
   */
  collectLive2DManifest(
    live2d: AdvCommand["live2d"],
    addFile: (label: string, url: string) => void,
    addTexture: (url: string) => void,
    usedMotions?: Set<string>,
    usedExpressions?: Set<string>,
  ) {
    const runtime = live2d?.runtime;
    if (!runtime) return;
    addFile("live2d", runtime.model || "");
    addFile("live2d", runtime.moc || "");
    if (runtime.imageUrl) addTexture(runtime.imageUrl);
    // Both Cubism generations consume the source physics descriptor. Keep it
    // in the core manifest so entry does not trigger another network round trip.
    addFile("live2d-physics", runtime.physics || "");
    for (const url of runtime.textures || []) addTexture(url);
    const defaultIdle = readDefaultIdleMotionName(live2d);
    for (const motion of advCharacterMotions(live2d)) {
      const name = motion?.name || "";
      // When no referenced set is supplied (defensive fallback), keep the legacy
      // behavior of warming the whole catalog. Otherwise warm only names this
      // story references on this model, plus the model's own default idle.
      if (usedMotions && !usedMotions.has(name) && name !== defaultIdle) continue;
      addFile("live2d-motion", motion?.runtime || "");
    }
    for (const expression of advCharacterExpressions(live2d)) {
      const name = expression?.name || "";
      if (usedExpressions && !usedExpressions.has(name)) continue;
      addFile("live2d-expression", expression?.runtime || "");
    }
  }

  fetchUrl(url: string) {
    let request = sharedFetchedUrls.get(url);
    if (!request) {
      request = fetchUrl(url).catch((err) => {
        sharedFetchedUrls.delete(url);
        throw err;
      });
      rememberSharedFetch(url, request);
    } else {
      rememberSharedFetch(url, request);
    }
    return waitForSharedFetch(request, this.preloadSignal, url);
  }

  registerCharacterAsset(cmd: AdvCommand) {
    if (!hasAdvCharacterModel(cmd?.live2d)) return;
    const index = Number(cmd.targetAssetIndex) || 0;
    for (const target of cmd.targets || []) {
      if (!target.target) continue;
      this.characterVariants.set(`${target.target}\u0000${index}`, {
        live2d: cmd.live2d!,
        live2dKey: cmd.live2dKey,
        targetAssetIndex: index,
      });
    }
  }

  resolveCharacterForTarget(target: string, index = 0) {
    return this.characterVariants.get(`${target}\u0000${Number(index) || 0}`) || null;
  }

  setCharacterAssetIndex(target: string, index = 0) {
    if (!target) return;
    this.characterAssetIndices.set(target, Number(index) || 0);
  }

  resolveCurrentCharacterForTarget(target: string) {
    if (!this.characterAssetIndices.has(target)) return null;
    const index = this.characterAssetIndices.get(target);
    return this.resolveCharacterForTarget(target, index == null ? 0 : index);
  }

  resolveCharacterForIn(target: string, index = 0) {
    if (this.characterAssetIndices.has(target)) {
      return this.resolveCurrentCharacterForTarget(target);
    }
    return this.resolveCharacterForTarget(target, index);
  }

  createSnapshot(): AdvEpisodeResourceSnapshot {
    return {
      // Variant manifests are immutable story data; preserve their references
      // when a host serializes loader state.
      characterVariants: [...this.characterVariants.entries()],
      characterAssetIndices: [...this.characterAssetIndices.entries()],
      playbackIndex: this.playbackIndex,
    };
  }

  restoreSnapshot(snapshot: AdvEpisodeResourceSnapshot | null) {
    if (!snapshot) return;
    this.characterVariants = new Map((snapshot.characterVariants as Array<[string, AdvCharacterVariant]>) || []);
    this.characterAssetIndices = new Map((snapshot.characterAssetIndices as Array<[string, number]>) || []);
    this.playbackIndex = Math.max(0, Math.trunc(Number(snapshot.playbackIndex) || 0));
  }
}

function isLocalRuntimeUrl(value: string): boolean {
  return isCanonicalStoryResourceUrl(value);
}

function assertLocalRuntimeUrl(label: string, value: string) {
  const url = value || "";
  if (url) requireCanonicalStoryResourceUrl(url, `${label} resource`);
}

const STORY_RESOURCE_FIELD = /(?:url$|^(?:src|source|runtime|model|moc|physics)$|textures?$)/i;
const STORY_RESOURCE_COLLECTION = /textures$/i;
const STORY_BUNDLED_CORE_FIELD = /^(?:cubismCoreUrl|motionSyncCoreUrl|live2d2CoreUrl)$/i;

function assertNestedCanonicalResourceUrls(
  value: unknown,
  label = "story",
  field = "",
  directResource = false,
  seen = new WeakSet<object>(),
) {
  if (typeof value === "string") {
    if (!value || (!directResource && !STORY_RESOURCE_FIELD.test(field))) return;
    if (field.toLocaleLowerCase() === "source" && !/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(value)) return;
    if (STORY_BUNDLED_CORE_FIELD.test(field) && value.startsWith("/Core/")) return;
    requireCanonicalStoryResourceUrl(value, label);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const valuesAreResources = STORY_RESOURCE_COLLECTION.test(field);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNestedCanonicalResourceUrls(entry, `${label}[${index}]`, "", valuesAreResources, seen);
    });
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assertNestedCanonicalResourceUrls(entry, `${label}.${key}`, key, valuesAreResources, seen);
  }
}

function collectDeclaredResourceUrls(
  value: unknown,
  add: (url: string) => void,
  field = "",
  directResource = false,
  seen = new WeakSet<object>(),
) {
  if (typeof value === "string") {
    if (!value || (!directResource && !STORY_RESOURCE_FIELD.test(field))) return;
    if (field.toLocaleLowerCase() === "source" && !/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(value)) return;
    if (STORY_BUNDLED_CORE_FIELD.test(field) && value.startsWith("/Core/")) return;
    if (isCanonicalStoryResourceUrl(value)) add(value);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const valuesAreResources = STORY_RESOURCE_COLLECTION.test(field);
  if (Array.isArray(value)) {
    value.forEach((entry) => collectDeclaredResourceUrls(entry, add, "", valuesAreResources, seen));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // Animation catalogs are preloaded by collectLive2DManifest, which warms only
    // the motions/expressions a story actually references (plus each model's idle).
    // Skip them here so this catch-all does not re-warm every entry in every
    // appearing character's catalog — that would fully defeat the per-story filter.
    if (key === "motions" || key === "expressions") continue;
    collectDeclaredResourceUrls(entry, add, key, valuesAreResources, seen);
  }
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read a model's default idle motion name from its catalog entry. Sourced from
 * the same fields the renderer uses (profile.defaultMotionName, then
 * runtime.defaultMotionName) so the warmed idle matches the one played on
 * placement. AdvCharacterModelEntry exposes profile via its index signature, so
 * the access is narrowed here rather than at every call site.
 */
function readDefaultIdleMotionName(live2d: AdvCommand["live2d"]): string {
  const profile = (live2d as { profile?: { defaultMotionName?: unknown } } | null | undefined)?.profile;
  const fromProfile = typeof profile?.defaultMotionName === "string" ? profile.defaultMotionName : "";
  const runtime = live2d?.runtime as { defaultMotionName?: unknown } | undefined;
  const fromRuntime = typeof runtime?.defaultMotionName === "string" ? runtime.defaultMotionName : "";
  return String(fromProfile || fromRuntime || "");
}

/**
 * Walk the script in playback order and attribute every referenced motion and
 * expression name to the specific model (by live2dKey) that plays it. Motion
 * and expression names are generic and collide across every character's
 * catalog, so a global name set would warm roughly N× too many files; this
 * replays the placement state machine the engine uses at runtime to pin each
 * reference to the one model actually playing it:
 *
 *   Character — registers a variant at (target, index)
 *   In        — places the active variant, plays its layout presentation
 *   Costume   — switches the active variant by index
 *
 * Uses local state only and never touches the loader's characterVariants /
 * characterAssetIndices (playback populates those itself). A misattribution
 * here only fails to pre-warm a file; the model layer fetches it lazily on
 * first play, so playback is never affected.
 */
function collectReferencedAnimations(commands: AdvCommand[]): {
  motions: Map<string, Set<string>>;
  expressions: Map<string, Set<string>>;
} {
  const motions = new Map<string, Set<string>>();
  const expressions = new Map<string, Set<string>>();
  const variantsByTarget = new Map<string, Map<number, string>>();
  const activeIndex = new Map<string, number>();

  const targetsOf = (cmd: AdvCommand): string[] => {
    const keys = (cmd?.targets || [])
      .map((entry) => entry?.target)
      .filter((key): key is string => Boolean(key && typeof key === "string"));
    return keys.length ? keys : splitAdvTargetNames(cmd?.targetName);
  };
  const registerVariant = (target: string, index: number, live2dKey: string | undefined) => {
    if (!target || !live2dKey) return;
    let byIndex = variantsByTarget.get(target);
    if (!byIndex) {
      byIndex = new Map<number, string>();
      variantsByTarget.set(target, byIndex);
    }
    byIndex.set(index, live2dKey);
  };
  const activeKey = (target: string, fallbackIndex: number): string | undefined => {
    const byIndex = variantsByTarget.get(target);
    if (!byIndex) return undefined;
    const idx = activeIndex.has(target) ? (activeIndex.get(target) as number) : fallbackIndex;
    return byIndex.get(idx) ?? byIndex.get(0);
  };
  const note = (store: Map<string, Set<string>>, live2dKey: string | undefined, name: unknown) => {
    const trimmed = String(name || "").trim();
    if (!live2dKey || !trimmed) return;
    let bucket = store.get(live2dKey);
    if (!bucket) {
      bucket = new Set<string>();
      store.set(live2dKey, bucket);
    }
    bucket.add(trimmed);
  };
  const attribute = (cmd: AdvCommand, target: string) => {
    const key = activeKey(target, Number(cmd.targetAssetIndex) || 0);
    note(motions, key, cmd.motionName);
    note(expressions, key, cmd.expressionName);
    const presentation = cmd.characterPresentation;
    if (presentation) {
      note(motions, key, presentation.motionName);
      note(expressions, key, presentation.expressionName);
    }
  };

  for (let i = 0; i < commands.length; i += 1) {
    for (const cmd of commandsIncludingTimelineEpisodes(commands[i])) {
      if (!cmd) continue;
      const op = Number(cmd.command);
      const targets = targetsOf(cmd);
      switch (op) {
        case ADV_COMMAND.Character: {
          const index = Number(cmd.targetAssetIndex) || 0;
          for (const target of targets) registerVariant(target, index, cmd.live2dKey);
          break;
        }
        case ADV_COMMAND.In: {
          // In places the currently-active variant. It only sets the active
          // index when none is set yet (matching resolveCharacterForIn); an In
          // that carries its own model registers and activates it. The layout
          // presentation plays on the target being placed.
          const fallback = Number(cmd.targetAssetIndex) || 0;
          for (const target of targets) {
            if (cmd.live2d) {
              registerVariant(target, fallback, cmd.live2dKey);
              activeIndex.set(target, fallback);
            } else if (!activeIndex.has(target)) {
              activeIndex.set(target, fallback);
            }
            attribute(cmd, target);
          }
          break;
        }
        case ADV_COMMAND.Costume: {
          const index = Number(cmd.targetAssetIndex) || 0;
          for (const target of targets) activeIndex.set(target, index);
          break;
        }
        default:
          break;
      }
      // Motion/Expression/Talk carry the reference on the command itself.
      if (op !== ADV_COMMAND.In && (cmd.motionName || cmd.expressionName || cmd.characterPresentation)) {
        for (const target of targets) attribute(cmd, target);
      }
    }
  }
  return { motions, expressions };
}

function preloadConcurrency(value: unknown, fallback = 8, max = 16) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(number)));
}

function preloadWindow(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

/**
 * Native `PreloadFromTimeline` traverses the AdvEpisodeSignal rows
 * and preloads their command resources at the parent Timeline command's
 * position. Recursive Timeline episodes are rejected by the native helper.
 */
function commandsIncludingTimelineEpisodes(command: AdvCommand): AdvCommand[] {
  const commands: AdvCommand[] = [];
  const seen = new Set<AdvCommand>();
  const visit = (entry: AdvCommand): void => {
    if (seen.has(entry)) return;
    seen.add(entry);
    commands.push(entry);
    for (const nested of advCommandGroupCommands(entry)) visit(nested);
    for (const signal of sortAdvTimelineSignals(entry.timeline?.signals || [])) {
      if (Number(signal.episode?.command) !== 45) visit(signal.episode);
    }
  };
  visit(command);
  return commands;
}
