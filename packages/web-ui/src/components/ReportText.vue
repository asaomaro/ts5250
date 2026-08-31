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
 * **SO/SI を出すと行は右へずれる。** SCS の SO/SI は桁を占めない（`ScsDecoder` は昔から
 * シフトで桁を進めない）ので、印を描くには桁を 1 つ借りるしかない。既定が非表示なのは
 * そのため——**紙と突き合わせるときは消しておく**。
 *
 * 行の区間分けは `@ts5250/scs` の `reportLineSegs` に任せる。**配布 HTML
 * （`spool-html.ts`）と同じ関数を通す**——別々に書くと「画面ではこう見えるのに
 * 保存した HTML では違う」が起きる。
 */
import { computed } from "vue";
import { reportLineSegs, type LogicalPage, type ReportSeg, type SbcsReading } from "@ts5250/scs";
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

/** そのまま描いた字がどちらの読みか（`screenExport` と同じ決め方） */
const hostReading = computed<SbcsReading>(() => (isKatakanaCcsid(props.ccsid) ? "kana" : "latin"));
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

/** 描く単位。行ごとに区間の並びを持つ（`sep` はページ区切りの行） */
interface Row {
  sep?: boolean;
  segs: ReportSeg[];
}

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  props.pages.forEach((p, pi) => {
    if (pi > 0) out.push({ sep: true, segs: [{ kind: "text", text: PAGE_BREAK }] });
    p.lines.forEach((line, r) => {
      out.push({
        segs: reportLineSegs(line, p.raw?.[r] ?? [], p.shifts?.[r] ?? [], alt.value, showMarks.value)
      });
    });
  });
  return out;
});

/** その区間に出す字（読み直す設定なら `alt` 側） */
function textOf(seg: ReportSeg): string {
  return seg.kind === "text" && seg.alt !== undefined && alt.value !== undefined ? seg.alt : seg.text;
}

/**
 * リンク化は**区間ごと**に掛ける。行をまたいで探さないのは元からの約束で、
 * ここでは SO/SI の印や全角の箱をまたいでも探さない——印は本文ではないので、
 * URL の一部として拾わせない。
 */
function partsOf(seg: ReportSeg): { text: string; href?: string }[] {
  const t = textOf(seg);
  return view.value.linkify ? splitLinks(t) : [{ text: t }];
}
</script>

<template>
  <pre class="report" :style="fontStyle"><template v-for="(row, i) in rows" :key="i"><template
    v-for="(seg, j) in row.segs"
    :key="j"
  ><span v-if="seg.kind === 'mark'" :class="markClass">{{ seg.text }}</span><span
    v-else-if="seg.kind === 'wide'"
    class="w"
  >{{ seg.text }}</span><template v-else><template
    v-for="(p, k) in partsOf(seg)"
    :key="k"
  ><a v-if="p.href" :href="p.href" target="_blank" rel="noopener noreferrer">{{ p.text }}</a><template
    v-else
  >{{ p.text }}</template></template></template></template>{{ i < rows.length - 1 ? "\n" : "" }}</template></pre>
</template>

<style scoped>
.report {
  margin: 0;
  font-family: var(--screen-mono);
  white-space: pre;
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
   桁を 1 つ借りるので幅を固定する。印は本文ではないので選択・コピーに混ぜない。 */
.so {
  display: inline-block;
  width: 1ch;
  color: color-mix(in srgb, currentColor 30%, transparent);
  user-select: none;
  -webkit-user-select: none;
}
.so.strong {
  color: color-mix(in srgb, currentColor 65%, transparent);
}
</style>
