<script setup lang="ts">
/**
 * **`EDTMSK` で分割された日付欄・時刻欄に出す選択部品。**
 *
 * 判定（この欄が日付か時刻か）は `composables/dateTimeField.ts` が持つ。ここは**選ばせるだけ**で、
 * 欄への書き込みは親（`ScreenGrid`）が既存の貼り付け経路（`pasteFrom`）で行う。
 *
 * 【`both`（日付 / 時刻のタブ）がある理由 — decisions D3】
 * 区切り文字は**欄に値があるときしか画面に届かない**（空の時刻欄は `:` が 1 桁も刷られない。実機実測）。
 * そのため `2,2,2` / `2,2` は日付とも時刻とも決まらないことがある。**そこで日付と決め打つと
 * 空の時刻欄に日付ピッカーが出て嘘をつく**ので、両方のタブを出して利用者に選ばせる。
 *
 * 【矩形選択・コピー＆ペーストを妨げない — `optHints` と同じ 3 点】
 * 1. `mousedown` を `.stop` でグリッドへ伝播させない（伝播すると矩形選択が消える）
 * 2. `mousedown` を `.prevent` して既定のフォーカス移動を止める（入力欄にフォーカスを残す）
 * 3. **グリッドにキーイベントを足さない**——このコンポーネント**自身**の `keydown` だけを購読する
 *    （`optHints` のリストと同じ作法）
 *
 * 桁順（どの区間が年 / 月 / 日か）は固定なので、**解釈中の書式を見出しに必ず出す**
 * （違えば利用者は直接打鍵に切り替えられる）。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { cycleTab } from "../composables/focusTrap.js";
import {
  daysInMonth,
  formatLabel,
  parseDate,
  parseTime,
  type DateTimeTarget,
  type DateValue,
  type TimeValue
} from "../composables/dateTimeField.js";
import {
  MSG_DATE_PICKER,
  MSG_DTP_FORMAT,
  MSG_DTP_NEXT_MONTH,
  MSG_DTP_NOW,
  MSG_DTP_PREV_MONTH,
  MSG_DTP_TAB_DATE,
  MSG_DTP_TAB_TIME,
  MSG_DTP_TODAY,
  MSG_TIME_PICKER
} from "../composables/opMessages.js";

const props = defineProps<{
  target: DateTimeTarget;
  /**
   * 開いた時点の区間の**実効値**（未送信のローカル編集込み・`target.run` と 1:1）。
   * 初期選択にだけ使う。ホストが送った `Field.value` では「打った日付ではなく今日」で開く。
   */
  values: readonly string[];
  /** 画面設定の意匠（`panel` / `outline` / `crt`）。`none` のときは親がそもそも描かない */
  pop: string;
}>();
const emit = defineEmits<{
  (e: "pick-date", v: DateValue): void;
  (e: "pick-time", v: TimeValue): void;
  (e: "close"): void;
}>();

/** 表示中のタブ。`both` のときだけ切り替えられる */
const tab = ref<"date" | "time">(props.target.kind === "time" ? "time" : "date");
watch(
  () => props.target,
  (t) => { tab.value = t.kind === "time" ? "time" : "date"; }
);
const showTabs = computed(() => props.target.kind === "both");
const label = computed(() => formatLabel(props.target, tab.value));

// ---- 日付 -----------------------------------------------------------------
// **初期選択は欄の現在値。読めなければ今日。どちらの場合も書き込まない**
// （利用者が選ぶまで欄は 1 桁も変わらない＝ホストが送った値を UI が上書きしない）。
const today = new Date();
const currentDate = parseDate(props.target, props.values);
const seedDate = currentDate ?? {
  year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate()
};
const year = ref(seedDate.year);
const month = ref(seedDate.month);
// 選択済みの印は**欄に実際の値があるときだけ**付ける（今日にフォールバックした分は選択扱いにしない）
const selDay = ref(currentDate?.day ?? null);

