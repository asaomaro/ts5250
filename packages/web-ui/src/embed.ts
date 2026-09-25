import { createApp } from "vue";
import EmbedApp from "./EmbedApp.vue";
import { initTheme } from "./composables/useTheme.js";
import { initSkin } from "./composables/useSkin.js";
import { initViewSettings } from "./stores/viewSettings.js";
import { initAppearance } from "./stores/appearance.js";
import { systemsStore } from "./stores/systems.js";
import { initEmbedBridge, postToHost } from "./stores/embed.js";
import type { EmbedAppKind } from "./embed-protocol.js";
import "./styles.css";

/**
 * 単一アプリ専用の最小WebView（VSCode拡張機能がiframeで開く）の起点。`main.ts`（通常の
 * ワークスペースUI）と対をなす、もう一つのエントリ（`vite.config.ts`のマルチページ入力）。
 *
 * `app`はURLクエリで渡す（非秘匿・iframe初期ロード時に必要。接続情報は`postMessage`で渡す
 * ——`embedStore`参照）。
 */
function appParam(): EmbedAppKind {
  const v = new URLSearchParams(location.search).get("app");
  return v === "printer" || v === "sql" || v === "ifs" ? v : "emulator";
}

initTheme();
initSkin();
initViewSettings(); // **initTheme の後**（テーマの既定を外観の実効値から取る。`main.ts`と同じ順序を保つ）
initAppearance();
void systemsStore.refresh();
initEmbedBridge();

createApp(EmbedApp, { app: appParam() }).mount("#app");
postToHost({ type: "ready" });
