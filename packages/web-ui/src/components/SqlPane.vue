<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { systemsStore } from "../stores/systems.js";
import LoadingBar from "./LoadingBar.vue";
import PaneSplitter from "./PaneSplitter.vue";
import { usePaneSplit } from "../composables/usePaneSplit.js";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";
import { useColumnWidths } from "../composables/useColumnWidths.js";
import { csvBlob, csvFileName, isLob, toCsv } from "../csv.js";
import SqlLogPanel from "./SqlLogPanel.vue";
import { appendSqlLog, type SqlLogEntry } from "../sqlLog.js";

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

/** フッターに出す直近の 1 件（開かなくても最後の結果が分かるように） */
const lastLog = computed<SqlLogEntry | undefined>(() => logEntries.value[logEntries.value.length - 1]);

const canRun = computed(
  () => !loading.value && sql.value.trim().length > 0 && Boolean(systemsStore.selected)
);

/**
 * 実行ログ。**フッターのボタンで開く**（5250 セッションの操作ログと同じ作法）。
 * 状態はここが持ち、パネルは結果領域に重ねる。
 *
 * ⚠ SQL 文をそのまま持つので、**サーバーへは送らない**（`sqlLog.ts` の理由）。
 */
const logEntries = ref<SqlLogEntry[]>([]);
const logOpen = ref(false);

function record(e: Omit<SqlLogEntry, "id" | "ts">): void {
  logEntries.value = appendSqlLog(logEntries.value, { ...e, ts: Date.now() });
}

interface ConnectionInfo {
  job?: string;
  host?: string;
  port?: number;
  reused?: boolean;
  ms?: number;
}

/**
 * いまこのペインの後ろにあるホスト接続。フッターに出す。
 *
 * **使い回し（reused）でも更新する**——ログ行と違って「いつ張り直したか」ではなく
 * 「いまどのジョブに繋がっているか」を示すので、毎回の応答が最新の答えになる。
 */
const conn = ref<ConnectionInfo | undefined>();
/** フッター用の接続先表記（host:port）。ホスト不明なら出さない */
const connTarget = computed(() => (conn.value?.host ? `${conn.value.host}:${conn.value.port ?? "?"}` : ""));

/**
 * 接続の確立を記録する。**張り直したときだけ**——使い回した場合は接続が
 * 起きていないので出さない（毎回同じ行が並ぶと本当に張り直した回が埋もれる）。
 */
function recordConnection(info: ConnectionInfo | undefined): void {
  // ログに出すかとは別に、フッターの表示は常に最新へ更新する
  if (info) conn.value = info;
  if (!info || info.reused) return;
  record({
    kind: "connect",
    sql: "",
    status: "ok",
    ms: info.ms ?? 0,
    ...(info.job ? { job: info.job } : {}),
    ...(info.host ? { target: `${info.host}:${info.port ?? "?"}` } : {})
  });
}

/**
 * 接続を先に暖めておく。
 *
 * ホストへの接続確立に約 4.6 秒かかる（うち 2.1 秒は database ポートの
 * TLS ハンドシェイクで、こちらでは短くできない）。**利用者が SQL を打っている間**に
 * 済ませておけば、「実行」を押してからの待ちが SQL 本体ぶんだけになる。
 *
 * 失敗しても実行時に開き直せばよいので、**画面には何も出さない**。
 */
function warmUp(): void {
  if (!systemsStore.selected) return;
  void fetch("/api/host/sql/warm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { system: systemsStore.selected } })
  })
    .then(async (res) => {
      // 暖機で実際に接続したなら、それもログに残す（「いつ繋がったか」が分かる）
      recordConnection((await res.json().catch(() => ({}))).connection);
    })
    .catch(() => undefined);
}

onMounted(warmUp);
// システムを選び直したら、そちらを暖める。前のシステムのジョブを出したままにしない
watch(() => systemsStore.selected, () => {
  conn.value = undefined;
  warmUp();
});

/**
 * 保持してもらっている結果セットを手放す。
 *
 * 結果セットは**接続を掴んでいる**ので、放置するとアイドル（60 秒）まで
 * 次の実行がその接続を使い回せない。読み終わり・再実行・画面を閉じるときに返す。
 */
async function releaseResultSet(): Promise<void> {
  const id = resultSetId.value;
  if (!id) return;
  resultSetId.value = "";
  await fetch(`/api/host/sql/${id}`, { method: "DELETE" }).catch(() => undefined);
}

// タブを閉じたときも返す（閉じ忘れをアイドル任せにしない）
onUnmounted(() => void releaseResultSet());

