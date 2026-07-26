<script setup lang="ts">
/**
 * ウォーターマーク（画面に重ねる透かし）。
 *
 * **重ねるだけ**で文字・桁・ホスト色には一切触れない（ウィンドウ装飾と同じ流儀）。
 * したがって `pointer-events: none`（入力・クリック・矩形選択を奪わない）と
 * `user-select: none`（画面のコピーに透かしの文字が混ざらない）が必須。
 *
 * 敷き詰めは**要素の対角線を一辺とする正方形**を回転させて作る。どの角度でも
 * 元の矩形を必ず覆えるので、角度ごとの場合分けが要らない。1 単位（文字＋区切り）の幅だけ
 * 実測し、行数・繰り返し数はそこから割り出す（レイアウトの無い環境では 1 単位に畳む）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { WatermarkView } from "../composables/watermark.js";

const props = defineProps<{ watermark: WatermarkView }>();

/** 文字と文字の間隔。全角空白なので**字の大きさに比例**して開く（欧文/和文どちらでも間が持つ） */
const SEP = "　　";

const boxEl = ref<HTMLElement>();
const probeEl = ref<HTMLElement>();
const boxW = ref(0);
const boxH = ref(0);
/** 1 単位（文字＋区切り）の実測幅 px。0 ならレイアウト前（jsdom 等） */
const unitW = ref(0);

/** 回転しても元の矩形を覆いきる一辺（＝対角線） */
const side = computed(() => Math.ceil(Math.hypot(boxW.value, boxH.value)));
/** 行の高さ。字の大きさに比例させて、大きくすると自然に隙間も開くようにする */
const lineH = computed(() => Math.max(8, Math.round(props.watermark.size * 2.4)));
const tiled = computed(() => props.watermark.layout === "tile");

const rowCount = computed(() =>
  tiled.value ? Math.max(1, Math.ceil(side.value / lineH.value)) : 1
);
const colCount = computed(() =>
  tiled.value && unitW.value > 0 ? Math.max(1, Math.ceil(side.value / unitW.value)) : 1
);
/** 1 行分の文字列。中央 1 つのときは区切りを付けない */
const lineText = computed(() =>
  tiled.value ? (props.watermark.text + SEP).repeat(colCount.value) : props.watermark.text
);
const probeText = computed(() => props.watermark.text + SEP);

const fieldStyle = computed<Record<string, string>>(() => {
  const st: Record<string, string> = {
    transform: `translate(-50%, -50%) rotate(${props.watermark.angle}deg)`,
    opacity: String(props.watermark.opacity),
    lineHeight: `${lineH.value}px`
  };
  // 敷き詰めのときだけ対角正方形に広げる（中央 1 つは文字の実サイズのまま）
  if (tiled.value && side.value > 0) {
    st.width = `${side.value}px`;
    st.height = `${side.value}px`;
  }
  return st;
});

const rootStyle = computed<Record<string, string>>(() => ({
  fontSize: `${props.watermark.size}px`,
  // 未指定なら端末の前景色に追従する（テーマ・スキンを切り替えても浮かない）
  color: props.watermark.color ?? "var(--t-white)"
}));

/** 奇数行を半単位ずらして市松に敷く（縦に文字が揃うと格子模様に見えてしまう） */
function lineStyle(index: number): Record<string, string> {
  return index % 2 === 1 && unitW.value > 0 ? { paddingLeft: `${unitW.value / 2}px` } : {};
}

function measure(): void {
  const el = boxEl.value;
  if (el) {
    boxW.value = el.clientWidth;
    boxH.value = el.clientHeight;
  }
  const probe = probeEl.value;
  if (probe) unitW.value = probe.getBoundingClientRect().width;
}

let ro: ResizeObserver | undefined;
onMounted(() => {
  if (typeof ResizeObserver !== "undefined" && boxEl.value) {
    ro = new ResizeObserver(() => measure());
    ro.observe(boxEl.value);
  }
  measure();
});
onBeforeUnmount(() => ro?.disconnect());

// 文字・大きさが変わると 1 単位の幅も変わる。**描画確定後に**測り直す
watch(() => [props.watermark.text, props.watermark.size], () => void nextTick(measure));
</script>

<template>
  <div ref="boxEl" class="wm" :style="rootStyle" aria-hidden="true">
    <div class="wm-field" :style="fieldStyle">
      <div v-for="i in rowCount" :key="i" class="wm-line" :style="lineStyle(i - 1)">{{ lineText }}</div>
    </div>
    <!-- 1 単位の実測用。見えないが**レイアウトには参加させる**（display:none だと幅が測れない） -->
    <span ref="probeEl" class="wm-probe">{{ probeText }}</span>
  </div>
</template>

<style scoped>
.wm {
  position: absolute;
  inset: 0;
  overflow: hidden;
  /* 重ねる要素の鉄則: 操作を奪わない。選択にも入れない（画面のコピーに透かしが混ざる） */
  pointer-events: none;
  user-select: none;
  /* 文字より上・矩形選択(3)/カーソル(4) より下。読み取りの邪魔をせず、選択は透かしの上に出る */
  z-index: 2;
  font-family: var(--sans);
  font-weight: 600;
  letter-spacing: 0.12em;
  /* 透かしは背景。フォスファのにじみ（--t-glow）は継がせない */
  text-shadow: none;
}
.wm-field {
  position: absolute;
  left: 50%;
  top: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.wm-line {
  /* 区切りの空白を潰さない。行内では折り返さず、はみ出した分は .wm が刈り取る */
  white-space: pre;
}
.wm-probe {
  position: absolute;
  top: 0;
  left: 0;
  white-space: pre;
  visibility: hidden;
}
</style>
