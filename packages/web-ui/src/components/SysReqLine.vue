<script setup lang="ts">
/**
 * システム要求行（SysReq）。
 *
 * **ホストとの往復を伴わない端末側だけの機能**。ACS / 実機の 5250 は SysReq を押した時点で
 * 画面下部に 1 行の入力欄を出し、そこで確定して初めてホストへ SRQ レコードを送る
 * （tn5250j も同等の入力をローカルに取ってから 1 レコードで送る）。ここが「押した瞬間に
 * 送ってしまう」実装だと、オプションを選ぶ機会が無くなりメニュー要求しか出せなくなる。
 *
 * 桁数は制限しない——実機ではホスト側がオプションとして検証する（`DSPJOB` は
 * 「オプション D は正しくない」で弾かれる）ので、端末が先回りして切る根拠が無い。
 */
import { nextTick, ref, watch } from "vue";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "submit", text: string): void; (e: "cancel"): void }>();

const text = ref("");
const inputEl = ref<HTMLInputElement | null>(null);

// 開いたら入力欄へフォーカスする。閉じるときに値を捨てるのは、前回打った文字が
// 次にシステム要求を出したときに残っていると誤送信になるため。
watch(
  () => props.open,
  async (open) => {
    if (!open) {
      text.value = "";
      return;
    }
    await nextTick();
    inputEl.value?.focus();
  }
);

function submit(): void {
  emit("submit", text.value.trim());
}

/**
 * 開いている間はフォーカスを手放さない。
 *
 * **これが無いと端末が固まって見える**: `ScreenGrid` は新しい画面が来るたび `focusCursorField()` で
 * 入力欄へフォーカスを移すため、行を出している最中にホスト発の非同期プッシュ（メッセージ表示灯・
 * ブレークメッセージ・遅延応答）が来ると caret が行の外へ飛ぶ。一方 `EmulatorPane` は行が開いている間
 * 5250 のキー処理を止めるので、そのままではキーボードがどこにも効かなくなる。
 * 行を出したまま端末を止めるのは ACS 準拠だが、そのときフォーカスは必ず行の中に無ければならない。
 */
function onFocusOut(): void {
  if (!props.open) return;
  void nextTick(() => {
    if (props.open && document.activeElement !== inputEl.value) inputEl.value?.focus();
  });
}
</script>

<template>
  <div v-if="open" class="sysreq" role="group" aria-label="システム要求" @focusout="onFocusOut">
    <label class="lbl" for="sysreq-input">システム要求</label>
    <input
      id="sysreq-input"
      ref="inputEl"
      v-model="text"
      class="inp"
      type="text"
      autocomplete="off"
      spellcheck="false"
      @keydown.enter.prevent="submit"
      @keydown.esc.prevent="emit('cancel')"
    />
    <span class="hint">実行キーで送信 / Esc で取り消し</span>
  </div>
</template>

<style scoped>
/*
 * 画面（CRT 面）の**中**の最下部に重ねる。StatusBar の外に置くと 5250 の画面の一部に
 * 見えず、実機・ACS の見え方から外れる。position:absolute はレイアウトを押し出さないため
 * （行の出し入れで画面が上下に動くと、背面の桁位置を見失う）。
 */
.sysreq {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: var(--crt-bezel);
  border-top: 1px solid var(--crt-line);
  font-family: var(--mono);
  font-size: 12px;
  color: var(--t-green);
}
.lbl {
  white-space: nowrap;
}
.inp {
  flex: 1;
  min-width: 0;
  background: var(--crt);
  border: 1px solid var(--crt-line);
  border-radius: 3px;
  padding: 2px 6px;
  font: inherit;
  color: var(--t-green);
  caret-color: var(--t-green);
}
.inp:focus {
  outline: none;
  border-color: var(--t-green);
}
.hint {
  white-space: nowrap;
  color: var(--muted);
  font-size: 11px;
}
</style>
