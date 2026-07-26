import { createApp } from "vue";
import App from "./App.vue";
import { initTheme } from "./composables/useTheme.js";
import { initSkin } from "./composables/useSkin.js";
import { initViewSettings } from "./stores/viewSettings.js";
import "./styles.css";

initTheme();
initSkin();
initViewSettings();
createApp(App).mount("#app");
