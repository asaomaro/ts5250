<script setup lang="ts">
/**
 * 実行計画のグラフ表示（**自前 SVG**）。
 *
 * 描画ライブラリを足さない（AGENTS.md のバンドル規律。`@ts5250/scs` のバレル参照で
 * 359,853 → 1,458,480 バイトにした実例がある）。座標の計算は `planLayout.ts` の
 * 純関数に切ってあり、ここは**写すだけ**。
 *
 * ## 線の意味はブロックごとに違う
 *
 * 結合のある計画は**結合の木**として描く（`QQJNP` がダイヤルの順位を持つ。`design.md` A1 の訂正）。
 * このとき線は**データの流れ**なので矢印を付け、上から下へ読ませる。
 *
 * 結合が無い計画は従来どおり縦並びで、線は「同じクエリブロックに属する」ことしか
 * 意味しない。**そこに矢印を付けると嘘になる**ので付けない。凡例も出し分ける。
 *
 * ## どの箱も選べる
 *
 * 記録のノードだけでなく**結合・テーブル・プローブ・最終選択も選べる**（ACS と同じ）。
 * 選ばれたものは `PlanSelection`（`id` / `label` / `attributes`）として親へ渡すので、
 * 詳細パネルは「記録か導いた節か」を場合分けせずに済む。
 */
import { computed } from "vue";
import type { PlanBlock } from "../planApi.js";
import { layoutPlan, connectorsOf, nodeClassOf, MAX_NODES, type PlanSelection } from "../planLayout.js";
// 全角判定は在り処（`@ts5250/base`）から。**表の幅ではなく箱の幅**に合わせて切るために要る
import { isFullWidth } from "@ts5250/base";

const props = withDefaults(
  defineProps<{
    blocks: PlanBlock[];
    selectedId?: string | undefined;
    maxNodes?: number;
  }>(),
  { maxNodes: MAX_NODES }
);

const emit = defineEmits<{ select: [item: PlanSelection] }>();

const layout = computed(() => layoutPlan(props.blocks, props.maxNodes));

/** 木として描いたブロックが 1 つでもあるか。**凡例の文言はこれで決める** */
const hasTree = computed(() => layout.value.blocks.some((b) => b.tree));
/** 木でないブロックが 1 つでもあるか（UNION で片方だけ結合、のような混在に備える） */
const hasFlat = computed(() =>
  layout.value.blocks.some((b) => !b.tree && b.connectors.length > 0)
);

/**
 * 箱に収まる長さで切る（省略記号は CSS ではなく文字で。SVG は `text-overflow` が効かない）。
 *
 * **文字数ではなく表示幅で数える。** 全角は半角 2 つぶんの場所を取るので、
 * 文字数で切ると「索引の使用: Q_TESTLIB_…」のような和欧混在のラベルが箱からはみ出す
 * （索引名を実際のアクセスパス名にしたら実際にはみ出した）。
 * `max` は**半角換算**の桁数。
 */
