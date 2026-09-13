import { defineConfig } from "vite";

// Offline viewer bundle: one IIFE file, no deps/assets/sourcemaps.
// Built first so src/export.ts can embed it via `.generated/replay.js?raw`.
export default defineConfig({
  build: {
    outDir: ".generated",
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: "src/export-entry.ts",
      name: "WitnessReplay",
      formats: ["iife"],
      fileName: () => "replay.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
