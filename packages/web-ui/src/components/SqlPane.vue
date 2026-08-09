<script setup lang="ts">
import { MSG_SYSTEM_GONE } from "../composables/opMessages.js";
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import LoadingBar from "./LoadingBar.vue";
import PaneSplitter from "./PaneSplitter.vue";
import { usePaneSplit } from "../composables/usePaneSplit.js";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";
import { csvBlob, csvFileName, toCsv } from "../csv.js";
// 型は在り処（`@ts5250/hostserver`）から。`import type` なのでバンドルに入らない
import type { LobPlaceholder } from "@ts5250/hostserver";
import { splitSqlStatements, summarizeSql } from "@ts5250/base";
import PlanViewer from "./PlanViewer.vue";
import { explainSql, runSql, type CaptureMode, type IndexAdvice, type QueryPlan } from "../planApi.js";
import { pushHistory } from "../planStore.js";
import {
  MSG_PLAN_MODE_RUN,
  MSG_PLAN_MODE_NO_ROWS,
  MSG_PLAN_MODE_RUN_HINT,
  MSG_PLAN_MODE_NO_ROWS_HINT
} from "../composables/opMessages.js";
import SqlLogPanel from "./SqlLogPanel.vue";
import SqlCompletion from "./SqlCompletion.vue";
import { toggleLineComment, indentLines, outdentLines } from "../sqlEdit.js";
import { isTablePosition, qualifierAt, resolveQualifier, tableRefsOf } from "../sqlRefs.js";
import { fetchColumns, fetchTables, type Candidate, type CandidateKind } from "../sqlColumns.js";
import { caretPosition } from "../composables/caretPosition.js";
import SqlResultTable from "./SqlResultTable.vue";
import { appendSqlLog, type SqlLogEntry } from "../sqlLog.js";

/**
 * SQL の実行と CSV ダウンロード（ACS のデータ転送に相当する入り口）。
 *
 * 一覧ペインと同じ「特殊なタブ ID」方式で開く（`sql:query`）。
 * 取得できる範囲は IBM i の権限が決めるため、アプリ側で追加の制限は掛けない。
 *
 * **SELECT だけでなく、結果を返さない文（INSERT / UPDATE / DELETE / CREATE …）も実行できる**
 * （`20260730-sql-non-query-statements`）。振り分けは**サーバーが行う**ので、ここでは
 * 応答の `kind` を見て「表を出す」か「行数・完了を出す」かを選ぶだけ。
 * ⚠ **書き込みは取り消せない**（コミットメント制御を使っていない）。
 *
 * **`;` で区切れば複数の文を順に実行する**。結果を返した文ごとに結果領域のタブを積み、
 * 表示中のタブに対して列幅・CSV・読み足しが働く。失敗したらそこで止め、
 * 何番目の文かを添える（後続は投げない）。
 */
/**
 * `tabId`: このペインのタブ ID。
 * `active`: **いま見えているか**（`20260802-keep-pane-state`）。開いたタブは切り替えても
 * アンマウントせず `v-show` で隠すので、「マウント中＝見えている」ではなくなった。
 * 裏で働き続けてよいかの判断はこれで行う。
 * `system`: **このタブのシステム参照**（`20260802-tabs-own-system`）。要求の宛先はこれ。
 * **自分で `systemsStore` から引かない**——引き方が散ると、画面に出ているシステムと
 * 宛先が食い違う経路ができる。`PanePool` が配る値だけを使う。
 * 設定から消えたときは `undefined`（銘板はプールが出す。ここは操作させないだけでよい）。
 */
const props = defineProps<{ tabId: string; active?: boolean; system?: string }>();

interface Column {
  name: string;
  typeName: string;
  nullable: boolean;
}
// LOB は**実体の型**を使う。`{ kind: "lob" }` とだけ書くと `SqlResultTable` の
// `Row` と構造が食い違い、prop として渡せない（vue-tsc TS2719）
type Row = Record<string, string | number | boolean | null | LobPlaceholder>;

const sql = ref("");
/** 1 度に取得する件数。**上限ではなく 1 回の読み足し量** */
const pageSize = ref(200);
const PAGE_SIZES = [50, 200, 500, 1000] as const;
/** LOB の中身も取るか。**既定オフ**——大きな LOB を無自覚に引かないため */
const fetchLob = ref(false);
/**
 * 結果タブ。**`;` 区切りの文ごとに 1 つ**積む。
 *
 * 表示に関わる状態（列・行・続き・期限切れ）はすべてここに持ち、
 * 画面は「表示中のタブ」から引く。単一文のときはタブが 1 つになるだけで、
 * 見え方は今までと変わらない（タブ帯は 2 つ以上のときだけ出す）。
 */
interface ResultTab {
  id: string;
  /** 何番目の文か（1 起点） */
  index: number;
  /** 実行した文。見出しの要約と CSV のファイル名に使う */
  sql: string;
  columns: Column[];
  rows: Row[];
  hasMore: boolean;
  resultSetId: string;
  expired: boolean;
  /**
   * 結果を返さない文（DML / DDL）の実行結果。**これがあるタブは表の代わりにこれを出す**。
   * 行が 0 件の SELECT と区別するために、`rows.length` ではなくこの有無で見分ける。
   */
  execute?: ExecuteInfo;
}

