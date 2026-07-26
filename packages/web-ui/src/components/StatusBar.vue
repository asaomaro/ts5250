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

const emit = defineEmits<{ (e: "toggle-log"): void; (e: "sysreq"): void }>();

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

/**
 * マクロの状態表示（spec D10）。ACS が記録中に画面下部へ出すシアンのバーに相当する役目を、
 * この OIA が担う。**止まった理由も出す**——「押したのに動かない」と
 * 「画面が一致せず止めた」を利用者が区別できないと、原因を追えない。
 */
const macro = computed<{ label: string; cls: string; title: string } | undefined>(() => {
  const m = props.state.macro;
  if (!m) return undefined;
  switch (m.mode) {
    case "recording":
      return { label: "⏺ 記録中", cls: "rec", title: "操作を記録しています" };
    case "recordPaused":
      return { label: "⏸ 記録休止", cls: "pause", title: "記録を休止しています（送信は記録されません）" };
    case "playing":
      return { label: "▶ 再生中", cls: "play", title: "マクロを再生しています" };
    case "playPaused":
      return { label: "⏸ 再生休止", cls: "pause", title: m.message ?? "再生を休止しています" };
    default:
      return undefined;
  }
});

/** 直前の再生が異常終了していたら理由を出す（次の操作・再生で消える） */
const MACRO_STOP_LABEL: Record<string, string> = {
  mismatch: "画面が一致しません",
  timeout: "ホストの応答がありません",
  disconnected: "切断されました",
  readonly: "閲覧のみのため再生できません",
  secret: "保存した秘密を取り出せません"
};
const macroStop = computed<string | undefined>(() => {
  const m = props.state.macro;
  if (!m || m.mode !== "idle" || !m.stopReason) return undefined;
  const label = MACRO_STOP_LABEL[m.stopReason];
  if (!label) return undefined; // completed / user は正常終了なので出さない
  return m.message ?? label;
});
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
    <!-- マクロの状態（ACS のシアンバー相当。spec D10）。幅は固定して隣をずらさない -->
    <span v-if="macro" class="macro" :class="macro.cls" :title="macro.title" role="status">
      {{ macro.label }}
    </span>
    <span v-else-if="macroStop" class="macro stopped" role="status">⏹ マクロ: {{ macroStop }}</span>
    <span class="mode">{{ insertMode ? "挿入" : "上書き" }}</span>
    <span v-if="notice" class="msg notice" role="status">{{ notice }}</span>
    <!-- クライアント側メッセージはホストのメッセージを**隠す**（ACS 準拠）。
         systemMessage はスナップショットが保持し続けるため、notice が消えれば自然に戻る。
         復帰のために状態を持つ必要は無い。 -->
    <span v-if="!notice && snap?.systemMessage" class="msg">{{ snap.systemMessage }}</span>
    <span class="fkeys">
      <button v-for="f in fkeys" :key="f.key" class="fk" @click="press(f.key)">{{ f.label }}</button>
      <!--
        Attn / SysReq はキー設定（⌨ キー）で任意のキーへ割り当てられるが、既定のバインドを持たない。
        設定を触らない利用者にも押せる導線として、他の AID と同じ .fk 意匠でここに並べる。
        SysReq だけは**押しても送らない**——画面下部のシステム要求行を開くのが実機・ACS の動きで、
        送信は行を確定したときなので、親（EmulatorPane）に投げて入口を 1 本にする。
      -->
      <button class="fk" title="アテンション（ホストの ATNPGM を呼ぶ）" @click="press('Attn')">
        Attn 割込
      </button>
      <button class="fk" title="システム要求行を開く" @click="emit('sysreq')">
        SysReq システム要求
      </button>
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
/* マクロ状態。記録＝赤・再生＝緑・休止＝黄で ACS のバーと同じ読み取り方にする。
   幅を固定するのは、記録→休止→再生で表記が変わっても隣の要素を動かさないため
   （UI-DESIGN「トグルボタンは状態切替で幅も高さも変わらないこと」）。 */
.macro {
  display: inline-flex;
  align-items: center;
  min-width: 6.5em;
  line-height: 1;
  font-weight: 600;
}
.macro.rec {
  color: var(--t-red, #e05252);
}
.macro.play {
  color: var(--t-green);
}
.macro.pause {
  color: var(--t-yellow, #d9a441);
}
/* 停止理由は原因の説明なので幅を固定しない（長さがまちまち。右端に流す） */
.macro.stopped {
  min-width: 0;
  font-weight: normal;
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
