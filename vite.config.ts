import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  build: {
    emptyOutDir: false,
    outDir: "dist/client",
    sourcemap: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/dashboard-client.ts",
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
