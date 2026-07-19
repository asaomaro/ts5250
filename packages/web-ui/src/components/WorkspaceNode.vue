<script setup lang="ts">
import { ref, computed } from "vue";
import EmulatorPane from "./EmulatorPane.vue";
import PrinterPane from "./PrinterPane.vue";
import AdminPane from "./AdminPane.vue";
import HostListPane from "./HostListPane.vue";
import SqlPane from "./SqlPane.vue";
import PaneTabs from "./PaneTabs.vue";
import { workspaceStore, type WsNode, type SplitNode, type GroupNode, type DropZone } from "../stores/workspace.js";
import { sessionsStore } from "../stores/sessions.js";

const props = defineProps<{ node: WsNode }>();

const isSplit = computed(() => props.node.type === "split");
const split = computed(() => props.node as SplitNode);
const group = computed(() => props.node as GroupNode);

// ---- ディバイダのリサイズ（Pointer Events） ----
const container = ref<HTMLElement>();
function onDividerDown(ev: PointerEvent): void {
  ev.preventDefault();
  const el = container.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const horiz = split.value.dir === "row";
  const move = (e: PointerEvent): void => {
    const ratio = horiz ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
    workspaceStore.setRatio((n) => n === split.value, ratio);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---- タブ D&D のドロップ（端 4 ゾーン＝分割のみ。中央合流は廃止しタブエリアで受ける） ----
type SplitZone = Exclude<DropZone, "center">;
const dropZone = ref<SplitZone | undefined>();
/** 端 4 ゾーンのみ返す。中央は分割対象外（合流はタブエリア＝PaneTabs が担当）→ undefined */
function zoneFrom(ev: DragEvent, el: HTMLElement): SplitZone | undefined {
  const r = el.getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width;
  const y = (ev.clientY - r.top) / r.height;
  if (x < 0.25) return "left";
  if (x > 0.75) return "right";
  if (y < 0.25) return "top";
  if (y > 0.75) return "bottom";
  return undefined; // 中央はドロップ不可
}
function onDragOver(ev: DragEvent): void {
  const zone = zoneFrom(ev, ev.currentTarget as HTMLElement);
  dropZone.value = zone;
  // 有効な端ゾーンのときだけドロップを許可（中央は no-drop カーソルにする）
  if (zone) ev.preventDefault();
}
function onDrop(ev: DragEvent): void {
  const zone = dropZone.value;
  dropZone.value = undefined;
  if (!zone) return; // 中央ドロップは無効
  ev.preventDefault();
  const sessionId = ev.dataTransfer?.getData("text/session");
  if (!sessionId) return;
  workspaceStore.split(group.value.id, zone, sessionId);
}

const focused = computed(() => workspaceStore.focusedGroupId === group.value.id);
/** アクティブタブがプリンターセッションかどうか（ペイン内容の出し分け） */
const activeIsPrinter = computed(
  () => !!group.value.activeTab && sessionsStore.get(group.value.activeTab)?.kind === "printer"
);
/** 管理タブ（admin:users/sessions/logs）か */
const activeIsAdmin = computed(() => group.value.activeTab?.startsWith("admin:") ?? false);
/** 一覧タブ（list:jobs/objects/users）か。管理タブと同じ「特殊なタブ ID」方式 */
const activeIsList = computed(() => group.value.activeTab?.startsWith("list:") ?? false);
const activeIsSql = computed(() => group.value.activeTab?.startsWith("sql:") ?? false);
</script>

<template>
  <div v-if="isSplit" ref="container" class="split" :class="split.dir">
    <div class="split-child" :style="{ flexBasis: split.ratio * 100 + '%' }">
      <WorkspaceNode :node="split.a" />
    </div>
    <div class="divider" :class="split.dir" @pointerdown="onDividerDown">
      <span class="grip"><i></i><i></i><i></i></span>
    </div>
    <div class="split-child" :style="{ flexBasis: (1 - split.ratio) * 100 + '%' }">
      <WorkspaceNode :node="split.b" />
    </div>
  </div>

  <div
    v-else
    class="group"
    :data-group-id="group.id"
    :data-focused="focused"
    @mousedown="workspaceStore.focus(group.id)"
    @dragover="onDragOver"
    @dragleave="dropZone = undefined"
    @drop="onDrop"
  >
    <PaneTabs :group="group" />
    <div class="group-body">
      <AdminPane v-if="group.activeTab && activeIsAdmin" :tab-id="group.activeTab" />
      <HostListPane v-else-if="group.activeTab && activeIsList" :tab-id="group.activeTab" />
      <SqlPane v-else-if="group.activeTab && activeIsSql" :tab-id="group.activeTab" />
      <PrinterPane
        v-else-if="group.activeTab && activeIsPrinter"
        :session-id="group.activeTab"
        :focused="focused"
        @focus="workspaceStore.focus(group.id)"
      />
      <EmulatorPane
        v-else-if="group.activeTab"
        :session-id="group.activeTab"
        :focused="focused"
        @focus="workspaceStore.focus(group.id)"
      />
      <div v-else class="group-empty">セッションなし</div>
      <div v-if="dropZone" class="dz" :data-zone="dropZone"></div>
    </div>
  </div>
</template>

<style scoped>
.split {
  display: flex;
  height: 100%;
  width: 100%;
}
.split.row {
  flex-direction: row;
}
.split.col {
  flex-direction: column;
}
.split-child {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.divider {
  flex: none;
  display: grid;
  place-items: center;
  background: var(--crt-bezel);
  user-select: none;
}
/* つまみ（3 点）は CSS で描画し向きを確実に制御する（フォントのグリフ依存を避ける）。
   縦バー（row 分割）は点を縦並び、横バー（col 分割）は点を横並びにする。 */
.divider .grip {
  display: flex;
  gap: 3px;
}
.divider.row .grip {
  flex-direction: column;
}
.divider.col .grip {
  flex-direction: row;
}
.divider .grip i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--muted);
}
.divider.row {
  width: 10px;
  cursor: col-resize;
}
.divider.col {
  height: 10px;
  cursor: row-resize;
}
.group {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 4px;
  position: relative;
}
.group[data-focused="true"] {
  background: color-mix(in srgb, var(--t-green) 6%, transparent);
}
.group-body {
  position: relative;
  flex: 1;
  min-height: 0;
}
.group-empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--muted);
}
.dz {
  position: absolute;
  background: color-mix(in srgb, var(--t-green) 22%, transparent);
  border: 1px solid var(--t-green);
  pointer-events: none;
}
.dz[data-zone="top"] { top: 0; left: 0; right: 0; height: 40%; }
.dz[data-zone="bottom"] { bottom: 0; left: 0; right: 0; height: 40%; }
.dz[data-zone="left"] { left: 0; top: 0; bottom: 0; width: 40%; }
.dz[data-zone="right"] { right: 0; top: 0; bottom: 0; width: 40%; }
</style>
