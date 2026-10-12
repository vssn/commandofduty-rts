import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
  // when this build was made (shown in the main menu; with the dev server: when it was started)
  define: { __BUILD_DATE__: JSON.stringify(new Date().toISOString()) },
  build: { chunkSizeWarningLimit: 6000, target: "es2022" }, // (top-level await: the world is built in stages)
});
