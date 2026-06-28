import pluginVue from "eslint-plugin-vue";
import vueTsConfig from "@vue/eslint-config-typescript";

const config = [
  {
    name: "app/files-to-lint",
    files: ["**/*.{ts,mts,tsx,vue}"],
  },
  {
    name: "app/files-to-ignore",
    ignores: [
      "dist/**",
      ".nuxt/**",
      ".output/**",
      "node_modules/**",
      "data/**",
      "tmp/**",
      "docs/**",
      "public/**",
      ".wrangler/**",
      "packages/story/src/vendor/**",
      "worker/worker-configuration.d.ts",
      "*.apks",
      "*.apk",
    ],
  },
  ...pluginVue.configs["flat/essential"],
  ...vueTsConfig(),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "vue/multi-word-component-names": "off",
      // Enforced: all Vue <script>/<style> blocks must declare lang="ts".
      "vue/block-lang": "error",
      "vue/no-unused-vars": "warn",
      "vue/no-v-html": "off",
      "vue/attributes-order": "off",
    },
  },
];

export default config;