async function execute(): Promise<void> {
  if (!systemsStore.selected) {
    error.value = "システムを選んでください";
    return;
  }
  if (!sql.value.trim()) return;
  error.value = "";
  sqlDetail.value = "";
  // **前の結果セットを手放し終えてから実行する**。待たずに投げると、まだ貸し出し中の
  // 接続をサーバーがプールから拾えず、再実行のたびに 4〜6 秒かかる（実測で気づいた）
  await releaseResultSet();
  const started = Date.now();
  const ranSql = sql.value;
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
        recordConnection(data.connection);
        record({
          kind: "run",
          sql: ranSql,
          status: "error",
          ms: Date.now() - started,
          detail: sqlDetail.value || String(error.value)
        });
        return;
      }
      columns.value = data.columns ?? [];
      // 列の並びが変わるので、手で決めた列幅は捨てる（前の列の幅が残ると対応が狂う）
      cols.clear();
      rows.value = data.rows ?? [];
      hasMore.value = Boolean(data.hasMore);
      resultSetId.value = data.resultSetId ?? "";
      expired.value = false;
      executed.value = true;
      recordConnection(data.connection);
      record({
        kind: "run",
        sql: ranSql,
        status: "ok",
        ms: Date.now() - started,
        rowCount: rows.value.length,
        hasMore: hasMore.value
      });
    } catch (e) {
      error.value = `実行に失敗しました: ${String(e)}`;
      record({ kind: "run", sql: ranSql, status: "error", ms: Date.now() - started, detail: String(e) });
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
  const started = Date.now();
  const ranSql = sql.value;
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
      record({
        kind: "more", sql: ranSql, status: "error", ms: Date.now() - started,
        detail: "結果セットの保持期限が切れました"
      });
      return;
    }
    if (!res.ok) {
      error.value = data.error ?? "続きの取得に失敗しました";
      hasMore.value = false;
      record({ kind: "more", sql: ranSql, status: "error", ms: Date.now() - started, detail: String(error.value) });
      return;
    }
    const added = (data.rows ?? []).length;
    rows.value = [...rows.value, ...(data.rows ?? [])];
    hasMore.value = Boolean(data.hasMore);
    record({
      kind: "more", sql: ranSql, status: "ok", ms: Date.now() - started,
      rowCount: added, hasMore: hasMore.value
    });
  } catch (e) {
    error.value = `続きの取得に失敗しました: ${String(e)}`;
    hasMore.value = false;
    record({ kind: "more", sql: ranSql, status: "error", ms: Date.now() - started, detail: String(e) });
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

/**
 * SQL 欄と結果欄の境界。**スプールペインと同じ操作**にするため共通化してある
 * （境界を掴む・上下キー・結果の最大化）。
 */
const split = usePaneSplit({ initial: 110, min: 60, max: 600 });

/**
 * **複数のクエリを持ち、左の一覧で切り替える。**
 *
 * 1 本の SQL を書き換えながら使うと、前の結果を見返したいときに打ち直すしかない。
 * 上の各 ref は「いま見えているクエリ」の状態そのものなので、切り替えのたびに
 * 現在値を控えて、行き先の控えを流し込む（各所のロジックは触らずに済む）。
 *
 * 結果セット（resultSetId）はサーバー側に残るため、切り替えても読み足しは続けられる。
 */
interface QuerySnapshot {
  id: number;
  sql: string;
  columns: Column[];
  rows: Row[];
  hasMore: boolean;
  resultSetId: string;
  expired: boolean;
  executed: boolean;
  error: string;
  sqlDetail: string;
}

let querySeq = 0;
function blankQuery(): QuerySnapshot {
  return {
    id: ++querySeq,
    sql: "",
    columns: [],
    rows: [],
    hasMore: false,
    resultSetId: "",
    expired: false,
    executed: false,
    error: "",
    sqlDetail: ""
  };
}

const queries = ref<QuerySnapshot[]>([blankQuery()]);
const activeId = ref(queries.value[0]!.id);

/** 一覧に出す名前。SQL の 1 行目を詰めたもの（未入力なら通し番号） */
function queryTitle(q: QuerySnapshot, index: number): string {
  const head = q.sql.trim().split("\n")[0]?.trim() ?? "";
  return head.length > 0 ? head.slice(0, 40) : `クエリ ${index + 1}`;
}

/** いま見えている状態を控えへ書き戻す */
function captureActive(): void {
  const q = queries.value.find((x) => x.id === activeId.value);
  if (!q) return;
  q.sql = sql.value;
  q.columns = columns.value;
  q.rows = rows.value;
  q.hasMore = hasMore.value;
  q.resultSetId = resultSetId.value;
  q.expired = expired.value;
  q.executed = executed.value;
  q.error = error.value;
  q.sqlDetail = sqlDetail.value;
}

function restore(q: QuerySnapshot): void {
  sql.value = q.sql;
  columns.value = q.columns;
  rows.value = q.rows;
  hasMore.value = q.hasMore;
  resultSetId.value = q.resultSetId;
  expired.value = q.expired;
  executed.value = q.executed;
  error.value = q.error;
  sqlDetail.value = q.sqlDetail;
}

function selectQuery(id: number): void {
  if (id === activeId.value) return;
  captureActive();
  const q = queries.value.find((x) => x.id === id);
  if (!q) return;
  activeId.value = id;
  restore(q);
}

function addQuery(): void {
  captureActive();
  const q = blankQuery();
  queries.value.push(q);
  activeId.value = q.id;
  restore(q);
}

/** 閉じる。**最後の 1 本は閉じない**（空のペインになって行き場が無くなる） */
function closeQuery(id: number): void {
  if (queries.value.length <= 1) return;
  const i = queries.value.findIndex((x) => x.id === id);
  if (i < 0) return;
  queries.value.splice(i, 1);
  if (id === activeId.value) {
    const next = queries.value[Math.min(i, queries.value.length - 1)]!;
    activeId.value = next.id;
    restore(next);
  }
}

/**
 * 列幅の手動指定（列の右端をドラッグ）。**実装は composable に共通化**してある
 * （データ転送ペインと同じ振る舞いにするため。片方だけ直す事故を避ける）。
 *
 * 既定は中身に合わせた幅で、長い値は CSS の `max-width` で打ち切る。
 * 手で指定した幅は打ち切りの基準そのものを動かすので、**広げれば隠れていた文字が見える**。
 */
const cols = useColumnWidths();
const resizingCol = cols.resizing;
const widthStyle = cols.widthStyle;
const onColDown = cols.onDown;
const onColMove = cols.onMove;
const onColUp = cols.onUp;
const resetColWidth = cols.reset;

/**
 * 打ち切られたセルの全文を title で読めるようにする。
 * NULL と LOB は中の span が自前の title を持つので、ここでは付けない
 * （付けると外側が勝って「LOB の中身は取得していません」等が読めなくなる）。
 */
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
  <div class="sql-layout admin">
    <!-- 左の一覧。複数のクエリを持ち、結果ごと切り替える -->
    <aside class="qlist">
      <div class="qlist-bar">
        <span class="qlist-title">クエリ</span>
        <button class="qadd" title="クエリを追加する" @click="addQuery">＋</button>
      </div>
      <ul>
        <li v-for="(q, i) in queries" :key="q.id" :class="{ sel: q.id === activeId }">
          <button class="qitem" :title="q.sql || '（未入力）'" @click="selectQuery(q.id)">
            <span class="qname">{{ queryTitle(q, i) }}</span>
            <span v-if="q.executed && !q.error" class="qcount">{{ q.rows.length }}</span>
            <span v-else-if="q.error" class="qerr" title="失敗">!</span>
          </button>
          <button
            v-if="queries.length > 1"
            class="qclose"
            title="このクエリを閉じる"
            @click="closeQuery(q.id)"
          >
            ×
          </button>
        </li>
      </ul>
    </aside>

  <div class="sql-pane">
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
      <button
        class="max"
        :title="split.maximized.value ? 'SQL 欄を出す' : '結果を最大化する'"
        @click="split.toggleMaximize()"
      >
        {{ split.maximized.value ? "◱ 元に戻す" : "⛶ 最大化" }}
      </button>
    </header>

    <textarea
      v-show="!split.maximized.value"
      v-model="sql"
      class="editor"
      :style="{ height: `${split.topHeight.value}px` }"
      spellcheck="false"
      placeholder="SELECT * FROM QSYS2.SYSTABLES FETCH FIRST 100 ROWS ONLY"
      @keydown="onKeydown"
    ></textarea>
    <p v-show="!split.maximized.value" class="hint">
      SELECT のみ実行できます（Ctrl+Enter で実行）。<strong>下までスクロールするか
      End / PageDown で続きを読み足します。</strong>「1 度に取得」はその 1 回ぶんの件数です。
    </p>

    <!-- SQL 欄と結果欄の境界。この罫線を掴んで高さを変える -->
    <PaneSplitter v-if="!split.maximized.value" :split="split" label="SQL 欄の高さ" />

    <LoadingBar v-if="slowLoading" label="実行しています…" />

    <p v-if="error" class="error">
      {{ error }}
      <span v-if="sqlDetail" class="detail">（{{ sqlDetail }}）</span>
    </p>

    <p v-if="expired" class="warn">
      結果セットの保持期限が切れました。もう一度「実行」してください。
    </p>

    <!-- ログを重ねる基準。ここを position: relative にしないとパネルが置けない -->
    <div class="results" @click="logOpen && (logOpen = false)">
    <div v-if="rows.length" class="rows-scroll" tabindex="0" @scroll="onScroll" @keydown="onPaneKeydown">
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
              @pointerdown="onColDown($event, ci)"
              @pointermove="onColMove"
              @pointerup="onColUp"
              @pointercancel="onColUp"
              @dblclick="resetColWidth(ci)"
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

    <p v-else-if="executed && !error && !loading" class="empty">該当する行はありません。</p>
    <p v-else-if="!executed && !error" class="empty">
      接続を選び、SELECT を入力して「実行」を押してください。取得できる範囲は IBM i の権限によります。
    </p>

      <!-- .sql-pane 直下に置くとフッターを覆ってしまうので、結果領域の中に置く -->
      <SqlLogPanel
        :entries="logEntries"
        :open="logOpen"
        @close="logOpen = false"
        @clear="logEntries = []"
        @click.stop
      />
    </div>

    <!-- フッター。5250 セッションと同じく、ここからログを開く -->
    <footer class="statusbar">
      <span v-if="lastLog" class="last" :class="{ err: lastLog.status === 'error' }">
        {{ lastLog.status === "error" ? "失敗" : "完了" }}・{{ lastLog.ms }}ms
      </span>
      <span v-else class="last muted">未実行</span>
      <!--
        いま繋がっているホスト側のジョブ。5250 の OIA と同じで「どこに繋がっているか」を
        常に見えるところへ置く（従来はログを開かないと分からなかった）。
      -->
      <span v-if="conn" class="conn" :title="`SQL 接続先 ${connTarget}${conn.job ? ` / ジョブ ${conn.job}` : ''}`">
        <template v-if="conn.job">job={{ conn.job }}</template>
        <template v-else>job=—</template>
        <span v-if="connTarget" class="target">{{ connTarget }}</span>
      </span>
      <span v-else class="conn muted">未接続</span>
      <span class="spacer"></span>
      <button
        class="logbtn"
        :class="{ on: logOpen }"
        title="SQL 実行ログ（この画面の中だけの記録です）"
        @click="logOpen = !logOpen"
      >
        {{ logOpen ? "▾" : "▴" }} 実行ログ <span class="cnt">{{ logEntries.length }}</span>
      </button>
    </footer>
  </div>
  </div>
</template>

<style scoped>
/* 左の一覧＋本体の 2 列。一覧は固定幅、本体が伸びる */
.sql-layout {
  display: flex;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
}
.qlist {
  flex: none;
  width: 170px;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
  padding: 12px 0 12px 12px;
  box-sizing: border-box;
}
.qlist-bar { display: flex; align-items: center; gap: 6px; padding-right: 8px; margin-bottom: 6px; }
.qlist-title { font-size: 12px; color: var(--muted); font-weight: 600; }
.qadd { margin-left: auto; }
.qlist ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.qlist li { display: flex; align-items: center; gap: 2px; padding-right: 6px; }
/* 名前は 1 行に収める。長い SQL でも一覧の幅を押し広げない */
.qitem {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  font-size: 12px;
  padding: 4px 6px;
  border: 1px solid transparent;
  background: none;
  border-radius: 4px;
  cursor: pointer;
}
.qitem:hover { background: var(--accent-soft); }
.qlist li.sel .qitem { background: var(--accent-soft); border-color: var(--accent); }
.qname { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.qcount { flex: none; font-size: 11px; color: var(--muted); }
.qerr { flex: none; font-size: 11px; color: #c62828; font-weight: 700; }
.qclose { flex: none; border: none; background: none; cursor: pointer; color: var(--muted); font-size: 12px; padding: 0 2px; }
.qclose:hover { color: #c62828; }

/* ペインは縦に積み、**表領域だけがスクロール**する。
   以前は .sql-pane 自体を overflow:auto にしていたため、表の高さを固定すると
   二重スクロールになり、ヘッダーが画面外へ押し出された */
.sql-pane { flex: 1 1 auto; min-width: 0; padding: 12px; height: 100%; display: flex; flex-direction: column; min-height: 0; box-sizing: border-box; }
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
  /* 高さは下の罫線（.splitter）で変える。右下のつまみは出さない */
  resize: none;
}
/* SQL 欄と結果欄の境界。掴めることが見て分かるように、罫線に握り手を描く */
/* ヘッダーの右端に寄せる。結果を広く見たいときのための切替 */
header .max { margin-left: auto; }
.hint { font-size: 12px; color: var(--muted); margin: 6px 0 10px; }
.hint code { font-family: var(--mono); }
/* **列幅は中身に合わせる**。`width: 100%` だと 4 列の表でも画面いっぱいに
   引き伸ばされ、5 文字の値の間に空白が空いてしまう（利用者の指摘）。
   代わりに横幅が足りなければ .rows-scroll が横スクロールする */
table { border-collapse: collapse; width: auto; table-layout: auto; }
th, td { border-bottom: 1px solid var(--line); padding: 5px 8px; text-align: left; font-size: 13px; }
th { color: var(--muted); font-weight: 600; font-size: 12px; font-family: var(--mono); }
td { font-family: var(--mono); white-space: pre; }
/* ただし**際限なく伸ばさない**。長い CLOB や説明文の 1 列で表が使えなくなるため、
   40 文字ぶんで打ち切って「…」を出す（全文は title で読める） */
th, td { max-width: 40ch; overflow: hidden; text-overflow: ellipsis; }
.null { color: var(--muted); font-style: italic; }
.lob { color: var(--muted); font-style: italic; }
.error { color: #c62828; }
.detail { font-family: var(--mono); font-size: 12px; }
.warn { color: var(--muted); border-left: 3px solid var(--accent); padding-left: 8px; font-size: 12px; }
.empty { color: var(--muted); text-align: center; }
/* 地の色を明示する。親（.group）が半透明の緑を重ねているため、
   固定列にだけ色を敷くと**そこだけ色がずれる**（実ブラウザの拡大で判明）。
   表の領域を不透明にして、固定列と本文を同じ地の上に載せる */
/* 結果領域。ログパネルを重ねる基準（position: relative）になる */
.results { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.rows-scroll { overflow: auto; flex: 1 1 auto; min-height: 0; border-top: 1px solid var(--line); background: var(--paper); }
/* 列見出しはスクロールしても残す */
.rows-scroll thead th { position: sticky; top: 0; background: var(--card); z-index: 1; }
/* 列の右端の掴み手。見出しは sticky＝配置済みなので、これを基準に置ける。
   掴める幅は 8px 取る（1px の罫線ちょうどでは掴めない） */
.col-grip {
  position: absolute;
  top: 0;
  /* 見出しは overflow: hidden なので、はみ出させると掴み手が切れる */
  right: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  touch-action: none;
  z-index: 2;
}
.col-grip::after {
  content: "";
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: 2px;
  background: transparent;
}
thead th:hover .col-grip::after,
.col-grip.dragging::after { background: var(--accent); }
/* レコード番号は**横スクロールでも動かさない**。
   背景を敷かないと、下を流れるセルが透けて重なる */
.rownum {
  position: sticky;
  left: 0;
  /* 本文の行は背景を敷いていないので、地の色（--paper）を敷く。
     --card（白）にすると**固定列だけ白い帯**になる（実ブラウザの拡大で判明） */
  background: var(--paper);
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  /* border-collapse 下の sticky セルは border が付いてこないので影で引く */
  box-shadow: 1px 0 0 var(--line);
  user-select: none;
}
/* 左上の角は縦・横どちらの sticky にも勝つ必要がある。見出し行は --card */
.rows-scroll thead th.rownum { z-index: 2; background: var(--card); }
.rows-scroll:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
.more { color: var(--muted); font-size: 12px; text-align: center; padding: 6px 0; }
/* フッター。5250 の OIA と同じ位置づけで、ここからログを開く */
.statusbar {
  flex: none;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  font-family: var(--mono);
}
.statusbar .spacer { flex: 1; }
.statusbar .last { color: var(--muted); }
.statusbar .last.err { color: #c62828; }
/* 接続中のホスト側ジョブ。長いジョブ名でフッターが 2 行にならないよう省略する */
.statusbar .conn {
  color: var(--muted);
  display: inline-flex;
  gap: 6px;
  align-items: baseline;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.statusbar .conn .target { opacity: 0.75; }
.logbtn {
  background: none;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--ink);
  cursor: pointer;
  font: inherit;
  padding: 1px 8px;
}
.logbtn.on { border-color: var(--accent); color: var(--accent); }
/* 件数が伸びても右がずれないように幅を取る */
.logbtn .cnt { min-width: 4ch; display: inline-block; text-align: right; font-variant-numeric: tabular-nums; }
</style>
