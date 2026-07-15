<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AidKey } from "@as400web/core";
import ScreenGrid from "./ScreenGrid.vue";
import StatusBar from "./StatusBar.vue";
import { sessionsStore } from "../stores/sessions.js";
import { workspaceStore } from "../stores/workspace.js";
import { makeKeydownHandler, type LocalAction } from "../composables/useKeymap.js";
import { sendKey, selectGuiChoice, submitGuiSelection } from "../session-controller.js";

const props = defineProps<{ sessionId: string; focused: boolean }>();
const emit = defineEmits<{ (e: "focus"): void }>();

const paneEl = ref<HTMLElement | null>(null);

const state = computed(() => sessionsStore.get(props.sessionId));
const snapshot = computed(() => state.value?.snapshot);
// 通信中（ホスト応答待ち）は入力プロテクト。loading は 0.5 秒超でスピナー表示
const busy = computed(() => state.value?.busy ?? false);
const loading = computed(() => state.value?.loading ?? false);
const insertMode = ref(false);
// ユーザーがクリック/フォーカスでカーソルを動かしたときの上書き（未操作ならホスト snapshot.cursor を使う）
const cursorOverride = ref<{ row: number; col: number } | undefined>();
const cursor = computed(() => cursorOverride.value ?? snapshot.value?.cursor ?? { row: 1, col: 1 });

function onEdit(fieldIndex: number, value: string): void {
  state.value?.edits.set(fieldIndex, value);
}
function onCursor(row: number, col: number): void {
  cursorOverride.value = { row, col };
}
function onGuiSelect(fieldId: number, choiceIndex: number, selected: boolean): void {
  selectGuiChoice(props.sessionId, fieldId, choiceIndex, selected);
}
function onGuiSubmit(fieldId: number): void {
  submitGuiSelection(props.sessionId, fieldId, cursor.value);
}
// 新しいホスト画面が来たらユーザーのカーソル上書きをリセットする
watch(snapshot, () => (cursorOverride.value = undefined));

// 【カーソル／編集モデルの協調（ScreenGrid との役割分担）】
//   EmulatorPane はフィールド「間」の移動（Tab/矢印/Home/End）だけを担う。対象 <input> を focus() し、
//   setSelectionRange で桁（native caret）を指定するところまでが責務。文字編集そのもの（上書き/挿入/
//   バックスペース・欄内桁の追従）は ScreenGrid の edit モデルが担い、ScreenGrid が onInputKeydown で
//   native caret に追従する。つまり両者を繋ぐ単一の真実は「native input の caret」で、ここでは caret を
//   動かすだけに徹する（ScreenGrid の内部状態には触れない）。上下移動は桁を保って真下のフィールドへ。
//
/** ペイン内の編集可能な入力欄（画面順＝DOM 順）。保護フィールドは readonly なので除外 */
function editableInputs(): HTMLInputElement[] {
  if (!paneEl.value) return [];
  return Array.from(paneEl.value.querySelectorAll<HTMLInputElement>("input.grid-input:not([readonly])"));
}

/** editableInputs と同順の非保護フィールド（行情報つき。上下移動の行判定に使う） */
function editableFields() {
  return (snapshot.value?.fields ?? []).filter((f) => !f.protected);
}

function focusInput(inputs: HTMLInputElement[], i: number): void {
  const el = inputs[i];
  if (!el) return;
  el.focus();
  el.setSelectionRange(0, 0);
}

/** 順次移動（Tab / Shift+Tab / 欄外での左右）。末尾↔先頭でラップ */
function focusByOffset(delta: number): void {
  const inputs = editableInputs();
  if (inputs.length === 0) return;
  const cur = inputs.indexOf(document.activeElement as HTMLInputElement);
  const start = cur === -1 ? (delta > 0 ? -1 : 0) : cur;
  focusInput(inputs, (start + delta + inputs.length) % inputs.length);
}

/**
 * 行方向移動（↑↓）。現在の桁を保ったまま、真下/真上の最も近い行で
 * その桁を含む（無ければ最も近い）フィールドへ移動し、カーソルを同じ桁に置く。
 * これで SEU の EVAL 下→MOVEL のように「次項目の先頭」ではなく真下へ移動する。
 */
