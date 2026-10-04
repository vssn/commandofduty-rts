import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 6000, target: "es2022" }, // (top-level await: the world is built in stages)
});
