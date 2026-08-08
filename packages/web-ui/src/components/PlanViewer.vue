<script setup lang="ts">
/**
 * 実行計画のビューア。**グラフ／ツリーを切り替えて見る**。
 *
 * ## 結合しているときだけ木になる
 *
 * 文 → クエリブロック（`QQQDTN`）→ ノード、が土台（`design.md` A1）。
 * そのうえで**結合の順位は `QQJNP`（ダイヤル）が持っている**ので、
 * 結合のある計画は「ダイヤル → 結合」の木として出す（A1 の訂正）。
 * 結合していない計画は今までどおり並べるだけ——**無い階層をでっち上げない**。
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
import type { IndexAdvice, PlanAttribute, PlanBlock, PlanNode, QueryPlan } from "../planApi.js";
import { flattenJoinTree, type PlanSelection } from "../planLayout.js";
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
/**
 * 選択中のもの。**記録のノードとは限らない**——結合・テーブル・プローブ・最終選択も選べる
 * （ACS と同じ）。共通の形（`id` / `label` / `attributes`）だけを持つので、
 * 詳細パネルは何を選んだかで分岐しなくてよい。`PlanNode` は構造的にこれを満たす。
 */
const selected = ref<PlanSelection | undefined>();
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

/**
 * ツリー表示の並び。**図（`PlanGraph`）と同じ開き方**をするため
 * `flattenJoinTree` を共有する（2 か所で開くと図と一覧で順序がずれる）。
 *
 * 結合が無いブロックは見出しの無い 1 群——今までの見え方を変えない。
 */
interface TreeGroup {
  key: string;
  label: string;
  nodes: PlanNode[];
}

function groupsOf(block: PlanBlock): TreeGroup[] {
  const steps = block.nodes.filter((n) => n.category === "step");
  const flat = block.joinTree ? flattenJoinTree(block.joinTree) : undefined;
  if (!flat) return [{ key: `b${block.number}`, label: "", nodes: steps }];
  const out: TreeGroup[] = flat.dials.map((d) => ({
    key: d.id,
    label: `ダイヤル ${d.position}`,
    nodes: d.nodes
  }));
  // **ダイヤルに属さないステップも必ず出す**（索引の助言など。落とすと図より情報が減る）
  const others = steps.filter((n) => n.joinPosition === undefined);
  if (others.length > 0) out.push({ key: `b${block.number}-others`, label: "ダイヤルに属さない", nodes: others });
  return out;
}

/**
 * 背骨（結合とその後の処理）を上から順に文にする。
 * **図と同じ並び**になるよう `flattenJoinTree` を共有する。
 */
function spineOf(block: PlanBlock): { key: string; text: string; item: PlanSelection }[] {
  const flat = block.joinTree ? flattenJoinTree(block.joinTree) : undefined;
  if (!flat) return [];
  const joined: number[] = [];
  return flat.spine.map((item) => {
    const sel: PlanSelection = { id: item.id, label: item.label, attributes: item.attributes };
    if (item.kind === "join") {
      const before = joined.length > 0 ? joined.join("・") : String(flat.dials[0]?.position ?? 1);
      if (joined.length === 0) joined.push(flat.dials[0]?.position ?? 1);
      const rightPos = flat.dials[item.dialIndex]?.position;
      joined.push(rightPos ?? item.dialIndex + 1);
      return { key: item.id, text: `ダイヤル ${before} と ${rightPos} を ${item.label}`, item: sel };
    }
    return {
      key: item.id,
      text: item.rows !== undefined ? `${item.label}（${item.rows.toLocaleString()} 行）` : item.label,
      item: sel
    };
  });
}

/**
 * 詳細を節ごとに束ねる。ACS の詳細ダイアログと同じ見え方にするため。
 *
 * **節の並びは属性が現れた順**——`plan-model.ts` が意味の分かるものから並べているので、
 * ここで並べ替えると「確かめた項目が先」という並びが崩れる。
 * 節名が無い項目は先頭の束に入れる（節を持たない古い計画 JSON を読んでも壊れない）。
 */
const detailGroups = computed<{ name: string; raw: boolean; items: PlanAttribute[] }[]>(() => {
  const out: { name: string; raw: boolean; items: PlanAttribute[] }[] = [];
  for (const a of selected.value?.attributes ?? []) {
    const name = a.group ?? "";
    const found = out.find((g) => g.name === name);
    if (found) found.items.push(a);
    else out.push({ name, raw: a.raw === true, items: [a] });
  }
  return out;
});

const allNodes = computed(() => props.plan.blocks.flatMap((b) => b.nodes));
/**
 * **付帯情報は図に出さない。** `3006`（アクセスプランの再作成）や `3014`（クエリ情報）は
 * ほぼ全文で出るので、計画のステップと同じ列に並べると図が埋まる。脇にまとめる。
 */
const infoNodes = computed(() => allNodes.value.filter((n) => n.category === "info"));
const diff = computed(() => (props.compareWith ? diffPlans(props.plan, props.compareWith) : undefined));

