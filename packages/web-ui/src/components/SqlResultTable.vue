<script setup lang="ts">
import { ref, computed, watch, nextTick, onActivated, onMounted } from "vue";
import { useColumnWidths } from "../composables/useColumnWidths.js";
import {
  columnCharWidths,
  charWidthToPx,
  visibleWindow,
  FALLBACK_CHAR_PX,
  FALLBACK_ROW_PX,
  FALLBACK_WIDE_WEIGHT,
  INITIAL_ROWS
} from "../composables/tableVirtual.js";
import { isLob } from "../csv.js";
// 型は在り処（`@ts5250/hostserver`）から。`import type` なのでバンドルに入らない
import type { LobPlaceholder } from "@ts5250/hostserver";

/**
 * SQL の結果 1 つぶんの表。
 *
 * **タブごとに 1 インスタンス**にして、`KeepAlive` で保持する。
 * 切り替えのたびに表を作り直すと、200 行 × 40 列（8,000 セル）で
 * **Vue の再生成に 220〜280ms** かかり、描画後に操作を受け付けない時間が出る
 * （実測。DOM を挿し直すだけなら 65ms なので、大半は vnode の作り直し）。
 * 保持しておけば切り替えは表示の切り替えだけで済む。
 *
 * 列幅も**このインスタンスが持つ**——タブごとに列が違うので、共有すると対応が狂う。
 * 保持されている間は幅も保たれる（切り替えて戻っても手で決めた幅が残る）。
 *
 * **スクロール位置だけは自分で覚える**。`KeepAlive` は DOM をいったん切り離すので、
 * `scrollTop` は 0 に戻ってしまう（実機で確認）。見比べている最中に先頭へ飛ばされると
 * タブを行き来する意味が薄れるため、離れるときに控えて戻るときに当てる。
 */
interface Column {
  name: string;
  typeName: string;
  nullable: boolean;
}
// LOB は**実体の型**を使う。`{ kind: "lob" }` とだけ書いていたため、
// `value` / `unavailable` / `byteLength` を読む関数がすべて `as` で読み直していた
type Cell = string | number | boolean | null | LobPlaceholder;
type Row = Record<string, Cell>;

const props = defineProps<{
  columns: Column[];
  rows: Row[];
  hasMore: boolean;
  loadingMore: boolean;
}>();

/** 続きの読み足しは親が持つ（結果セット ID と実行ログを握っているため） */
const emit = defineEmits<{ (e: "load-more"): void }>();

const cols = useColumnWidths();
const resizingCol = cols.resizing;
const widthStyle = cols.widthStyle;

const scroller = ref<HTMLElement | undefined>(undefined);
const probe = ref<HTMLElement | undefined>(undefined);
const wideProbe = ref<HTMLElement | undefined>(undefined);
const headRow = ref<HTMLElement | undefined>(undefined);
/**
 * スクロール位置。**離れるときに読むのでは間に合わない**——`KeepAlive` が DOM を
 * 切り離した時点で `scrollTop` は 0 になっている（実機で確認）。スクロールのたびに控える。
 * 反応性は要らないので ref にしない（1 スクロールごとに再描画を起こさない）
 */
let savedScroll = 0;

// ---- 仮想化（`20260802-sql-table-virtualize`）----
/**
 * **表示範囲だけ描く。**
 *
 * 実ブラウザで測った初回描画は 1000 行 × 40 列（40,000 セル）で **582ms**。
 * 1 セルあたり ~14µs でほぼ一定なので、律速は行数でもレイアウトでもなく
 * **セルを 1 つ作る仕事**（`scripts/research-sql-table-render.mjs`）。
 * `table-layout: fixed` にするだけでは速くならず、**セルを作らない**ことだけが効く。
 */
const scrollTop = ref(0);
const viewportH = ref(0);
/** 1 行の高さ。等幅・折り返しなし・固定フォントサイズなので**揃っている** */
const rowH = ref(FALLBACK_ROW_PX);
/** sticky な見出しのぶん。引き忘れると窓がその高さだけずれる */
const headerH = ref(0);
/** 1 文字ぶんの px。`th`(12px) と `td`(13px) でフォントが違うので `ch` は使えない */
const charPx = ref(FALLBACK_CHAR_PX);
/**
 * 全角が半角の何倍か。**2 とは限らない**——`IBM Plex Mono` は CJK の字形を持たず、
 * 代替フォントが描く。実ブラウザでは 1.625 倍だった（節 7 で実測）。
 * 2 のまま数えると日本語の列だけ 2 割ほど広くなる
 */
const wideWeight = ref(FALLBACK_WIDE_WEIGHT);

