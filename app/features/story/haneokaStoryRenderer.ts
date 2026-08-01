import type { StoryRichTextRenderer, VegaPlugin } from "@haneoka/vega";
import { createVegaPluginLock, resolveVegaPluginDependencies, vegaPluginSourceKey } from "@haneoka/vega/marketplace";
import { defineVegaPlugin } from "@haneoka/vega/plugin";
import type { StoryProjectPlugin } from "@haneoka/altair";
import { vegaOfficialPluginCatalog } from "@haneoka/vega-catalog-official";
import type { VegaPluginLock, VegaProjectPlugin } from "@haneoka/vega-protocol";
import { createCubismPlugin } from "@haneoka/vega-plugin-cubism";
import { createHaneokaPlugin, type HaneokaHostBridge } from "@haneoka/vega-plugin-haneoka";
import {
  createVegaRichTextPlugin,
  DefaultVegaRichTextService,
  type VegaRichTextRenderer,
} from "@haneoka/vega-plugin-richtext";
import { createSpinePlugin, type SpineRuntimeAdapter } from "@haneoka/vega-plugin-spine";
import { createWebGalCompatibilityPlugin } from "@haneoka/vega-plugin-webgal";
import { createPixiRendererPlugin } from "@haneoka/vega-renderer-pixi";
import { createThreeRendererPlugin } from "@haneoka/vega-renderer-three";
import vegaDefaultShell from "@haneoka/vega-shell-default";
import { createHaneokaThemeHostPlugin, vegaHaneokaTheme, type HaneokaThemeHost } from "@haneoka/vega-theme-haneoka";
import { vegaPortableUiPlugin } from "@haneoka/vega-ui-portable";
import { effectiveHaneokaStoryProjectPlugins, HANEOKA_AUTHORING_PLUGIN_IDS } from "~/features/story/pluginSelection";
import { storyProjectPluginTargetsAltairAuthoring } from "~/features/story/altairAuthoring";
import { createCubismWebRuntimeAdapter } from "~/features/story/cubismRuntimeProvision";

const haneokaCubismRuntime = createCubismWebRuntimeAdapter({
  id: "haneoka.web-cubism-runtime",
  runtime: {
    cubismCoreUrl: "/Core/live2dcubismcore.js",
    cubism2CoreUrl: "/Core/live2d.min.js",
    motionSyncCoreUrl: "/Core/CRI/live2dcubismmotionsynccore.min.js",
  },
});

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
};

const HANEOKA_STORY_KEY_ACTIONS = Object.freeze({
  Enter: "advance",
  Space: "advance",
  Escape: "menu",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
} as const);

interface HaneokaStoryKeydownEvent {
  readonly altKey?: boolean;
  readonly code: string;
  readonly ctrlKey?: boolean;
  readonly defaultPrevented: boolean;
  readonly isComposing: boolean;
  readonly metaKey?: boolean;
  readonly repeat: boolean;
  readonly target: EventTarget | null;
}

type HaneokaStoryInputScope = Pick<HTMLElement, "addEventListener" | "contains" | "removeEventListener">;
type HaneokaStoryInputScopeSource = HaneokaStoryInputScope | (() => HaneokaStoryInputScope | undefined);

const resolveHaneokaStoryInputScope = (source?: HaneokaStoryInputScopeSource): HaneokaStoryInputScope | undefined =>
  typeof source === "function" ? source() : source;

const isEditableStoryInputTarget = (target: EventTarget | null): boolean => {
  if (!target || typeof target !== "object") return false;
  const candidate = target as {
    readonly isContentEditable?: boolean;
    readonly tagName?: unknown;
  };
  const tagName = typeof candidate.tagName === "string" ? candidate.tagName.toLowerCase() : "";
  return tagName === "input" || tagName === "textarea" || tagName === "select" || candidate.isContentEditable === true;
};

export const shouldHandleHaneokaStoryKeydown = (
  event: HaneokaStoryKeydownEvent,
  inputScope?: HaneokaStoryInputScope,
): boolean =>
  Boolean(
    inputScope &&
    event.target &&
    inputScope.contains(event.target as Node) &&
    Object.hasOwn(HANEOKA_STORY_KEY_ACTIONS, event.code) &&
    !event.defaultPrevented &&
    !event.isComposing &&
    !event.repeat &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !isEditableStoryInputTarget(event.target),
  );

