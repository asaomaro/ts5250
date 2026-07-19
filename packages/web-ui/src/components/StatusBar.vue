<script setup lang="ts">
import { computed } from "vue";
import type { AidKey } from "@as400web/core";
import type { SessionState } from "../stores/sessions.js";
import { sendKey } from "../session-controller.js";
import { fieldAt } from "../composables/useCursor.js";

const props = defineProps<{
  state: SessionState;
  insertMode?: boolean;
  /** 有効カーソル（override ?? snapshot.cursor）。ホスト由来の snapshot.cursor と違い
   *  ユーザーのカーソル移動に追従する。ACS 同様「行/列」を出して位置を確認できるようにする。 */
  cursor?: { row: number; col: number };
  /** クライアント側の操作員メッセージ（挿入ペーストの入り切らない等）。ホスト由来の
   *  systemMessage とは別物なので、区別できるよう別枠で出す。 */
  notice?: string;
  /** 操作ログの件数（このセッション分）。フッター内にトグルを置くため受け取る */
  logCount?: number;
  logOpen?: boolean;
}>();

const emit = defineEmits<{ (e: "toggle-log"): void }>();

/** 表示するカーソル位置（未指定ならホスト由来へフォールバック） */
const cur = computed(() => props.cursor ?? props.state.snapshot?.cursor);
const shift = computed(() => false);

const snap = computed(() => props.state.snapshot);

/**
 * 入力できる状態か。
 *
 * 以前は接続の有無だけを見ていたため、保護画面でも常に「入力可」と出ていた。
 * 5250 の OIA と同じく、**いまその位置に打てるか**を示す。
 */
const inputState = computed<{ label: string; ok: boolean }>(() => {
  if (!props.state.connected) return { label: "切断", ok: false };
  if (props.state.readOnly) return { label: "閲覧のみ", ok: false };
  const sn = snap.value;
  if (!sn) return { label: "—", ok: false };
  if (sn.keyboardLocked) return { label: "入力禁止", ok: false };
  const c = cur.value;
  if (!c) return { label: "入力不可", ok: false };
  const f = fieldAt(c.row, c.col, sn.fields, sn.cols, sn.rows);
  if (!f) return { label: "入力不可", ok: false };
  if (f.protected) return { label: "保護", ok: false };
  return { label: "入力可", ok: true };
});
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
    <!-- 操作ログのトグル。フッターが 2 行にならないよう、ここに収める -->
    <button
      v-if="logCount !== undefined"
      class="logbtn"
      :class="{ on: logOpen }"
      title="操作ログ"
      @click="emit('toggle-log')"
    >
      {{ logOpen ? "▾" : "▴" }} ログ <span class="cnt">{{ logCount }}</span>
    </button>
    <span class="ime" :class="{ ng: !inputState.ok }" :title="inputState.ok ? 'この位置に入力できます' : '入力できません'">
      ⌨ {{ inputState.label }}
    </span>
    <span v-if="cur" class="pos" title="カーソル位置（行/列）">
      <b>{{ String(cur.row).padStart(2, "0") }}/{{ String(cur.col).padStart(3, "0") }}</b>
    </span>
    <span v-if="snap">画面 <b>{{ snap.rows }}x{{ snap.cols }}</b></span>
    <span v-if="snap?.keyboardLocked" class="lock">🔒 応答待ち</span>
    <span class="mode">{{ insertMode ? "挿入" : "上書き" }}</span>
    <span v-if="notice" class="msg notice" role="status">{{ notice }}</span>
    <span v-if="snap?.systemMessage" class="msg">{{ snap.systemMessage }}</span>
    <span class="fkeys">
      <button v-for="f in fkeys" :key="f.key" class="fk" @click="press(f.key)">{{ f.label }}</button>
    </span>
  </div>
</template>

<style scoped>
/* 入力できない状態は色で分かるようにする（OIA と同じ役目） */
.ime {
  /* 幅を固定する。表記が変わるたびに右側の要素が動くと読みにくい */
  display: inline-block;
  min-width: 7em;
}
.ime.ng {
  color: var(--muted);
}
.logbtn {
  background: none;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 1px 7px;
  font: inherit;
  color: var(--muted);
  cursor: pointer;
}
.logbtn:hover,
.logbtn.on {
  color: var(--t-green);
  border-color: var(--crt-line);
}
.logbtn .cnt {
  /* 件数は増え続けるので桁数で幅を固定する（右側がずれない） */
  display: inline-block;
  min-width: 6ch;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

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
/* クライアント側の操作員メッセージ。ホストのメッセージと取り違えないよう色を変える */
.notice {
  color: var(--t-red, #c62828);
  font-weight: 600;
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
