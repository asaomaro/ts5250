<script setup lang="ts">
import { ref, nextTick, onActivated } from "vue";
import { useColumnWidths } from "../composables/useColumnWidths.js";
import { isLob } from "../csv.js";

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
type Cell = string | number | boolean | null | { kind: "lob" };
type Row = Record<string, Cell>;

defineProps<{
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
/**
 * スクロール位置。**離れるときに読むのでは間に合わない**——`KeepAlive` が DOM を
 * 切り離した時点で `scrollTop` は 0 になっている（実機で確認）。スクロールのたびに控える。
 * 反応性は要らないので ref にしない（1 スクロールごとに再描画を起こさない）
 */
let savedScroll = 0;
onActivated(() => {
  // 再挿入直後は高さが決まっておらず、その場で入れても効かない。次の描画まで待つ
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = savedScroll;
  });
});

/** 表の下端に近づいたら読み足す。ついでに位置を控える（タブを戻したときに当てる） */
function onScroll(e: Event): void {
  const el = e.target as HTMLElement;
  savedScroll = el.scrollTop;
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

/** LOB セルの表示。**取得済み・未取得・大きすぎを区別する** */
function lobText(v: unknown): string {
  const lob = v as { value?: unknown; unavailable?: string };
  if (typeof lob.value === "string") {
    return lob.unavailable === "too-large" ? `${lob.value}…（以降省略）` : lob.value;
  }
  return lob.unavailable === "too-large" ? "(LOB: 大きすぎます)" : "(LOB)";
}

function lobTitle(v: unknown): string {
  const lob = v as { byteLength?: number; unavailable?: string };
  if (lob.unavailable === "not-requested") return "LOB の中身は取得していません（左のチェックで取得）";
  if (lob.unavailable === "too-large") return `全体 ${lob.byteLength ?? "?"} バイトのうち先頭のみ`;
  return `LOB（${lob.byteLength ?? "?"} バイト）`;
}
</script>

<template>
  <div ref="scroller" class="rows-scroll" tabindex="0" @scroll="onScroll" @keydown="onKeydown">
    <table>
      <thead>
        <tr>
          <!-- レコード番号。**横スクロールしても残す**ので、どの行を見ているか見失わない -->
          <th class="rownum" title="レコード番号（読み足した順の通し番号）">#</th>
          <th
            v-for="(c, ci) in columns"
            :key="c.name"
            :style="widthStyle(ci)"
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
        <tr v-for="(r, i) in rows" :key="i">
          <td class="rownum">{{ i + 1 }}</td>
          <td v-for="(c, ci) in columns" :key="c.name" :style="widthStyle(ci)" :title="cellTitle(r[c.name])">
            <span v-if="r[c.name] === null" class="null">NULL</span>
            <span v-else-if="isLob(r[c.name])" class="lob" :title="lobTitle(r[c.name])">{{ lobText(r[c.name]) }}</span>
            <template v-else>{{ r[c.name] }}</template>
          </td>
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
/* 中身に合わせて広げる（横に溢れたら .rows-scroll が横スクロールする） */
table {
  border-collapse: collapse;
  width: auto;
  table-layout: auto;
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
}
tbody tr:hover {
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
