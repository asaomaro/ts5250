<script setup lang="ts">
import { ref, computed } from "vue";
import EmulatorPane from "./EmulatorPane.vue";
import PaneTabs from "./PaneTabs.vue";
import { workspaceStore, type WsNode, type SplitNode, type GroupNode, type DropZone } from "../stores/workspace.js";

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

// ---- タブ D&D のドロップ（5 ゾーン） ----
const dropZone = ref<DropZone | undefined>();
function zoneFrom(ev: DragEvent, el: HTMLElement): DropZone {
  const r = el.getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width;
  const y = (ev.clientY - r.top) / r.height;
  if (x < 0.25) return "left";
  if (x > 0.75) return "right";
  if (y < 0.25) return "top";
  if (y > 0.75) return "bottom";
  return "center";
}
function onDragOver(ev: DragEvent): void {
  ev.preventDefault();
  dropZone.value = zoneFrom(ev, ev.currentTarget as HTMLElement);
}
function onDrop(ev: DragEvent): void {
  ev.preventDefault();
  const sessionId = ev.dataTransfer?.getData("text/session");
  const zone = dropZone.value;
  dropZone.value = undefined;
  if (!sessionId || !zone) return;
  if (zone === "center") workspaceStore.moveTab(sessionId, group.value.id);
  else workspaceStore.split(group.value.id, zone, sessionId);
}

const focused = computed(() => workspaceStore.focusedGroupId === group.value.id);
</script>

<template>
  <div v-if="isSplit" ref="container" class="split" :class="split.dir">
    <div class="split-child" :style="{ flexBasis: split.ratio * 100 + '%' }">
      <WorkspaceNode :node="split.a" />
    </div>
    <div class="divider" :class="split.dir" @pointerdown="onDividerDown">⋮</div>
    <div class="split-child" :style="{ flexBasis: (1 - split.ratio) * 100 + '%' }">
      <WorkspaceNode :node="split.b" />
    </div>
  </div>

  <div
    v-else
    class="group"
    :data-focused="focused"
    @mousedown="workspaceStore.focus(group.id)"
    @dragover="onDragOver"
    @dragleave="dropZone = undefined"
    @drop="onDrop"
  >
    <PaneTabs :group="group" />
    <div class="group-body">
      <EmulatorPane
        v-if="group.activeTab"
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
  color: var(--muted);
  background: var(--crt-bezel);
  user-select: none;
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
.dz[data-zone="center"] { inset: 25%; }
.dz[data-zone="top"] { top: 0; left: 0; right: 0; height: 40%; }
.dz[data-zone="bottom"] { bottom: 0; left: 0; right: 0; height: 40%; }
.dz[data-zone="left"] { left: 0; top: 0; bottom: 0; width: 40%; }
.dz[data-zone="right"] { right: 0; top: 0; bottom: 0; width: 40%; }
</style>