const createHaneokaBrowserHostBridge = (inputScopeSource?: HaneokaStoryInputScopeSource): HaneokaHostBridge => ({
  async loadResource(key, signal) {
    throwIfAborted(signal);
    const response = await fetch(`/${key.replace(/^\/+/u, "")}`, { signal });
    if (!response.ok) {
      throw new Error(`Haneoka resource request failed with HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
  async readStorage(key, signal) {
    throwIfAborted(signal);
    const value = globalThis.localStorage?.getItem(key);
    if (value == null) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  },
  async writeStorage(key, value, signal) {
    throwIfAborted(signal);
    globalThis.localStorage?.setItem(key, JSON.stringify(value) ?? "null");
  },
  async deleteStorage(key, signal) {
    throwIfAborted(signal);
    globalThis.localStorage?.removeItem(key);
  },
  subscribeInput(listener, signal) {
    throwIfAborted(signal);
    const inputScope = resolveHaneokaStoryInputScope(inputScopeSource);
    if (!inputScope) return { dispose() {} };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleHaneokaStoryKeydown(event, inputScope)) return;
      const action = HANEOKA_STORY_KEY_ACTIONS[event.code as keyof typeof HANEOKA_STORY_KEY_ACTIONS];
      event.preventDefault();
      listener({ action, source: "keyboard" });
    };
    inputScope.addEventListener("keydown", onKeyDown);
    const dispose = () => inputScope.removeEventListener("keydown", onKeyDown);
    signal.addEventListener("abort", dispose, { once: true });
    return {
      dispose() {
        signal.removeEventListener("abort", dispose);
        dispose();
      },
    };
  },
});

export interface HaneokaStoryPluginOptions {
  /**
   * Keyboard input is accepted only while the event target belongs to this
   * focused preview/player surface. Omitting it leaves keyboard input inert.
   */
  readonly inputScope?: HaneokaStoryInputScopeSource;
  /** Application-owned settings, callbacks, and licensed theme image URLs. */
  readonly themeHost?: HaneokaThemeHost;
  /**
   * Spine's SDK/runtime is licensed and provisioned by the application or
   * Deneb bundle. The public plugin package contains only this adapter port.
   */
  readonly spineRuntime?: SpineRuntimeAdapter;
}

export const createHaneokaStoryHostPlugin = (options: Pick<HaneokaStoryPluginOptions, "inputScope"> = {}) =>
  createHaneokaPlugin({
    bridge: createHaneokaBrowserHostBridge(options.inputScope),
    storageNamespace: "story",
  });

const HANEOKA_VEGA_PLUGIN_RELEASES = vegaOfficialPluginCatalog.plugins.filter(
  ({ apiVersion, targets }) => apiVersion === 1 && targets?.runtimes?.includes("vega") === true,
);
const HANEOKA_PLUGIN_TARGET = Object.freeze({
  runtime: "vega",
  platform: "web",
  engineVersion: "0.1.0",
  apiVersion: 1,
} as const);

const canonicalPluginRequest = (plugin: StoryProjectPlugin): VegaProjectPlugin => {
  const { enabled: _enabled, ...request } = plugin;
  return request;
};

export const resolveHaneokaStoryPluginLock = (selection?: readonly StoryProjectPlugin[]): VegaPluginLock => {
  const selected = effectiveHaneokaStoryProjectPlugins(selection);
  const requiredDisabled = selected.find(({ enabled, required }) => required && enabled === false);
  if (requiredDisabled) {
    throw new Error(`Required Haneoka plugin cannot be disabled: ${requiredDisabled.id}`);
  }
  const runtimeRequests = selected
    .filter(
      (selection) =>
        selection.enabled !== false &&
        !HANEOKA_AUTHORING_PLUGIN_IDS.has(selection.id) &&
        !storyProjectPluginTargetsAltairAuthoring(selection),
    )
    .map(canonicalPluginRequest);
  for (const plugin of runtimeRequests) {
    const release = HANEOKA_VEGA_PLUGIN_RELEASES.find(
      (entry) =>
        entry.id === plugin.id &&
        entry.version === plugin.version &&
        (plugin.source === undefined || vegaPluginSourceKey(entry.source) === vegaPluginSourceKey(plugin.source)),
    );
    if (!release) {
      throw new Error(`Haneoka preview requires an exact official release for ${plugin.id}@${plugin.version}`);
    }
  }
  const resolution = resolveVegaPluginDependencies(HANEOKA_VEGA_PLUGIN_RELEASES, {
    plugins: runtimeRequests,
    target: HANEOKA_PLUGIN_TARGET,
  });
  const blocking = resolution.diagnostics.filter(
    ({ code, severity }) => severity === "error" || code === "permission-review-required",
  );
  if (blocking.length) {
    throw new Error(blocking.map(({ message }) => message).join("; "));
  }
  return createVegaPluginLock(
    resolution.entries,
    HANEOKA_PLUGIN_TARGET,
    Object.fromEntries(
      runtimeRequests
        .filter(({ dependencies }) => dependencies !== undefined)
        .map(({ id, dependencies }) => [id, dependencies!]),
    ),
  );
};

export const isHaneokaStoryShellEnabled = (selection?: readonly StoryProjectPlugin[]): boolean =>
  effectiveHaneokaStoryProjectPlugins(selection).some(
    ({ id, enabled }) => id === "haneoka.vega-shell-default" && enabled !== false,
  );

type HaneokaRuntimePluginFactory = (options: HaneokaStoryPluginOptions) => VegaPlugin;

interface LazyHaneokaRichTextPlugin {
  readonly formats: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly load: () => Promise<{ readonly default: VegaPlugin }>;
  readonly loadRenderer: () => Promise<VegaRichTextRenderer>;
}

const HANEOKA_RICH_TEXT_FORMAT_PLUGINS = Object.freeze({
  "haneoka.vega-richtext-bbcode": {
    formats: ["bbcode", "bb"],
    id: "haneoka.vega-richtext-bbcode",
    name: "Vega Rich Text — BBCode",
    load: () => import("@haneoka/vega-plugin-richtext-bbcode"),
    loadRenderer: async () => (await import("@haneoka/vega-plugin-richtext-bbcode")).vegaBbcodeRichTextRenderer,
  },
  "haneoka.vega-richtext-html": {
    formats: ["html"],
    id: "haneoka.vega-richtext-html",
    name: "Vega Rich Text — HTML",
    load: () => import("@haneoka/vega-plugin-richtext-html"),
    loadRenderer: async () => (await import("@haneoka/vega-plugin-richtext-html")).vegaHtmlRichTextRenderer,
  },
  "haneoka.vega-richtext-latex": {
    formats: ["latex", "tex"],
    id: "haneoka.vega-richtext-latex",
    name: "Vega Rich Text — LaTeX",
    load: () => import("@haneoka/vega-plugin-richtext-latex"),
    loadRenderer: async () => (await import("@haneoka/vega-plugin-richtext-latex")).createLatexRichTextRenderer(),
  },
  "haneoka.vega-richtext-markdown": {
    formats: ["markdown", "md"],
    id: "haneoka.vega-richtext-markdown",
    name: "Vega Rich Text — Markdown",
    load: () => import("@haneoka/vega-plugin-richtext-markdown"),
    loadRenderer: async () => (await import("@haneoka/vega-plugin-richtext-markdown")).vegaMarkdownRichTextRenderer,
  },
} satisfies Readonly<Record<string, LazyHaneokaRichTextPlugin>>);

const createLazyHaneokaRichTextPlugin = ({ id, name, load }: LazyHaneokaRichTextPlugin): VegaPlugin =>
  defineVegaPlugin({
    manifest: {
      id,
      name,
      version: "0.1.0",
      apiVersion: 1,
      description: `${name} lazy Haneoka adapter`,
      capabilities: ["rich-text"],
      dependencies: {
        "haneoka.vega-richtext": "^0.1.0",
      },
    },
    async setup(context) {
      return (await load()).default.setup(context);
    },
  });

const unavailableHaneokaSpineRuntime: SpineRuntimeAdapter = {
  id: "haneoka.host-unavailable-spine-runtime",
  create() {
    throw new Error(
      "Haneoka Spine model playback requires a host-provisioned Spine runtime; no SDK/Core is distributed by the plugin",
    );
  },
  createForRenderer() {
    throw new Error(
      "Haneoka Spine model playback requires a host-provisioned Spine runtime; no SDK/Core is distributed by the plugin",
    );
  },
};

const HANEOKA_INSTALLED_RUNTIME_PLUGIN_FACTORIES: Readonly<Record<string, HaneokaRuntimePluginFactory>> = Object.freeze(
  {
    "haneoka.cubism": () => createCubismPlugin({ adapter: haneokaCubismRuntime }),
    "haneoka.host": (options) => createHaneokaStoryHostPlugin(options),
    "haneoka.renderer-pixi": () => createPixiRendererPlugin(),
    "haneoka.renderer-three": () => createThreeRendererPlugin(),
    "haneoka.spine": (options) =>
      createSpinePlugin({
        adapter: options.spineRuntime ?? unavailableHaneokaSpineRuntime,
      }),
    "haneoka.theme": () => vegaHaneokaTheme,
    "haneoka.vega-portable-ui": () => vegaPortableUiPlugin,
    "haneoka.vega-richtext": () => createVegaRichTextPlugin(),
    ...Object.fromEntries(
      Object.entries(HANEOKA_RICH_TEXT_FORMAT_PLUGINS).map(([id, descriptor]) => [
        id,
        () => createLazyHaneokaRichTextPlugin(descriptor),
      ]),
    ),
    "haneoka.vega-shell-default": () => vegaDefaultShell,
    "haneoka.webgal-runtime": () => createWebGalCompatibilityPlugin(),
  },
);

const HANEOKA_RUNTIME_PLUGIN_ORDER = Object.freeze([
  "haneoka.vega-richtext",
  "haneoka.vega-richtext-bbcode",
  "haneoka.vega-richtext-html",
  "haneoka.vega-richtext-latex",
  "haneoka.vega-richtext-markdown",
  "haneoka.vega-portable-ui",
  "haneoka.vega-shell-default",
  "haneoka.renderer-three",
  "haneoka.renderer-pixi",
  "haneoka.webgal-runtime",
  "haneoka.cubism",
  "haneoka.spine",
  "haneoka.theme",
  "haneoka.host",
] as const);

export const createHaneokaStoryPlugins = (
  selection?: readonly StoryProjectPlugin[],
  options: HaneokaStoryPluginOptions = {},
): readonly VegaPlugin[] => {
  const lock = resolveHaneokaStoryPluginLock(selection);
  const enabled = new Set(lock.plugins.map(({ id }) => id));
  const unsupported = [...enabled].filter((id) => !HANEOKA_INSTALLED_RUNTIME_PLUGIN_FACTORIES[id]);
  if (unsupported.length) {
    throw new Error(`Haneoka preview has no installed runtime adapter for: ${unsupported.join(", ")}`);
  }
  const plugins = HANEOKA_RUNTIME_PLUGIN_ORDER.filter((id) => enabled.has(id)).map((id) =>
    HANEOKA_INSTALLED_RUNTIME_PLUGIN_FACTORIES[id]!(options),
  );
  if (options.themeHost && enabled.has("haneoka.theme")) {
    plugins.push(createHaneokaThemeHostPlugin(options.themeHost));
  }
  return plugins;
};

export interface HaneokaStoryRichTextBridge {
  readonly renderer: StoryRichTextRenderer;
  dispose(): void;
}

/**
 * Text reading and full playback resolve the same project plugin selection.
 * No service means no markup interpretation: Vega's text component keeps the
 * exact source string as textContent.
 */
export const createHaneokaStoryTextRichTextBridge = (
  selection?: readonly StoryProjectPlugin[],
): HaneokaStoryRichTextBridge | undefined => {
  const enabled = new Set(resolveHaneokaStoryPluginLock(selection).plugins.map(({ id }) => id));
  if (!enabled.has("haneoka.vega-richtext")) return undefined;

  const service = new DefaultVegaRichTextService();
  for (const descriptor of Object.values(HANEOKA_RICH_TEXT_FORMAT_PLUGINS)) {
    if (!enabled.has(descriptor.id)) continue;
    service.register({
      id: `${descriptor.id}.lazy-text-bridge`,
      formats: descriptor.formats,
      async render(request) {
        throwIfAborted(request.signal);
        const renderer = await descriptor.loadRenderer();
        throwIfAborted(request.signal);
        return renderer.render(request);
      },
    });
  }

  return {
    renderer: {
      render: (target, value) => service.render(target, value, { defaultFormat: "adv" }),
    },
    dispose: () => service.dispose(),
  };
};