/** 非クエリ文の実行結果（サーバーの `kind: "execute"` 応答） */
interface ExecuteInfo {
  /** 影響した行数。`hasRowCount` が false のときは意味を持たない */
  updateCount: number;
  /** 影響行数に意味があるか（DML なら true。DDL は false） */
  hasRowCount: boolean;
  /** 警告つき成功（`7905` など）。**捨てると「作られたのに何も言われない」になる** */
  warning?: { sqlCode: number; sqlState: string };
  /**
   * `CALL P(…, ?)` の出力パラメーター（`?` と同じ並び）。
   * **これが手続きの結果そのもの**なので、出さないと呼んだ意味が分からない。
   */
  outputs?: (string | number | boolean | null)[];
  /**
   * 手続きが返した結果セットの数（`CALL` で `SQLCODE +466`）。
   * **表に出せるのは 1 個目だけ**なので、2 個以上あることは文章で言う——
   * 黙って 1 個目だけ出すと「全部見た」と思わせてしまう。
   */
  resultSets?: number;
  /** 結果セットを上限で切ったか（続きは取りに行けない） */
  truncated?: boolean;
}

const tabs = ref<ResultTab[]>([]);
const activeTabId = ref("");
let tabSeq = 0;

const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value));
/** 以下は「表示中のタブ」から引く。テンプレートと既存の処理をそのまま使えるようにするため */
const columns = computed<Column[]>(() => activeTab.value?.columns ?? []);
const rows = computed<Row[]>(() => activeTab.value?.rows ?? []);
const hasMore = computed(() => activeTab.value?.hasMore ?? false);
/**
 * 表示中のタブが「結果を返さない文」なら、その実行結果。
 * **行が 0 件の SELECT と混ぜない**ためにタブの `execute` の有無で見る。
 */
const executeInfo = computed(() => activeTab.value?.execute);
/**
 * 行数に意味がある文は件数を、意味が無い文（DDL）は完了だけを伝える。
 *
 * **手続きの結果セットは数を必ず言う。** 表に出せるのは 1 個目だけなので、
 * 2 個以上あることを黙っていると「全部見た」と思わせてしまう。
 * 上限で切ったことも同じ理由で言う（続きは取りに行けない）。
 */
const executeMessage = computed(() => {
  const e = executeInfo.value;
  if (!e) return "";
  const head = e.hasRowCount ? `${e.updateCount} 行に影響しました。` : "実行しました。";
  if (e.resultSets === undefined) return head;
  const many = e.resultSets > 1 ? `結果セット ${e.resultSets} 個のうち 1 個目を表示しています。` : "結果セットを表示しています。";
  const cut = e.truncated ? `先頭 ${rows.value.length} 件だけです（続きは取得しません）。` : "";
  return `${head}${many}${cut}`;
});
const resultSetId = computed(() => activeTab.value?.resultSetId ?? "");
const expired = computed(() => activeTab.value?.expired ?? false);
const loadingMore = ref(false);
const executed = ref(false);
const { visible: slowLoading, busy: loading, run } = useDelayedLoading();
const error = ref("");
/** SQLCODE / SQLSTATE。これが無いと文法誤りと権限不足を区別できない */
const sqlDetail = ref("");

/** フッターに出す直近の 1 件（開かなくても最後の結果が分かるように） */
const lastLog = computed<SqlLogEntry | undefined>(() => logEntries.value[logEntries.value.length - 1]);

const canRun = computed(
  () => !loading.value && sql.value.trim().length > 0 && Boolean(props.system)
);

// ---- 実行計画（Visual Explain 相当。`20260802-sql-visual-explain`） ----

/**
 * 採った計画。**結果タブと同じ帯の「実行計画」タブ**に出す。
 *
 * 以前は SQL 欄と結果表の**間**に挟んだパネルだったが、`.sql-pane` は縦積みで
 * 掴める境界が「SQL 欄／結果欄」の 1 本しか無く、挟まれた段は伸び縮みさせられない。
 * `max-height: 60vh` の内側でグラフがほとんど見えなかった（利用者の指摘）。
 * タブにすれば結果表と**同じ領域**を丸ごと使うので、既存の境界ドラッグと
 * 「最大化」がそのまま計画にも効く（新しい操作を覚えさせない）。
 */
const plan = ref<QueryPlan | undefined>();
const planBusy = ref(false);
const planError = ref("");
/** 計画タブが帯にあるか。**閉じるまで残す**——結果を見てから計画へ戻れるように */
const planOpen = ref(false);
/** 計画タブの ID。結果タブは `tab-N` なので衝突しない */
const PLAN_TAB_ID = "plan";
/** いま計画タブを見ているか。**結果側の描画はこれで抑える**（同じ領域を奪い合う） */
const planActive = computed(() => planOpen.value && activeTabId.value === PLAN_TAB_ID);

/**
 * `行を返さず計画` は SELECT 系でしか使えない（`capturePlan` が非クエリ文を拒む）が、
 * **こちらの推測でボタンを塞がない。**
 *
 * `docs/UI-DESIGN.md` /（AGENTS.md「UI デザインガイド」）:
 * 「環境の検出結果で選択肢を塞がない。**印を出すに留め、選ばせて結果で分からせる**」。
 * 文種の判定は本来 hostserver 側にある純関数で、web-ui に写すと**同じ判定が 2 か所**になる
 * （`db-decode.ts` がまさにそれで事故った）。サーバーは
 * 「行を返さずに計画だけ取るモードは SELECT 系の文でのみ使えます」と明示して断るので、
 * **押せるようにしておいて結果で分からせる**方が、判定の重複も塞ぎ過ぎも避けられる。
 */

