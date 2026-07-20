<script setup lang="ts">
import { computed, ref } from "vue";
import type { GroupNode } from "../stores/workspace.js";
import { workspaceStore } from "../stores/workspace.js";
import { sessionsStore } from "../stores/sessions.js";
import { systemsStore } from "../stores/systems.js";
import { PANE_LABELS, isPaneTab } from "../paneLabels.js";
import { closeSession } from "../session-controller.js";
import SessionInfo from "./SessionInfo.vue";

const props = defineProps<{ group: GroupNode }>();
const infoFor = ref<string | undefined>();
// 並び替えプレビュー（どのタブの前/後ろに挿入されるか）
const reorder = ref<{ overId: string; after: boolean } | undefined>();


/** セッションを持たない（＝接続の概念が無い）タブか。判定は paneLabels に集約している */
const isPane = isPaneTab;
function label(sessionId: string): string {
  return PANE_LABELS[sessionId] ?? sessionsStore.get(sessionId)?.label ?? sessionId.slice(0, 6);
}
function connected(sessionId: string): boolean {
  if (isPane(sessionId)) return true;
  return sessionsStore.get(sessionId)?.connected ?? false;
}

/**
 * 選択中システムに属するタブだけを描画する。
 * **`group.tabs` は変えない**——隠すだけで、切り替えて戻れば元どおり現れる。
 */
const shownTabs = computed(() => workspaceStore.visibleTabs(props.group, systemsStore.selected));


/** タブを選ぶ。ランチャーが開いたままにならないよう閉じる */
function selectTab(id: string): void {
  workspaceStore.setActiveTab(props.group.id, id);
  workspaceStore.showLauncher = false;
}
/** プリンターの未読スプール数（非アクティブ時にタブへバッジ表示） */
function unread(sessionId: string): number {
  return sessionsStore.get(sessionId)?.unread ?? 0;
}
/**
 * タブを閉じる。**セッションを持たないタブ（管理・一覧）は workspace から外すだけ**——
 * 以前は `list:*` がこの分岐から漏れており、切断処理へ流れていた。
 */
function closeTab(id: string): void {
  if (isPane(id)) workspaceStore.closeSession(id);
  else closeSession(id);
}
// タブエリアが現在ドロップ対象か（末尾追加のハイライト用）
const stripActive = ref(false);

/** このペインが最大化中か */
const maximized = computed(() => workspaceStore.maximizedGroupId === props.group.id);
/**
 * 最大化ボタンを出すか。**分割しているときだけ**——単一ペインは既に全面なので、
 * 押しても何も変わらないボタンを置かない。最大化中は「元に戻す」として出し続ける。
 */
const showMaximize = computed(() => maximized.value || workspaceStore.isSplit());
function toggleMaximize(): void {
  workspaceStore.toggleMaximize(props.group.id);
}

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
/**
 * タブの隙間・末尾の空き領域に落としたら末尾へ追加（合流）。
 *
 * **ここへ来た時点で「タブ耳の上ではない」ことが確定している**——
 * タブ耳の dragover は stopPropagation するため、この関数まで届かない。
 * よって残っている `reorder`（タブ間の挿入位置の目印）は過去のもので、消してよい。
 *
 * 以前は `if (!reorder.value)` で抑制していたため、タブ耳を通ってから空き領域へ移ると
 * 目印が残ったままになり、**帯のドロップ領域が出なくなっていた**。
 */
function onStripDragOver(ev: DragEvent): void {
  if (!isTabDrag()) return;
  ev.preventDefault();
  ev.stopPropagation();
  reorder.value = undefined;
  // 同じグループ内の並べ替えでは合流の目印を出さない——移動先が変わらないので意味がない
  stripActive.value = !props.group.tabs.includes(workspaceStore.draggingSession!);
}
function onStripDrop(ev: DragEvent): void {
  if (!isTabDrag()) return;
  ev.preventDefault();
  ev.stopPropagation();
  dropAt(props.group.tabs.filter((x) => x !== workspaceStore.draggingSession).length); // 末尾
}
/**
 * ドラッグがこの帯から出たら、表示中の目印を消す。
 *
 * **`reorder` も消すのが要点**——タブ個別には dragleave が無いため、
 * ドラッグ元のペインでタブ上を通過すると目印が立ちっぱなしになり、
 * 移動先のペインが反応していないように見えていた。
 * 子要素（タブ）へ移っただけの dragleave では消さない（ちらつく）。
 */
function onStripLeave(ev: DragEvent): void {
  const to = ev.relatedTarget as Node | null;
  if (to && (ev.currentTarget as HTMLElement).contains(to)) return;
  stripActive.value = false;
  reorder.value = undefined;
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
      v-for="t in shownTabs"
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
      @click="selectTab(t)"
    >
      <span class="dot" :class="{ live: connected(t) }"></span>
      {{ label(t) }}
      <span v-if="unread(t) > 0" class="badge" title="新着スプール">{{ unread(t) }}</span>
      <button
        v-if="!isPane(t)"
        class="info"
        title="セッション情報"
        @click.stop="infoFor = infoFor === t ? undefined : t"
      >
        ⓘ
      </button>
      <button class="x" title="閉じる" @click.stop="closeTab(t)">✕</button>
      <SessionInfo v-if="infoFor === t && !isPane(t)" :session-id="t" @close="infoFor = undefined" />
    </div>
    <button
      v-if="showMaximize"
      class="maximize"
      :aria-pressed="maximized"
      :title="maximized ? 'ペインを元に戻す' : 'ペインを最大化'"
      @click.stop="toggleMaximize"
    >
      {{ maximized ? "🗗" : "🗖" }}
    </button>
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
/* 最大化 / 元に戻す。タブの並びとは別物なので右端へ寄せる */
.maximize {
  margin-left: auto;
  align-self: center;
  border: 1px solid var(--crt-line);
  border-radius: 4px;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 1px 6px;
  font-size: 12px;
  line-height: 1.4;
}
.maximize[aria-pressed="true"] {
  color: var(--t-green);
  border-color: var(--t-green);
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
.badge {
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent, #3b82f6);
  color: #fff;
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  font-family: var(--mono);
}
</style>
