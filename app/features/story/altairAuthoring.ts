import type { JsonObject, StoryProject, StoryProjectPlugin } from "@haneoka/altair";
import { AltairPluginHost as CoreAltairPluginHost } from "@haneoka/altair/plugins";
import { satisfiesVegaSemVer } from "@haneoka/vega/marketplace";
import {
  effectiveHaneokaStoryProjectPlugins,
  HANEOKA_AUTHORING_PLUGIN_IDS,
  HANEOKA_AUTHORING_PLUGIN_RELEASES,
} from "~/features/story/pluginSelection";

export interface AltairAuthoringPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: 2;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly capabilities?: readonly string[];
}

export interface AltairAuthoringPlugin {
  readonly manifest: AltairAuthoringPluginManifest;
  readonly setup: (...arguments_: readonly unknown[]) => unknown;
}

export interface AltairAuthoringServiceKey<T> {
  readonly id: string;
  readonly __type?: T;
}

export interface AltairAuthoringHostPort {
  readonly installedPluginIds: readonly string[];
  readonly commandSchema: CoreAltairPluginHost["commandSchema"];
  readonly createCommand: CoreAltairPluginHost["createCommand"];
  readonly importFormat: CoreAltairPluginHost["importFormat"];
  readonly exportFormat: CoreAltairPluginHost["exportFormat"];
  readonly evaluateDiagnostics: CoreAltairPluginHost["evaluateDiagnostics"];
  readonly buildFlow: CoreAltairPluginHost["buildFlow"];
  readonly createPreview: CoreAltairPluginHost["createPreview"];
  install(
    plugin: AltairAuthoringPlugin,
    options?: {
      readonly configuration?: JsonObject;
      readonly permissions?: readonly string[];
    },
  ): Promise<void>;
  list(): readonly AltairAuthoringPluginManifest[];
  contributions<T = unknown>(kind: string): readonly T[];
  service<T>(key: AltairAuthoringServiceKey<T>): T | undefined;
  dispose(): Promise<void>;
}

export interface AltairAuthoringPluginLoadContext {
  readonly selection: StoryProjectPlugin;
  readonly signal: AbortSignal;
}

export type AltairAuthoringPluginLoader = (context: AltairAuthoringPluginLoadContext) => unknown | Promise<unknown>;

export interface AltairAuthoringPluginRegistration {
  readonly id: string;
  readonly version: string;
  readonly source?: StoryProjectPlugin["source"];
  readonly load: AltairAuthoringPluginLoader;
}

export interface AltairAuthoringPluginRegistry {
  readonly pluginIds: ReadonlySet<string>;
  registration(pluginId: string): AltairAuthoringPluginRegistration | undefined;
}

const freezeRegistration = (registration: AltairAuthoringPluginRegistration): AltairAuthoringPluginRegistration => {
  if (!registration || typeof registration.id !== "string" || !registration.id.trim()) {
    throw new TypeError("Altair authoring plugin registration requires an id");
  }
  if (typeof registration.version !== "string" || !registration.version.trim()) {
    throw new TypeError(`Altair authoring plugin ${registration.id} requires an exact version`);
  }
  if (typeof registration.load !== "function") {
    throw new TypeError(`Altair authoring plugin ${registration.id} requires a loader`);
  }
  return Object.freeze({
    id: registration.id.trim(),
    version: registration.version.trim(),
    ...(registration.source === undefined ? {} : { source: cloneJson(registration.source) }),
    load: registration.load,
  });
};

export const createAltairAuthoringPluginRegistry = (
  registrations: readonly AltairAuthoringPluginRegistration[],
): AltairAuthoringPluginRegistry => {
  const entries = new Map<string, AltairAuthoringPluginRegistration>();
  for (const value of registrations) {
    const registration = freezeRegistration(value);
    if (entries.has(registration.id)) {
      throw new Error(`Duplicate Altair authoring plugin registration: ${registration.id}`);
    }
    entries.set(registration.id, registration);
  }
  return Object.freeze({
    pluginIds: new Set(entries.keys()) as ReadonlySet<string>,
    registration: (pluginId: string) => entries.get(pluginId),
  });
};

