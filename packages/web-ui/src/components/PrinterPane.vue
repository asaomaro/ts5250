<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import ReportText from "./ReportText.vue";
import { sessionsStore, type SpoolReportView } from "../stores/sessions.js";
import { setPrinterOutput, startPrinter, stopPrinter } from "../session-controller.js";
import { renderSpoolHtml } from "@as400web/scs/spool-html";

const props = defineProps<{ sessionId: string; focused?: boolean }>();
const emit = defineEmits<{ (e: "focus"): void }>();

const session = computed(() => sessionsStore.get(props.sessionId));
const reports = computed(() => session.value?.reports ?? []);

/**
 * 受信件数の表示（`20260802-printer-report-history`）。
 *
 * **累計と保持を区別する。** サーバーは 50 件で頭打ちにして古いものから落とすので、
 * `reports.length` だけを「受信 N 件」と出すと、落ちた分がここで消える。
 *
 * **普段は括弧を出さない**——50 件を超えるまで起きない状態のために、常時 2 つ並べない。
 * サービス一覧（`ServicesPane`）の `帳票 N 件（保持 M）` と同じ形にしてある。
 */
const countLabel = computed(() => {
  const held = reports.value.length;
  const total = session.value?.receivedTotal ?? held;
  return total > held ? `受信 ${total} 件（保持 ${held}）` : `受信 ${held} 件`;
});

// ---- 未読クリア: このペインが表示されている＝ユーザーが見ている ----
onMounted(() => sessionsStore.markSpoolRead(props.sessionId));
watch(
  () => reports.value.length,
  () => sessionsStore.markSpoolRead(props.sessionId)
);

// ---- 待ち受けの開始/停止（`20260801-service-start-stop`）----
/**
 * 待ち受けの状態。**未設定は「待ち受け中」扱い**——`printer-opened` より前の一瞬と、
 * 状態を持たない古い経路がここに落ちる。停止中と誤表示するより、
 * いままでの見え方に倒すほうが安全。
 */
const state = computed(() => session.value?.state ?? "listening");
/** 接続を持っている状態。**停止中と再接続中を混ぜない**（意図と障害は別物） */
const listening = computed(() => state.value === "listening" || state.value === "reconnecting");
const stateLabel = computed(() =>
  state.value === "listening"
    ? "待ち受け中"
    : state.value === "reconnecting"
      ? "再接続中"
      : state.value === "stopped"
        ? "停止中"
        : "エラー"
);
/** `error` の理由（自動出力の失敗とは別物。あちらは警告バー） */
const stateError = computed(() => session.value?.serviceError);
/**
 * 押している間はボタンを止める。**サーバー側は冪等**だが、開始は数秒かかることがあり
 * （装置使用中の判明まで）、その間の連打で「押せているのか」が分からなくなる。
 *
 * **状態の値ではなく通知の到着で戻す**（`stateSeq`）——`error` のまま開始をやり直して
 * また同じ理由で失敗すると値が変わらず、ボタンが押せないまま固まる。
 */
const pending = ref(false);
watch(
  () => session.value?.stateSeq,
  () => (pending.value = false)
);
function toggleListening(): void {
  const id = props.sessionId;
  pending.value = true;
  if (listening.value) stopPrinter(id);
  else startPrinter(id);
}

// ---- サイドバー開閉・フィルタ ----
const sidebarOpen = ref(true);
const filter = ref("");
/** スプールがフィルタ語に一致するか（タイトル/本文の大文字小文字無視の部分一致） */
function matches(r: SpoolReportView, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (reportTitle(r).toLowerCase().includes(needle)) return true;
  return r.pages.some((p) => p.lines.some((l) => l.toLowerCase().includes(needle)));
}
const filteredReports = computed(() => reports.value.filter((r) => matches(r, filter.value)));

