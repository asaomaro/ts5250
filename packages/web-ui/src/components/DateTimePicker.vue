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
import { computed, ref, watch } from "vue";
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

/** `Esc` で閉じる。**このコンポーネント自身の keydown だけ**を購読する（グリッドには足さない）。 */
function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    emit("close");
  }
}
</script>

<template>
  <div
    class="dtp crt-pop"
    :data-pop="pop"
    role="dialog"
    :aria-label="tab === 'date' ? MSG_DATE_PICKER : MSG_TIME_PICKER"
    @mousedown.stop.prevent
    @keydown="onKeydown"
  >
    <!-- 見出し: 解釈中の書式を必ず出す。桁順を固定している以上、名乗る責任がある -->
    <div class="dtp-head">
      <div v-if="showTabs" class="dtp-tabs" role="tablist">
        <button
          type="button" class="dtp-tab" role="tab" :aria-selected="tab === 'date'"
          @mousedown.stop.prevent @click.stop="tab = 'date'"
        >{{ MSG_DTP_TAB_DATE }}</button>
        <button
          type="button" class="dtp-tab" role="tab" :aria-selected="tab === 'time'"
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
          :aria-pressed="d === selDay"
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
            :aria-selected="h === hour" role="option"
            @mousedown.stop.prevent @click.stop="pickTime('h', h)"
          >{{ two(h) }}</button>
        </div>
        <div class="dtp-col" role="listbox">
          <button
            v-for="m in MINUTES" :key="'m' + m" type="button" class="dtp-cell"
            :aria-selected="m === minute" role="option"
            @mousedown.stop.prevent @click.stop="pickTime('mi', m)"
          >{{ two(m) }}</button>
        </div>
        <div v-if="hasSecond" class="dtp-col" role="listbox">
          <button
            v-for="s in MINUTES" :key="'s' + s" type="button" class="dtp-cell"
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
