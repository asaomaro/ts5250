<script setup lang="ts">
/**
 * **VT（文字モード端末）のペイン。**
 *
 * `EmulatorPane` / `ScreenGrid` とは**別物として作ってある**。あちらは 5250 のフィールド編集を
 * native caret を単一の真実として組んであり、4,000 行かけて「欄の中を動く」ことを実現している。
 * VT には欄が無い——**1 打鍵ごとに送り、ホストのエコーで画面が変わる**。混ぜると両方壊れる。
 *
 * ## この画面が背負っていること
 *
 * - **桁は文字の並びで決まる**（`ScreenGrid` のような絶対配置はしない）。VT は行が流れるので、
 *   履歴と画面を 1 本の流れとして並べる方が自然に読める
 * - **大きさはペインを測って決める**。VT は 24x80 固定ではなく、ペインの寸法がそのまま
 *   `stty size` になる（`NAWS`）
 * - **代替画面のときは履歴を出さない**。`vi` の背後に履歴が見えるのはおかしい
 * - **打鍵は意味のまま送る**。バイト列への符号化はサーバーがモードを見て行う（spec D4）
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { sessionsStore } from "../stores/sessions.js";
import { vtStore, type VtRunView } from "../stores/vt.js";
import type { WsVtInput, WsVtStyle } from "@ts5250/server";

const props = defineProps<{ sessionId: string; focused?: boolean }>();
const emit = defineEmits<{ focus: [] }>();

const view = computed(() => vtStore.get(props.sessionId));
const session = computed(() => sessionsStore.get(props.sessionId));

const root = ref<HTMLElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
/** 桁・行を測るための見本。**画面と同じフォントで描く**必要があるので DOM に置く */
const probe = ref<HTMLElement | null>(null);

/** 画面に出す行（履歴 ＋ 現在の画面）。代替画面では履歴を混ぜない */
const rows = computed<{ key: string; runs: VtRunView[]; screenRow: number | undefined }[]>(() => {
  const v = view.value;
  if (v === undefined) return [];
  const out: { key: string; runs: VtRunView[]; screenRow: number | undefined }[] = [];
  if (!v.alternate) {
    // 履歴は**上限を切って出す**。1,000 行を毎回 DOM に起こすと重い
    const from = Math.max(0, v.scrollback.length - VISIBLE_SCROLLBACK);
    for (let i = from; i < v.scrollback.length; i++) {
      out.push({ key: `h${i}`, runs: v.scrollback[i] ?? [], screenRow: undefined });
    }
  }
  for (let r = 0; r < v.lines.length; r++) {
    out.push({ key: `s${r}`, runs: v.lines[r] ?? [], screenRow: r });
  }
  return out;
});

/** DOM に起こす履歴の上限。これ以上遡りたい要求が出たら仮想スクロールにする */
const VISIBLE_SCROLLBACK = 2000;

// ---- 見た目 ----

/**
 * `indexed` の色。**0-15 は CSS 変数**（テーマに追随させる）、16-255 は xterm の標準の並びを
 * **計算で出す**（表を持たない——6x6x6 の色立方体 216 色 ＋ 24 段階のグレー）。
 */