function select(item: PlanSelection): void {
  selected.value = item;
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
              <li v-for="g in groupsOf(block)" :key="g.key">
                <!-- 結合が無いブロックでは見出しを出さない（今までの見え方を変えない） -->
                <span v-if="g.label" class="pv-dial">{{ g.label }}</span>
                <ul :class="{ 'pv-plain': !g.label }">
                  <li v-for="node in g.nodes" :key="node.id">
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
              <!-- 結合の順。**ダイヤルの下**に置いて「重ねていく」順に読ませる。
                   図と同じく**選んで詳細が見られる** -->
              <li v-for="j in spineOf(block)" :key="j.key" class="pv-join-step">
                <button
                  type="button"
                  class="pv-spine-btn"
                  :class="{ on: j.key === selected?.id }"
                  @click="select(j.item)"
                >
                  {{ j.text }}
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </div>

      <aside class="pv-side">
        <section>
          <h3>ノードの詳細</h3>
          <p v-if="!selected" class="pv-empty">図の箱を選ぶと詳細が出ます</p>
          <template v-else>
          <p class="pv-selected-label">{{ selected.label }}</p>
          <!--
            節ごとに区切る（ACS の詳細ダイアログと同じ）。
            「モニターの記録（列名のまま）」に入っているものは**意味を確かめていない列**で、
            名前を与えていないことが節の見出しで分かる
          -->
          <!--
            **ここだけをスクロールさせる。** 「最終選択」は 160 項目を超える（ACS も同じ量）ので、
            そのまま流すと図が画面外へ押し出される
          -->
          <div class="pv-attr-scroll">
            <template v-for="g in detailGroups.filter((x) => !x.raw)" :key="g.name">
              <h4 v-if="g.name" class="pv-attr-group">{{ g.name }}</h4>
              <dl class="pv-attrs">
                <div v-for="a in g.items" :key="a.label">
                  <dt>{{ a.label }}</dt>
                  <dd>{{ a.value }}</dd>
                </div>
              </dl>
            </template>
            <!--
              **確かめた項目を先に、モニターの全列は畳んで後ろに置く**——
              全部並べると 100 項目を超えて、読みたい数行が埋もれる
            -->
            <details v-for="g in detailGroups.filter((x) => x.raw)" :key="g.name" class="pv-attr-more">
              <summary>{{ g.name }}（{{ g.items.length }} 件）</summary>
              <dl class="pv-attrs">
                <div v-for="a in g.items" :key="a.column ?? a.label">
                  <!-- 論理名が取れた列は名前で出し、**列の ID も添える**（ACS と突き合わせるため） -->
                  <dt>
                    {{ a.label }}
                    <small v-if="a.column && a.column !== a.label" class="pv-col-id">{{ a.column }}</small>
                  </dt>
                  <dd>{{ a.value }}</dd>
                </div>
              </dl>
            </details>
          </div>
          </template>
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
/*
 * 見出しは動かさず、**図と詳細がそれぞれ自分でスクロールする**。
 *
 * 以前は外側（`SqlPane` の `.plan-view` / `PlanListPane` の `.pl-viewer`）が
 * まとめてスクロールしていたため、(1) 図・詳細・ペイン全体で縦棒が 3 本出る、
 * (2) 図の横棒が SVG の直後＝画面の途中に出て、その下が死んだ余白になる、
 * という状態だった（利用者の指摘）。**高さを親から貰い切る**形に直してある。
 */
.plan-viewer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
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
  /* **伸ばす**（flex-start だと子が中身なりの高さになり、下に余白が残る） */
  align-items: stretch;
  flex: 1 1 auto;
  min-height: 0;
}
/* 図側。**ここが唯一のスクロール枠**——横棒が枠の下端に出る */
.pv-main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
/* 詳細側。**図とは別に縦スクロールする** */
.pv-side {
  flex: 0 0 280px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12px;
  min-height: 0;
  overflow-y: auto;
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
.pv-dial {
  font-size: 11px;
  color: var(--muted);
}
/* 見出しの無い群は入れ子のぶんの字下げを戻す（従来の見え方を保つ） */
.pv-plain {
  padding-left: 0;
  margin-left: -14px;
}
.pv-join-step {
  font-size: 12px;
  padding: 0 0 0 6px;
  border-left: 2px solid var(--accent);
  margin-top: 4px;
}
.pv-spine-btn {
  border: 1px solid transparent;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: left;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.pv-spine-btn:hover {
  background: var(--accent-soft);
}
.pv-spine-btn.on {
  background: var(--accent-soft);
  border-color: var(--accent);
}
/* 何を選んでいるかを詳細の頭に出す。図の外（ツリー表示）から選んだときに要る */
.pv-selected-label {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
}
/* 節の見出し。**名前を与えた項目と生の列名を見分ける唯一の手がかり**なので薄くしすぎない */
.pv-attr-group {
  margin: 8px 0 3px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  padding-bottom: 2px;
}
.pv-attr-group:first-child {
  margin-top: 0;
}
/* 詳細の中身。**ここではスクロールさせない**——`.pv-side` が枠ごとスクロールするので、
   入れ子にすると縦棒が 2 本並ぶ（以前は親の高さが決まらず 55vh で頭打ちにしていた） */
/* モニターの全列。**既定は畳む**——読みたい数行が 100 項目に埋もれないように */
.pv-attr-more {
  margin-top: 8px;
}
.pv-attr-more summary {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  cursor: pointer;
  border-bottom: 1px solid var(--line);
  padding-bottom: 2px;
}
/* 列の ID。論理名の脇に小さく添える（ACS や IBM の資料と突き合わせるため） */
.pv-col-id {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  margin-left: 4px;
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
