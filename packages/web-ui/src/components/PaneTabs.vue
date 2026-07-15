<script setup lang="ts">
import { ref } from "vue";
import type { GroupNode } from "../stores/workspace.js";
import { workspaceStore } from "../stores/workspace.js";
import { sessionsStore } from "../stores/sessions.js";
import { closeSession } from "../session-controller.js";
import SessionInfo from "./SessionInfo.vue";

defineProps<{ group: GroupNode }>();
const infoFor = ref<string | undefined>();

function label(sessionId: string): string {
  return sessionsStore.get(sessionId)?.label ?? sessionId.slice(0, 6);
}
function connected(sessionId: string): boolean {
  return sessionsStore.get(sessionId)?.connected ?? false;
}
function onDragStart(ev: DragEvent, sessionId: string): void {
  ev.dataTransfer?.setData("text/session", sessionId);
}
</script>

<template>
  <div class="tabs">
    <div
      v-for="t in group.tabs"
      :key="t"
      class="tab"
      :class="{ on: group.activeTab === t, off: !connected(t) }"
      draggable="true"
      @dragstart="onDragStart($event, t)"
      @click="workspaceStore.setActiveTab(group.id, t)"
    >
      <span class="dot" :class="{ live: connected(t) }"></span>
      {{ label(t) }}
      <button class="info" title="セッション情報" @click.stop="infoFor = infoFor === t ? undefined : t">ⓘ</button>
      <button class="x" title="閉じる" @click.stop="closeSession(t)">✕</button>
      <SessionInfo v-if="infoFor === t" :session-id="t" @close="infoFor = undefined" />
    </div>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 2px;
  padding: 4px 4px 0;
  flex-wrap: wrap;
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-family: var(--mono);
  font-size: 12px;
  border: 1px solid var(--crt-line);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: var(--crt);
  color: var(--muted);
  cursor: grab;
}
.tab.on {
  color: var(--t-green);
}
.tab.off {
  opacity: 0.6;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
}
.dot.live {
  background: var(--t-green);
}
.info,
.x {
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 2px;
  font-size: 11px;
}
</style>
