<script setup lang="ts">
/**
 * **帳票の本文**（`20260802-view-menu-refine`）。プリンターセッションとスプールで共用する。
 *
 * `⚙ 表示` の設定のうち、**この経路で実際に効くもの**だけを適用する:
 *
 * - `linkify`——本文中の URL・メールをリンクにする
 * - `font`——`--screen-mono` を上書きする（`EmulatorPane` と同じやり方）
 * - `sosi`——SO/SI の位置に淡色の `{ }` を出す
 * - `kana`——SBCS の生バイトをもう一方の表で読み直す（カナ ⇄ 英）
 *
 * **後ろの 2 つは `ScsDecoder` が桁ごとの生バイトと SO/SI 位置を残すようになって初めて
 * できるようになった。** それ以前は復号済みの文字列しか届いておらず、印を置く位置も
 * 読み直す元も無かった（この注記は「実装できない」と書いてあった）。
 *
 * **SO/SI の印を出しても桁は 1 つも動かない。** 印は文字の流れに挟まず、桁の境目に
 * **重ねて**描く（幅を持たない）。挟むと印を出した行だけ右へずれ、実採取の帳票
 * （PUB400 の Library List）で確かめたとおり**ホストが組んだ桁と食い違う**
 * ——DBCS の行も他の行と同じ 39 桁目から始まっており、SO/SI は桁を占めない前提で組まれている。
 *
 * 行の区間分けは `@ts5250/scs` の `reportLineSegs` に任せる。**配布 HTML
 * （`spool-html.ts`）と同じ関数を通す**——別々に書くと「画面ではこう見えるのに
 * 保存した HTML では違う」が起きる。行を `div` にしているのも同じ理由で、
 * 重ね置きの基準（`position:relative`）を行ごとに持つため。
 */
import { computed } from "vue";
// **サブパスから取る**（`@ts5250/ebcdic/katakana` と同じ理由）。入口から取ると
// `spool-html` まで画面側へ引き込むことになる——型は実行時に消えるので入口のままでよい。
import { reportLineSegs, type ReportSeg, type SbcsReading } from "@ts5250/scs/report-line";
import type { LogicalPage, ShiftMark } from "@ts5250/scs";
import { isKatakanaCcsid } from "@ts5250/ebcdic/katakana";
import { viewSettings, resolveSbcsView } from "../stores/viewSettings.js";
import { screenFontStack } from "../composables/screenFonts.js";
import { splitLinks } from "../composables/linkify.js";

const props = defineProps<{
  /** カスケードの鍵（プリンターはセッション ID、スプールはタブ ID） */
  sessionId: string;
  pages: readonly LogicalPage[];
  /** 帳票の復号 CCSID（表示コード切替の向きを決める。未指定なら英小文字系とみなす） */
  ccsid?: number | undefined;
}>();

const view = computed(() => viewSettings.effective(props.sessionId));
const fontStyle = computed<Record<string, string> | undefined>(() => {
  const stack = screenFontStack(view.value.font);
  return stack ? { "--screen-mono": stack } : undefined;
});

/** 読み直す先。`host`（＝そのまま）なら読み直さない */
const alt = computed<SbcsReading | undefined>(() => {
  const v = resolveSbcsView(view.value.kana, isKatakanaCcsid(props.ccsid));
  return v === "host" ? undefined : v;
});
const showMarks = computed(() => view.value.sosi !== "none");
/** 濃目は薄目より濃く、どちらもふつうの文字より薄い（画面の `.a-shift` と同じ考え方） */
const markClass = computed(() => (view.value.sosi === "strong" ? "so strong" : "so"));

/** 改ページの区切り。**プリンターとスプールで同じ**（経路が違うだけで中身は同じもの） */
const PAGE_BREAK = "─".repeat(20) + " (改ページ) " + "─".repeat(20);