// ---- 自動出力（PDF 保存・自動印刷）の状態と警告 ----
/** サーバー側に自動出力設定があるか（トグルの表示条件） */
const outputConfigured = computed(() => session.value?.outputConfigured === true);
const outputEnabled = computed(() => session.value?.outputEnabled !== false);
function toggleOutput(): void {
  setPrinterOutput(props.sessionId, !outputEnabled.value);
}
// ---- 自動出力の結果ステータス（PDF 作成・印刷の成否） ----
/** スプールの結果（無ければ undefined＝記録なし） */
function statusOf(spoolId: string) {
  return session.value?.outputStatuses?.[spoolId];
}
/** 一覧行の簡易表示（成功 ✓ / 失敗 ✗ / スキップ ⏸ / 設定なしは項目ごと省略） */
function statusChips(spoolId: string): { label: string; cls: string }[] {
  const s = statusOf(spoolId);
  if (!s) return [];
  if (s.skipped) return [{ label: "⏸ スキップ", cls: "skip" }];
  const out: { label: string; cls: string }[] = [];
  if (s.pdf) out.push({ label: `PDF ${s.pdf.ok ? "✓" : "✗"}`, cls: s.pdf.ok ? "ok" : "ng" });
  if (s.print) out.push({ label: `印刷 ${s.print.ok ? "✓" : "✗"}`, cls: s.print.ok ? "ok" : "ng" });
  return out;
}
/** 選択スプールの詳細（保存先・プリンター名・失敗理由） */
const selectedStatusLines = computed<{ text: string; cls: string }[]>(() => {
  const r = selected.value;
  const s = r ? statusOf(r.id) : undefined;
  if (!s) return [];
  if (s.skipped) return [{ text: "自動出力オフのためスキップしました", cls: "skip" }];
  const lines: { text: string; cls: string }[] = [];
  if (s.pdf) {
    lines.push(
      s.pdf.ok
        ? { text: `PDF 保存: ${s.pdf.path ?? "成功"}`, cls: "ok" }
        : { text: `PDF 保存に失敗: ${s.pdf.error ?? "原因不明"}`, cls: "ng" }
    );
  }
  if (s.print) {
    lines.push(
      s.print.ok
        ? { text: `自動印刷: ${s.print.printer ?? ""} へ送信しました`, cls: "ok" }
        : { text: `自動印刷に失敗: ${s.print.error ?? "原因不明"}`, cls: "ng" }
    );
  }
  return lines;
});

/** 自動出力の警告（失敗）。画面上部のバーに出して気づけるようにする */
const warnings = computed(() => session.value?.printerWarnings ?? []);
const latestWarning = computed(() => warnings.value[warnings.value.length - 1]);
function warnTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}
function clearWarnings(): void {
  const s = session.value;
  if (s) s.printerWarnings = [];
}

/** CPA3394（用紙タイプ問い合わせ）回避のための writer 起動コマンド。デバイス名が分かれば差し込む */
const deviceName = computed(() => session.value?.meta?.deviceName ?? "<デバイス名>");
const formtypeCmd = computed(() => `STRPRTWTR DEV(${deviceName.value}) FORMTYPE(*ALL *NOMSG)`);
async function copyCmd(): Promise<void> {
  try {
    await navigator.clipboard.writeText(formtypeCmd.value);
  } catch {
    /* クリップボード不可環境では無視 */
  }
}

/** 帳票のタイトル＝先頭の非空白行（多くの帳票で見出し）。無ければ空 */
function reportTitle(r: SpoolReportView): string {
  for (const p of r.pages) {
    for (const line of p.lines) {
      const t = line.trim();
      if (t) return t.length > 46 ? t.slice(0, 46) + "…" : t;
    }
  }
  return "";
}
/** 総行数（空行含む） */
function reportLines(r: SpoolReportView): number {
  return r.pages.reduce((n, p) => n + p.lines.length, 0);
}
function receivedLabel(r: SpoolReportView): string {
  return r.receivedAt ? new Date(r.receivedAt).toLocaleTimeString() : "";
}
const selectedId = computed(() => session.value?.selectedReportId);
const selected = computed(() => reports.value.find((r) => r.id === selectedId.value));

