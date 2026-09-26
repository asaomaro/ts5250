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
  build: {
    outDir: "dist",
    // **`embed.html` は VSCode 拡張機能が iframe で開く単一アプリ専用の最小ページ**
    // （`.aidev/works/20260924-vscode-extension/design.md`「設計方針4」）。`index.html`
    // （通常のワークスペースUI）と同じビルドに同居させる——サーバーの `--web-root` は
    // `packages/web-ui/dist` を丸ごと配信するので、既存の配信経路を変えずに済む
    rollupOptions: { input: { main: "index.html", embed: "embed.html" } }
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    // **毎テスト後にマウントを畳む**（`test/setup.ts`）。付けっぱなしの
    // コンポーネントがフォーカスを保持し、回ごとに違うテストが落ちていた
    setupFiles: ["test/setup.ts"]
  }
});
