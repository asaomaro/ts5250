<script setup lang="ts">
/**
 * 実行計画のビューア。**グラフ／ツリーを切り替えて見る**。
 *
 * ## 階層は 3 層で、演算子木ではない
 *
 * 文 → クエリブロック（`QQQDTN`）→ ノード（`design.md` A1）。
 * DB モニターの記録に親子リンクは無いので、**推定で木を組まない**。
 * ツリー表示もこの 3 層をそのまま出す。
 *
 * ## 知らない記録種別を隠さない
 *
 * 実測で中身を確かめた 3 種（`3000`/`3001`/`3020`）だけが名前を持ち、
 * 残りは「記録 nnnn」として生の属性を見せる（`design.md` A2）。
 * 未対応の種別は**警告ではなく淡々と**出す——毎回出ると、7.5 だけに出る `3015` のような
 * 版数差の信号が埋もれる。
 */
import { computed, ref, watch } from "vue";
import PlanGraph from "./PlanGraph.vue";
import type { IndexAdvice, PlanNode, QueryPlan } from "../planApi.js";
import { diffPlans } from "../planStore.js";
import {
  MSG_PLAN_CREATE_INDEX_CONFIRM,
  MSG_PLAN_UNKNOWN_RECORDS
} from "../composables/opMessages.js";

const props = defineProps<{
  plan: QueryPlan;
  /** 比較の相手。指定すると比較表示になる */
  compareWith?: QueryPlan | undefined;
  /** 索引作成を実行する（親が `/api/host/sql` へ送る）。**未指定なら文を見せるだけ** */
  onCreateIndex?: ((advice: IndexAdvice) => Promise<void>) | undefined;
}>();

type ViewMode = "graph" | "tree";
const view = ref<ViewMode>("graph");
const selected = ref<PlanNode | undefined>();
const creating = ref("");
const createError = ref("");

// 計画が差し替わったら選択を捨てる（前の計画のノードを指したままにしない）
watch(
  () => props.plan,
  () => {
    selected.value = undefined;
    createError.value = "";
  }
);

const allNodes = computed(() => props.plan.blocks.flatMap((b) => b.nodes));
/**
 * **付帯情報は図に出さない。** `3006`（アクセスプランの再作成）や `3014`（クエリ情報）は
 * ほぼ全文で出るので、計画のステップと同じ列に並べると図が埋まる。脇にまとめる。
 */
const infoNodes = computed(() => allNodes.value.filter((n) => n.category === "info"));
const diff = computed(() => (props.compareWith ? diffPlans(props.plan, props.compareWith) : undefined));

function select(node: PlanNode): void {
  selected.value = node;
}

async function createIndex(advice: IndexAdvice): Promise<void> {
  if (!props.onCreateIndex) return;
  // **取り消せない操作なので確認を取る**（spec「索引の作成」）
  if (!globalThis.confirm?.(`${MSG_PLAN_CREATE_INDEX_CONFIRM}\n\n${advice.createStatement}`)) return;
  creating.value = advice.createStatement;
  createError.value = "";
  try {
    await props.onCreateIndex(advice);
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e);
  } finally {
    creating.value = "";
  }
}
</script>