/** 選択スプールの全ページを等幅テキストに（改ページは区切り線） */
const selectedText = computed(() => {
  const r = selected.value;
  if (!r) return "";
  return r.pages.map((p) => p.lines.join("\n")).join("\n" + "─".repeat(20) + " (改ページ) " + "─".repeat(20) + "\n");
});

function selectReport(id: string): void {
  const s = session.value;
  if (s) s.selectedReportId = id;
}

function saveText(): void {
  const r = selected.value;
  if (!r) return;
  const blob = new Blob([selectedText.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${session.value?.label ?? "spool"}-${r.id}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/** サーバー生成の PDF をダウンロードする（等幅・DBCS 対応・改ページ保持） */
async function downloadPdf(): Promise<void> {
  const r = selected.value;
  if (!r) return;
  const res = await fetch(`/api/spool/${props.sessionId}/${r.id}/pdf`);
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${session.value?.label ?? "spool"}-${r.id}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * ブラウザの印刷（→PDF）用に別ウィンドウで開いて印刷する。
 *
 * **中身は core の `renderSpoolHtml` に描かせる。** 以前はここで `<pre>` を組み立てていたが、
 * それだと (1) `--screen-mono` のフォントスタックをインラインで再掲することになり
 * （別ウィンドウに CSS 変数は届かない）二重管理になる、(2) 改ページが本物にならず
 * `selectedText` の「── (改ページ) ──」という区切り文字がそのまま紙に出る、
 * (3) 全角の桁が開いた先のフォント任せになる——の 3 つを抱えていた。
 * 同じ帳票の絵を 2 か所で持たない（`spool-html.ts` が唯一の経路）。
 */
function printReport(): void {
  const r = selected.value;
  if (!r) return;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(
    renderSpoolHtml(r.pages, {
      title: `${session.value?.label ?? "スプール"} — ${r.id}`,
      ...(r.receivedAt !== undefined ? { capturedAt: new Date(r.receivedAt).toISOString() } : {}),
      spoolId: r.id
    })
  );
  w.document.close();
  w.focus();
  // 印刷は次のタスクへ回す。document.write 直後だとレイアウト前に印刷が走る環境がある
  setTimeout(() => w.print(), 0);
}
</script>

<template>
  <div class="printer-pane" tabindex="0" @focus="emit('focus')" @mousedown="emit('focus')">
    <div class="toolbar">
      <button class="toggle" :title="sidebarOpen ? '一覧を隠す' : '一覧を表示'" @click="sidebarOpen = !sidebarOpen">
        {{ sidebarOpen ? "«" : "»" }}
      </button>
      <span class="badge">プリンター</span>
      <!-- **黙って止まらない。** 停止も再接続も失敗も、まずここで分かるようにする -->
      <span class="state" :class="state" :title="stateError ?? ''">
        {{ stateLabel }}<template v-if="stateError">: {{ stateError }}</template>
      </span>
      <span v-if="listening" class="muted">起動: {{ session?.startupCode ?? "-" }}</span>
      <span class="muted">{{ countLabel }}</span>
      <span class="spacer"></span>
      <!--
        待ち受けの開始/停止。**停止しても受信済みの帳票は消えない**——
        スプールはホストの OUTQ に残るので、停止は「いま消費しない」であって「取りこぼす」ではない
      -->
      <button
        class="run-toggle"
        :class="{ on: listening }"
        :disabled="pending"
        :title="listening ? 'ホストからの受け取りを止めます（受信済みの帳票は残ります）' : 'ホストからの受け取りを始めます'"
        @click="toggleListening"
      >
        {{ listening ? "停止" : "開始" }}
      </button>
      <!-- 自動出力の ON/OFF: サーバー側に出力設定があるときだけ表示 -->
      <button
        v-if="outputConfigured"
        class="out-toggle"
        :class="{ on: outputEnabled }"
        :title="outputEnabled ? '自動 PDF/印刷を停止する' : '自動 PDF/印刷を再開する'"
        @click="toggleOutput"
      >
        自動出力: <span class="onoff">{{ outputEnabled ? "ON" : "OFF" }}</span>
      </button>
      <button :disabled="!selected" @click="saveText">テキスト保存</button>
      <button :disabled="!selected" @click="downloadPdf">PDF ダウンロード</button>
      <button :disabled="!selected" @click="printReport">印刷</button>
    </div>
    <!-- 自動出力の失敗を画面で気づけるようにする（サーバーログだけに埋もれない） -->
    <div v-if="latestWarning" class="warn-bar" role="alert">
      <span class="warn-icon">⚠</span>
      <span class="warn-msg" :title="latestWarning.message">
        [{{ warnTime(latestWarning.at) }}] {{ latestWarning.message }}
      </span>
      <span v-if="warnings.length > 1" class="warn-count">他 {{ warnings.length - 1 }} 件</span>
      <button class="warn-close" title="消す" @click="clearWarnings">✕</button>
    </div>
    <div class="body">
      <div v-show="sidebarOpen" class="sidebar">
        <div class="filter">
          <input v-model="filter" type="search" placeholder="スプールを絞り込み（名称/本文）" />
        </div>
        <ul class="list">
          <!-- **停止中に「待ち受け中…」と出さない。** 待っていないのに待っていると書くのは嘘で、
               帳票が来ないのを装置やホストのせいだと思わせる -->
          <li v-if="reports.length === 0 && !listening" class="empty">
            <strong>{{ stateLabel }}</strong
            ><br />
            <small v-if="stateError">{{ stateError }}</small>
            <small v-else>「開始」を押すとホストからの受け取りを始めます。</small>
          </li>
          <li v-else-if="reports.length === 0" class="empty">
            スプール待ち受け中…<br />
            <small>
              ホスト側で用紙タイプ問い合わせ（CPA3394）の応答待ちになることがあります。writer の
              メッセージ制御を <code>*NOMSG</code> にすると毎回の「I」応答が不要になります:
            </small>
            <code class="cmd" @click="copyCmd" title="クリックでコピー">{{ formtypeCmd }}</code>
            <small>
              抑止するのは第2要素の <code>*NOMSG</code> です（<code>FORMTYPE(*ALL)</code> だけでは既定の
              <code>*INQMSG</code> のままで応答待ちは止まりません）。既存 writer は
              <code>CHGWTR WTR(…) FORMTYPE(*ALL *NOMSG)</code>。ただし writer の制御には
              <code>*JOBCTL</code> 権限が必要で、PUB400 のような共用環境では実行できません。
            </small>
          </li>
          <li v-else-if="filteredReports.length === 0" class="empty">
            「{{ filter }}」に一致するスプールはありません
          </li>
          <li
            v-for="r in filteredReports"
            :key="r.id"
            :class="{ sel: r.id === selectedId }"
            @click="selectReport(r.id)"
          >
            <div class="row1">
              <span class="idx">#{{ reports.indexOf(r) + 1 }}</span>
              <span class="title" :title="reportTitle(r)">{{ reportTitle(r) || "（無題）" }}</span>
            </div>
            <div class="row2">
              <span class="time">{{ receivedLabel(r) }}</span>
              <span class="meta">{{ r.pages.length }}ページ・{{ reportLines(r) }}行</span>
            </div>
            <!-- 自動出力の結果（成功も含めて一目で分かるように） -->
            <div v-if="statusChips(r.id).length" class="row3">
              <span v-for="(c, i) in statusChips(r.id)" :key="i" class="st" :class="c.cls">{{ c.label }}</span>
            </div>
          </li>
        </ul>
      </div>
      <div class="viewer">
        <!-- 選択スプールの自動出力の詳細（保存先・プリンター名・失敗理由） -->
        <div v-if="selectedStatusLines.length" class="status-detail">
          <div v-for="(l, i) in selectedStatusLines" :key="i" class="st-line" :class="l.cls">{{ l.text }}</div>
        </div>
        <!-- ホスト変換（HPT）で受けている帳票はページを持たない。中身はプリンターの言語なので
             当アプリでは描けない。何も出ないと壊れて見えるので、理由をはっきり書く -->
        <div v-if="selected && selected.pages.length === 0" class="viewer-empty raw">
          <p><strong>ホスト変換済みの印刷データです。</strong></p>
          <p>
            このセッションはホストに印刷データへ変換させる設定（印刷の経路＝ホスト変換）のため、
            画面表示と PDF は使えません。書式はホストが決めたまま、実プリンターへそのまま送られます。
          </p>
          <p class="hint">画面で読みたい場合は、セッション設定の「印刷の経路」を「画面で見る」に戻してください。</p>
        </div>
        <!-- 本文は共用の `ReportText` へ（`⚙ 表示` のリンク化・フォントが効く） -->
        <ReportText v-else-if="selected" :session-id="sessionId" :text="selectedText" />
        <div v-else class="viewer-empty">スプールを選択すると帳票を表示します</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ホスト変換で受けたときの説明。空白ではなく理由を出す */
.viewer-empty.raw {
  text-align: left;
  max-width: 46em;
  margin: 0 auto;
  padding: 24px 12px;
  line-height: 1.7;
}
.viewer-empty.raw .hint { color: var(--muted); font-size: 12px; }

.printer-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  outline: none;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  /* 上部の余白を他の一覧（ジョブ・オブジェクト等）に合わせる */
  padding: 9px 10px;
  border-bottom: 1px solid var(--crt-bezel, #333);
  font-size: 13px;
}
.badge {
  background: color-mix(in srgb, var(--t-green, #3f6) 20%, transparent);
  border: 1px solid var(--t-green, #3f6);
  border-radius: 3px;
  padding: 1px 8px;
  font-size: 13px;
}
.muted {
  color: var(--muted, #888);
  font-size: 13px;
}
.spacer {
  flex: 1;
}
/* ツールバーのボタンは F キー（.fk）と同じ CRT テイストに揃える */
.toolbar button {
  font-family: var(--mono);
  font-size: 12px;
  padding: 4px 10px;
  background: var(--crt);
  color: var(--muted);
  border: 1px solid var(--crt-line);
  border-radius: 5px;
  cursor: pointer;
}
.toolbar button:hover:not(:disabled) {
  color: var(--t-green);
  border-color: var(--t-green);
}
.toolbar button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.sidebar {
  flex: none;
  width: 220px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--crt-bezel, #333);
}
.filter {
  padding: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--crt-bezel, #333) 60%, transparent);
}
.filter input {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  font-size: 13px;
  background: var(--crt, #0b0f0b);
  color: var(--ink, #cfc);
  border: 1px solid var(--crt-bezel, #333);
  border-radius: 4px;
}
.toggle {
  min-width: 28px;
  text-align: center;
  font-size: 13px;
  line-height: 1;
  padding: 3px 6px;
}
/* 待ち受けの状態。**監視コンソール（WatchPane）と同じ色分け**にする——
   プリンターと待ち行列で語が違うだけで、意味は同じ */
.state {
  font-size: 12px;
  font-family: var(--mono, monospace);
}
.state.listening {
  color: var(--t-green, #3f6);
}
/* **停止中は「正常だが動いていない」。** 待ち受け中と同じ色にすると、
   止めたことに気づかないまま帳票を待ってしまう */
.state.stopped {
  color: var(--muted, #888);
}
.state.reconnecting {
  color: var(--warn, darkorange);
}
.state.error {
  color: var(--t-red, #c62828);
}
/* 開始/停止: 待ち受け中は緑（自動出力トグルと同じ扱い） */
.run-toggle.on {
  color: var(--t-green, #3f6);
  border-color: var(--t-green, #3f6);
}
/* 自動出力トグル: ON は緑で目立たせる */
.out-toggle.on {
  color: var(--t-green, #3f6);
  border-color: var(--t-green, #3f6);
}
/* ON/OFF で幅が変わらないよう固定幅を確保する（隣のボタンをずらさない） */
.onoff {
  display: inline-block;
  width: 2.2em;
  text-align: left;
}
/* 自動出力の結果: 一覧行の簡易チップ */
.row3 {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.st {
  font-size: 10px;
  font-family: var(--mono, monospace);
  padding: 0 5px;
  border-radius: 3px;
  border: 1px solid var(--crt-line, #333);
  color: var(--muted, #888);
}
.st.ok {
  color: var(--t-green, #3f6);
  border-color: var(--t-green, #3f6);
}
.st.ng {
  color: var(--t-red, #c62828);
  border-color: var(--t-red, #c62828);
}
/* 選択スプールの結果詳細（ビューア上部） */
.status-detail {
  margin: -8px -8px 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--crt-bezel, #333);
  font-family: var(--mono, monospace);
  font-size: 11px;
}
.st-line.ok {
  color: var(--t-green, #3f6);
}
.st-line.ng {
  color: var(--t-red, #c62828);
}
.st-line.skip {
  color: var(--muted, #888);
}
/* 自動出力の失敗を示す警告バー */
.warn-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  background: color-mix(in srgb, var(--t-red, #c62828) 16%, transparent);
  border-bottom: 1px solid var(--t-red, #c62828);
  color: var(--ink, #cfc);
  font-size: 11.5px;
}
.warn-icon {
  color: var(--t-red, #c62828);
}
.warn-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono, monospace);
}
.warn-count {
  flex: none;
  color: var(--muted, #888);
}
.warn-close {
  flex: none;
  background: none;
  border: none;
  color: var(--muted, #888);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}
.list {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}
.cmd {
  display: block;
  margin: 6px 0;
  padding: 4px 6px;
  background: var(--crt, #0b0f0b);
  border: 1px solid var(--crt-bezel, #333);
  border-radius: 4px;
  font-family: var(--mono, monospace);
  font-size: 11px;
  color: var(--t-green, #3f6);
  cursor: pointer;
  word-break: break-all;
}
.list li {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  /* 他の一覧（ジョブ・オブジェクト等）と同じ大きさに揃える */
  font-size: 13px;
  cursor: pointer;
  border-bottom: 1px solid color-mix(in srgb, var(--crt-bezel, #333) 50%, transparent);
}
.list li.sel {
  background: color-mix(in srgb, var(--t-green, #3f6) 14%, transparent);
}
.list .row1 {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.list .idx {
  color: var(--muted, #888);
  font-size: 12px;
  flex: none;
}
.list .title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.list .row2 {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  color: var(--muted, #888);
  font-size: 12px;
}
.list li.empty {
  cursor: default;
  color: var(--muted, #888);
  text-align: center;
  padding: 16px 8px;
}
.list .meta {
  color: var(--muted, #888);
  font-size: 12px;
}
.viewer {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 8px;
}
.viewer pre {
  margin: 0;
  /* 以前は DejaVu Sans Mono/Courier New で日本語が等幅にならなかった。
     日本語対応の等幅（半角:全角=1:2）に揃え、帳票の桁を保つ（--screen-mono） */
  font-family: var(--screen-mono);
  font-size: 12px;
  line-height: 1.2;
  white-space: pre;
}
.viewer-empty {
  color: var(--muted, #888);
  display: grid;
  place-items: center;
  height: 100%;
}
</style>