export const createHaneokaAltairAuthoringRegistry = (
  loaders: Readonly<Partial<Record<string, AltairAuthoringPluginLoader>>>,
): AltairAuthoringPluginRegistry =>
  createAltairAuthoringPluginRegistry(
    HANEOKA_AUTHORING_PLUGIN_RELEASES.flatMap((release) => {
      const load = loaders[release.id];
      return load
        ? [
            {
              id: release.id,
              version: release.version,
              source: release.source,
              load,
            },
          ]
        : [];
    }),
  );

/**
 * Haneoka's authoring preset. Every implementation stays in its independently
 * versioned package and is only evaluated when the project selects it.
 */
export const createDefaultHaneokaAltairAuthoringRegistry = (
  overrides: Readonly<Partial<Record<string, AltairAuthoringPluginLoader>>> = {},
): AltairAuthoringPluginRegistry =>
  createHaneokaAltairAuthoringRegistry({
    "haneoka.altair-adv": () => import("@haneoka/altair-plugin-adv"),
    "haneoka.altair-bestdori": () => import("@haneoka/altair-plugin-bestdori"),
    "haneoka.altair-haneoka": () => import("@haneoka/altair-plugin-haneoka"),
    "haneoka.altair-webgal": async () => {
      const webgal = await import("@haneoka/altair-plugin-webgal");
      return webgal.createAltairWebGalPlugin({ resourceFiles: [] });
    },
    "haneoka.altair-flow": () => import("@haneoka/altair-plugin-flow"),
    "haneoka.altair-history": () => import("@haneoka/altair-plugin-history"),
    "haneoka.altair-drafts": async () => {
      const drafts = await import("@haneoka/altair-plugin-drafts");
      if (typeof globalThis.indexedDB === "undefined") return drafts.altairDraftsPlugin;
      return drafts.createAltairDraftsPlugin({
        persistenceFactory: () => drafts.createAltairIndexedDbDraftPersistence(),
      });
    },
    "haneoka.altair-vega-preview": () => import("@haneoka/altair-plugin-vega-preview"),
    "haneoka.altair-workspace-browser": async () => {
      const workspace = await import("@haneoka/altair-plugin-workspace-browser");
      const persistence =
        typeof globalThis.indexedDB === "undefined"
          ? undefined
          : workspace.createIndexedDbBrowserWorkspaceDirectoryPersistence({
              // Retain the existing Haneoka handle store while the plugin owns
              // all transaction, validation, and disposal semantics.
              databaseName: "haneoka-story-editor-v2",
              databaseVersion: 1,
              storeName: "drafts",
              key: "active-directory",
            });
      return workspace.createAltairWorkspaceBrowserPlugin({
        ...(persistence ? { persistence } : {}),
      });
    },
    ...overrides,
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isAltairAuthoringPlugin = (value: unknown): value is AltairAuthoringPlugin => {
  if (!isRecord(value) || typeof value.setup !== "function") return false;
  const manifest = value.manifest;
  return (
    isRecord(manifest) &&
    typeof manifest.id === "string" &&
    typeof manifest.name === "string" &&
    typeof manifest.version === "string" &&
    manifest.apiVersion === 2
  );
};

/**
 * Independent packages expose their plugin as the default export. Direct
 * plugin values are accepted as well for host-provided/builtin adapters.
 */
export const altairAuthoringPluginFromModule = (value: unknown): AltairAuthoringPlugin => {
  const plugin = isAltairAuthoringPlugin(value)
    ? value
    : isRecord(value) && isAltairAuthoringPlugin(value.default)
      ? value.default
      : undefined;
  if (!plugin) {
    throw new TypeError("Altair authoring package must default-export an API 2 plugin");
  }
  return plugin;
};

const cloneJson = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)])) as T;
  }
  return value;
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
};