/** 描く単位。行ごとに区間の並びと、重ねて描く SO/SI を持つ */
interface Row {
  segs: ReportSeg[];
  marks: readonly ShiftMark[];
}

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  props.pages.forEach((p, pi) => {
    if (pi > 0) out.push({ segs: [{ kind: "text", text: PAGE_BREAK }], marks: [] });
    p.lines.forEach((line, r) => {
      out.push({
        segs: reportLineSegs(line, p.raw?.[r] ?? [], alt.value),
        marks: showMarks.value ? (p.shifts?.[r] ?? []) : []
      });
    });
  });
  return out;
});

/**
 * 印を置く位置（桁の境目）。
 * `ch` は**この要素自身のフォント**で解決されるので、印の字の大きさは変えないこと。
 */
function markStyle(m: ShiftMark): Record<string, string> {
  return { left: `${m.col - 1}ch` };
}

/** その区間に出す字（読み直す設定なら `alt` 側） */
function textOf(seg: ReportSeg): string {
  return seg.kind === "text" && seg.alt !== undefined && alt.value !== undefined ? seg.alt : seg.text;
}

/**
 * リンク化は**区間ごと**に掛ける。行をまたいで探さないのは元からの約束で、
 * ここでは全角の箱をまたいでも探さない。
 */
function partsOf(seg: ReportSeg): { text: string; href?: string }[] {
  const t = textOf(seg);
  return view.value.linkify ? splitLinks(t) : [{ text: t }];
}
</script>

<template>
  <div class="report" :style="fontStyle">
    <div v-for="(row, i) in rows" :key="i" class="ln"><span
      v-for="(m, n) in row.marks"
      :key="`m${n}`"
      :class="markClass"
      :style="markStyle(m)"
    >{{ m.kind === "so" ? "{" : "}" }}</span><template
      v-for="(seg, j) in row.segs"
      :key="j"
    ><span v-if="seg.kind === 'wide'" class="w">{{ seg.text }}</span><template v-else><template
      v-for="(p, k) in partsOf(seg)"
      :key="k"
    ><a v-if="p.href" :href="p.href" target="_blank" rel="noopener noreferrer">{{ p.text }}</a><template
      v-else
    >{{ p.text }}</template></template></template></template></div>
  </div>
</template>

<style scoped>
.report {
  margin: 0;
  font-family: var(--screen-mono);
  white-space: pre;
}
/* 行ごとの箱。**重ねて描く SO/SI の基準**（`position:relative`）でもある。
   空行でも 1 行ぶんの高さを保つ（`spool-html.ts` の `.ln` と同じ）。

   **`width: max-content` が要る。** 行はブロックなので、既定では親の幅に収まってしまい
   長い行がはみ出しても**親にスクロールバーが出ない**（`<pre>` にインラインで流していた
   ときは内容ぶんの幅を持っていた）。`min-width:100%` は短い行でも行の箱を
   ペイン幅まで広げるため——選択やホバーの当たりが行全体になる。 */
.ln {
  position: relative;
  min-height: 1.35em;
  width: max-content;
  min-width: 100%;
}
.report a {
  color: var(--t-turquoise, var(--accent));
}
/* 全角は 2 桁の箱に入れる（フォントに桁幅を委ねない。`spool-html.ts` と同じ理由） */
.w {
  display: inline-block;
  width: 2ch;
  overflow: hidden;
  vertical-align: top;
  text-align: left;
}
/* SO/SI の印は本物の { } と見分けが付くよう淡く描く（画面の `.a-shift` と同じ考え方）。
   **桁は占めない**——桁の境目に重ねて置き、幅を持たせない。だから出しても消しても
   桁が 1 つも動かない。印は本文ではないので選択・コピーにも混ぜない。 */
.so {
  position: absolute;
  top: 0;
  width: 1ch;
  margin-left: -0.5ch;
  text-align: center;
  color: color-mix(in srgb, currentColor 30%, transparent);
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
.so.strong {
  color: color-mix(in srgb, currentColor 65%, transparent);
}
</style>
