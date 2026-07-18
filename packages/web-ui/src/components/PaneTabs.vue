<script setup lang="ts">
import { ref } from "vue";
import type { GroupNode } from "../stores/workspace.js";
import { workspaceStore } from "../stores/workspace.js";
import { sessionsStore } from "../stores/sessions.js";
import { closeSession } from "../session-controller.js";
import SessionInfo from "./SessionInfo.vue";

const props = defineProps<{ group: GroupNode }>();
const infoFor = ref<string | undefined>();
// 並び替えプレビュー（どのタブの前/後ろに挿入されるか）
const reorder = ref<{ overId: string; after: boolean } | undefined>();

const ADMIN_LABELS: Record<string, string> = {
  "admin:users": "ユーザー管理",
  "admin:sessions": "セッション管理",
  "admin:logs": "ログ"
};
function label(sessionId: string): string {
  return ADMIN_LABELS[sessionId] ?? sessionsStore.get(sessionId)?.label ?? sessionId.slice(0, 6);
}
function connected(sessionId: string): boolean {
  if (sessionId.startsWith("admin:")) return true;
  return sessionsStore.get(sessionId)?.connected ?? false;
}
/** タブを閉じる（管理タブは workspace から外すだけ、セッションは切断も行う） */
function closeTab(id: string): void {
  if (id.startsWith("admin:")) workspaceStore.closeSession(id);
  else closeSession(id);
}
// タブエリアが現在ドロップ対象か（末尾追加のハイライト用）
const stripActive = ref(false);

function onDragStart(ev: DragEvent, sessionId: string): void {
  ev.dataTransfer?.setData("text/session", sessionId);
  workspaceStore.draggingSession = sessionId;
}
function onDragEnd(): void {
  workspaceStore.draggingSession = undefined;
  reorder.value = undefined;
  stripActive.value = false;
}
/** タブの D&D 対象か（自グループ内の並び替え／別グループからの合流。どちらもタブエリアで受ける） */
function isTabDrag(): boolean {
  return !!workspaceStore.draggingSession;
}
/** ドラッグ中タブを除いた配列での挿入位置（0〜末尾）を計算して落とす */
function dropAt(toIndex: number): void {
  const dragged = workspaceStore.draggingSession;
  reorder.value = undefined;
  stripActive.value = false;
  workspaceStore.draggingSession = undefined;
  if (!dragged) return;
  workspaceStore.dropTabInto(props.group.id, dragged, toIndex);
}
function onTabDragOver(ev: DragEvent, t: string): void {
  if (!isTabDrag()) return;
  ev.preventDefault();
  ev.stopPropagation(); // グループ全体（分割ゾーン）へは伝播させない
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  reorder.value = { overId: t, after: ev.clientX > r.left + r.width / 2 };
  stripActive.value = false;
}
function onTabDrop(ev: DragEvent, t: string): void {
  if (!isTabDrag()) return;
  ev.preventDefault();
  ev.stopPropagation();
  const dragged = workspaceStore.draggingSession!;
  const after = reorder.value?.overId === t ? reorder.value.after : false;
  if (t === dragged) {
    // 自身へのドロップは無操作
    reorder.value = undefined;
    stripActive.value = false;
    workspaceStore.draggingSession = undefined;
    return;
  }
  // ドラッグ中タブを除いた配列での挿入位置（t の前/後ろ）
  const rest = props.group.tabs.filter((x) => x !== dragged);
  const j = rest.indexOf(t);
  dropAt(j < 0 ? rest.length : after ? j + 1 : j);
}
// タブの隙間・末尾の空き領域に落としたら末尾へ追加（合流）
function onStripDragOver(ev: DragEvent): void {
  if (!isTabDrag()) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (!reorder.value) stripActive.value = true;
}
function onStripDrop(ev: DragEvent): void {
  if (!isTabDrag()) return;
  ev.preventDefault();
  ev.stopPropagation();
  dropAt(props.group.tabs.filter((x) => x !== workspaceStore.draggingSession).length); // 末尾
}
function onStripLeave(): void {
  stripActive.value = false;
}
</script>

<template>
  <div
    class="tabs"
    :class="{ 'strip-drop': stripActive }"
    @dragover="onStripDragOver"
    @dragleave="onStripLeave"
    @drop="onStripDrop"
  >
    <div
      v-for="t in group.tabs"
      :key="t"
      class="tab"
      :class="{
        on: group.activeTab === t,
        off: !connected(t),
        'drop-before': reorder?.overId === t && !reorder.after,
        'drop-after': reorder?.overId === t && reorder.after
      }"
      draggable="true"
      @dragstart="onDragStart($event, t)"
      @dragend="onDragEnd"
      @dragover="onTabDragOver($event, t)"
      @drop="onTabDrop($event, t)"
      @click="workspaceStore.setActiveTab(group.id, t)"
    >
      <span class="dot" :class="{ live: connected(t) }"></span>
      {{ label(t) }}
      <button
        v-if="!t.startsWith('admin:')"
        class="info"
        title="セッション情報"
        @click.stop="infoFor = infoFor === t ? undefined : t"
      >
        ⓘ
      </button>
      <button class="x" title="閉じる" @click.stop="closeTab(t)">✕</button>
      <SessionInfo v-if="infoFor === t && !t.startsWith('admin:')" :session-id="t" @close="infoFor = undefined" />
    </div>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 2px;
  padding: 4px 4px 0;
  flex-wrap: wrap;
  /* タブが少なくても末尾の空き領域へドロップ（合流）できるよう最低幅・高さを確保 */
  min-height: 28px;
  align-content: flex-start;
}
/* 別ペインのタブをこのタブエリアへドロップして合流できることを示すハイライト */
.tabs.strip-drop {
  background: color-mix(in srgb, var(--t-green) 12%, transparent);
  outline: 1px dashed var(--t-green);
  outline-offset: -2px;
  border-radius: 6px;
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
/* 並び替えの挿入位置インジケータ（ドラッグ中に前/後ろを示す） */
.tab.drop-before::before,
.tab.drop-after::after {
  content: "";
  position: absolute;
  top: 2px;
  bottom: 2px;
  width: 2px;
  background: var(--t-green);
  box-shadow: 0 0 4px var(--t-green);
}
.tab.drop-before::before {
  left: -2px;
}
.tab.drop-after::after {
  right: -2px;
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
