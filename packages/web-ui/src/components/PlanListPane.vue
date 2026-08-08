<script setup lang="ts">
/**
 * 実行計画の一覧（ACS の Performance Center 相当の入口）。
 *
 * ## ソースが 2 つあり、**特権の要否が違う**
 *
 * | ソース | 中身 | 特権 |
 * |---|---|---|
 * | プランキャッシュ | システム上の計画（他の利用者のものも） | **要**（`*JOBCTL` 等） |
 * | 実行履歴 | このアプリで採った計画（`planStore`） | **不要** |
 *
 * 実測（`20260802-sql-visual-explain` research F15）で、特権が無い接続では
 * `SQLCODE -443 / SQLSTATE 38501` が返る。サーバーはそれを `available:false` ＋ 理由に畳むので、
 * **画面は「使えない理由」を出したうえで履歴側へ逃がす**。黙って空の一覧にしない。
 */
import { computed, ref, watch } from "vue";
import PlanViewer from "./PlanViewer.vue";
import { fetchPlan, fetchPlanList, type PlanListItem, type QueryPlan } from "../planApi.js";
import { planStore, removeSaved, exportPlans, importPlans, savePlan } from "../planStore.js";
import {
  MSG_PLAN_CACHE_FALLBACK,
  MSG_PLAN_SAVE_DROPPED,
  MSG_PLAN_SAVE_NOT_PERSISTED
} from "../composables/opMessages.js";

const props = defineProps<{ tabId: string; active?: boolean; system?: string }>();

type Source = "cache" | "history" | "saved";
const source = ref<Source>("cache");
const topN = ref(20);
const TOP_N_CHOICES = [10, 20, 50, 100] as const;

const items = ref<PlanListItem[]>([]);
const available = ref(true);
const reason = ref("");
const loading = ref(false);
const error = ref("");
const notice = ref("");

const plan = ref<QueryPlan | undefined>();
/** 比較の相手（選ぶと 2 つ並べる） */
const compareWith = ref<QueryPlan | undefined>();

const historyItems = computed(() => planStore.history);
const savedItems = computed(() => planStore.saved);

async function reload(): Promise<void> {
  if (source.value !== "cache" || !props.system) return;
  loading.value = true;
  error.value = "";
  try {
    const res = await fetchPlanList({ source: props.system, topN: topN.value });
    available.value = res.available;
    reason.value = res.reason ?? "";
    items.value = res.items;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    items.value = [];
  } finally {
    loading.value = false;
  }
}

