import type { StoryProjectPlugin } from "@haneoka/altair";

export const HANEOKA_AUTHORING_PLUGIN_RELEASES = Object.freeze([
  {
    id: "haneoka.altair-adv",
    version: "0.1.0",
    required: false,
    enabled: true,
    capabilities: ["assets", "commands", "compiler", "diagnostics", "format", "services"],
    source: {
      type: "registry",
      package: "@haneoka/altair-plugin-adv",
    },
    targets: { runtimes: ["altair"] },
  },
  {
    id: "haneoka.altair-haneoka",
    version: "0.1.0",
    required: false,
    enabled: true,
    capabilities: ["assets", "services"],
    permissions: ["network"],
    source: {
      type: "registry",
      package: "@haneoka/altair-plugin-haneoka",
    },
    targets: { runtimes: ["altair"] },
  },
  {
    id: "haneoka.altair-bestdori",
    version: "0.1.0",
    required: false,
    enabled: true,
    capabilities: ["assets", "diagnostics", "format", "services"],
    permissions: ["network"],
    dependencies: {
      "haneoka.altair-adv": "^0.1.0",
    },
    source: {
      type: "registry",
      package: "@haneoka/altair-plugin-bestdori",
    },
    targets: { runtimes: ["altair"] },
  },
  {
    id: "haneoka.altair-webgal",
    version: "0.1.0",
    required: false,
    enabled: true,
    capabilities: ["assets", "diagnostics", "format", "commands", "services"],
    permissions: ["project.read", "project.write"],
    dependencies: {
      "haneoka.altair-adv": "^0.1.0",
    },
    source: {
      type: "registry",
      package: "@haneoka/altair-plugin-webgal",
    },
    targets: { runtimes: ["altair"] },
  },
  {
    id: "haneoka.altair-flow",
    version: "0.1.0",
    required: false,
    enabled: true,
    capabilities: ["flow"],
    source: {
      type: "registry",
      package: "@haneoka/altair-plugin-flow",
    },
    targets: { runtimes: ["altair"] },
  },
  {
    id: "haneoka.altair-history",
    version: "0.1.0",
    required: false,
    enabled: true,
    capabilities: ["services"],
    source: {
      type: "registry",
      package: "@haneoka/altair-plugin-history",
    },
    targets: { runtimes: ["altair"] },
  },
  {
    id: "haneoka.altair-drafts",
    version: "0.1.0",
    required: false,
    enabled: true,
    capabilities: ["services"],
    source: {
      type: "registry",
      package: "@haneoka/altair-plugin-drafts",
    },
    targets: { runtimes: ["altair"] },
  },
  {
    id: "haneoka.altair-vega-preview",
    version: "0.1.0",
    required: false,
    enabled: true,
    capabilities: ["compiler", "preview", "services"],
    dependencies: {
      "haneoka.altair-adv": "^0.1.0",
    },
    source: {
      type: "registry",
      package: "@haneoka/altair-plugin-vega-preview",
    },
    targets: { runtimes: ["altair"] },
  },
  {
    id: "haneoka.altair-workspace-browser",
    version: "0.1.0",
    required: false,
    enabled: true,
    capabilities: ["assets", "services"],
    permissions: ["filesystem:read", "filesystem:write"],
    source: {
      type: "registry",
      package: "@haneoka/altair-plugin-workspace-browser",
    },
    targets: { runtimes: ["altair"] },
  },
] satisfies readonly StoryProjectPlugin[]);

export const HANEOKA_AUTHORING_PLUGIN_IDS: ReadonlySet<string> = new Set(
  HANEOKA_AUTHORING_PLUGIN_RELEASES.map(({ id }) => id),
);

