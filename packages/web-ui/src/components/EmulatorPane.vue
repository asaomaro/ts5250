<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { AidKey } from "@as400web/core";
import ScreenGrid from "./ScreenGrid.vue";
import StatusBar from "./StatusBar.vue";
import { sessionsStore } from "../stores/sessions.js";
import { workspaceStore } from "../stores/workspace.js";
import { makeKeydownHandler, type LocalAction } from "../composables/useKeymap.js";
import { moveCursor, fieldAt, caretInField, roundToDbcsLead, type Dir } from "../composables/useCursor.js";
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
  reconcileFocus({ row, col });
}

/**
 * 有効カーソル位置に応じて表現モードを調停する（field ⇄ free）。
 * - 編集可能フィールド上 → 該当 <input> に focus し native キャレットを桁に合わせる（field モード）。
 * - 非入力/保護セル上 → 入力欄を blur し、キーボード捕捉のためペインへ focus（free モード。オーバーレイ表示）。
 * クリック（ScreenGrid）と矢印セル移動（onLocal）の両経路がここを通り、単一の調停点にする。
 */
function reconcileFocus(pos: { row: number; col: number }): void {
  const snap = snapshot.value;
  if (!snap) return;
  const f = fieldAt(pos.row, pos.col, snap.fields);
  const active = document.activeElement;
  if (f && !f.protected) {
    const el = editableInputs()[editableFields().indexOf(f)];
    if (el) {
      const caret = caretInField(f, pos.col);
      if (active !== el) el.focus();
      el.setSelectionRange(caret, caret);
      // el.focus() が onInputFocus を発火し emit("cursor", 欄先頭) で override を巻き戻すため、
      // 目的桁を再確定する（論理カーソルと native キャレットの不一致を防ぐ。review R1-1）。
      cursorOverride.value = pos;
    }
  } else {
    if (active instanceof HTMLInputElement && paneEl.value?.contains(active)) active.blur();
    if (document.activeElement !== paneEl.value) paneEl.value?.focus();
  }
}

/** 矢印で有効カーソルを 1 セル移動し、着地セルでモード調停する（onCursor 経由） */
function moveCell(dir: Dir): void {
  const snap = snapshot.value;
  if (!snap) return;
  let next = moveCursor(cursor.value, dir, snap.rows, snap.cols);
  // DBCS（全角 2 桁）の桁間には止めない。右移動は tail を飛び越え、左/上/下・位置確定は lead へ丸める
  // （一律丸めだと lead で右が tail→lead に戻され進めない。review R1-2）。
  if (snap.cells[next.row - 1]?.[next.col - 1]?.kind === "dbcs-tail") {
    next = dir === "right" ? moveCursor(next, "right", snap.rows, snap.cols) : roundToDbcsLead(next, snap.cells);
  }
  onCursor(next.row, next.col);
}
// ACS の自動送り: 欄が満杯になったら次の入力欄へフォーカスを進める。
// 満杯時は欄外へ論理カーソルが出て input が blur 済み（activeElement がペイン）なので、
// focusByOffset ではなく満杯欄の index から次欄を特定する。
function onFieldFull(fieldIndex: number): void {
  const flds = editableFields();
  const els = editableInputs();
  const cur = flds.findIndex((f) => f.index === fieldIndex);
  if (cur < 0 || els.length === 0) return;
  focusInput(els, (cur + 1) % els.length);
}
function onGuiSelect(fieldId: number, choiceIndex: number, selected: boolean): void {
  selectGuiChoice(props.sessionId, fieldId, choiceIndex, selected);
}
function onGuiSubmit(fieldId: number): void {
  submitGuiSelection(props.sessionId, fieldId, cursor.value);
}
// 新しいホスト画面が来たらユーザーのカーソル上書きをリセットする
watch(snapshot, (snap) => {
  cursorOverride.value = undefined;
  // 入力欄が 1 つも無い画面では ScreenGrid の欄フォーカス（focusCursorField）が早期 return し、
  // どこも focus されずキー操作できない（見た目はカーソルが出る）。ペインを focus して
  // 自由カーソル・F キーを有効にする（クリックで reconcileFocus がペインを focus するのと同じ状態）。
  if (props.focused && snap && !snap.keyboardLocked && !snap.fields.some((f) => !f.protected)) {
    nextTick(() => paneEl.value?.focus());
  }
});

// 【カーソル／編集モデルの協調（ScreenGrid との役割分担）】
//   有効カーソル `cursor`（override ?? snapshot.cursor）を論理カーソルの単一の真実とし、AID 送信と
//   ScreenGrid（オーバーレイ）へ供給する。矢印は画面全体を 1 セルずつ自由移動し（moveCell）、着地セルが
//   編集可能フィールドなら該当 <input> に focus＋キャレット（field モード）、非入力/保護なら input を blur し
//   ペインに focus してオーバーレイ表示（free モード）。この調停は reconcileFocus に集約する。
//   Tab はフィールド「間」ジャンプ（focusByOffset）で従来どおり。文字編集そのもの（上書き/挿入/バックスペース・
//   欄内桁の追従）は ScreenGrid の edit モデルが担い、欄内で動かせる Left/Right は ScreenGrid が処理して
//   ここへは伝播しない（端・上下・非入力セルだけがセル移動として届く）。両者を繋ぐのは native input の caret。
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

function onLocal(action: LocalAction): void {
  const inputs = editableInputs();
  switch (action) {
    // Tab はフィールド「間」ジャンプ（従来どおり）。矢印は画面全体を 1 セルずつ自由移動。
    case "tab":
      focusByOffset(1);
      break;
    case "shift-tab":
      focusByOffset(-1);
      break;
    case "left":
    case "right":
    case "up":
    case "down":
      // 欄内でキャレットが動かせる Left/Right は ScreenGrid が処理して伝播しない。
      // ここに来るのは欄の端／非入力セル／上下。いずれも 1 セル移動＋モード調停。
      moveCell(action);
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
        :cursor="cursor"
        :show-shift-marks="workspaceStore.showShiftMarks"
        :katakana-view="workspaceStore.katakanaView"
        :linkify="workspaceStore.linkify"
        @edit="onEdit"
        @cursor="onCursor"
        @field-full="onFieldFull"
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
  /* グリッドをコンテンツサイズに縮めたうえで中央寄せ（余白を上下・左右均等に） */
  align-items: center;
  justify-content: center;
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
