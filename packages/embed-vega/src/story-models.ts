import type { AdvStory } from "@haneoka/vega/engine";
import type { EmbedLoader } from "@haneoka/embed-core";
import { createModelAssets } from "./model-assets.js";
import { loadModelRuntime } from "./model.js";
import type { MountStoryOptions } from "./types.js";

type CharacterModel = NonNullable<AdvStory["characterModels"]>[string];

export function createStoryModels(options: MountStoryOptions, loader: EmbedLoader<AdvStory>, signal: AbortSignal) {
  const assets = createModelAssets();
  const explicit = new Set<string>();
  const sourceModels = Object.fromEntries(
    Object.entries(options.models ?? {}).map(([key, location]) => {
      if (typeof location !== "string" && !(location instanceof URL)) return [key, location];
      const model = String(location);
      explicit.add(model);
      return [key, { runtime: { model } } satisfies CharacterModel];
    }),
  );
  const prepared = new Map<string, Promise<string>>();
  let usesCubism = false;
  let usesSpine = false;
  const read = (url: string, consumer: AbortSignal) =>
    loader.resourceBytes(url, {
      signal: AbortSignal.any([consumer, AbortSignal.timeout(options.resourceTimeoutMs ?? 30_000)]),
    });
  return {
    document(story: AdvStory): AdvStory {
      return options.models ? { ...story, characterModels: { ...story.characterModels, ...sourceModels } } : story;
    },
    async url(key: string): Promise<string> {
      if (!key) return key;
      const url = await loader.resourceUrl(key, { signal });
      const archive = /\.zip(?:[?#]|$)/iu.test(key) || /\.zip(?:[?#]|$)/iu.test(url);
      if (!archive && !explicit.has(key)) {
        if (/\.(?:model3\.json|moc3|model\.json|moc)(?:[?#]|$)/iu.test(url)) usesCubism = true;
        return url;
      }
      usesCubism = true;
      let source = prepared.get(url);
      if (!source) {
        source = assets.load(url, read, signal).then((model) => model.url);
        prepared.set(url, source);
      }
      return source;
    },
    inspect(record: Record<string, unknown>) {
      if (typeof record.atlas === "string" && (record.json || record.skel || record.skeleton)) usesSpine = true;
    },
    async plugins() {
      const plugins = [];
      if (usesCubism && !options.plugins?.some(({ manifest }) => manifest.id === "haneoka.cubism")) {
        const [{ cubismStoryPlugin }, runtime] = await Promise.all([
          import("./haneoka.js"),
          options.cubism ?? loadModelRuntime(options.runtimeManifestUrl, (url) => read(url, signal)),
        ]);
        plugins.push(cubismStoryPlugin(runtime));
      }
      if (usesSpine && !options.plugins?.some(({ manifest }) => manifest.id === "haneoka.spine")) {
        const [{ createSpinePlugin }, { createSpineThreeRuntimeAdapter }, three, spine] = await Promise.all([
          import("@haneoka/vega-plugin-spine"),
          import("@haneoka/vega-plugin-spine/three"),
          import("three"),
          import("@esotericsoftware/spine-threejs"),
        ]);
        plugins.push(createSpinePlugin({ adapter: createSpineThreeRuntimeAdapter({ three, spine }) }));
      }
      return plugins;
    },
    owns: assets.owns,
    dispose: assets.dispose,
  };
}