function indexedColor(i: number): string {
  if (i < 16) return `var(--vt-c${i})`;
  if (i < 232) {
    const n = i - 16;
    const step = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${step(Math.floor(n / 36))},${step(Math.floor(n / 6) % 6)},${step(n % 6)})`;
  }
  const g = 8 + (i - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

function colorOf(c: NonNullable<WsVtStyle["fg"]>): string {
  if (c.kind === "indexed") return indexedColor(c.index);
  if (c.kind === "rgb") return `rgb(${c.r},${c.g},${c.b})`;
  return "";
}

/**
 * run の見た目を CSS へ。
 *
 * **`reverse` は色を入れ替えて解決する**（CSS の `filter: invert` に頼らない）——
 * 前景・背景のどちらかが既定のときに、地の色と文字色を正しく入れ替えるため。
 */
function runStyle(s: WsVtStyle | undefined): Record<string, string> {
  if (s === undefined) return {};
  const out: Record<string, string> = {};
  let fg = s.fg !== undefined ? colorOf(s.fg) : "";
  let bg = s.bg !== undefined ? colorOf(s.bg) : "";
  if (s.reverse === true) {
    const f = fg === "" ? "var(--vt-fg)" : fg;
    const b = bg === "" ? "var(--vt-bg)" : bg;
    fg = b;
    bg = f;
  }
  if (fg !== "") out.color = fg;
  if (bg !== "") out.background = bg;
  if (s.bold === true) out.fontWeight = "bold";
  if (s.dim === true) out.opacity = "0.65";
  if (s.italic === true) out.fontStyle = "italic";
  const lines: string[] = [];
  if (s.underline === true) lines.push("underline");
  if (s.strike === true) lines.push("line-through");
  if (lines.length > 0) out.textDecoration = lines.join(" ");
  if (s.hidden === true) out.visibility = "hidden";
  if (s.blink === true) out.animation = "vt-blink 1s step-end infinite";
  return out;
}

/** run の桁位置を字下げで表す（`ch` 単位＝等幅 1 文字ぶん） */
function runIndent(runs: readonly VtRunView[], i: number): Record<string, string> {
  const prev = runs[i - 1];
  const cur = runs[i];
  if (cur === undefined) return {};
  const from = prev === undefined ? 0 : prev.col + textCols(prev.text);
  const gap = cur.col - from;
  return gap > 0 ? { paddingLeft: `${gap}ch` } : {};
}

/** 文字列が占める桁数（全角は 2 桁）。`stores/vt.ts` と同じ規則 */
function textCols(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    n +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1;
  }
  return n;
}

/** カーソルの箱の位置（履歴のぶんだけ下へずらす） */
const cursorStyle = computed<Record<string, string>>(() => {
  const v = view.value;
  if (v === undefined || !v.cursor.visible) return { display: "none" };
  const above = v.alternate ? 0 : Math.min(v.scrollback.length, VISIBLE_SCROLLBACK);
  return {
    left: `${v.cursor.col}ch`,
    top: `calc(${above + v.cursor.row} * var(--vt-line-h))`
  };
});

// ---- 打鍵 ----

/**
 * ブラウザのキーイベント → サーバーへ送る意味。
 *
 * **`preventDefault` を惜しまない。** `Tab` も `Ctrl+A` も端末へ渡すのが正しく、
 * ブラウザに食われると端末として使えない。
 * ただし **`Ctrl+Shift+C` / `Ctrl+Shift+V` は通す**——コピーと貼り付けの逃げ道が要る。
 */
const NAMED: Readonly<Record<string, string>> = {
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Escape: "Escape",
  Delete: "Delete",
  Insert: "Insert",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12"
};

/** IME で変換中か。**変換中の `keydown` は送らない**（確定前の文字が流れてしまう） */
const composing = ref(false);

function send(msg: Omit<WsVtInput, "type">): void {
  const s = session.value;
  if (!s?.connected || s.readOnly) return;
  s.client.send({ type: "vt-input", ...msg } as WsVtInput);
}

function onKeydown(e: KeyboardEvent): void {
  if (composing.value) return;
  // コピー・貼り付けの逃げ道はブラウザに任せる
  if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "V" || e.key === "c" || e.key === "v")) return;

  const named = NAMED[e.key];
  if (named !== undefined) {
    e.preventDefault();
    send({ key: named, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
    followTail();
    return;
  }
  if (e.key.length === 1) {
    // **`Ctrl` / `Alt` つきはここで拾う**（`keypress` は来ない）
    if (e.ctrlKey || e.altKey) {
      e.preventDefault();
      send({ text: e.key, ctrl: e.ctrlKey, alt: e.altKey });
      followTail();
      return;
    }
    e.preventDefault();
    send({ text: e.key });
    followTail();
  }
}

/** IME の確定。**まとめて 1 通で送る**（1 文字ずつだと変換結果が崩れる） */
function onCompositionEnd(e: CompositionEvent): void {
  composing.value = false;
  if (e.data !== "") {
    send({ text: e.data });
    followTail();
  }
}

function onPaste(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData("text");
  e.preventDefault();
  if (text !== undefined && text !== "") {
    send({ paste: text });
    followTail();
  }
}

// ---- 大きさ ----

/**
 * **ペインを測って桁・行を出す。**
 *
 * 見本（`0` を 100 個）の実寸から 1 桁の幅を得る。`ch` は「`0` の送り幅」なので、
 * これがそのまま `ch` の実寸になる。行の高さは見本の高さ。
 *
 * **変更は落ち着いてから送る**——ドラッグ中に何十回も `NAWS` を投げない。
 */
const MIN_COLS = 20;
const MIN_ROWS = 5;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let observer: ResizeObserver | undefined;

function measure(): { rows: number; cols: number } | undefined {
  const box = scroller.value;
  const p = probe.value;
  if (box === null || p === null) return undefined;
  const cellW = p.getBoundingClientRect().width / 100;
  const lineH = p.getBoundingClientRect().height;
  if (cellW <= 0 || lineH <= 0) return undefined;
  const cols = Math.max(MIN_COLS, Math.floor(box.clientWidth / cellW));
  const rowsN = Math.max(MIN_ROWS, Math.floor(box.clientHeight / lineH));
  return { rows: rowsN, cols };
}

function scheduleResize(): void {
  if (resizeTimer !== undefined) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = undefined;
    const m = measure();
    const v = view.value;
    const s = session.value;
    if (m === undefined || v === undefined || s === undefined) return;
    if (m.rows === v.rows && m.cols === v.cols) return;
    s.client.send({ type: "vt-resize", rows: m.rows, cols: m.cols });
  }, 150);
}

// ---- スクロール ----

/** 打鍵したら最下部へ戻す（遡っている最中にホストが喋っても勝手に飛ばさない） */
function followTail(): void {
  vtStore.setFollowTail(props.sessionId, true);
  void nextTick(() => scrollToBottom());
}

function scrollToBottom(): void {
  const box = scroller.value;
  if (box !== null) box.scrollTop = box.scrollHeight;
}

function onScroll(): void {
  const box = scroller.value;
  if (box === null) return;
  // 下端から 4px 以内なら「追いかけている」とみなす
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 4;
  vtStore.setFollowTail(props.sessionId, atBottom);
}

watch(
  () => view.value?.lines,
  () => {
    if (view.value?.followTail !== false) void nextTick(() => scrollToBottom());
  },
  { deep: true }
);

watch(
  () => props.focused,
  (on) => {
    if (on === true) root.value?.focus();
  }
);

onMounted(() => {
  root.value?.focus();
  scheduleResize();
  if (scroller.value !== null && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => scheduleResize());
    observer.observe(scroller.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (resizeTimer !== undefined) clearTimeout(resizeTimer);
});
</script>

<template>
  <div
    ref="root"
    class="vt-pane"
    tabindex="0"
    @focus="emit('focus')"
    @mousedown="emit('focus')"
    @keydown="onKeydown"
    @compositionstart="composing = true"
    @compositionend="onCompositionEnd"
    @paste="onPaste"
  >
    <div ref="scroller" class="vt-scroll" @scroll="onScroll">
      <!-- 桁と行の実寸を測る見本。**画面と同じフォントで描く**必要があるので DOM に置く -->
      <div ref="probe" class="vt-probe" aria-hidden="true">00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000</div>
      <div class="vt-body">
        <div v-for="row in rows" :key="row.key" class="vt-line">
          <span
            v-for="(run, i) in row.runs"
            :key="i"
            :style="{ ...runIndent(row.runs, i), ...runStyle(run.style) }"
            >{{ run.text }}</span
          >
        </div>
        <div class="vt-cursor" :class="{ off: focused !== true }" :style="cursorStyle"></div>
      </div>
    </div>
    <div v-if="view && !view.connected" class="vt-closed">
      切断されました{{ view.closeReason ? "——" + view.closeReason : "" }}
    </div>
    <div v-else-if="view && !view.hostEchoes" class="vt-note">
      ホストがエコーを返していません（打った文字は画面に出ません）
    </div>
  </div>
</template>

<style scoped>
/*
 * **色は CSS 変数で 16 色を定義する。** `indexed 0-15` はここを引くのでテーマに追随し、
 * 16-255 は計算で出す（表を持たない）。
 */
.vt-pane {
  --vt-bg: var(--crt-bg, #0b0f0b);
  --vt-fg: var(--crt-fg, #d6f5d6);
  --vt-c0: #2e3436;
  --vt-c1: #cc0000;
  --vt-c2: #4e9a06;
  --vt-c3: #c4a000;
  --vt-c4: #3465a4;
  --vt-c5: #75507b;
  --vt-c6: #06989a;
  --vt-c7: #d3d7cf;
  --vt-c8: #555753;
  --vt-c9: #ef2929;
  --vt-c10: #8ae234;
  --vt-c11: #fce94f;
  --vt-c12: #729fcf;
  --vt-c13: #ad7fa8;
  --vt-c14: #34e2e2;
  --vt-c15: #eeeeec;
  --vt-line-h: 1.25em;

  position: relative;
  height: 100%;
  width: 100%;
  background: var(--vt-bg);
  color: var(--vt-fg);
  outline: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.vt-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 4px 6px;
}

.vt-body {
  position: relative;
  font-family: var(--screen-font, "DejaVu Sans Mono", "MS Gothic", monospace);
  font-size: 0.9rem;
  line-height: var(--vt-line-h);
  /* **選択はブラウザ既定に任せる**（自前の矩形選択は作らない） */
  user-select: text;
  white-space: pre;
}

.vt-line {
  height: var(--vt-line-h);
  white-space: pre;
}

/* 見本は測るためだけのもの。**位置を占めない**が、フォントは本文と同じでなければならない */
.vt-probe {
  position: absolute;
  visibility: hidden;
  pointer-events: none;
  white-space: pre;
  font-family: var(--screen-font, "DejaVu Sans Mono", "MS Gothic", monospace);
  font-size: 0.9rem;
  line-height: var(--vt-line-h);
}

.vt-cursor {
  position: absolute;
  width: 1ch;
  height: var(--vt-line-h);
  background: var(--vt-fg);
  opacity: 0.65;
  pointer-events: none;
}
.vt-cursor.off {
  background: transparent;
  outline: 1px solid var(--vt-fg);
  opacity: 0.5;
}

.vt-note,
.vt-closed {
  flex: 0 0 auto;
  padding: 2px 8px;
  font-size: 0.75rem;
  background: var(--surface-2, #222);
  color: var(--text-muted, #aaa);
}
.vt-closed {
  color: var(--danger, #e66);
}

@keyframes vt-blink {
  50% {
    opacity: 0;
  }
}
</style>
