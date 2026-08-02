import { createApp } from "vue";
import App from "./App.vue";
import { initTheme } from "./composables/useTheme.js";
import { initSkin } from "./composables/useSkin.js";
import { initViewSettings } from "./stores/viewSettings.js";
import { initAppearance } from "./stores/appearance.js";
import "./styles.css";

initTheme();
initSkin();
initViewSettings(); // **initTheme の後**（テーマの既定を外観の実効値から取る）
initAppearance();
createApp(App).mount("#app");