async function openFromCache(id: string): Promise<void> {
  if (!props.system) return;
  loading.value = true;
  error.value = "";
  try {
    plan.value = await fetchPlan({ source: props.system, id, topN: topN.value });
  } catch (e) {
    // **「消えた」を黙らない**（プランキャッシュは変わりうる）
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function save(): void {
  if (!plan.value) return;
  const { dropped, persisted } = savePlan(plan.value);
  // **書けなかったことを黙らない**（次に開いたとき消えている）
  if (!persisted) {
    error.value = MSG_PLAN_SAVE_NOT_PERSISTED;
    notice.value = "";
    return;
  }
  error.value = "";
  notice.value = dropped > 0 ? MSG_PLAN_SAVE_DROPPED : "保存しました";
}

function download(): void {
  const text = exportPlans(planStore.saved);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "ts5250-plans.json";
  a.click();
  URL.revokeObjectURL(url);
}

async function upload(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  error.value = "";
  try {
    const added = importPlans(await file.text());
    notice.value = `${added.length} 件を読み込みました`;
    source.value = "saved";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// タブが見えているときだけ読みに行く（裏で働かせない）
watch(
  () => [props.active, props.system, source.value, topN.value] as const,
  () => {
    if (props.active) void reload();
  },
  { immediate: true }
);
</script>

<template>
  <div class="plan-list">
    <header class="pl-head">
      <div role="group" aria-label="ソースの切替" class="pl-sources">
        <button type="button" class="theme-btn" :class="{ on: source === 'cache' }" @click="source = 'cache'">
          プランキャッシュ
        </button>
        <button type="button" class="theme-btn" :class="{ on: source === 'history' }" @click="source = 'history'">
          実行履歴（{{ historyItems.length }}）
        </button>
        <button type="button" class="theme-btn" :class="{ on: source === 'saved' }" @click="source = 'saved'">
          保存済み（{{ savedItems.length }}）
        </button>
      </div>
      <label v-if="source === 'cache'" class="pl-topn">
        件数
        <select v-model.number="topN">
          <option v-for="n in TOP_N_CHOICES" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <button v-if="source === 'cache'" type="button" class="theme-btn" :disabled="loading" @click="reload()">
        再読み込み
      </button>
      <span class="pl-spacer" />
      <button type="button" class="theme-btn" :disabled="!plan" @click="save()">この計画を保存</button>
      <button type="button" class="theme-btn" :disabled="savedItems.length === 0" @click="download()">
        JSON で書き出す
      </button>
      <label class="theme-btn pl-file">
        JSON を読み込む
        <input type="file" accept="application/json" @change="upload" />
      </label>
    </header>

    <p v-if="notice" class="pl-notice">{{ notice }}</p>
    <p v-if="error" class="pl-error">{{ error }}</p>

    <div class="pl-body">
      <div class="pl-items">
        <!-- **権限が無いことを黙らない。理由を出して履歴へ逃がす** -->
        <div v-if="source === 'cache' && !available" class="pl-unavailable">
          <p>{{ reason }}</p>
          <p class="pl-hint">{{ MSG_PLAN_CACHE_FALLBACK }}</p>
          <button type="button" class="theme-btn" @click="source = 'history'">実行履歴を見る</button>
        </div>
        <ul v-else-if="source === 'cache'" class="pl-list">
          <li v-if="items.length === 0 && !loading" class="pl-empty">計画がありません</li>
          <li v-for="it in items" :key="it.id">
            <button type="button" class="pl-item" @click="openFromCache(it.id)">
              <span class="pl-stmt">{{ it.statement }}</span>
              <small>{{ it.tables.join(", ") || "-" }} / 記録 {{ it.recordCount }} 件</small>
            </button>
          </li>
        </ul>
        <ul v-else class="pl-list">
          <li v-if="(source === 'history' ? historyItems : savedItems).length === 0" class="pl-empty">
            まだありません
          </li>
          <li v-for="entry in source === 'history' ? historyItems : savedItems" :key="entry.id">
            <button type="button" class="pl-item" @click="plan = entry.plan">
              <span class="pl-stmt">{{ entry.name }}</span>
              <small>{{ entry.plan.at }}</small>
            </button>
            <button
              type="button"
              class="pl-mini"
              title="この計画を比較の相手にする"
              @click="compareWith = entry.plan"
            >
              比較
            </button>
            <button v-if="source === 'saved'" type="button" class="pl-mini" @click="removeSaved(entry.id)">
              削除
            </button>
          </li>
        </ul>
      </div>

      <div class="pl-viewer">
        <p v-if="!plan" class="pl-empty">計画を選ぶとここに出ます</p>
        <template v-else>
          <div v-if="compareWith" class="pl-compare-head">
            比較中
            <button type="button" class="pl-mini" @click="compareWith = undefined">比較をやめる</button>
          </div>
          <PlanViewer :plan="plan" :compare-with="compareWith" />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 8px;
}
.pl-head {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.pl-sources {
  display: flex;
  gap: 4px;
}
.theme-btn.on {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.pl-spacer {
  margin-left: auto;
}
.pl-file input {
  display: none;
}
.pl-topn {
  font-size: 12px;
  color: var(--muted);
}
.pl-body {
  display: flex;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
}
.pl-items {
  flex: 0 0 300px;
  overflow: auto;
  border-right: 1px solid var(--line);
  padding-right: 8px;
}
/* ビューアの枠。**ここではスクロールさせない**——図と詳細がそれぞれ自分でスクロールする
   （`PlanViewer` の `.pv-main` / `.pv-side`）。ここを `auto` にすると、
   一覧以外の領域にもう 1 本、全体の縦棒が出る（利用者の指摘） */
.pl-viewer {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 中の `PlanViewer` に高さを渡す（`height: 100%` の受け皿になる） */
.pl-viewer :deep(.plan-viewer) {
  flex: 1 1 auto;
  min-height: 0;
}
/* 比較の見出しなど、ビューアの前に置くものは縮めない */
.pl-viewer > .pl-compare-head,
.pl-viewer > .pl-empty {
  flex: none;
}
.pl-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.pl-list li {
  display: flex;
  gap: 4px;
  align-items: center;
  border-bottom: 1px solid var(--line);
}
.pl-item {
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  background: none;
  border: none;
  padding: 6px 4px;
  cursor: pointer;
  color: var(--ink);
}
.pl-stmt {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.pl-item small {
  color: var(--muted);
  font-size: 11px;
}
.pl-mini {
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  font-size: 11px;
  padding: 1px 5px;
  cursor: pointer;
  color: var(--muted);
}
.pl-unavailable {
  border: 1px dashed var(--line);
  border-radius: 4px;
  padding: 10px;
  font-size: 12px;
}
.pl-hint,
.pl-empty {
  color: var(--muted);
  font-size: 12px;
}
.pl-notice {
  color: var(--muted);
  font-size: 12px;
  margin: 0;
}
.pl-error {
  color: var(--t-red);
  font-size: 12px;
  margin: 0;
}
.pl-compare-head {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}
</style>