function clip(s: string, max = 26): string {
  const width = (t: string): number => [...t].reduce((n, ch) => n + (isFullWidth(ch) ? 2 : 1), 0);
  if (width(s) <= max) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const w = isFullWidth(ch) ? 2 : 1;
    // 末尾の「…」（全角 2 桁）ぶんを空けておく
    if (used + w > max - 2) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/**
 * 線を「下 → 横 → 下」の折れ線にする。
 *
 * 木では枝が横にずれるので、直線で引くと箱の角を横切って読めなくなる。
 * 縦並び（`x1 === x2`）では中間点が同じ座標に潰れるので、見た目は今までの直線のまま。
 */
function elbow(c: { x1: number; y1: number; x2: number; y2: number }): string {
  const mid = (c.y1 + c.y2) / 2;
  return `${c.x1},${c.y1} ${c.x1},${mid} ${c.x2},${mid} ${c.x2},${c.y2}`;
}

/** 2 行目に出す数値。**無い値は書かない**（`-` を並べても読めない） */
function metrics(node: { estimatedRows?: number; totalRows?: number; estimatedMs?: number }): string {
  const parts: string[] = [];
  if (node.estimatedRows !== undefined) parts.push(`推定 ${node.estimatedRows.toLocaleString()} 行`);
  if (node.totalRows !== undefined) parts.push(`全 ${node.totalRows.toLocaleString()} 行`);
  if (node.estimatedMs !== undefined) parts.push(`${node.estimatedMs} ms`);
  return parts.join(" / ");
}
</script>

<template>
  <div class="plan-graph">
    <svg
      :viewBox="`0 0 ${layout.width} ${layout.height}`"
      :width="layout.width"
      :height="layout.height"
      role="img"
      aria-label="実行計画のグラフ"
    >
      <!-- 木のときだけ矢印を出す。線の意味が違うので印も分ける -->
      <defs>
        <marker id="pg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 7 4 L 0 7 z" class="pg-arrow-head" />
        </marker>
      </defs>
      <g v-for="block in layout.blocks" :key="block.number">
        <text :x="block.x" :y="block.y + 12" class="pg-block-label">
          クエリブロック {{ block.number }}
        </text>
        <!-- 折れ線にする。木では横にずれた枝を斜めに引くと交差が読めない -->
        <polyline
          v-for="(c, i) in connectorsOf(block)"
          :key="`c${i}`"
          :points="elbow(c)"
          class="pg-link"
          :class="{ flow: block.tree }"
          :marker-end="block.tree ? 'url(#pg-arrow)' : undefined"
        />

        <!--
          結合と単項の節（テーブル・プローブ／最終選択）。
          **`PlanNode` を持たないので選択の対象にしない**（詳細パネルに出すものが無い）
        -->
        <g
          v-for="j in block.joins"
          :key="j.id"
          class="pg-join"
          :class="{ 'is-selected': j.id === props.selectedId }"
          role="button"
          tabindex="0"
          @click="emit('select', j)"
          @keydown.enter.prevent="emit('select', j)"
          @keydown.space.prevent="emit('select', j)"
        >
          <rect :x="j.x" :y="j.y" :width="j.w" :height="j.h" rx="6" />
          <text :x="j.x + j.w / 2" :y="j.y + 32" class="pg-join-label">{{ clip(j.label, 28) }}</text>
        </g>
        <g
          v-for="o in block.ops"
          :key="o.id"
          class="pg-op"
          :class="[`pg-op-${o.op}`, { 'is-selected': o.id === props.selectedId }]"
          role="button"
          tabindex="0"
          @click="emit('select', o)"
          @keydown.enter.prevent="emit('select', o)"
          @keydown.space.prevent="emit('select', o)"
        >
          <rect :x="o.x" :y="o.y" :width="o.w" :height="o.h" rx="6" />
          <text :x="o.x + o.w / 2" :y="o.rows === undefined ? o.y + 32 : o.y + 24" class="pg-join-label">
            {{ clip(o.label, 28) }}
          </text>
          <text v-if="o.rows !== undefined" :x="o.x + o.w / 2" :y="o.y + 41" class="pg-op-rows">
            {{ o.rows.toLocaleString() }} 行
          </text>
        </g>
        <g
          v-for="ln in block.nodes"
          :key="ln.node.id"
          class="pg-node"
          :class="[nodeClassOf(ln.node), { 'is-selected': ln.node.id === props.selectedId }]"
          role="button"
          tabindex="0"
          @click="emit('select', ln.node)"
          @keydown.enter.prevent="emit('select', ln.node)"
          @keydown.space.prevent="emit('select', ln.node)"
        >
          <rect :x="ln.x" :y="ln.y" :width="ln.w" :height="ln.h" rx="6" />
          <text :x="ln.x + 10" :y="ln.y + 21" class="pg-label">{{ clip(ln.node.label) }}</text>
          <text :x="ln.x + 10" :y="ln.y + 39" class="pg-metrics">{{ clip(metrics(ln.node), 34) }}</text>
        </g>
      </g>
    </svg>
    <!-- **畳んだことを黙らない** -->
    <p v-if="layout.hidden > 0" class="pg-hidden">図に収まらなかったノードが他 {{ layout.hidden }} 件あります（ツリー表示ですべて見られます）</p>
    <!--
      **凡例は描いた形に合わせる。** 木のときの線はデータの流れ、
      縦並びのときは「同じブロック」でしかない——同じ文言で済ませると片方が嘘になる
    -->
    <p v-if="hasTree" class="pg-legend">
      矢印はデータの流れです（上のダイヤルから下へ）。破線の箱は記録そのものではなく、記録から導いた処理です
      （テーブル・プローブ＝索引だけでは足りず表から行を取り直す）
    </p>
    <p v-if="hasFlat" class="pg-legend">
      矢印の無い線は同じクエリブロックに属することを示します（処理の順序や依存ではありません）
    </p>
  </div>
</template>

<style scoped>
/* **ここではスクロールさせない。** スクロールの枠は親（`PlanViewer` の `.pv-main`）で、
   そちらは高さいっぱいに伸びる。ここで `overflow: auto` にすると枠が中身なりの高さになり、
   横スクロールバーが画面の途中に浮いて下が死んだ余白になる（利用者の指摘） */
.plan-graph {
  overflow: visible;
}
svg {
  display: block;
  max-width: none;
}
.pg-block-label {
  font-size: 11px;
  fill: var(--muted);
}
.pg-link {
  stroke: var(--line);
  stroke-width: 1.5;
  fill: none;
}
/* データの流れは色を付けて、ただの「同じブロック」の線と区別する */
.pg-link.flow {
  stroke: var(--sys-1);
}
.pg-arrow-head {
  fill: var(--sys-1);
}
/* 結合の節。ステップの箱と混ぜないよう塗りを変える */
.pg-join rect {
  fill: var(--accent-soft);
  stroke: var(--accent);
  stroke-width: 1.5;
  cursor: pointer;
}
/* 選択中は太らせ、地を敷く。**ステップの箱と同じ合図**にして、選べることを一目で分からせる。
   破線（＝導いた節）は破線のまま——選んだからといって由来の印を消さない */
.pg-join.is-selected rect,
.pg-op.is-selected rect {
  stroke-width: 3;
  fill: var(--accent-soft);
}
.pg-join:hover rect,
.pg-op:hover rect {
  stroke-width: 2.5;
}
/* 単項の節。**記録そのものではなく導いたもの**なので、枠を破線にして区別する */
.pg-op rect {
  fill: var(--card);
  stroke: var(--accent);
  stroke-width: 1.5;
  stroke-dasharray: 5 3;
  cursor: pointer;
}
/* 最終選択は木の根。実線・塗りありで「ここで終わり」を示す */
.pg-op-final-select rect {
  fill: var(--accent-soft);
  stroke-dasharray: none;
}
.pg-op-rows {
  font-size: 11px;
  fill: var(--muted);
  text-anchor: middle;
}
.pg-join-label {
  font-size: 12px;
  fill: var(--ink);
  text-anchor: middle;
}
.pg-node rect {
  fill: var(--card);
  stroke: var(--line);
  stroke-width: 1.5;
  cursor: pointer;
}
.pg-node:hover rect {
  stroke: var(--accent);
}
.pg-node.is-selected rect {
  stroke: var(--accent);
  stroke-width: 2.5;
  fill: var(--accent-soft);
}
/* 種別は枠線で分ける（塗り分けると選択状態が読めなくなる） */
.pn-access rect {
  stroke: var(--sys-1);
}
.pn-operation rect {
  stroke: var(--sys-3);
}
.pn-advice rect {
  stroke: var(--sys-6);
  stroke-dasharray: 4 3;
}
.pn-info rect {
  stroke: var(--sys-8);
}
.pn-other rect {
  stroke: var(--line);
  stroke-dasharray: 2 3;
}
.pg-label {
  font-size: 12px;
  fill: var(--ink);
}
.pg-metrics {
  font-size: 11px;
  fill: var(--muted);
}
.pg-hidden,
.pg-legend {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--muted);
}
</style>
