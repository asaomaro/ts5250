<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useTheme } from "./composables/useTheme.js";
import { workspaceStore } from "./stores/workspace.js";
import { sessionsStore } from "./stores/sessions.js";
import ConnectView from "./components/ConnectView.vue";
import WorkspaceNode from "./components/WorkspaceNode.vue";
import LogPanel from "./components/LogPanel.vue";
import KeybindingsPanel from "./components/KeybindingsPanel.vue";

const { toggle, effective } = useTheme();
workspaceStore.init();

const hasSessions = computed(() => sessionsStore.order.length > 0);
const showConnect = ref(true);
const showKeys = ref(false);

function onConnected(): void {
  showConnect.value = false;
}

// 狭幅フォールバック（分割無効化）
function checkNarrow(): void {
  workspaceStore.narrow = window.innerWidth < 720;
}
onMounted(() => {
  checkNarrow();
  window.addEventListener("resize", checkNarrow);
});
onBeforeUnmount(() => window.removeEventListener("resize", checkNarrow));
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <span class="brand">5250 Web エミュレーター</span>
      <button v-if="hasSessions" class="link" @click="showConnect = !showConnect">
        {{ showConnect ? "エミュレーターへ" : "＋ 接続" }}
      </button>
      <button
        v-if="hasSessions"
        class="theme-btn"
        :aria-pressed="workspaceStore.showShiftMarks"
        @click="workspaceStore.showShiftMarks = !workspaceStore.showShiftMarks"
      >
        SO/SI {{ workspaceStore.showShiftMarks ? "{ }" : "␣" }}
      </button>
      <button
        v-if="hasSessions"
        class="theme-btn"
        :aria-pressed="workspaceStore.katakanaView"
        title="半角カナ表示切替（英小文字位置をカナ解釈）"
        @click="workspaceStore.katakanaView = !workspaceStore.katakanaView"
      >
        {{ workspaceStore.katakanaView ? "カナ" : "英" }}
      </button>
      <button
        v-if="hasSessions"
        class="theme-btn"
        :aria-pressed="workspaceStore.linkify"
        title="URL/メールのリンク化切替"
        @click="workspaceStore.linkify = !workspaceStore.linkify"
      >
        🔗 {{ workspaceStore.linkify ? "ON" : "OFF" }}
      </button>
      <button class="theme-btn" @click="showKeys = true">⌨ キー</button>
      <button class="theme-btn" @click="toggle">{{ effective() === "dark" ? "☀ 通常" : "🌙 ダーク" }}</button>
    </header>

    <KeybindingsPanel v-if="showKeys" @close="showKeys = false" />

    <main v-if="showConnect || !hasSessions">
      <ConnectView @connected="onConnected" />
    </main>
    <main v-else class="workspace">
      <WorkspaceNode :node="workspaceStore.root" />
    </main>

    <LogPanel />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
  flex: none;
}
.brand {
  font-family: var(--mono);
  font-weight: 600;
}
.link {
  font-family: var(--mono);
  font-size: 12px;
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
}
.theme-btn {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 12px;
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
  cursor: pointer;
}
main {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
main.workspace {
  overflow: hidden;
}
</style>