/**
 * 測ったか。**「まだ測っていない」と「測れない」を分ける。**
 *
 * 高さは描いたあとでないと測れないので、1 枚目は必ず未測定になる。そこを
 * 「測れない＝全行描く」に倒すと、**1 枚目で全行を描いてから間引く**ことになり
 * 仮想化前より遅くなる（実測 1000 行で 582ms → 876ms）。1 枚目は固定数で始める。
 */
const measured = ref(false);
const win = computed(() => {
  if (!measured.value) return { start: 0, end: Math.min(props.rows.length, INITIAL_ROWS) };
  return visibleWindow(scrollTop.value, viewportH.value, rowH.value, props.rows.length, undefined, headerH.value);
});
const windowRows = computed(() => props.rows.slice(win.value.start, win.value.end));
/** 上下の詰め物。**スクロールできる高さを保つ**（バーの長さが全行を映す） */
const padTop = computed(() => win.value.start * rowH.value);
const padBottom = computed(() => Math.max(0, (props.rows.length - win.value.end) * rowH.value));

/** 実測を取り直す。**描いたあとでないと測れない** */
function measure(): void {
  const el = scroller.value;
  if (!el) return;
  viewportH.value = el.clientHeight;
  scrollTop.value = el.scrollTop;
  const p = probe.value?.getBoundingClientRect().width ?? 0;
  // 探り棒は 10 文字並べてある（1 文字だと丸めの誤差が 10 倍で効く）
  if (p > 0) charPx.value = p / 10;
  const wp = wideProbe.value?.getBoundingClientRect().width ?? 0;
  if (p > 0 && wp > 0) wideWeight.value = wp / 5 / (p / 10);
  const h = headRow.value?.getBoundingClientRect().height ?? 0;
  if (h > 0) headerH.value = h;
  const first = el.querySelector("tbody tr.data");
  const rh = first?.getBoundingClientRect().height ?? 0;
  if (rh > 0) rowH.value = rh;
  // **測り終えた印**。以降は窓の計算に切り替える（jsdom では高さが 0 のまま
  // 返るので、`visibleWindow` が「全行描く」へ倒れる＝行は落ちない）
  measured.value = true;
}

onMounted(() => void nextTick(measure));
// 行や列が変わったら測り直す（列の数で行の高さは変わらないが、初回は行が無い）
watch(
  () => [props.columns, props.rows.length],
  () => void nextTick(measure)
);

onActivated(() => {
  // 再挿入直後は高さが決まっておらず、その場で入れても効かない。次の描画まで待つ
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = savedScroll;
    // **位置を戻すだけでは足りない**——窓も計算し直さないと中身が先頭のままになる
    measure();
  });
});

/** スクロールの再計算は 1 フレームに 1 回へ間引く */
let raf = 0;
/** 表の下端に近づいたら読み足す。ついでに位置を控える（タブを戻したときに当てる） */
function onScroll(e: Event): void {
  const el = e.target as HTMLElement;
  savedScroll = el.scrollTop;
  if (raf === 0) {
    raf = requestAnimationFrame(() => {
      raf = 0;
      scrollTop.value = el.scrollTop;
      viewportH.value = el.clientHeight;
    });
  }
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) emit("load-more");
}

/** End / PageDown でも読み足す（キーボードだけで使えるように） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "End" || e.key === "PageDown") emit("load-more");
}

/** セルの title。**LOB と NULL には出さない**（別の説明を出しているため） */
function cellTitle(v: unknown): string | undefined {
  if (v === null || isLob(v)) return undefined;
  return String(v);
}

/**
 * LOB セルの表示。**取得済み・未取得・大きすぎ・失敗を区別する**。
 *
 * テンプレートは `v-else-if="isLob(…)"` の中でしか呼ばないので、冒頭の絞り込みは
 * 形式上のもの（`as` で読み直さないために置く）。
 */
function lobText(v: Cell | undefined): string {
  if (!isLob(v)) return String(v ?? "");
  // **中身があるならまず出す**。理由の判定を先に置くと、部分値を持つ状態で値を捨てる
  if (typeof v.value === "string") {
    return v.unavailable === "too-large" ? `${v.value}…（以降省略）` : v.value;
  }
  if (v.unavailable === "too-large") return "(LOB: 大きすぎます)";
  if (v.unavailable === "failed") return "(LOB: 取得失敗)";
  return "(LOB)";
}

/**
 * **セルに実際に出る文字**。
 *
 * 表示と列幅の計算が**同じ関数を使う**ようにするために切り出した。別々に決めると、
 * LOB や NULL の列だけ幅と中身が食い違う（幅は生値、画面は `(LOB)` のように）。
 */