function shiftMonth(delta: number): void {
  const m = month.value + delta;
  if (m < 1) { month.value = 12; year.value -= 1; }
  else if (m > 12) { month.value = 1; year.value += 1; }
  else month.value = m;
}

/** 月の頭の空きマス数（日曜始まり）。`Date` の月は 0 始まり。 */
const leading = computed(() => new Date(year.value, month.value - 1, 1).getDay());
const days = computed(() => Array.from({ length: daysInMonth(year.value, month.value) }, (_, i) => i + 1));
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 今日の日（表示中の月に限る）。カレンダー上で「今日」が分かるようにする */
const todayDay = computed(() =>
  year.value === today.getFullYear() && month.value === today.getMonth() + 1 ? today.getDate() : null
);
/**
 * 開いた直後にフォーカスを置く日。**選択済み ＞ 今日 ＞ 1 日**。
 * 月送りをした後は「その月に選択済みの日」は無いので、今日か 1 日に落ちる。
 */
const focusDay = computed(() => selDay.value ?? todayDay.value ?? 1);

function chooseDay(d: number): void {
  selDay.value = d;
  emit("pick-date", { year: year.value, month: month.value, day: d });
}
function chooseToday(): void {
  const n = new Date();
  year.value = n.getFullYear();
  month.value = n.getMonth() + 1;
  chooseDay(n.getDate());
}

// ---- 時刻 -----------------------------------------------------------------
/** 秒の列を出すのは 3 区間の欄だけ（`HH:MM` の欄に秒は無い） */
const hasSecond = computed(() => (props.target.shape.timeParts?.length ?? 0) >= 3);
const seedTime = parseTime(props.target, props.values) ?? { hour: today.getHours(), minute: today.getMinutes(), second: 0 };
const hour = ref(seedTime.hour);
const minute = ref(seedTime.minute);
const second = ref(seedTime.second);
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const two = (n: number): string => String(n).padStart(2, "0");

/**
 * 時刻は**列を選ぶたびに下書き全体を書き込む**（開いたまま）。
 * 日付と違って 1 クリックでは値が定まらないので、確定ボタンを置くより
 * 「選ぶたびに欄が追従する」ほうが結果が見えて確かめやすい。
 */
function pickTime(part: "h" | "mi" | "s", v: number): void {
  if (part === "h") hour.value = v;
  else if (part === "mi") minute.value = v;
  else second.value = v;
  emit("pick-time", { hour: hour.value, minute: minute.value, second: second.value });
}
function chooseNow(): void {
  const n = new Date();
  hour.value = n.getHours();
  minute.value = n.getMinutes();
  second.value = hasSecond.value ? n.getSeconds() : 0;
  emit("pick-time", { hour: hour.value, minute: minute.value, second: second.value });
}

// ---------------------------------------------------------------------------
// キーボードだけで操作を完結させる（`optHints` のリストと同じ約束）。
//
// - 開いたら**フォーカスをピッカーへ移す**（`optHints` の `openOptAt` と同じ）。
//   移さないと、開いた直後の矢印・Enter が欄へ行ってしまい、マウスが要る。
// - 矢印で候補を移動し、`Enter` / `Space` で決定（`button` の既定動作）。
// - `Esc` で閉じて欄へ戻る。
//
// **購読するのはこのコンポーネント自身の `keydown` だけ**——グリッドには足さない
// （矩形選択・コピー＆ペーストを妨げないための約束）。
// ---------------------------------------------------------------------------

const rootEl = ref<HTMLElement | null>(null);

/**
 * **ロービング tabindex**（日のグリッド・時刻の列を「まとまりで 1 停止点」にする）。
 *
 * 全部を tabindex 0 にすると、`Tab` が 60 個の分を 1 つずつ辿ることになって使えない。
 * ARIA の複合ウィジェットの作法どおり、**現在の 1 つだけを 0 にして残りを -1** にし、
 * 中の移動は矢印に任せる。`focusin` で追うのでクリックでも矢印でも追従する。
 */