/**
 * 計画を採る。
 *
 * **`no-rows` を「実行しない」と呼ばない**——IBM i に文を実行せずに計画だけ得る経路は無く
 * （research F7）、行を返さないだけで文はホストで実行される。
 */
async function explain(mode: CaptureMode): Promise<void> {
  if (!props.system) return;
  const statements = splitSqlStatements(sql.value);
  // 複数文のときは**先頭の 1 文だけ**を対象にする（どれの計画か曖昧にしない）
  const target = statements[0]?.sql ?? sql.value;
  planBusy.value = true;
  planError.value = "";
  // **押した先を先に見せる**。採取はモニターの起動ぶん数秒かかるので、後から開くと
  // それまで結果表のままで「押しても何も起きない」ように見える
  planOpen.value = true;
  activeTabId.value = PLAN_TAB_ID;
  try {
    const res = await explainSql({ source: props.system, sql: target, mode, maxRows: pageSize.value });
    plan.value = res.plan;
    pushHistory(res.plan);
    // **警告を握り潰さない**（モニターが残った可能性など）
    if (res.warnings?.length) planError.value = res.warnings.join(" / ");
  } catch (e) {
    planError.value = e instanceof Error ? e.message : String(e);
  } finally {
    planBusy.value = false;
  }
}

/**
 * 計画タブを閉じる。**採った計画も捨てる**（帯だけ残しても開き直せない）。
 * 履歴（`planStore`）には積んであるので、見返したいときは実行計画ペインから開ける。
 */
function closePlan(): void {
  planOpen.value = false;
  plan.value = undefined;
  planError.value = "";
  // 見ていたタブが消えるので結果の先頭へ戻す（結果が無ければ空＝案内文に戻る）
  if (activeTabId.value === PLAN_TAB_ID) activeTabId.value = tabs.value[0]?.id ?? "";
}

/**
 * 助言の索引を作る。**専用の入口を作らず既存の SQL 経路へ送る**——
 * SQL 欄に同じ文を打てば通るので新しい権限を増やさず、監査もそのまま乗る。
 */
async function createIndex(advice: IndexAdvice): Promise<void> {
  if (!props.system) return;
  await runSql({ source: props.system, sql: advice.createStatement });
}

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
  if (!props.system) return;
  void fetch("/api/host/sql/warm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { system: props.system } })
  })
    .then(async (res) => {
      // 暖機で実際に接続したなら、それもログに残す（「いつ繋がったか」が分かる）
      recordConnection((await res.json().catch(() => ({}))).connection);
    })
    .catch(() => undefined);
}

onMounted(warmUp);
/**
 * **このタブのシステムは生涯変わらない**（`20260802-tabs-own-system`）。
 * 以前はアプリ全体の選択値を見ていたため「選び直したら暖め直す」監視が要ったが、
 * いまは切り替わりようがない——暖めるのはマウント時の 1 回でよい。
 */

/**
 * 保持してもらっている結果セットを手放す。
 *
 * 結果セットは**接続を掴んでいる**ので、放置するとアイドル（60 秒）まで
 * 次の実行がその接続を使い回せない。読み終わり・再実行・画面を閉じるときに返す。
 */
async function releaseResultSets(): Promise<void> {
  // **開いているタブぶんすべて返す**。1 つでも残すと、その接続はアイドル（60 秒）まで
  // プールへ戻らず、次の実行が接続確立の 4〜6 秒を払うことになる
  const ids = tabs.value.map((t) => t.resultSetId).filter(Boolean);
  for (const t of tabs.value) t.resultSetId = "";
  await Promise.all(
    ids.map((id) => fetch(`/api/host/sql/${id}`, { method: "DELETE" }).catch(() => undefined))
  );
}

// タブを閉じたときも返す（閉じ忘れをアイドル任せにしない）
onUnmounted(() => void releaseResultSets());

/**
 * 入力欄の SQL を `;` で分割し、**書いた順に 1 文ずつ実行**する。
 *
 * 1 文 = 1 要求（既存の `/api/host/sql`）。まとめて投げる API を作らないのは、
 * ページング・接続プール・期限切れの規律を**既存のまま**使えるため。
 *
 * **失敗したらそこで止める**（後続は実行しない）。それまでのタブは残す——
 * どこまで通ったかが分かる方が調べやすい。
 */
async function execute(): Promise<void> {
  // **「システムを選んでください」ではない**（`20260802-tabs-own-system`）。
  // タブは 1 つのシステムへの窓なので、ここが空なのは**設定から消えた**ときだけ。
  // 利用者に選び直す手立ては無いので、文言は共通の定数に寄せる
  if (!props.system) {
    error.value = MSG_SYSTEM_GONE;
    return;
  }
  const statements = splitSqlStatements(sql.value);
  if (statements.length === 0) return;
  error.value = "";
  sqlDetail.value = "";
  // **前の結果セットを手放し終えてから実行する**。待たずに投げると、まだ貸し出し中の
  // 接続をサーバーがプールから拾えず、再実行のたびに 4〜6 秒かかる（実測で気づいた）
  await releaseResultSets();
  tabs.value = [];
  // **計画タブは閉じない**が、焦点は結果へ戻す——前の計画を見たまま新しい結果が
  // 隠れると「実行したのに変わらない」ように見える（最初の結果タブが選ばれる）
  activeTabId.value = "";
  executed.value = true;

  await run(async () => {
    for (const [i, statement] of statements.entries()) {
      const ok = await executeOne(statement.sql, i + 1, statements.length);
      if (!ok) return; // 失敗した時点で止める（後続は投げない）
    }
  });
}