function cellText(row: Row, col: number): string {
  const v = row[props.columns[col]!.name];
  if (v === null || v === undefined) return "NULL";
  if (isLob(v)) return lobText(v);
  return String(v);
}

/**
 * 列幅（px）。**全行の表示幅から計算する**。
 *
 * 行を間引くと `table-layout: auto` は「いま描いている行」だけで幅を決めるので、
 * スクロールのたびに表が横に踊る。だから**先に決めて宣言する**（`fixed`）。
 *
 * **標本（先頭 N 行）にしない**——後ろにある長い値で列が足りなくなり、
 * いままでの見え方と食い違う。文字数を数えるだけなので、全行を走っても描画より 2 桁安い。
 */
const autoChars = computed(() =>
  columnCharWidths(
    props.columns.map((c) => c.name),
    props.rows,
    cellText,
    undefined,
    wideWeight.value
  )
);

/**
 * **px への換算は分けてある**（`charPx` に依存させない）。
 *
 * 1 文字ぶんの px は測ったあとに確定するので、まとめて `computed` にすると
 * **全行の走査が 2 回**走る（測る前と後）。40,000 セルではそれがそのまま無駄になる。
 */
const autoWidths = computed(() => autoChars.value.map((n) => charWidthToPx(n, charPx.value)));

/**
 * レコード番号の列幅。**桁数から決めて宣言する。**
 *
 * `table-layout: fixed` は**最初の行**で列幅を決めるので、宣言しないと
 * 窓の先頭が `1` のときと `968` のときで幅が変わる——スクロールで表が横に動く
 * （実ブラウザで 32px → 40px に動くのを観測）。
 */
const rownumStyle = computed(() => {
  const digits = String(Math.max(1, props.rows.length)).length;
  const w = `${charWidthToPx(digits, charPx.value)}px`;
  return { width: w, minWidth: w, maxWidth: w };
});

/** 手で決めた幅があればそれ、無ければ計算値。**ダブルクリックで計算値へ戻る** */
function colStyle(i: number): Record<string, string> {
  const manual = widthStyle(i);
  if (manual) return manual;
  const w = `${autoWidths.value[i] ?? 0}px`;
  return { width: w, minWidth: w, maxWidth: w };
}

function lobTitle(v: Cell | undefined): string {
  if (!isLob(v)) return String(v ?? "");
  const lob = v;
  // **取得を促すのは本当に要求していないときだけ**。取りに行って失敗した場合にも
  // これを出していたので、既に取得を要求した利用者へ同じ操作を勧めていた
  if (lob.unavailable === "not-requested") return "LOB の中身は取得していません（左のチェックで取得）";
  if (lob.unavailable === "too-large") return `全体 ${lob.byteLength ?? "?"} バイトのうち先頭のみ`;
  // 理由は JSON に載せない（ホスト由来のデバッグ文字列のため）。サーバーのログに warn で出る
  if (lob.unavailable === "failed") return "LOB の取得に失敗しました（サーバーのログに理由が出ます）";
  return `LOB（${lob.byteLength ?? "?"} バイト）`;
}
</script>