<template>
  <div class="plan-viewer">
    <header class="pv-head">
      <div class="pv-modes" role="group" aria-label="表示の切替">
        <button type="button" class="theme-btn" :class="{ on: view === 'graph' }" @click="view = 'graph'">
          グラフ
        </button>
        <button type="button" class="theme-btn" :class="{ on: view === 'tree' }" @click="view = 'tree'">
          ツリー
        </button>
      </div>
      <dl class="pv-summary">
        <div><dt>ステップ</dt><dd>{{ plan.summary.stepCount }}</dd></div>
        <div><dt>ノード計</dt><dd>{{ plan.summary.nodeCount }}</dd></div>
        <div><dt>ブロック</dt><dd>{{ plan.summary.blockCount }}</dd></div>
        <div><dt>表</dt><dd>{{ plan.summary.tables.join(", ") || "-" }}</dd></div>
        <div><dt>索引</dt><dd>{{ plan.summary.indexes.join(", ") || "-" }}</dd></div>
        <div v-if="plan.summary.maxEstimatedMs !== undefined"><dt>推定最大</dt><dd>{{ plan.summary.maxEstimatedMs }} ms</dd></div>
        <div v-if="plan.summary.elapsedMs !== undefined"><dt>実測</dt><dd>{{ plan.summary.elapsedMs }} ms</dd></div>
      </dl>
    </header>

    <!-- 比較 -->
    <section v-if="diff" class="pv-diff">
      <h3>比較</h3>
      <table class="pv-table">
        <thead><tr><th>項目</th><th>この計画</th><th>比較相手</th></tr></thead>
        <tbody>
          <tr v-for="row in diff.summary" :key="row.label" :class="{ changed: row.changed }">
            <th scope="row">{{ row.label }}</th>
            <td>{{ row.left }}</td>
            <td>{{ row.right }}</td>
          </tr>
        </tbody>
      </table>
      <ul class="pv-node-diff">
        <li v-for="n in diff.nodes" :key="n.key" :class="n.state">
          <span class="pv-state">{{
            n.state === "same" ? "同じ" : n.state === "changed" ? "変化" : n.state === "left-only" ? "この計画のみ" : "相手のみ"
          }}</span>
          {{ n.label }}
        </li>
      </ul>
    </section>

    <div class="pv-body">
      <div class="pv-main">
        <PlanGraph v-if="view === 'graph'" :blocks="plan.blocks" :selected-id="selected?.id" @select="select" />
        <ul v-else class="pv-tree">
          <li v-for="block in plan.blocks" :key="block.number">
            <span class="pv-block">クエリブロック {{ block.number }}</span>
            <ul>
              <li v-for="node in block.nodes.filter((n) => n.category === 'step')" :key="node.id">
                <button
                  type="button"
                  class="pv-tree-node"
                  :class="[`pn-${node.kind}`, { on: node.id === selected?.id }]"
                  @click="select(node)"
                >
                  {{ node.label }}
                  <small v-if="node.estimatedRows !== undefined">推定 {{ node.estimatedRows.toLocaleString() }} 行</small>
                  <small v-if="node.reasonCode">理由 {{ node.reasonCode }}</small>
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </div>

      <aside class="pv-side">
        <section>
          <h3>ノードの詳細</h3>
          <p v-if="!selected" class="pv-empty">ノードを選ぶと詳細が出ます</p>
          <dl v-else class="pv-attrs">
            <div v-for="a in selected.attributes" :key="a.label">
              <dt>{{ a.label }}</dt>
              <dd>{{ a.value }}</dd>
            </div>
          </dl>
        </section>

        <section v-if="infoNodes.length > 0">
          <h3>付帯情報（{{ infoNodes.length }} 件）</h3>
          <ul class="pv-info-list">
            <li v-for="n in infoNodes" :key="n.id">
              <button type="button" class="pv-info-item" :class="{ on: n.id === selected?.id }" @click="select(n)">
                {{ n.label }}
              </button>
            </li>
          </ul>
        </section>

        <section v-if="plan.advice.length > 0">
          <h3>索引の助言（{{ plan.advice.length }} 件）</h3>
          <ul class="pv-advice">
            <li v-for="(a, i) in plan.advice" :key="i">
              <div class="pv-advice-table">{{ a.table.schema }}.{{ a.table.name }}</div>
              <code>{{ a.createStatement }}</code>
              <button
                v-if="props.onCreateIndex"
                type="button"
                class="theme-btn"
                :disabled="creating !== ''"
                @click="createIndex(a)"
              >
                {{ creating === a.createStatement ? "作成中…" : "この索引を作成" }}
              </button>
            </li>
          </ul>
          <p v-if="createError" class="pv-error">{{ createError }}</p>
        </section>

        <!-- **警告にしない。** 淡々と事実として出す -->
        <section v-if="plan.unknownRecordTypes.length > 0">
          <h3>{{ MSG_PLAN_UNKNOWN_RECORDS }}</h3>
          <p class="pv-unknown">{{ plan.unknownRecordTypes.join(", ") }}</p>
          <p class="pv-note">名前を付けていない記録です。中身は「記録 nnnn」のノードの詳細で見られます</p>
        </section>
      </aside>
    </div>

    <p class="pv-meta">
      採取: {{ plan.captured === "run" ? "実行して計画" : plan.captured === "no-rows" ? "行を返さず計画" : "プランキャッシュ" }}
      / {{ plan.at }}
      <template v-if="plan.job"> / ジョブ {{ plan.job }}</template>
      / ノード総数 {{ allNodes.length }}
    </p>
  </div>