/** 1 文を実行してタブを足す。続けてよければ true */
async function executeOne(one: string, position: number, total: number): Promise<boolean> {
  const started = Date.now();
  /** 何番目の文かを添える（複数文のときだけ。単一文の文言を変えないため） */
  const where = total > 1 ? `${position} 番目の文: ` : "";
  try {
    const res = await fetch("/api/host/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: { system: props.system },
        sql: one,
        pageSize: pageSize.value,
        ...(fetchLob.value ? { lobMaxBytes: 65536 } : {})
      })
    });
    const data = await res.json();
    if (!res.ok) {
      error.value = `${where}${data.error ?? "実行に失敗しました"}`;
      // core のメッセージが既に SQLCODE を含むことがある（`prepare failed: SQLCODE=-204 …`）。
      // その場合に併記すると二重に出る（実ブラウザ確認で判明）
      if (data.sqlCode !== undefined && !String(error.value).includes("SQLCODE")) {
        sqlDetail.value = `SQLCODE=${data.sqlCode} SQLSTATE=${data.sqlState}`;
      }
      recordConnection(data.connection);
      record({
        kind: "run",
        sql: one,
        status: "error",
        ms: Date.now() - started,
        detail: sqlDetail.value || String(error.value)
      });
      return false;
    }
    // **結果を返さない文はサーバーが `kind: "execute"` で返す。**
    // 列の有無で見分けると「列が 0 の結果セット」と区別できない
    const isExecute = data.kind === "execute";
    const tab: ResultTab = {
      id: `tab-${++tabSeq}`,
      index: position,
      sql: one,
      columns: data.columns ?? [],
      rows: data.rows ?? [],
      hasMore: Boolean(data.hasMore),
      resultSetId: data.resultSetId ?? "",
      expired: false,
      ...(isExecute
        ? {
            execute: {
              updateCount: Number(data.updateCount ?? 0),
              hasRowCount: Boolean(data.hasRowCount),
              ...(data.warning ? { warning: data.warning } : {}),
              ...(Array.isArray(data.outputs) ? { outputs: data.outputs } : {}),
              ...(typeof data.resultSets === "number" ? { resultSets: data.resultSets } : {}),
              ...(data.truncated ? { truncated: true } : {})
            }
          }
        : {})
    };
    tabs.value = [...tabs.value, tab];
    // **選ぶのは最初のタブ**。書いた順に見るのが自然で、最後の文が確認用のこともある
    if (!activeTabId.value) activeTabId.value = tab.id;
    recordConnection(data.connection);
    record({
      kind: "run",
      sql: one,
      status: "ok",
      ms: Date.now() - started,
      // 行数の意味が無い文（DDL）では**件数を載せない**——0 と書くと「0 行に影響した」に見える
      ...(tab.execute
        ? tab.execute.hasRowCount
          ? { rowCount: tab.execute.updateCount }
          : {}
        : { rowCount: tab.rows.length }),
      hasMore: tab.hasMore,
      ...(tab.execute?.warning
        ? { detail: `SQLCODE=${tab.execute.warning.sqlCode} SQLSTATE=${tab.execute.warning.sqlState}` }
        : {})
    });
    return true;
  } catch (e) {
    error.value = `${where}実行に失敗しました: ${String(e)}`;
    record({ kind: "run", sql: one, status: "error", ms: Date.now() - started, detail: String(e) });
    return false;
  }
}

/**
 * タブを選ぶ。**列幅とスクロール位置はタブごとに保たれる**——表のインスタンスを
 * KeepAlive で持っているため（スクロール位置は表側が自分で覚えている）
 */
function selectTab(id: string): void {
  activeTabId.value = id;
}

/**
 * 続きを読み足す。**End / PageDown / スクロールのすべてがここを通る**。
 * 二重に走らせない（`loadingMore`）。
 */
