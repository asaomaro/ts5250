<script setup lang="ts">
/**
 * 実行計画のグラフ表示（**自前 SVG**）。
 *
 * 描画ライブラリを足さない（AGENTS.md のバンドル規律。`@ts5250/scs` のバレル参照で
 * 359,853 → 1,458,480 バイトにした実例がある）。座標の計算は `planLayout.ts` の
 * 純関数に切ってあり、ここは**写すだけ**。
 *
 * ## 縦線は「データの流れ」ではない
 *
 * DB モニターの記録は**演算子の親子を持たない**（`design.md` A1）。
 * 同じクエリブロックに属することを示すだけの線なので、矢印にしない。
 * 凡例を出して誤読させない。
 */
import { computed } from "vue";
import type { PlanBlock, PlanNode } from "../planApi.js";
import { layoutPlan, connectorsOf, nodeClassOf, MAX_NODES } from "../planLayout.js";

const props = withDefaults(
  defineProps<{
    blocks: PlanBlock[];
    selectedId?: string | undefined;
    maxNodes?: number;
  }>(),
  { maxNodes: MAX_NODES }
);

const emit = defineEmits<{ select: [node: PlanNode] }>();

const layout = computed(() => layoutPlan(props.blocks, props.maxNodes));

/** 箱に収まる長さで切る（省略記号は CSS ではなく文字で。SVG は text-overflow が効かない） */
function clip(s: string, max = 26): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 2 行目に出す数値。**無い値は書かない**（`-` を並べても読めない） */
function metrics(node: PlanNode): string {
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
      <g v-for="block in layout.blocks" :key="block.number">
        <text :x="block.x" :y="block.y + 12" class="pg-block-label">
          クエリブロック {{ block.number }}
        </text>
        <line
          v-for="(c, i) in connectorsOf(block)"
          :key="`c${i}`"
          :x1="c.x1"
          :y1="c.y1"
          :x2="c.x2"
          :y2="c.y2"
          class="pg-link"
        />
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
          <text :x="ln.x + 10" :y="ln.y + 39" class="pg-metrics">{{ clip(metrics(ln.node), 30) }}</text>
        </g>
      </g>
    </svg>
    <!-- **畳んだことを黙らない** -->
    <p v-if="layout.hidden > 0" class="pg-hidden">図に収まらなかったノードが他 {{ layout.hidden }} 件あります（ツリー表示ですべて見られます）</p>
    <p class="pg-legend">線は同じクエリブロックに属することを示します（処理の順序や依存ではありません）</p>
  </div>
</template>

<style scoped>
.plan-graph {
  overflow: auto;
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
