import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const source = (file: string) => resolve(packageRoot, "src", file);

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        index: source("index.ts"),
        formats: source("formats/index.ts"),
        history: source("history.ts"),
        model: source("model.ts"),
        timing: source("timing.ts"),
        validation: source("validation.ts"),
        viewport: source("viewport.ts"),
        waveform: source("waveform.ts"),
      },
      fileName: (_format, entryName) => `${entryName}.js`,
      formats: ["es"],
    },
    minify: false,
    rollupOptions: {
      output: {
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
    sourcemap: true,
    target: "es2022",
  },
});
