<script setup lang="ts">
import type { PaneSplit } from "../composables/usePaneSplit.js";

/**
 * 上下 2 段の境界。掴んで上段の高さを変える。
 *
 * 見た目は 1px の罫線だが、**掴める幅は 9px 取る**——1px ちょうどでは掴めない。
 * separator ロールで focus でき、上下キーでも動かせる（マウス専用にしない）。
 */
defineProps<{ split: PaneSplit; label: string }>();
</script>

<template>
  <div
    class="splitter"
    :class="{ dragging: split.dragging.value }"
    role="separator"
    aria-orientation="horizontal"
    :aria-label="`${label}（ドラッグまたは上下キーで高さを変えられます）`"
    tabindex="0"
    :title="`ドラッグすると${label}を変えられます`"
    @pointerdown="split.onDown"
    @pointermove="split.onMove"
    @pointerup="split.onUp"
    @pointercancel="split.onUp"
    @keydown="split.onKeydown"
  ></div>
</template>

<style scoped>
.splitter {
  flex: none;
  height: 9px;
  margin: 2px 0 6px;
  cursor: row-resize;
  touch-action: none;
  position: relative;
  border-radius: 3px;
}
/* 罫線は中央に 1px。掴める範囲（9px）と見た目を分ける */
.splitter::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 4px;
  height: 1px;
  background: var(--line);
}
.splitter:hover::after,
.splitter:focus-visible::after,
.splitter.dragging::after {
  background: var(--accent);
  height: 3px;
  top: 3px;
}
.splitter:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