function focusByRow(dir: number): void {
  const inputs = editableInputs();
  const fields = editableFields();
  if (inputs.length === 0) return;
  const cur = inputs.indexOf(document.activeElement as HTMLInputElement);
  const curField = cur >= 0 ? fields[cur] : undefined;
  const caret = cur >= 0 ? (inputs[cur]!.selectionStart ?? 0) : 0;
  // 現在の画面桁（1 始まり）。フォーカスが無ければホストカーソル桁
  const curCol = curField ? curField.col + caret : cursor.value.col;
  const curRow = curField ? curField.row : dir > 0 ? -Infinity : Infinity;

  // dir 方向で最も近い行を決める（無ければ端でラップ）
  let targetRow: number | undefined;
  for (const f of fields) {
    if ((f.row - curRow) * dir > 0) {
      if (targetRow === undefined || Math.abs(f.row - curRow) < Math.abs(targetRow - curRow)) targetRow = f.row;
    }
  }
  if (targetRow === undefined) {
    targetRow = fields.reduce(
      (acc, f) => (dir > 0 ? Math.min(acc, f.row) : Math.max(acc, f.row)),
      dir > 0 ? Infinity : -Infinity
    );
  }

  // targetRow の中で curCol を含む、無ければ最も桁が近いフィールド
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.row !== targetRow) continue;
    const inside = curCol >= f.col && curCol < f.col + f.length;
    const score = inside ? 0 : Math.min(Math.abs(f.col - curCol), Math.abs(f.col + f.length - 1 - curCol));
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return;

  const el = inputs[best]!;
  el.focus();
  const target = fields[best]!;
  const newCaret = Math.max(0, Math.min(curCol - target.col, target.length));
  el.setSelectionRange(newCaret, newCaret); // 桁を保持（onInputKeydown が edit カーソルを追従）
}

function onLocal(action: LocalAction): void {
  const inputs = editableInputs();
  switch (action) {
    case "tab":
    case "right":
      focusByOffset(1);
      break;
    case "shift-tab":
    case "left":
      focusByOffset(-1);
      break;
    case "down":
      focusByRow(1);
      break;
    case "up":
      focusByRow(-1);
      break;
    case "home":
      focusInput(inputs, 0);
      break;
    case "end":
      focusInput(inputs, inputs.length - 1);
      break;
  }
}

const rawKeydown = makeKeydownHandler({
  sendAid: (key: AidKey) => sendKey(props.sessionId, key, cursor.value),
  local: onLocal,
  isFocused: () => props.focused
});
function onKeydown(ev: KeyboardEvent): void {
  if (busy.value) {
    ev.preventDefault(); // 通信中は入力プロテクト（キー操作を無効化）
    return;
  }
  rawKeydown(ev);
}

// ACS 同様、マウスホイールで PageUp/PageDown を送る。連続発火はクールダウンで 1 ページ/ジェスチャに抑制
let wheelCooldownUntil = 0;
function onWheel(ev: WheelEvent): void {
  if (Math.abs(ev.deltaY) < 4) return; // 微小ジッタは無視
  ev.preventDefault(); // 端末はスクロールせずページ送りに割り当てる（ACS 準拠）
  if (busy.value || snapshot.value?.keyboardLocked) return; // 通信中・ロック中は送らない
  const now = Date.now();
  if (now < wheelCooldownUntil) return;
  wheelCooldownUntil = now + 120;
  emit("focus");
  sendKey(props.sessionId, ev.deltaY > 0 ? "PageDown" : "PageUp", cursor.value);
}
</script>

<template>
  <div
    ref="paneEl"
    class="pane"
    :data-focused="focused"
    tabindex="0"
    @keydown="onKeydown"
    @mousedown="emit('focus')"
    @wheel="onWheel"
  >
    <div class="screen-wrap">
      <ScreenGrid
        v-if="snapshot"
        v-model:insert-mode="insertMode"
        :snapshot="snapshot"
        :edits="state!.edits"
        :focused="focused"
        :busy="busy"
        :show-shift-marks="workspaceStore.showShiftMarks"
        :katakana-view="workspaceStore.katakanaView"
        :linkify="workspaceStore.linkify"
        @edit="onEdit"
        @cursor="onCursor"
        @gui-select="onGuiSelect"
        @gui-submit="onGuiSubmit"
      />
      <div v-else class="pane-empty">接続待ち…</div>
      <!-- 通信中プロテクト（0.5 秒超で loading クラス＝スピナー表示） -->
      <div v-if="busy" class="busy-overlay" :class="{ loading }" aria-busy="true">
        <div v-if="loading" class="spinner" role="status" aria-label="通信中"></div>
      </div>
    </div>
    <StatusBar v-if="state" :state="state" :insert-mode="insertMode" />
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  border: 1px solid var(--crt-line);
  border-radius: 6px;
  overflow: hidden;
  background: var(--crt);
}
.pane[data-focused="true"] {
  border-color: var(--t-green);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--t-green) 35%, transparent);
}
.pane:focus {
  outline: none;
}
.pane-empty {
  color: var(--muted);
  padding: 20px;
  font-family: var(--mono);
}
/* ScreenGrid とオーバーレイを重ねるためのラッパ（grid の flex:1 を維持） */
.screen-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
/* 通信中プロテクト: ポインタ操作をブロック。0.5 秒までは透明、loading で薄く覆う */
.busy-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  cursor: progress;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  transition: background 0.2s ease;
}
.busy-overlay.loading {
  background: color-mix(in srgb, var(--crt) 55%, transparent);
}
.spinner {
  width: 34px;
  height: 34px;
  border: 3px solid color-mix(in srgb, var(--t-green) 30%, transparent);
  border-top-color: var(--t-green);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2s;
  }
}
</style>
