<script setup lang="ts">
import { computed } from "vue";
import type { AidKey } from "@as400web/core";
import type { SessionState } from "../stores/sessions.js";
import { sendKey } from "../session-controller.js";

const props = defineProps<{
  state: SessionState;
  insertMode?: boolean;
  /** 有効カーソル（override ?? snapshot.cursor）。ホスト由来の snapshot.cursor と違い
   *  ユーザーのカーソル移動に追従する。ACS 同様「行/列」を出して位置を確認できるようにする。 */
  cursor?: { row: number; col: number };
}>();

/** 表示するカーソル位置（未指定ならホスト由来へフォールバック） */
const cur = computed(() => props.cursor ?? props.state.snapshot?.cursor);
const shift = computed(() => false);

const snap = computed(() => props.state.snapshot);
const fkeys = computed<{ key: AidKey; label: string }[]>(() =>
  shift.value
    ? [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].map((n) => ({ key: `F${n}` as AidKey, label: `F${n}` }))
    : [
        { key: "F1", label: "F1 ヘルプ" },
        { key: "F3", label: "F3 終了" },
        { key: "F4", label: "F4 プロンプト" },
        { key: "F5", label: "F5 更新" },
        { key: "F12", label: "F12 取消" },
        { key: "Enter", label: "⏎ 実行" }
      ]
);
function press(k: AidKey): void {
  sendKey(props.state.sessionId, k, props.state.cursor);
}
</script>

<template>
  <div class="oia">
    <span>{{ state.connected ? "⌨ 入力可" : "切断" }}</span>
    <span v-if="cur" class="pos" title="カーソル位置（行/列）">
      <b>{{ String(cur.row).padStart(2, "0") }}/{{ String(cur.col).padStart(3, "0") }}</b>
    </span>
    <span v-if="snap">画面 <b>{{ snap.rows }}x{{ snap.cols }}</b></span>
    <span v-if="snap?.keyboardLocked" class="lock">🔒 応答待ち</span>
    <span class="mode">{{ insertMode ? "挿入" : "上書き" }}</span>
    <span v-if="snap?.systemMessage" class="msg">{{ snap.systemMessage }}</span>
    <span class="fkeys">
      <button v-for="f in fkeys" :key="f.key" class="fk" @click="press(f.key)">{{ f.label }}</button>
    </span>
  </div>
</template>

<style scoped>
/* カーソル位置（行/列）。桁ズレの確認に使うので等幅・固定幅で読み取りやすくする */
.pos {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
.pos b {
  letter-spacing: 0.5px;
}
.oia {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 5px 10px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  background: var(--crt-bezel);
  border-top: 1px solid var(--crt-line);
}
.oia b {
  color: var(--t-green);
}
.lock {
  color: var(--t-yellow);
}
.msg {
  color: var(--t-red);
}
.fkeys {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-left: auto;
}
.fk {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 3px 8px;
  background: var(--crt);
  color: var(--muted);
  border: 1px solid var(--crt-line);
  border-radius: 5px;
  cursor: pointer;
}
.fk:hover {
  color: var(--t-green);
  border-color: var(--t-green);
}
</style>