const activeDay = ref<number | null>(null);
const activeCell = ref<{ col: number; val: number } | null>(null);
function onFocusIn(ev: FocusEvent): void {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.day !== undefined) activeDay.value = Number(t.dataset.day);
  else if (t.dataset.col !== undefined) activeCell.value = { col: Number(t.dataset.col), val: Number(t.dataset.val) };
}
/** その日が「日のグリッドの停止点」か */
const rovingDay = computed(() => activeDay.value ?? focusDay.value);
/** その列の停止点になる値（フォーカス中の値 ＞ その列の現在値） */
function rovingVal(col: number): number {
  if (activeCell.value?.col === col) return activeCell.value.val;
  return col === 0 ? hour.value : col === 1 ? minute.value : second.value;
}

/** 開いた直後にフォーカスを置く要素（選択済み ＞ 今日/現在値 ＞ 先頭）。 */
function initialTarget(): HTMLElement | null {
  const r = rootEl.value;
  if (!r) return null;
  return (
    r.querySelector<HTMLElement>('[data-dtp-initial="true"]') ??
    r.querySelector<HTMLElement>(".dtp-day, .dtp-cell")
  );
}
async function focusInitial(): Promise<void> {
  await nextTick();
  initialTarget()?.focus();
}
onMounted(focusInitial);
// タブを切り替えたら、切り替え先の中身へフォーカスを移す（タブに残ると矢印が効かない）
watch(tab, () => void focusInitial());

/** 日を移動して、移った先にフォーカスを置く。月をまたぐときは月送りも行う。 */
async function moveDay(from: number, delta: number): Promise<void> {
  let target = from + delta;
  if (target < 1) {
    shiftMonth(-1);
    target += daysInMonth(year.value, month.value);
  } else if (target > daysInMonth(year.value, month.value)) {
    target -= daysInMonth(year.value, month.value);
    shiftMonth(1);
  }
  await nextTick();
  rootEl.value?.querySelector<HTMLElement>(`.dtp-day[data-day="${target}"]`)?.focus();
}

/** 時刻の列の中／列の間を移動する。列内は**巡回**する（23 時の下は 0 時）。 */
function moveCell(col: number, val: number, dCol: number, dVal: number): void {
  const cols = hasSecond.value ? 3 : 2;
  const nextCol = Math.min(Math.max(col + dCol, 0), cols - 1);
  const len = nextCol === 0 ? HOURS.length : MINUTES.length;
  const cur = nextCol === col ? val : nextCol === 0 ? hour.value : nextCol === 1 ? minute.value : second.value;
  const nextVal = ((cur + dVal) % len + len) % len;
  rootEl.value
    ?.querySelector<HTMLElement>(`.dtp-cell[data-col="${nextCol}"][data-val="${nextVal}"]`)
    ?.focus();
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    emit("close");
    return;
  }
  // **`Tab` はピッカーの中で巡回させる。** 抜けると開いたままのピッカーへキーだけでは
  // 戻れない（出口は `Esc` と選択）。オプション選択肢と同じ仕組みを共有する。
  if (rootEl.value && cycleTab(rootEl.value, ev)) return;
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  const arrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key);
  if (!arrow || ev.altKey || ev.ctrlKey || ev.metaKey) return;

  // タブの上では左右でタブを切り替える（切り替え後は中身へフォーカスが移る）
  if (t.classList.contains("dtp-tab") && showTabs.value) {
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      ev.preventDefault();
      tab.value = tab.value === "date" ? "time" : "date";
    }
    return;
  }
  if (t.classList.contains("dtp-day")) {
    const from = Number(t.dataset.day);
    if (!Number.isFinite(from)) return;
    ev.preventDefault();
    // 左右は 1 日、上下は 1 週（カレンダーの並びと同じ動き）
    const delta = ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : ev.key === "ArrowUp" ? -7 : 7;
    void moveDay(from, delta);
    return;
  }
  if (t.classList.contains("dtp-cell")) {
    const col = Number(t.dataset.col), val = Number(t.dataset.val);
    if (!Number.isFinite(col) || !Number.isFinite(val)) return;
    ev.preventDefault();
    if (ev.key === "ArrowLeft") moveCell(col, val, -1, 0);
    else if (ev.key === "ArrowRight") moveCell(col, val, 1, 0);
    else moveCell(col, val, 0, ev.key === "ArrowUp" ? -1 : 1);
  }
}
</script>

