<script setup lang="ts">
import { ref, computed } from "vue";
import { systemsStore } from "../stores/systems.js";
import LoadingBar from "./LoadingBar.vue";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";
import { csvBlob, csvFileName, isLob, toCsv } from "../csv.js";

/**
 * SQL の実行と CSV ダウンロード（ACS のデータ転送に相当する入り口）。
 *
 * 一覧ペインと同じ「特殊なタブ ID」方式で開く（`sql:query`）。
 * 取得できる範囲は IBM i の権限が決めるため、アプリ側で追加の制限は掛けない。
 *
 * **実行できるのは SELECT だけ**——サーバー側 `/api/host/sql` の実装がそうなっている
 * （結果セットを持たない文は describe の段階で落ちる）。UI でも SELECT 以外を勧めない。
 */
defineProps<{ tabId: string }>();

interface Column {
  name: string;
  typeName: string;
  nullable: boolean;
}
type Row = Record<string, string | number | boolean | null | { kind: "lob" }>;

const sql = ref("");
/** 1 度に取得する件数。**上限ではなく 1 回の読み足し量** */
const pageSize = ref(200);
const PAGE_SIZES = [50, 200, 500, 1000] as const;
/** LOB の中身も取るか。**既定オフ**——大きな LOB を無自覚に引かないため */
const fetchLob = ref(false);
const columns = ref<Column[]>([]);
const rows = ref<Row[]>([]);
const hasMore = ref(false);
const resultSetId = ref("");
const loadingMore = ref(false);
const expired = ref(false);
const executed = ref(false);
const { visible: slowLoading, busy: loading, run } = useDelayedLoading();
const error = ref("");
/** SQLCODE / SQLSTATE。これが無いと文法誤りと権限不足を区別できない */
const sqlDetail = ref("");

const canRun = computed(
  () => !loading.value && sql.value.trim().length > 0 && Boolean(systemsStore.selected)
);

async function execute(): Promise<void> {
  if (!systemsStore.selected) {
    error.value = "システムを選んでください";
    return;
  }
  if (!sql.value.trim()) return;
  error.value = "";
  sqlDetail.value = "";
  await run(async () => {
    try {
      const res = await fetch("/api/host/sql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: { system: systemsStore.selected },
          sql: sql.value,
          pageSize: pageSize.value,
          ...(fetchLob.value ? { lobMaxBytes: 65536 } : {})
        })
      });
      const data = await res.json();
      if (!res.ok) {
        error.value = data.error ?? "実行に失敗しました";
        // core のメッセージが既に SQLCODE を含むことがある（`prepare failed: SQLCODE=-204 …`）。
        // その場合に併記すると二重に出る（実ブラウザ確認で判明）
        if (data.sqlCode !== undefined && !String(error.value).includes("SQLCODE")) {
          sqlDetail.value = `SQLCODE=${data.sqlCode} SQLSTATE=${data.sqlState}`;
        }
        columns.value = [];
        rows.value = [];
        hasMore.value = false;
        resultSetId.value = "";
        executed.value = true;
        return;
      }
      columns.value = data.columns ?? [];
      rows.value = data.rows ?? [];
      hasMore.value = Boolean(data.hasMore);
      resultSetId.value = data.resultSetId ?? "";
      expired.value = false;
      executed.value = true;
    } catch (e) {
      error.value = `実行に失敗しました: ${String(e)}`;
    }
  });
}

/**
 * 続きを読み足す。**End / PageDown / スクロールのすべてがここを通る**。
 * 二重に走らせない（`loadingMore`）。
 */