export const HANEOKA_RICH_TEXT_FORMAT_PLUGIN_RELEASES: readonly StoryProjectPlugin[] = Object.freeze(
  (
    [
      {
        id: "haneoka.vega-richtext-bbcode",
        packageName: "@haneoka/vega-plugin-richtext-bbcode",
        permissions: ["ui:dom"],
      },
      {
        id: "haneoka.vega-richtext-html",
        packageName: "@haneoka/vega-plugin-richtext-html",
        permissions: ["ui:dom"],
      },
      {
        id: "haneoka.vega-richtext-latex",
        packageName: "@haneoka/vega-plugin-richtext-latex",
        permissions: ["ui:dom"],
      },
      {
        id: "haneoka.vega-richtext-markdown",
        packageName: "@haneoka/vega-plugin-richtext-markdown",
        permissions: ["ui:dom"],
      },
      {
        id: "haneoka.vega-richtext-typst",
        packageName: "@haneoka/vega-plugin-richtext-typst",
        permissions: ["ui:dom", "wasm:execute"],
      },
    ] as const
  ).map(({ id, packageName, permissions }): StoryProjectPlugin => ({
    id,
    version: "0.1.0",
    required: false,
    enabled: false,
    capabilities: ["rich-text"],
    permissions: [...permissions],
    dependencies: {
      "haneoka.vega-richtext": "^0.1.0",
    },
    source: {
      type: "registry",
      package: packageName,
    },
    targets: { runtimes: ["vega"] },
  })),
);

export const HANEOKA_DEFAULT_STORY_PROJECT_PLUGINS: readonly StoryProjectPlugin[] = Object.freeze([
  ...HANEOKA_AUTHORING_PLUGIN_RELEASES,
  {
    id: "haneoka.cubism",
    version: "0.1.0",
    required: true,
    enabled: true,
    capabilities: ["character"],
    permissions: ["audio:analysis", "render:webgl"],
    source: {
      type: "registry",
      package: "@haneoka/vega-plugin-cubism",
    },
    targets: { runtimes: ["vega"] },
  },
  {
    id: "haneoka.host",
    version: "0.1.0",
    required: true,
    enabled: true,
    capabilities: ["input", "resource", "storage"],
    permissions: ["host:input", "host:resource", "host:storage"],
    source: {
      type: "registry",
      package: "@haneoka/vega-plugin-haneoka",
    },
    targets: { runtimes: ["vega"] },
  },
  {
    id: "haneoka.renderer-three",
    version: "0.1.0",
    required: true,
    enabled: true,
    capabilities: ["render"],
    permissions: ["render:webgl"],
    source: {
      type: "registry",
      package: "@haneoka/vega-renderer-three",
    },
    targets: { runtimes: ["vega"] },
  },
  {
    id: "haneoka.vega-richtext",
    version: "0.1.0",
    required: true,
    enabled: true,
    capabilities: ["rich-text"],
    permissions: ["ui:dom"],
    source: {
      type: "registry",
      package: "@haneoka/vega-plugin-richtext",
    },
    targets: { runtimes: ["vega"] },
  },
  ...HANEOKA_RICH_TEXT_FORMAT_PLUGIN_RELEASES,
  {
    id: "haneoka.theme",
    version: "0.1.0",
    required: true,
    enabled: true,
    capabilities: ["theme", "ui-slot"],
    permissions: ["ui:dom"],
    dependencies: {
      "haneoka.vega-portable-ui": "^0.1.0",
      "haneoka.vega-richtext": "^0.1.0",
      "haneoka.vega-shell-default": "^0.1.0",
    },
    source: {
      type: "registry",
      package: "@haneoka/vega-theme-haneoka",
    },
    targets: { runtimes: ["vega"] },
  },
  {
    id: "haneoka.vega-portable-ui",
    version: "0.1.0",
    required: true,
    enabled: true,
    capabilities: ["theme", "ui-slot"],
    permissions: ["ui:dom"],
    dependencies: {
      "haneoka.vega-richtext": "^0.1.0",
    },
    source: {
      type: "registry",
      package: "@haneoka/vega-ui-portable",
    },
    targets: { runtimes: ["vega"] },
  },
  {
    id: "haneoka.vega-shell-default",
    version: "0.1.0",
    required: true,
    enabled: true,
    capabilities: ["theme", "ui-slot"],
    permissions: ["ui:dom"],
    source: {
      type: "registry",
      package: "@haneoka/vega-shell-default",
    },
    targets: { runtimes: ["vega"] },
  },
] satisfies readonly StoryProjectPlugin[]);

export const effectiveHaneokaStoryProjectPlugins = (
  plugins: readonly StoryProjectPlugin[] | undefined,
): readonly StoryProjectPlugin[] => (plugins === undefined ? HANEOKA_DEFAULT_STORY_PROJECT_PLUGINS : plugins);
