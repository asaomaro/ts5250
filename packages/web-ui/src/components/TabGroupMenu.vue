<script setup lang="ts">
/**
 * **タブグループのポップアップ**（`20260804-tab-groups`）。
 *
 * チップを押すと開き、名前・色・グループ化の解除・一括クローズを扱う。
 *
 * **`InfoPopover` は使わない**——あちらはラベル/値の行を並べる部品で、入力欄・パレット・
 * メニュー項目は載らない。ただし**構造の規約は同じ**（`docs/UI-DESIGN.md`「情報ポップオーバー」）:
 * バックドロップ（`position:fixed; inset:0`）＋本体（`position:absolute; top:100%`）、
 * 本体は `@click.stop` / `@mousedown.stop` で伝播を止め、外側クリックとトリガ再クリックで閉じる。
 */
import { workspaceStore, type TabGroup } from "../stores/workspace.js";
import { TAB_GROUP_COLOR_COUNT, tabGroupColorVar } from "../composables/tabGroupColor.js";

const props = defineProps<{ tg: TabGroup }>();
const emit = defineEmits<{ (e: "close"): void; (e: "close-all"): void }>();

const COLORS = Array.from({ length: TAB_GROUP_COLOR_COUNT }, (_, i) => i + 1);

/** 名前は**入力のたび反映**する（確定操作を要らなくする。空に戻せば色だけのチップに戻る） */
function onName(ev: Event): void {
  workspaceStore.renameTabGroup(props.tg.id, (ev.target as HTMLInputElement).value);
}
function pick(color: number): void {
  workspaceStore.setTabGroupColor(props.tg.id, color);
}
/** 解除したらチップごと消えるので、ポップアップも閉じる */
function ungroup(): void {
  workspaceStore.ungroupTabGroup(props.tg.id);
  emit("close");
}
</script>

<template>
  <!--
    バックドロップ: 外側クリックで閉じる（本体は click.stop で伝播させない）。

    **`click` も止める**のが `InfoPopover` との違い。この部品はチップ（＝開閉のトリガ）の
    **中に**マウントされるので、止めないとバックドロップのクリックがチップまで上がり、
    「閉じる → すぐ開き直す」になって永久に閉じない。
  -->
  <div class="backdrop" draggable="false" @click.stop="emit('close')" @mousedown.stop></div>
  <!--
    **`draggable="false"` を明示する**。この部品は `draggable="true"` のチップの**中**に置かれるため、
    外さないと**名前入力欄でドラッグして文字を選ぼうとした瞬間にグループごとのドラッグが始まる**
    （ブラウザによる）。原因が見た目から辿れない種類の不具合なので、構造の側で塞ぐ。
  -->
  <div class="menu" draggable="false" @click.stop @mousedown.stop>
    <input
      class="name"
      type="text"
      placeholder="このグループに名前を付ける"
      :value="tg.name"
      @input="onName"
    />
    <div class="palette">
      <button
        v-for="c in COLORS"
        :key="c"
        class="swatch"
        :class="{ on: c === tg.color }"
        :style="{ '--tg': tabGroupColorVar(c) }"
        :aria-pressed="c === tg.color"
        :title="`色 ${c}`"
        @click="pick(c)"
      ></button>
    </div>
    <div class="sep"></div>
    <button class="item" @click="ungroup">⌧ グループ化を解除</button>
    <button class="item" @click="emit('close-all')">⊗ グループ内のタブをすべて閉じる</button>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  background: transparent;
}
.menu {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 31;
  min-width: 240px;
  background: var(--crt-bezel, #1a1f1a);
  border: 1px solid var(--crt-line, #333);
  border-radius: 8px;
  padding: 8px;
  box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.5);
  text-align: left;
  font-family: var(--mono);
}
.name {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  font-family: inherit;
  font-size: 12px;
  color: var(--t-white);
  background: var(--crt);
  border: 1px solid var(--crt-line);
  border-radius: 6px;
}
.name:focus {
  outline: none;
  border-color: var(--t-green);
}
.palette {
  display: flex;
  gap: 6px;
  padding: 8px 2px 4px;
}
.swatch {
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid transparent;
  background: var(--tg);
  cursor: pointer;
}
/* 選択中は輪で示す（塗りつぶしの色は選択肢そのものなので、印は外側に出す） */
.swatch.on {
  box-shadow: 0 0 0 2px var(--crt-bezel), 0 0 0 3px var(--tg);
}
.sep {
  height: 1px;
  margin: 6px -8px;
  background: var(--crt-line);
}
.item {
  display: block;
  width: 100%;
  padding: 6px 4px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--muted);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.item:hover {
  background: color-mix(in srgb, var(--t-green) 12%, transparent);
  color: var(--t-white);
}
</style>