</template>

<style scoped>
.plan-viewer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.pv-head {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}
.pv-modes {
  display: flex;
  gap: 4px;
}
.theme-btn.on {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.pv-summary {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin: 0;
  font-size: 12px;
}
.pv-summary div {
  display: flex;
  gap: 4px;
}
.pv-summary dt {
  color: var(--muted);
}
.pv-summary dd {
  margin: 0;
  color: var(--ink);
}
.pv-body {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  min-height: 0;
}
.pv-main {
  flex: 1 1 auto;
  min-width: 0;
  overflow: auto;
}
.pv-side {
  flex: 0 0 280px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12px;
}
.pv-side h3 {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--muted);
}
.pv-empty,
.pv-note {
  color: var(--muted);
  margin: 0;
}
.pv-attrs div {
  display: flex;
  gap: 6px;
  border-bottom: 1px solid var(--line);
  padding: 2px 0;
}
.pv-attrs dt {
  flex: 0 0 110px;
  color: var(--muted);
}
.pv-attrs dd {
  margin: 0;
  word-break: break-all;
}
.pv-tree {
  list-style: none;
  padding-left: 0;
  margin: 0;
}
.pv-tree ul {
  list-style: none;
  padding-left: 14px;
  margin: 2px 0 8px;
}
.pv-block {
  font-size: 11px;
  color: var(--muted);
}
.pv-tree-node {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px 8px;
  margin: 2px 0;
  cursor: pointer;
  color: var(--ink);
}
.pv-tree-node.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.pv-tree-node small {
  color: var(--muted);
  margin-left: 8px;
}
.pn-access {
  border-left: 3px solid var(--sys-1);
}
.pn-operation {
  border-left: 3px solid var(--sys-3);
}
.pn-advice {
  border-left: 3px solid var(--sys-6);
}
.pn-info {
  border-left: 3px solid var(--sys-8);
}
.pv-info-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.pv-info-item {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 3px 6px;
  margin: 2px 0;
  cursor: pointer;
  color: var(--muted);
  font-size: 11px;
}
.pv-info-item.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--ink);
}
.pv-advice {
  list-style: none;
  padding: 0;
  margin: 0;
}
.pv-advice li {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 6px;
  margin-bottom: 6px;
}
.pv-advice code {
  display: block;
  word-break: break-all;
  margin: 4px 0;
  font-size: 11px;
}
.pv-advice-table {
  color: var(--muted);
}
.pv-error {
  color: var(--t-red);
}
.pv-table {
  border-collapse: collapse;
  font-size: 12px;
}
.pv-table th,
.pv-table td {
  border: 1px solid var(--line);
  padding: 2px 8px;
  text-align: left;
}
.pv-table tr.changed td {
  background: var(--accent-soft);
}
.pv-node-diff {
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
  font-size: 12px;
}
.pv-node-diff .pv-state {
  display: inline-block;
  min-width: 6em;
  color: var(--muted);
}
.pv-node-diff li.changed .pv-state,
.pv-node-diff li.left-only .pv-state,
.pv-node-diff li.right-only .pv-state {
  color: var(--accent);
}
.pv-unknown {
  margin: 0;
  font-family: monospace;
}
.pv-meta {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
}
</style>