const sameSource = (requested: StoryProjectPlugin["source"], installed: StoryProjectPlugin["source"]): boolean =>
  requested === undefined || (installed !== undefined && canonicalJson(requested) === canonicalJson(installed));

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
};

const withAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};

const linkedAbortController = (
  signals: readonly (AbortSignal | undefined)[],
): { readonly signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const forward = () => controller.abort(signal.reason);
    signal.addEventListener("abort", forward, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", forward));
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const cleanup of cleanups) cleanup();
    },
  };
};

const requireApi2Host = (value: unknown): AltairAuthoringHostPort => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.installedPluginIds) ||
    typeof value.commandSchema !== "function" ||
    typeof value.createCommand !== "function" ||
    typeof value.importFormat !== "function" ||
    typeof value.exportFormat !== "function" ||
    typeof value.evaluateDiagnostics !== "function" ||
    typeof value.buildFlow !== "function" ||
    typeof value.createPreview !== "function" ||
    typeof value.install !== "function" ||
    typeof value.list !== "function" ||
    typeof value.contributions !== "function" ||
    typeof value.service !== "function" ||
    typeof value.dispose !== "function"
  ) {
    throw new TypeError(
      "Haneoka requires the Altair API 2 plugin host; legacy authoring implementations are unsupported",
    );
  }
  return value as unknown as AltairAuthoringHostPort;
};

const defaultHostFactory = (): AltairAuthoringHostPort => requireApi2Host(new CoreAltairPluginHost());

interface LoadedSelection {
  readonly selection: StoryProjectPlugin;
  readonly plugin: AltairAuthoringPlugin;
}

export const storyProjectPluginTargetsAltairAuthoring = (selection: StoryProjectPlugin): boolean =>
  Boolean(selection.targets?.runtimes?.some((runtime) => runtime.trim().toLowerCase() === "altair"));

const requestedCapabilitiesArePresent = (selection: StoryProjectPlugin, plugin: AltairAuthoringPlugin): void => {
  const provided = new Set(plugin.manifest.capabilities ?? []);
  const missing = (selection.capabilities ?? []).filter((capability) => !provided.has(capability));
  if (missing.length) {
    throw new Error(
      `${selection.id}@${selection.version} does not provide requested capabilities: ${missing.join(", ")}`,
    );
  }
};

const validateDependency = (
  ownerId: string,
  dependencyId: string,
  range: string,
  loaded: ReadonlyMap<string, LoadedSelection>,
): void => {
  const dependency = loaded.get(dependencyId);
  if (!dependency) {
    throw new Error(`${ownerId} requires enabled authoring plugin ${dependencyId}`);
  }
  if (!satisfiesVegaSemVer(dependency.plugin.manifest.version, range)) {
    throw new Error(`${ownerId} requires ${dependencyId}@${range}, found ${dependency.plugin.manifest.version}`);
  }
};

const installationOrder = (loaded: readonly LoadedSelection[]): readonly LoadedSelection[] => {
  const byId = new Map(loaded.map((entry) => [entry.plugin.manifest.id, entry]));
  for (const entry of loaded) {
    for (const [dependencyId, range] of Object.entries(entry.plugin.manifest.dependencies ?? {})) {
      validateDependency(entry.plugin.manifest.id, dependencyId, range, byId);
    }
    for (const [dependencyId, range] of Object.entries(entry.selection.dependencies ?? {})) {
      validateDependency(entry.plugin.manifest.id, dependencyId, range, byId);
    }
  }

  const result: LoadedSelection[] = [];
  const active = new Set<string>();
  const complete = new Set<string>();
  const visit = (entry: LoadedSelection, trail: readonly string[]): void => {
    const id = entry.plugin.manifest.id;
    if (complete.has(id)) return;
    if (active.has(id)) {
      throw new Error(`Altair authoring plugin dependency cycle: ${[...trail, id].join(" -> ")}`);
    }
    active.add(id);
    const dependencies = new Set([
      ...Object.keys(entry.plugin.manifest.dependencies ?? {}),
      ...Object.keys(entry.selection.dependencies ?? {}),
    ]);
    for (const dependencyId of dependencies) {
      visit(byId.get(dependencyId)!, [...trail, id]);
    }
    active.delete(id);
    complete.add(id);
    result.push(entry);
  };
  for (const entry of loaded) visit(entry, []);
  return Object.freeze(result);
};

