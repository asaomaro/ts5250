import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/api": "http://localhost:3400",
      "/ws": { target: "ws://localhost:3400", ws: true }
    }
  },
  build: { outDir: "dist" },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"]
  }
});
