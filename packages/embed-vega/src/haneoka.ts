import { haneokaDataSource } from "@haneoka/embed-core/haneoka";
import type { DataSource } from "@haneoka/embed-core";
import type { AdvStory } from "@haneoka/vega/engine";
import type { VegaPlugin } from "@haneoka/vega/plugin";
import { hydrateStoryPayload } from "@haneoka/vega-plugin-haneoka";
import { createCubismPlugin, type CubismRuntimeAdapter } from "@haneoka/vega-plugin-cubism";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected a catalog record");
  return value as RecordValue;
};

const mergeRuntime = (base: RecordValue, authored: RecordValue): RecordValue => {
  const output = { ...base };
  for (const [key, value] of Object.entries(authored)) {
    output[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
        ? mergeRuntime(record(base[key]), record(value))
        : value;
  }
  return output;
};

/** Resolve authored Unity paths using this data source's deployment origin. */
export function haneokaSourceAssetUrl(path: string, assetsBase: string | URL, server = "intl"): string {
  return /^(?:Assets|Packages)\//u.test(path)
    ? new URL(`/assets/${encodeURIComponent(server)}/${path.split("/").map(encodeURIComponent).join("/")}`, assetsBase)
        .href
    : path;
}

/** Resolve one current public story and only its declared model metadata. */
export function haneokaStorySource(options: { readonly id: string; readonly apiBase?: string }): DataSource<AdvStory> {
  const common = options.apiBase === undefined ? {} : { apiBase: options.apiBase };
  const storySource = haneokaDataSource({ ...common, resource: "stories", id: options.id, decode: record });
  return {
    assetsBase: storySource.assetsBase!,
    async load(context) {
      const [story, runtime] = await Promise.all([
        storySource.load(context),
        haneokaDataSource({ ...common, resource: "story-runtime", decode: record }).load(context),
      ]);
      const assets = record(story.assets ?? {});
      const models = Array.isArray(assets.live2d) ? assets.live2d : [];
      const keys = [...new Set(models.map((entry) => String(record(entry).live2dKey ?? "")).filter(Boolean))];
      // Bounded sequential metadata reads; no whole model catalog download.
      const live2d: RecordValue[] = [];
      for (const id of keys) {
        context.signal.throwIfAborted();
        live2d.push({
          id,
          ...(await haneokaDataSource({ ...common, resource: "live2d", id, decode: record }).load(context)),
        });
      }
      const resolvedRuntime = mergeRuntime(runtime, record(story.runtime ?? {}));
      const chat = record(resolvedRuntime.chatAssets ?? {});
      const sourceAsset = (value: unknown): string =>
        haneokaSourceAssetUrl(String(value ?? ""), storySource.assetsBase!, context.server);
      const roots = Object.fromEntries(
        Object.entries(record(chat.dataRootsByWindowAsset ?? {})).map(([key, value]) => [key, sourceAsset(value)]),
      );
      const icons = Object.fromEntries(
        Object.entries(record(chat.iconImagesByAsset ?? {})).map(([key, value]) => [key, sourceAsset(value)]),
      );
      const rects = Object.fromEntries(
        Object.entries(record(chat.windowRectsByDataRoot ?? {})).map(([key, value]) => [sourceAsset(key), value]),
      );
      const hydrated = hydrateStoryPayload({
        ...story,
        assets: { ...assets, live2d },
        runtime: {
          ...resolvedRuntime,
          chatAssets: {
            ...chat,
            defaultDataRoot: sourceAsset(chat.defaultDataRoot),
            dataRootsByWindowAsset: roots,
            iconImagesByAsset: icons,
            windowRectsByDataRoot: rects,
          },
        },
      });
      // This catalog's actual array order is a source contract, not an author restriction.
      return {
        ...hydrated,
        localization: { arrayOrder: ["ja", "en", "zh-TW", "zh-CN", "ko"], defaultLocale: "ja" },
      } as AdvStory;
    },
  };
}

export interface CubismEmbedOptions {
  /** Absolute URL of the separately provisioned Web runtime module. */
  readonly moduleUrl: string;
  readonly runtime: {
    readonly cubismCoreUrl: string;
    readonly cubismWasmUrl?: string;
    readonly cubism2CoreUrl?: string;
    readonly motionSyncCoreUrl?: string;
  };
}

/** Lazily imports the host's licensed adapter only when a model is needed. */
export function cubismStoryPlugin(options: CubismEmbedOptions): VegaPlugin {
  let resolved: CubismRuntimeAdapter | undefined;
  let pending: Promise<CubismRuntimeAdapter> | undefined;
  const adapter = () =>
    (pending ??= (
      import(/* @vite-ignore */ options.moduleUrl) as Promise<{
        createCubismWebRuntimeAdapter(options: RecordValue): CubismRuntimeAdapter;
      }>
    )
      .then((module) => {
        resolved = module.createCubismWebRuntimeAdapter({ id: "embed.cubism-web", runtime: options.runtime });
        return resolved;
      })
      .catch((error) => {
        pending = undefined;
        throw error;
      }));
  return createCubismPlugin({
    adapter: {
      id: "embed.cubism-web",
      async prepare(version, signal) {
        signal.throwIfAborted();
        const value = await adapter();
        signal.throwIfAborted();
        await value.prepare?.(version, signal);
      },
      async create(context) {
        return (await adapter()).create(context);
      },
      async createForRenderer(context) {
        const value = await adapter();
        if (!value.createForRenderer) throw new Error("Cubism adapter requires createForRenderer for Three");
        return value.createForRenderer(context);
      },
      async disposeRendererModel(model, context) {
        const value = await adapter();
        if (value.disposeRendererModel) await value.disposeRendererModel(model, context);
        else {
          const disposable = model as { dispose?: () => void | Promise<void>; destroy?: () => void | Promise<void> };
          if (disposable.dispose) await disposable.dispose();
          else await disposable.destroy?.();
        }
      },
      getMouthParameterProfile(context) {
        return resolved?.getMouthParameterProfile?.(context) ?? null;
      },
      applyLipSync(context) {
        resolved?.applyLipSync?.(context);
      },
    },
  });
}
