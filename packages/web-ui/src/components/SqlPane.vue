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
const maxRows = ref(200);
const columns = ref<Column[]>([]);
const rows = ref<Row[]>([]);
const truncated = ref(false);
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
          maxRows: maxRows.value
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
        truncated.value = false;
        executed.value = true;
        return;
      }
      columns.value = data.columns ?? [];
      rows.value = data.rows ?? [];
      truncated.value = Boolean(data.truncated);
      executed.value = true;
    } catch (e) {
      error.value = `実行に失敗しました: ${String(e)}`;
    }
  });
}

/** Ctrl+Enter で実行（textarea 内なので Enter は改行のまま残す） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canRun.value) {
    e.preventDefault();
    void execute();
  }
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
      <label>
        最大行数
        <input v-model.number="maxRows" type="number" min="1" max="1000" size="5" />
      </label>
      <button :disabled="!canRun" @click="execute">{{ loading ? "実行中…" : "実行" }}</button>
      <button v-if="rows.length" class="link" @click="download">CSV をダウンロード</button>
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
      SELECT のみ実行できます（Ctrl+Enter で実行）。<strong>最大行数は表示する行数の上限で、
      ホストから取り出す行数は絞りません。</strong>大きな表では SQL に
      <code>FETCH FIRST n ROWS ONLY</code> を付けてください。
    </p>

    <LoadingBar v-if="slowLoading" label="実行しています…" />

    <p v-if="error" class="error">
      {{ error }}
      <span v-if="sqlDetail" class="detail">（{{ sqlDetail }}）</span>
    </p>

    <p v-if="truncated" class="warn">
      最大行数 {{ maxRows }} 件で表示を打ち切りました。CSV も表示中の {{ rows.length }} 件のみです。
    </p>

    <table v-if="rows.length">
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
            <span v-else-if="isLob(r[c.name])" class="lob" title="LOB は値を取得していません（ロケーターのみ）">(LOB)</span>
            <template v-else>{{ r[c.name] }}</template>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-else-if="executed && !error && !loading" class="empty">該当する行はありません。</p>
    <p v-else-if="!executed && !error" class="empty">
      接続を選び、SELECT を入力して「実行」を押してください。取得できる範囲は IBM i の権限によります。
    </p>
  </div>
</template>

<style scoped>
.sql-pane { padding: 12px; overflow: auto; height: 100%; }
header { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
h2 { margin: 0; font-size: 13px; font-family: var(--mono); font-weight: 700; }
label { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--muted); }
.editor {
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
</style>