const authoringSelections = (
  project: Pick<StoryProject, "plugins">,
  registry: AltairAuthoringPluginRegistry,
  knownAuthoringPluginIds: ReadonlySet<string>,
  enforceRequiredPreset: boolean,
): readonly StoryProjectPlugin[] => {
  const selections = effectiveHaneokaStoryProjectPlugins(project.plugins);
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      throw new Error(`Duplicate project plugin selection: ${selection.id}`);
    }
    seen.add(selection.id);
  }
  if (enforceRequiredPreset) {
    const missingRequired = HANEOKA_AUTHORING_PLUGIN_RELEASES.filter(
      (release) => release.required && !seen.has(release.id),
    ).map(({ id }) => id);
    if (missingRequired.length) {
      throw new Error(`Project is missing required Altair authoring plugins: ${missingRequired.join(", ")}`);
    }
  }

  return Object.freeze(
    selections.flatMap((selection) => {
      const registered = registry.pluginIds.has(selection.id);
      const known = knownAuthoringPluginIds.has(selection.id);
      const explicitlyTargetsAuthoring = storyProjectPluginTargetsAltairAuthoring(selection);
      const authoring = registered || known || explicitlyTargetsAuthoring;
      if (!authoring) return [];
      if (selection.enabled === false) {
        if (selection.required) {
          throw new Error(`Required Altair authoring plugin cannot be disabled: ${selection.id}`);
        }
        return [];
      }
      if (!registered && !known && explicitlyTargetsAuthoring) {
        throw new Error(`No installed authoring package is registered for ${selection.id}@${selection.version}`);
      }
      if (!registry.registration(selection.id)) {
        throw new Error(`No installed authoring package is registered for ${selection.id}@${selection.version}`);
      }
      return [cloneJson(selection)];
    }),
  );
};

const selectionSignature = (selections: readonly StoryProjectPlugin[]): string => canonicalJson(selections);

export interface HaneokaAltairAuthoringHostOptions {
  readonly registry: AltairAuthoringPluginRegistry;
  readonly hostFactory?: () => unknown;
  readonly authoringPluginIds?: ReadonlySet<string>;
  /** Disable only for generic host tests or hosts that do not use Haneoka's preset. */
  readonly enforceRequiredPreset?: boolean;
  readonly signal?: AbortSignal;
}

export interface ReconcileAltairAuthoringOptions {
  readonly signal?: AbortSignal;
}

export interface AltairAuthoringCleanupWarning {
  readonly attempt: number;
  readonly installedPluginIds: readonly string[];
  readonly error: unknown;
}

export interface AltairAuthoringCleanupReport {
  readonly pendingRetiredHosts: number;
  readonly warnings: readonly AltairAuthoringCleanupWarning[];
  readonly unresolvedError?: AggregateError;
}

interface RetiredAltairAuthoringHost {
  readonly host: AltairAuthoringHostPort;
  readonly installedPluginIds: readonly string[];
  attempts: number;
  lastError?: unknown;
}

/**
 * Stable Haneoka-facing handle around replaceable Altair hosts.
 *
 * A complete next host is activated before it becomes visible. Reconcile
 * activation failures leave the previous host and its services alive.
 * Successful swaps retire the previous dependency graph; cleanup failures are
 * retained in `cleanupReport` and retried during later reconciliation/disposal.
 */
