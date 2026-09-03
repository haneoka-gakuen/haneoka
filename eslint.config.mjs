import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".astro/**",
      ".generated-public/**",
      ".output/**",
      "node_modules/**",
      "data/**",
      "tmp/**",
      "docs/**",
      "public/**",
      ".wrangler/**",
      ".dependencies/**",
      "worker/worker-configuration.d.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,mts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