async function loadMore(): Promise<void> {
  if (!hasMore.value || loadingMore.value || !resultSetId.value) return;
  loadingMore.value = true;
  try {
    const res = await fetch(`/api/host/sql/${resultSetId.value}/next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageSize: pageSize.value })
    });
    const data = await res.json();
    if (res.status === 404) {
      // **黙って空にしない**——期限切れだと分かるようにする
      expired.value = true;
      hasMore.value = false;
      return;
    }
    if (!res.ok) {
      error.value = data.error ?? "続きの取得に失敗しました";
      hasMore.value = false;
      return;
    }
    rows.value = [...rows.value, ...(data.rows ?? [])];
    hasMore.value = Boolean(data.hasMore);
  } catch (e) {
    error.value = `続きの取得に失敗しました: ${String(e)}`;
    hasMore.value = false;
  } finally {
    loadingMore.value = false;
  }
}

/** 表の下端に近づいたら読み足す */
function onScroll(e: Event): void {
  const el = e.target as HTMLElement;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) void loadMore();
}

/** End / PageDown でも読み足す（キーボードだけで使えるように） */
function onPaneKeydown(e: KeyboardEvent): void {
  if (e.key === "End" || e.key === "PageDown") void loadMore();
}

/** Ctrl+Enter で実行（textarea 内なので Enter は改行のまま残す） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canRun.value) {
    e.preventDefault();
    void execute();
  }
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

function download(): void {
  const csv = toCsv(
    columns.value.map((c) => c.name),
    rows.value
  );
  const url = URL.createObjectURL(csvBlob(csv));
  const a = document.createElement("a");
  a.href = url;
  a.download = csvFileName();
  a.click();
  // 解放しないと Blob がタブの寿命だけ残る
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="sql-pane admin">
    <header>
      <h2>SQL</h2>
      <label title="1 回の読み足しで取得する件数です（上限ではありません）">
        1 度に取得
        <select v-model.number="pageSize">
          <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }} 件</option>
        </select>
      </label>
      <label title="LOB は既定でロケーターのみ取得します。中身が要るときだけ有効にしてください（1 セル 64KB まで）">
        <input v-model="fetchLob" type="checkbox" />
        LOB の中身も取得
      </label>
      <button :disabled="!canRun" @click="execute">{{ loading ? "実行中…" : "実行" }}</button>
      <button v-if="rows.length" class="link" @click="download">
        CSV をダウンロード（表示中の {{ rows.length }} 件）
      </button>
    </header>

    <textarea
      v-model="sql"
      class="editor"
      rows="5"
      spellcheck="false"
      placeholder="SELECT * FROM QSYS2.SYSTABLES FETCH FIRST 100 ROWS ONLY"
      @keydown="onKeydown"
    ></textarea>
    <p class="hint">
      SELECT のみ実行できます（Ctrl+Enter で実行）。<strong>下までスクロールするか
      End / PageDown で続きを読み足します。</strong>「1 度に取得」はその 1 回ぶんの件数です。
    </p>

    <LoadingBar v-if="slowLoading" label="実行しています…" />

    <p v-if="error" class="error">
      {{ error }}
      <span v-if="sqlDetail" class="detail">（{{ sqlDetail }}）</span>
    </p>

    <p v-if="expired" class="warn">
      結果セットの保持期限が切れました。もう一度「実行」してください。
    </p>

    <div v-if="rows.length" class="rows-scroll" tabindex="0" @scroll="onScroll" @keydown="onPaneKeydown">
    <table>
      <thead>
        <tr>
          <th v-for="c in columns" :key="c.name" :title="`${c.typeName}${c.nullable ? '' : ' NOT NULL'}`">
            {{ c.name }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in rows" :key="i">
          <td v-for="c in columns" :key="c.name">
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

    <p v-else-if="executed && !error && !loading" class="empty">該当する行はありません。</p>
    <p v-else-if="!executed && !error" class="empty">
      接続を選び、SELECT を入力して「実行」を押してください。取得できる範囲は IBM i の権限によります。
    </p>
  </div>
</template>

<style scoped>
/* ペインは縦に積み、**表領域だけがスクロール**する。
   以前は .sql-pane 自体を overflow:auto にしていたため、表の高さを固定すると
   二重スクロールになり、ヘッダーが画面外へ押し出された */
.sql-pane { padding: 12px; height: 100%; display: flex; flex-direction: column; min-height: 0; box-sizing: border-box; }
header { flex: none; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
h2 { margin: 0; font-size: 13px; font-family: var(--mono); font-weight: 700; }
label { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--muted); }
.editor { flex: none;
  width: 100%;
  box-sizing: border-box;
  font-family: var(--mono);
  font-size: 13px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
  resize: vertical;
}
.hint { font-size: 12px; color: var(--muted); margin: 6px 0 10px; }
.hint code { font-family: var(--mono); }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 5px 8px; text-align: left; font-size: 13px; }
th { color: var(--muted); font-weight: 600; font-size: 12px; font-family: var(--mono); }
td { font-family: var(--mono); white-space: pre; }
.null { color: var(--muted); font-style: italic; }
.lob { color: var(--muted); font-style: italic; }
.error { color: #c62828; }
.detail { font-family: var(--mono); font-size: 12px; }
.warn { color: var(--muted); border-left: 3px solid var(--accent); padding-left: 8px; font-size: 12px; }
.empty { color: var(--muted); text-align: center; }
.rows-scroll { overflow: auto; flex: 1 1 auto; min-height: 0; border-top: 1px solid var(--line); }
/* 列見出しはスクロールしても残す */
.rows-scroll thead th { position: sticky; top: 0; background: var(--card); z-index: 1; }
.rows-scroll:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
.more { color: var(--muted); font-size: 12px; text-align: center; padding: 6px 0; }
</style>