export class HaneokaAltairAuthoringHost {
  readonly #registry: AltairAuthoringPluginRegistry;
  readonly #hostFactory: () => unknown;
  readonly #knownAuthoringPluginIds: ReadonlySet<string>;
  readonly #enforceRequiredPreset: boolean;
  readonly #lifetime = new AbortController();
  readonly #retiredHosts = new Set<RetiredAltairAuthoringHost>();
  readonly #cleanupWarnings: AltairAuthoringCleanupWarning[] = [];
  #host: AltairAuthoringHostPort;
  #activeSelections: readonly StoryProjectPlugin[] = Object.freeze([]);
  #signature = "";
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;
  #disposal: Promise<void> | undefined;
  readonly #removeExternalAbort?: () => void;

  constructor(options: HaneokaAltairAuthoringHostOptions) {
    this.#registry = options.registry;
    this.#hostFactory = options.hostFactory ?? defaultHostFactory;
    this.#knownAuthoringPluginIds = options.authoringPluginIds ?? HANEOKA_AUTHORING_PLUGIN_IDS;
    this.#enforceRequiredPreset = options.enforceRequiredPreset ?? true;
    this.#host = requireApi2Host(this.#hostFactory());
    if (options.signal) {
      const abort = () => {
        void this.dispose().catch(() => undefined);
      };
      if (options.signal.aborted) {
        this.#lifetime.abort(options.signal.reason);
        void this.dispose().catch(() => undefined);
      } else {
        options.signal.addEventListener("abort", abort, { once: true });
        this.#removeExternalAbort = () => options.signal?.removeEventListener("abort", abort);
      }
    }
  }

  get host(): AltairAuthoringHostPort {
    this.#assertActive();
    return this.#host;
  }

