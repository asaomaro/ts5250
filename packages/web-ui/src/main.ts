import { createApp } from "vue";
import App from "./App.vue";
import { initTheme } from "./composables/useTheme.js";
import { initSkin } from "./composables/useSkin.js";
import { initViewSettings } from "./stores/viewSettings.js";
import { initAppearance } from "./stores/appearance.js";
import { installReloadGuard } from "./composables/reloadGuard.js";
import { closeAllOnPageHide } from "./session-controller.js";
import "./styles.css";

initTheme();
initSkin();
initViewSettings(); // **initTheme の後**（テーマの既定を外観の実効値から取る）
initAppearance();
installReloadGuard(); // F5・Ctrl+R での再読み込みを止める（開いているセッションを失わないため）
addEventListener("pagehide", closeAllOnPageHide); // タブ・ブラウザを閉じたとき、ホストのセッションを残さない
createApp(App).mount("#app");