async function loadMore(): Promise<void> {
  const tab = activeTab.value;
  if (!tab || !tab.hasMore || loadingMore.value || !tab.resultSetId) return;
  loadingMore.value = true;
  const started = Date.now();
  // **表示中のタブの文**でログを残す（複数文では入力欄と一致しない）
  const ranSql = tab.sql;
  try {
    const res = await fetch(`/api/host/sql/${tab.resultSetId}/next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageSize: pageSize.value })
    });
    const data = await res.json();
    if (res.status === 404) {
      // **黙って空にしない**——期限切れだと分かるようにする
      tab.expired = true;
      tab.hasMore = false;
      record({
        kind: "more", sql: ranSql, status: "error", ms: Date.now() - started,
        detail: "結果セットの保持期限が切れました"
      });
      return;
    }
    if (!res.ok) {
      error.value = data.error ?? "続きの取得に失敗しました";
      tab.hasMore = false;
      record({ kind: "more", sql: ranSql, status: "error", ms: Date.now() - started, detail: String(error.value) });
      return;
    }
    const added = (data.rows ?? []).length;
    tab.rows = [...tab.rows, ...(data.rows ?? [])];
    tab.hasMore = Boolean(data.hasMore);
    record({
      kind: "more", sql: ranSql, status: "ok", ms: Date.now() - started,
      rowCount: added, hasMore: tab.hasMore
    });
  } catch (e) {
    error.value = `続きの取得に失敗しました: ${String(e)}`;
    tab.hasMore = false;
    record({ kind: "more", sql: ranSql, status: "error", ms: Date.now() - started, detail: String(e) });
  } finally {
    loadingMore.value = false;
  }
}



// ---- SQL 欄のキー操作と列の補完 ----

/**
 * 入力欄の実体。**選択範囲を戻すのに要る**——`v-model` で書き換えると
 * キャレットが末尾へ飛ぶので、更新後に自分で置き直す。
 */
const editor = ref<HTMLTextAreaElement | undefined>();

/**
 * 編集結果を流し込む。**`nextTick` を挟んでから選択を戻す**——
 * `sql.value` を変えた時点ではまだ DOM に反映されておらず、先に位置を書いても消える。
 */
async function applyEdit(result: { text: string; start: number; end: number }): Promise<void> {
  sql.value = result.text;
  await nextTick();
  const el = editor.value;
  if (!el) return;
  el.selectionStart = result.start;
  el.selectionEnd = result.end;
}

/**
 * 補完の候補。`.` を打つと出る。
 *
 * - `別名.` / `表名.` … その表の**列**
 * - `ライブラリー.` … そのライブラリーの**表**
 *
 * **`textarea` のままにする**（CodeMirror 等は入れない。AGENTS.md のバンドル規律）。
 * 候補は入力欄に重ねた別の箱で、キーはこちらで捌く——候補側にフォーカスを渡すと
 * 日本語の変換中に確定してしまう。
 */
const completion = ref<
  { items: Candidate[]; kind: CandidateKind; index: number; left: number; top: number } | undefined
>();
/** いま出ている候補が置き換える範囲（`.` の次〜キャレット） */
let completionRange: { from: number; to: number } | undefined;
/** 打鍵のたびに前の問い合わせが後から返って上書きしないための世代番号 */
let completionSeq = 0;

function closeCompletion(): void {
  completion.value = undefined;
  completionRange = undefined;
  // **返ってきた結果を捨てる**（閉じたあとに前の問い合わせが開き直さないように）
  completionSeq += 1;
}

/**
 * キャレットの手前を見て候補を出す。**`.` の直後と、その後の打ち足しの両方**で走る。
 *
 * 表が解けない・列が引けないときは**黙って閉じる**——候補が出ないだけで、
 * SQL を書く手は止めない。
 */
async function updateCompletion(): Promise<void> {
  const el = editor.value;
  if (!el || !props.system) return closeCompletion();
  const caret = el.selectionEnd;
  // 範囲選択中は出さない（選択を潰す操作になる）
  if (el.selectionStart !== caret) return closeCompletion();
  const q = qualifierAt(sql.value, caret);
  if (!q) return closeCompletion();

  /**
   * 列か表かを決める。
   *
   * **表を書く位置（`FROM ライブラリー.`）は先に弾く**——`tableRefsOf` から見ると
   * `FROM TESTLIB` は表 1 つに見えるので、素直に解くと「`TESTLIB` という表の列」を
   * 引きに行って空振りする。それ以外は別名・表名で解き、解けなければ
   * ライブラリーとみなす（`WHERE TESTLIB.` のような書き方も拾える）。
   */
  const ref = isTablePosition(sql.value, q.start)
    ? undefined
    : resolveQualifier(tableRefsOf(sql.value), q.qualifier);
  const kind: CandidateKind = ref ? "column" : "table";

  const seq = ++completionSeq;
  const found = ref
    ? await fetchColumns(props.system, ref)
    : await fetchTables(props.system, q.qualifier);
  // 打鍵が進んでいたら捨てる
  if (seq !== completionSeq) return;
  const prefix = q.prefix.toUpperCase();
  const items = found.filter((c) => c.name.toUpperCase().startsWith(prefix)).slice(0, 50);
  if (items.length === 0) return closeCompletion();

  const at = caretPosition(el, q.from);
  completionRange = { from: q.from, to: q.to };
  completion.value = { items, kind, index: 0, left: at.left, top: at.top + at.height };
}

/** 候補を確定する。**`.` の後ろに打ちかけていた文字を置き換える** */
async function pickCompletion(item: Candidate): Promise<void> {
  const range = completionRange;
  if (!range) return;
  const text = sql.value.slice(0, range.from) + item.name + sql.value.slice(range.to);
  const caret = range.from + item.name.length;
  closeCompletion();
  await applyEdit({ text, start: caret, end: caret });
  editor.value?.focus();
}

function moveCompletion(delta: number): void {
  const c = completion.value;
  if (!c) return;
  c.index = (c.index + delta + c.items.length) % c.items.length;
}

/**
 * SQL 欄のキー操作。
 *
 * - Ctrl+Enter … 実行（`textarea` なので Enter は改行のまま残す）
 * - Ctrl+/ … 選択行のコメントを切り替え
 * - Tab / Shift+Tab … インデントの追加・削除
 * - 候補が出ている間は ↑↓ / Enter / Tab / Esc が候補側の操作になる
 *
 * ⚠ **Tab を奪うとキーボードだけで欄から出られなくなる。** Esc で候補を閉じたうえで、
 * **Esc の直後の Tab は素通しする**（`escaped`）ことで逃げ道を残す。
 */
let escaped = false;

function onKeydown(e: KeyboardEvent): void {
  const el = editor.value;
  const c = completion.value;

  if (c) {
    if (e.key === "ArrowDown") return e.preventDefault(), moveCompletion(1);
    if (e.key === "ArrowUp") return e.preventDefault(), moveCompletion(-1);
    if (e.key === "Enter" || e.key === "Tab") {
      // **変換中の Enter は取らない**（日本語入力の確定を横取りしない）
      if (e.isComposing) return;
      e.preventDefault();
      void pickCompletion(c.items[c.index]!);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeCompletion();
      return;
    }
  }

  if (e.key === "Escape") {
    // 次の Tab を素通しさせる（フォーカスの逃げ道）
    escaped = true;
    return;
  }

  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canRun.value) {
    e.preventDefault();
    void execute();
    return;
  }

  // `/` は配列によって `.` などになるが、`code` は物理キーなので両方見る
  if ((e.ctrlKey || e.metaKey) && (e.key === "/" || e.code === "Slash") && el) {
    e.preventDefault();
    void applyEdit(toggleLineComment(sql.value, el.selectionStart, el.selectionEnd));
    return;
  }

  if (e.key === "Tab" && el) {
    if (escaped) {
      // Esc の直後だけは素通し（欄から出る）
      escaped = false;
      return;
    }
    e.preventDefault();
    const edit = e.shiftKey
      ? outdentLines(sql.value, el.selectionStart, el.selectionEnd)
      : indentLines(sql.value, el.selectionStart, el.selectionEnd);
    void applyEdit(edit);
    return;
  }

  escaped = false;
}

/** 打つたび・動くたびに候補を出し直す。**閉じる判断もここ**（`.` から離れたら消える） */
function onEditorInput(): void {
  void updateCompletion();
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
  /** 結果はタブごと控える（複数文を実行したクエリを行き来しても崩れない） */
  tabs: ResultTab[];
  activeTabId: string;
  executed: boolean;
  error: string;
  sqlDetail: string;
  /**
   * 実行計画も**クエリごとに持つ**。1 本の ref を共有していると、クエリを切り替えても
   * 前のクエリの計画がタブに残り、どの文の計画なのか分からなくなる
   * （計画をタブにして結果と同じ帯へ並べたことで、この食い違いが目に見えるようになった）
   */
  plan: QueryPlan | undefined;
  planError: string;
  planOpen: boolean;
}

let querySeq = 0;
function blankQuery(): QuerySnapshot {
  return {
    id: ++querySeq,
    sql: "",
    tabs: [],
    activeTabId: "",
    executed: false,
    error: "",
    sqlDetail: "",
    plan: undefined,
    planError: "",
    planOpen: false
  };
}

const queries = ref<QuerySnapshot[]>([blankQuery()]);
const activeId = ref(queries.value[0]!.id);

/**
 * クエリ一覧に出す行数。複数文なら全タブの合計。
 * **非クエリ文は影響行数を足す**（行数に意味が無い DDL は 0 のまま）。
 */
function queryRowCount(q: QuerySnapshot): number {
  return q.tabs.reduce(
    (n, t) => n + (t.execute ? (t.execute.hasRowCount ? t.execute.updateCount : 0) : t.rows.length),
    0
  );
}

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
  q.tabs = tabs.value;
  q.activeTabId = activeTabId.value;
  q.executed = executed.value;
  q.error = error.value;
  q.sqlDetail = sqlDetail.value;
  q.plan = plan.value;
  q.planError = planError.value;
  q.planOpen = planOpen.value;
}

function restore(q: QuerySnapshot): void {
  sql.value = q.sql;
  tabs.value = q.tabs;
  activeTabId.value = q.activeTabId;
  executed.value = q.executed;
  error.value = q.error;
  sqlDetail.value = q.sqlDetail;
  plan.value = q.plan;
  planError.value = q.planError;
  planOpen.value = q.planOpen;
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





function download(): void {
  const csv = toCsv(
    columns.value.map((c) => c.name),
    rows.value
  );
  const url = URL.createObjectURL(csvBlob(csv));
  const a = document.createElement("a");
  a.href = url;
  // **複数のタブを続けて落とすときに同じ名前にしない**（何番目の文かを付ける）
  const name = csvFileName();
  a.download =
    tabs.value.length > 1 && activeTab.value
      ? name.replace(/\.csv$/, `-${activeTab.value.index}.csv`)
      : name;
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
            <!-- 複数文なら合計の行数（タブごとの内訳は結果側のタブで見る） -->
            <span v-if="q.executed && !q.error" class="qcount">{{ queryRowCount(q) }}</span>
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
      <button :disabled="!canRun || planBusy" :title="MSG_PLAN_MODE_RUN_HINT" @click="explain('run')">
        {{ planBusy ? "計画を取得中…" : MSG_PLAN_MODE_RUN }}
      </button>
      <button
        :disabled="!canRun || planBusy"
        :title="MSG_PLAN_MODE_NO_ROWS_HINT"
        @click="explain('no-rows')"
      >
        {{ MSG_PLAN_MODE_NO_ROWS }}
      </button>
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

    <!-- 候補を重ねる基準。入力欄の左上を原点に置きたいので position: relative -->
    <div v-show="!split.maximized.value" class="editor-wrap">
      <textarea
        ref="editor"
        v-model="sql"
        class="editor"
        :style="{ height: `${split.topHeight.value}px` }"
        spellcheck="false"
        placeholder="SELECT * FROM QSYS2.SYSTABLES FETCH FIRST 100 ROWS ONLY"
        @keydown="onKeydown"
        @input="onEditorInput"
        @click="onEditorInput"
        @blur="closeCompletion"
      ></textarea>
      <SqlCompletion
        v-if="completion"
        :items="completion.items"
        :kind="completion.kind"
        :index="completion.index"
        :left="completion.left"
        :top="completion.top"
        @pick="pickCompletion"
      />
    </div>
    <p v-show="!split.maximized.value" class="hint">
      SELECT も更新（INSERT / UPDATE / DELETE / MERGE）も定義（CREATE / DROP / ALTER）も実行できます
      （Ctrl+Enter で実行）。
      <strong>更新は取り消せません。</strong><strong>「;」で区切ると順に実行し、
      結果ごとにタブが出ます。</strong>下までスクロールするか End / PageDown で続きを読み足します
      （「1 度に取得」はその 1 回ぶんの件数）。
      <br />
      <!--
        **手続き・関数の作り方をここに書く。** `BEGIN … END` の中の `;` は区切りにしない
        と決めたので、他の SQL と同じように貼って実行できる——それが分からないと
        「`;` で切られるはず」と思って避けてしまう
      -->
      <strong>CREATE PROCEDURE / FUNCTION / TRIGGER はそのまま貼れます</strong>
      （BEGIN … END の中の「;」では切りません）。
      CALL の出力パラメーターは「?」と書くと値が返ります（入力に値が要る位置には値を書いてください）。
      手続きが返す結果セットも表に出ます（<strong>出せるのは 1 個目だけ</strong>）。
      <br />
      Ctrl+/ でコメントの切り替え、Tab / Shift+Tab で字下げ。
      <strong>表名や別名に「.」を打つと列の候補、ライブラリー名に「.」を打つと表の候補が出ます</strong>
      （↑↓ で選び、Enter か Tab で確定）。
      Tab で欄から出たいときは Esc を押してから Tab を押します。
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

    <!--
      結果と実行計画のタブ帯。**2 つ以上のときだけ出す**——単一文の見え方を変えないため
      （1 つのときにタブ帯を出すと、今までの画面に無かった段が増える）。
      計画タブがあるときは 1 本でも出す——切り替えと「閉じる」の手立てがここにしか無い
    -->
    <div v-if="tabs.length > 1 || planOpen" class="rtabs" role="tablist" aria-label="結果">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="rtab"
        role="tab"
        :class="{ sel: t.id === activeTabId }"
        :aria-selected="t.id === activeTabId"
        :title="t.sql"
        @click="selectTab(t.id)"
      >
        <span class="rtab-no">{{ t.index }}</span>
        <span class="rtab-name">{{ summarizeSql(t.sql) }}</span>
        <!--
          非クエリ文は行が無い。**行数の意味が無い文は「済」**（0 と出すと 0 行に見える）。
          ただし手続きの結果セットは行があるので、そちらは件数を出す
        -->
        <span v-if="t.execute && t.rows.length" class="rtab-count">{{ t.rows.length }}</span>
        <span v-else-if="t.execute" class="rtab-count">{{ t.execute.hasRowCount ? t.execute.updateCount : "済" }}</span>
        <span v-else class="rtab-count">{{ t.rows.length }}{{ t.hasMore ? "+" : "" }}</span>
      </button>

      <!--
        実行計画のタブ。**結果を置き換えるのではなく並べる**ので、計画を見たあとに
        結果へ戻れる（別パネルにしていた理由はタブでも満たせる）。
        閉じる ✕ はタブの中に重ねる。`role="tablist"` の直下にタブ以外のボタンを
        並べたくないので、包みは `presentation` にして中身だけを親へ見せる
      -->
      <span v-if="planOpen" class="rtab-slot" role="presentation">
        <button
          class="rtab plan"
          role="tab"
          :class="{ sel: planActive }"
          :aria-selected="planActive"
          :title="plan?.statement || '実行計画'"
          @click="selectTab(PLAN_TAB_ID)"
        >
          <span class="rtab-name">実行計画</span>
          <!-- 失敗・警告は帯の時点で分かるようにする（開かないと気づけないのを避ける） -->
          <span v-if="planError" class="rtab-count err">!</span>
          <span v-else-if="plan" class="rtab-count">{{ plan.summary.stepCount }}</span>
        </button>
        <button class="rtab-x" title="実行計画を閉じる" @click="closePlan">✕</button>
      </span>
    </div>

    <!-- ログを重ねる基準。ここを position: relative にしないとパネルが置けない -->
    <div class="results" @click="logOpen && (logOpen = false)">
    <!--
      実行計画。**結果表と同じ枠を丸ごと使う**——ここがスクロールするので、
      グラフが縦に伸びても SQL 欄との境界を動かせば見える高さを取れる
    -->
    <div v-if="planActive" class="plan-view">
      <LoadingBar v-if="planBusy" label="計画を取得しています…" />
      <p v-if="planError" class="plan-error">{{ planError }}</p>
      <PlanViewer v-if="plan" :plan="plan" :on-create-index="createIndex" />
    </div>

    <!-- 結果側。計画タブを見ている間は出さない（同じ領域なので重なる） -->
    <template v-else>
    <!--
      **タブごとに表のインスタンスを保つ**（KeepAlive）。切り替えのたびに作り直すと
      200 行 × 40 列で 220〜280ms のブロッキングが出て、描画後に操作を受け付けない
      （実測。DOM を挿し直すだけなら 65ms なので、大半は vnode の作り直し）。
      `:max` は保持するタブ数の上限——多数のタブで DOM を抱え込みすぎないため
    -->
    <KeepAlive :max="4">
      <SqlResultTable
        v-if="activeTab && activeTab.rows.length"
        :key="activeTab.id"
        :columns="activeTab.columns"
        :rows="activeTab.rows"
        :has-more="activeTab.hasMore"
        :loading-more="loadingMore"
        @load-more="loadMore"
      />
    </KeepAlive>

    <!--
      結果を返さない文（DML / DDL）の結果。**表の代わりにここへ出す**。
      警告（SQLCODE > 0）も併記する——捨てると「作られたのに何も言われない」になる
    -->
    <!--
      **`v-if` の連なりを切らない。** 間に別の要素を挟むと `v-else-if` が繋がらず、
      非クエリ文の結果と一緒に「該当する行はありません」まで出る（テストで踏んだ）
    -->
    <template v-if="executeInfo">
      <p class="done">
        {{ executeMessage }}
        <span v-if="executeInfo.warning" class="detail">
          （警告 SQLCODE={{ executeInfo.warning.sqlCode }} SQLSTATE={{ executeInfo.warning.sqlState }}）
        </span>
      </p>
      <!--
        `CALL P(…, ?)` の出力パラメーター。**表と同じ体裁で出す**——手続きの結果は
        これしか無いので、本文と同じ重みで読めないと呼んだ意味が分からない
      -->
      <table v-if="executeInfo.outputs" class="outparams">
        <thead>
          <tr><th>?</th><th>値</th></tr>
        </thead>
        <tbody>
          <tr v-for="(v, i) in executeInfo.outputs" :key="i">
            <td class="n">?{{ i + 1 }}</td>
            <td :class="{ null: v === null }">{{ v === null ? "NULL" : v }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <p v-else-if="executed && !error && !loading && !rows.length" class="empty">該当する行はありません。</p>
    <p v-else-if="!executed && !error && !rows.length" class="empty">
      接続を選び、SQL を入力して「実行」を押してください。実行できる範囲は IBM i の権限によります。
    </p>
    </template>

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
        <!-- 三角は `StatusBar` のログと同じ字（`▴`/`▾` は一回り小さく揃って見えない） -->
        {{ logOpen ? "▼" : "▲" }} 実行ログ <span class="cnt">{{ logEntries.length }}</span>
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
/* 候補を重ねる基準。入力欄と同じ矩形にするため、余白も枠も持たせない */
.editor-wrap { flex: none; position: relative; width: 100%; }
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
/* 非クエリ文の結果。**エラーと見間違えないよう**赤にはしない（成功の報告） */
.done { padding: 8px 4px; border-left: 3px solid var(--accent); }
/* 出力パラメーター。**結果表と同じ体裁**にする（読み方を 2 通り覚えさせない）。
   **幅は中身ぶんだけ**——親が伸ばすので `width: auto` では効かず、`?` と値の間に
   画面幅ぶんの空白が空いた（実ブラウザで確認）。`max-content` と `align-self` で止める */
.outparams { width: max-content; max-width: 100%; align-self: start; margin: 0 4px 8px; }
.outparams .n { color: var(--muted); }
/* 地の色を明示する。親（.group）が半透明の緑を重ねているため、
   固定列にだけ色を敷くと**そこだけ色がずれる**（実ブラウザの拡大で判明）。
   表の領域を不透明にして、固定列と本文を同じ地の上に載せる */
/* 結果領域。ログパネルを重ねる基準（position: relative）になる */
/* 結果と実行計画のタブ。2 つ以上のときだけ出る（単一文の見え方を変えない）。
   **色は実在する変数から取る**——`--border` / `--bg` / `--fg` はこのリポジトリに
   定義が無く、var() の解決に失敗したプロパティは初期値へ落ちる。`border` の
   shorthand では border-style が none になるので、枠が一切描かれていなかった */
.rtabs {
  display: flex;
  gap: 4px;
  padding: 4px 6px 0;
  overflow-x: auto;
  flex: 0 0 auto;
  border-bottom: 1px solid var(--line);
}
.rtab {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
}
.rtab.sel {
  background: var(--accent-soft);
  color: var(--ink);
  border-color: var(--accent);
}
.rtab-no {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}
.rtab-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.rtab-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}
.rtab-count.err {
  color: #c62828;
  font-weight: 700;
  opacity: 1;
}
/* 計画タブは「閉じる」を内側に重ねる。包み自体は見た目を持たない（枠はタブ側） */
.rtab-slot {
  position: relative;
  display: flex;
  align-items: stretch;
}
.rtab.plan {
  /* ✕ のぶんだけ右を空ける。文字と重ねない */
  padding-right: 26px;
}
.rtab-x {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  border: none;
  background: none;
  padding: 0 2px;
  line-height: 1;
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  border-radius: 3px;
}
.rtab-x:hover {
  color: #c62828;
}

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

/* 実行計画。高さは親（.results）から貰うので、SQL 欄との境界を動かせばそのまま広がる。
   **スクロールはここではしない**——図と詳細が別々に縦スクロールする
   （`PlanViewer` の `.pv-main` / `.pv-side`）。ここを `auto` にすると
   その 2 本に加えてペイン全体の縦棒が出て、どれを動かせばよいか分からなくなる */
.plan-view {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  padding: 8px 4px 0;
  display: flex;
  flex-direction: column;
}
/* 中の `PlanViewer` に高さを渡す（`height: 100%` の受け皿になる） */
.plan-view :deep(.plan-viewer) {
  flex: 1 1 auto;
  min-height: 0;
}
.plan-error {
  color: var(--t-red);
  font-size: 12px;
  margin: 0 0 6px;
}
</style>
