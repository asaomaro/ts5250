import { createApp } from "vue";
import App from "./App.vue";
import { initTheme } from "./composables/useTheme.js";
import "./styles.css";

initTheme();
createApp(App).mount("#app");
