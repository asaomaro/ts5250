<script setup lang="ts">
import type { PaneSplit } from "../composables/usePaneSplit.js";

/**
 * 2 つのペインの境界。掴んで前側（上段の高さ／左列の幅）を変える。
 *
 * 見た目は 1px の罫線だが、**掴める幅は 9px 取る**——1px ちょうどでは掴めない。
 * separator ロールで focus でき、矢印キーでも動かせる（マウス専用にしない）。
 *
 * `vertical` は左右を仕切る縦の罫線（`usePaneSplit({ axis: "x" })` と対で使う。
 * IFS ペインの列境界。`20260924-vscode-extension` D18）。既定は上下を仕切る横の罫線。
 */
const props = defineProps<{ split: PaneSplit; label: string; vertical?: boolean }>();
</script>

<template>
  <div
    class="splitter"
    :class="{ dragging: split.dragging.value, vertical: props.vertical }"
    role="separator"
    :aria-orientation="props.vertical ? 'vertical' : 'horizontal'"
    :aria-label="`${label}（ドラッグまたは${props.vertical ? '左右' : '上下'}キーで${props.vertical ? '幅' : '高さ'}を変えられます）`"
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
/* 左右を仕切る縦の罫線。**負のmarginで隣へ食い込ませない**——食い込むと隣の列の縦スクロールバーを
   掴み手が覆い、スクロールバーを掴めなくなる */
.splitter.vertical {
  width: 9px;
  height: auto;
  margin: 0;
  cursor: col-resize;
}
.splitter.vertical::after {
  left: 4px;
  right: auto;
  top: 0;
  bottom: 0;
  width: 1px;
  height: auto;
}
.splitter.vertical:hover::after,
.splitter.vertical:focus-visible::after,
.splitter.vertical.dragging::after {
  left: 3px;
  top: 0;
  width: 3px;
  height: auto;
}
.splitter:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