<template>
  <div
    ref="rootEl"
    class="dtp crt-pop"
    :data-pop="pop"
    role="dialog"
    :aria-label="tab === 'date' ? MSG_DATE_PICKER : MSG_TIME_PICKER"
    @mousedown.stop.prevent
    @keydown="onKeydown"
    @focusin="onFocusIn"
  >
    <!-- 見出し: 解釈中の書式を必ず出す。桁順を固定している以上、名乗る責任がある -->
    <div class="dtp-head">
      <div v-if="showTabs" class="dtp-tabs" role="tablist">
        <button
          type="button" class="dtp-tab" role="tab" :aria-selected="tab === 'date'"
          :tabindex="tab === 'date' ? 0 : -1"
          @mousedown.stop.prevent @click.stop="tab = 'date'"
        >{{ MSG_DTP_TAB_DATE }}</button>
        <button
          type="button" class="dtp-tab" role="tab" :aria-selected="tab === 'time'"
          :tabindex="tab === 'time' ? 0 : -1"
          @mousedown.stop.prevent @click.stop="tab = 'time'"
        >{{ MSG_DTP_TAB_TIME }}</button>
      </div>
      <span class="dtp-fmt">{{ MSG_DTP_FORMAT(label) }}</span>
    </div>

    <div v-if="tab === 'date'" class="dtp-cal">
      <div class="dtp-nav">
        <button
          type="button" class="dtp-step" :aria-label="MSG_DTP_PREV_MONTH"
          @mousedown.stop.prevent @click.stop="shiftMonth(-1)"
        >‹</button>
        <span class="dtp-ym">{{ year }}/{{ two(month) }}</span>
        <button
          type="button" class="dtp-step" :aria-label="MSG_DTP_NEXT_MONTH"
          @mousedown.stop.prevent @click.stop="shiftMonth(1)"
        >›</button>
        <button
          type="button" class="dtp-now" @mousedown.stop.prevent @click.stop="chooseToday"
        >{{ MSG_DTP_TODAY }}</button>
      </div>
      <div class="dtp-grid">
        <span v-for="w in WEEKDAYS" :key="'w' + w" class="dtp-wd">{{ w }}</span>
        <span v-for="n in leading" :key="'p' + n" class="dtp-pad"></span>
        <button
          v-for="d in days"
          :key="'d' + d"
          type="button"
          class="dtp-day"
          :data-day="d"
          :tabindex="d === rovingDay ? 0 : -1"
          :data-dtp-initial="d === focusDay || undefined"
          :aria-pressed="d === selDay"
          :aria-current="d === todayDay ? 'date' : undefined"
          @mousedown.stop.prevent
          @click.stop="chooseDay(d)"
        >{{ d }}</button>
      </div>
    </div>

    <div v-else class="dtp-time">
      <div class="dtp-cols">
        <div class="dtp-col" role="listbox">
          <button
            v-for="h in HOURS" :key="'h' + h" type="button" class="dtp-cell"
            data-col="0" :data-val="h" :tabindex="h === rovingVal(0) ? 0 : -1"
            :data-dtp-initial="h === hour || undefined"
            :aria-selected="h === hour" role="option"
            @mousedown.stop.prevent @click.stop="pickTime('h', h)"
          >{{ two(h) }}</button>
        </div>
        <div class="dtp-col" role="listbox">
          <button
            v-for="m in MINUTES" :key="'m' + m" type="button" class="dtp-cell"
            data-col="1" :data-val="m" :tabindex="m === rovingVal(1) ? 0 : -1"
            :aria-selected="m === minute" role="option"
            @mousedown.stop.prevent @click.stop="pickTime('mi', m)"
          >{{ two(m) }}</button>
        </div>
        <div v-if="hasSecond" class="dtp-col" role="listbox">
          <button
            v-for="s in MINUTES" :key="'s' + s" type="button" class="dtp-cell"
            data-col="2" :data-val="s" :tabindex="s === rovingVal(2) ? 0 : -1"
            :aria-selected="s === second" role="option"
            @mousedown.stop.prevent @click.stop="pickTime('s', s)"
          >{{ two(s) }}</button>
        </div>
      </div>
      <button type="button" class="dtp-now" @mousedown.stop.prevent @click.stop="chooseNow">
        {{ MSG_DTP_NOW }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 面・枠・端末調は `.crt-pop`（styles.css）が持つ。ここは並びと寸法だけ。 */
.dtp {
  position: absolute;
  margin: var(--grid-pad-y) 0 0 var(--grid-pad-x);
  z-index: 7;
  padding: 4px;
  font-size: 0.8em;
  line-height: 1.4;
}
.dtp-head {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 1px 3px 4px;
}
.dtp-tabs {
  display: flex;
  gap: 2px;
}
.dtp-tab,
.dtp-step,
.dtp-now,
.dtp-day,
.dtp-cell {
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.dtp-tab {
  padding: 1px 7px;
}
.dtp-tab[aria-selected="true"] {
  background: var(--accent-soft);
  color: var(--accent);
}
.dtp-fmt {
  margin-left: auto;
  color: var(--muted);
  font-size: 0.9em;
  white-space: nowrap;
}
.dtp-nav {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 0 3px 3px;
}
.dtp-step {
  width: 1.6em;
  color: var(--accent);
}
.dtp-ym {
  min-width: 5.5em;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.dtp-now {
  margin-left: auto;
  padding: 1px 7px;
  color: var(--accent);
}
.dtp-grid {
  display: grid;
  grid-template-columns: repeat(7, 2em);
  gap: 1px;
}
.dtp-wd {
  color: var(--muted);
  text-align: center;
  font-size: 0.85em;
}
.dtp-day {
  padding: 1px 0;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.dtp-day:hover,
.dtp-day:focus-visible,
.dtp-cell:hover,
.dtp-cell:focus-visible {
  background: var(--accent-soft);
}
.dtp-day[aria-pressed="true"],
.dtp-cell[aria-selected="true"] {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.dtp-cols {
  display: flex;
  gap: 3px;
}
.dtp-col {
  display: flex;
  flex-direction: column;
  max-height: 11em;
  overflow-y: auto;
}
.dtp-cell {
  padding: 0 6px;
  font-variant-numeric: tabular-nums;
}
/* 端末調では中身の色も CRT の緑側へ寄せる（`.opt-hints` の crt 意匠と同じ考え方） */
.dtp[data-pop="crt"] .dtp-fmt,
.dtp[data-pop="crt"] .dtp-wd {
  color: var(--t-yellow);
}
.dtp[data-pop="crt"] .dtp-step,
.dtp[data-pop="crt"] .dtp-now,
.dtp[data-pop="crt"] .dtp-tab[aria-selected="true"] {
  color: var(--t-turquoise);
}
.dtp[data-pop="crt"] .dtp-day:hover,
.dtp[data-pop="crt"] .dtp-day:focus-visible,
.dtp[data-pop="crt"] .dtp-cell:hover,
.dtp[data-pop="crt"] .dtp-cell:focus-visible,
.dtp[data-pop="crt"] .dtp-tab[aria-selected="true"] {
  background: var(--crt-line);
}
</style>