<template>
  <div ref="scroller" class="rows-scroll" tabindex="0" @scroll="onScroll" @keydown="onKeydown">
    <!-- 1 文字ぶんの px を測る探り棒。**`ch` は使えない**——`th`(12px) と `td`(13px) で
         フォントサイズが違うので、要素自身のフォントを基準にする `ch` では列がずれる。
         **表の外に置く**（`<td>` にすると `tbody tr` を数える検査に混ざる） -->
    <span ref="probe" class="probe" aria-hidden="true">0000000000</span>
    <!-- 全角の送り幅。**半角の 2 倍とは限らない**ので測る -->
    <span ref="wideProbe" class="probe" aria-hidden="true">あいうえお</span>
    <table>
      <thead>
        <tr ref="headRow">
          <!-- レコード番号。**横スクロールしても残す**ので、どの行を見ているか見失わない -->
          <th class="rownum" :style="rownumStyle" title="レコード番号（読み足した順の通し番号）">#</th>
          <th
            v-for="(c, ci) in columns"
            :key="c.name"
            :style="colStyle(ci)"
            :title="`${c.name} — ${c.typeName}${c.nullable ? '' : ' NOT NULL'}`"
          >
            {{ c.name }}
            <!-- 列の右端を掴んで幅を変える。ダブルクリックで既定へ戻す -->
            <span
              class="col-grip"
              :class="{ dragging: resizingCol === ci }"
              title="ドラッグで列幅を変えられます（ダブルクリックで戻す）"
              @pointerdown="cols.onDown($event, ci)"
              @pointermove="cols.onMove"
              @pointerup="cols.onUp"
              @pointercancel="cols.onUp"
              @dblclick="cols.reset(ci)"
            ></span>
          </th>
        </tr>
      </thead>
      <tbody>
        <!-- 詰め物。**スクロールできる高さを保つ**ので、バーの長さが全行を映す -->
        <tr v-if="padTop > 0" class="spacer" :style="{ height: padTop + 'px' }">
          <td :colspan="columns.length + 1"></td>
        </tr>
        <!-- **行番号は通し番号**（間引いてもずれない） -->
        <tr v-for="(r, i) in windowRows" :key="win.start + i" class="data">
          <td class="rownum" :style="rownumStyle">{{ win.start + i + 1 }}</td>
          <td v-for="(c, ci) in columns" :key="c.name" :style="colStyle(ci)" :title="cellTitle(r[c.name])">
            <span v-if="r[c.name] === null" class="null">NULL</span>
            <span v-else-if="isLob(r[c.name])" class="lob" :title="lobTitle(r[c.name])">{{ lobText(r[c.name]) }}</span>
            <template v-else>{{ r[c.name] }}</template>
          </td>
        </tr>
        <tr v-if="padBottom > 0" class="spacer" :style="{ height: padBottom + 'px' }">
          <td :colspan="columns.length + 1"></td>
        </tr>
      </tbody>
    </table>
    <p v-if="loadingMore" class="more">読み足しています…</p>
    <p v-else-if="hasMore" class="more">
      下までスクロール、または End / PageDown で続きを読み込みます（{{ rows.length }} 件表示中）
    </p>
    <p v-else class="more">これ以上ありません（全 {{ rows.length }} 件）</p>
  </div>
</template>

<style scoped>
/* 表そのものの見た目は SqlPane から移してきたもの（意匠は変えていない） */
.rows-scroll {
  overflow: auto;
  flex: 1 1 auto;
  min-height: 0;
  border-top: 1px solid var(--line);
  background: var(--paper);
}
.rows-scroll:focus {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
/* **幅は宣言する**（`20260802-sql-table-virtualize`）。行を間引くと `auto` は
   「いま描いている行」だけで幅を決めるので、スクロールのたびに表が横に踊る。
   横に溢れたら .rows-scroll が横スクロールする */
table {
  border-collapse: collapse;
  width: auto;
  table-layout: fixed;
}
/* 1 文字ぶんの px を測るためだけの印。**場所も取らず、選択もされない**。
   フォントは `td` と揃えること——ここがずれると全列の幅がずれる */
.probe {
  position: absolute;
  visibility: hidden;
  pointer-events: none;
  user-select: none;
  top: 0;
  left: 0;
  font-family: var(--mono);
  font-size: 13px;
  white-space: pre;
}
/* 詰め物。中身が無いので罫線も引かない（行と誤認させない） */
tbody tr.spacer td {
  border-bottom: none;
  padding: 0;
}
th,
td {
  border-bottom: 1px solid var(--line);
  padding: 5px 8px;
  text-align: left;
  font-size: 13px;
}
th {
  color: var(--muted);
  font-weight: 600;
  font-size: 12px;
  font-family: var(--mono);
}
td {
  font-family: var(--mono);
  white-space: pre;
  /* **`fixed` は溢れを吸収しない。** `auto` は列を広げていたが、宣言した幅を超えると
     隣の列へはみ出す。切って `…` を出す（全文は title に出ている） */
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 詰め物は光らせない（行ではないので） */
tbody tr.data:hover {
  background: var(--accent-soft);
}
/* 列見出しはスクロールしても残す */
thead th {
  position: sticky;
  top: 0;
  background: var(--card);
  z-index: 1;
}
/* レコード番号は横スクロールしても残す */
.rownum {
  position: sticky;
  left: 0;
  background: var(--paper);
  color: var(--muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
  z-index: 1;
}
thead th.rownum {
  z-index: 2;
  background: var(--card);
}
/* 列の右端の掴み手。見出しは sticky＝配置済みなので、これを基準に置ける。
   掴める幅は 8px 取る（1px の罫線ちょうどでは掴めない） */
.col-grip {
  position: absolute;
  top: 0;
  right: -4px;
  width: 8px;
  height: 100%;
  cursor: col-resize;
  touch-action: none;
}
.col-grip:hover,
.col-grip.dragging {
  background: var(--accent);
  opacity: 0.35;
}
th {
  position: relative;
}
.null {
  color: var(--muted);
  font-style: italic;
}
.lob {
  color: var(--muted);
}
.more {
  color: var(--muted);
  font-size: 12px;
  text-align: center;
  padding: 6px 0;
}
</style>