  get installedPluginIds(): readonly string[] {
    return Object.freeze([...this.#host.installedPluginIds]);
  }

  get activeSelections(): readonly StoryProjectPlugin[] {
    return Object.freeze(this.#activeSelections.map((selection) => cloneJson(selection)));
  }

  get cleanupReport(): AltairAuthoringCleanupReport {
    const unresolved = [...this.#retiredHosts].flatMap(({ lastError }) => (lastError === undefined ? [] : [lastError]));
    return Object.freeze({
      pendingRetiredHosts: this.#retiredHosts.size,
      warnings: Object.freeze(
        this.#cleanupWarnings.map((warning) =>
          Object.freeze({
            ...warning,
            installedPluginIds: Object.freeze([...warning.installedPluginIds]),
          }),
        ),
      ),
      ...(unresolved.length
        ? {
            unresolvedError: new AggregateError(
              unresolved,
              "Altair authoring activated successfully, but retired plugin hosts still require cleanup",
            ),
          }
        : {}),
    });
  }

  service<T>(key: AltairAuthoringServiceKey<T>): T | undefined {
    this.#assertActive();
    return this.#host.service(key);
  }

  contributions<T = unknown>(kind: string): readonly T[] {
    this.#assertActive();
    return this.#host.contributions<T>(kind);
  }

  reconcile(project: Pick<StoryProject, "plugins">, options: ReconcileAltairAuthoringOptions = {}): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new ReferenceError("Haneoka Altair authoring host is disposed"));
    }
    const operation = this.#tail.then(() => this.#reconcileNow(project, options.signal));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    this.#removeExternalAbort?.();
    this.#lifetime.abort(new DOMException("Haneoka Altair authoring host disposed", "AbortError"));
    this.#disposal = this.#tail.then(async () => {
      this.#retireHost(this.#host);
      await this.#cleanupRetiredHosts();
      const unresolved = this.cleanupReport.unresolvedError;
      if (unresolved) throw unresolved;
    });
    this.#tail = this.#disposal.then(
      () => undefined,
      () => undefined,
    );
    return this.#disposal;
  }

  async #reconcileNow(project: Pick<StoryProject, "plugins">, callerSignal?: AbortSignal): Promise<void> {
    const linked = linkedAbortController([this.#lifetime.signal, callerSignal]);
    try {
      throwIfAborted(linked.signal);
      const selections = authoringSelections(
        project,
        this.#registry,
        this.#knownAuthoringPluginIds,
        this.#enforceRequiredPreset,
      );
      const signature = selectionSignature(selections);
      if (signature === this.#signature) {
        await this.#cleanupRetiredHosts();
        return;
      }

      const loaded: LoadedSelection[] = [];
      for (const selection of selections) {
        const registration = this.#registry.registration(selection.id)!;
        if (registration.version !== selection.version) {
          throw new Error(
            `Project pins ${selection.id}@${selection.version}, but Haneoka installed ${registration.version}`,
          );
        }
        if (!sameSource(selection.source, registration.source)) {
          throw new Error(
            `Project source does not match the installed package for ${selection.id}@${selection.version}`,
          );
        }
        const module = await withAbort(
          Promise.resolve(registration.load({ selection, signal: linked.signal })),
          linked.signal,
        );
        const plugin = altairAuthoringPluginFromModule(module);
        if (plugin.manifest.id !== selection.id || plugin.manifest.version !== selection.version) {
          throw new Error(
            `Loaded ${plugin.manifest.id}@${plugin.manifest.version} for pinned ${selection.id}@${selection.version}`,
          );
        }
        requestedCapabilitiesArePresent(selection, plugin);
        loaded.push({ selection, plugin });
      }

      const next = requireApi2Host(this.#hostFactory());
      let nextDisposal: Promise<void> | undefined;
      let nextDisposalError: unknown;
      const disposeNext = (): Promise<void> => {
        nextDisposal ??= Promise.resolve()
          .then(() => next.dispose())
          .catch((error: unknown) => {
            nextDisposalError = error;
          });
        return nextDisposal;
      };
      const abortNext = () => {
        void disposeNext();
      };
      linked.signal.addEventListener("abort", abortNext, { once: true });
      try {
        for (const { selection, plugin } of installationOrder(loaded)) {
          throwIfAborted(linked.signal);
          await next.install(plugin, {
            ...(selection.configuration === undefined
              ? {}
              : {
                  configuration: cloneJson(selection.configuration) as JsonObject,
                }),
            ...(selection.permissions === undefined ? {} : { permissions: [...selection.permissions] }),
          });
        }
        throwIfAborted(linked.signal);
      } catch (error) {
        linked.signal.removeEventListener("abort", abortNext);
        await disposeNext();
        if (nextDisposalError !== undefined) {
          throw new AggregateError(
            [error, nextDisposalError],
            "Failed to activate and clean up the next Altair authoring host",
          );
        }
        throw error;
      }

      linked.signal.removeEventListener("abort", abortNext);
      const previous = this.#host;
      this.#host = next;
      this.#activeSelections = Object.freeze(selections.map((selection) => cloneJson(selection)));
      this.#signature = signature;
      this.#retireHost(previous);
      await this.#cleanupRetiredHosts();
    } finally {
      linked.dispose();
    }
  }

  #retireHost(host: AltairAuthoringHostPort): void {
    if ([...this.#retiredHosts].some((retired) => retired.host === host)) return;
    this.#retiredHosts.add({
      host,
      installedPluginIds: Object.freeze([...host.installedPluginIds]),
      attempts: 0,
    });
  }

  async #cleanupRetiredHosts(): Promise<void> {
    for (const retired of [...this.#retiredHosts]) {
      retired.attempts += 1;
      try {
        await retired.host.dispose();
        this.#retiredHosts.delete(retired);
      } catch (error) {
        retired.lastError = error;
        this.#cleanupWarnings.push(
          Object.freeze({
            attempt: retired.attempts,
            installedPluginIds: retired.installedPluginIds,
            error,
          }),
        );
      }
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new ReferenceError("Haneoka Altair authoring host is disposed");
    }
  }
}

export const createHaneokaAltairAuthoringHost = async (
  project: Pick<StoryProject, "plugins">,
  options: HaneokaAltairAuthoringHostOptions,
): Promise<HaneokaAltairAuthoringHost> => {
  const host = new HaneokaAltairAuthoringHost(options);
  try {
    await host.reconcile(project);
    return host;
  } catch (error) {
    try {
      await host.dispose();
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        "Failed to create and clean up the Haneoka Altair authoring host",
      );
    }
    throw error;
  }
};
