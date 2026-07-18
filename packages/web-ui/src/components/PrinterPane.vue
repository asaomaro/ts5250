<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import { sessionsStore, type SpoolReportView } from "../stores/sessions.js";
import { setPrinterOutput } from "../session-controller.js";

const props = defineProps<{ sessionId: string; focused?: boolean }>();
const emit = defineEmits<{ (e: "focus"): void }>();

const session = computed(() => sessionsStore.get(props.sessionId));
const reports = computed(() => session.value?.reports ?? []);

// ---- 未読クリア: このペインが表示されている＝ユーザーが見ている ----
onMounted(() => sessionsStore.markSpoolRead(props.sessionId));
watch(
  () => reports.value.length,
  () => sessionsStore.markSpoolRead(props.sessionId)
);

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
const formtypeCmd = computed(() => `STRPRTWTR DEV(${deviceName.value}) FORMTYPE(*ALL)`);
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

/** ブラウザの印刷（→PDF）用に別ウィンドウで開いて印刷する */
function printReport(): void {
  if (!selected.value) return;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(
    `<pre style="font-family:'DejaVu Sans Mono',monospace;font-size:11px;white-space:pre">${escapeHtml(selectedText.value)}</pre>`
  );
  w.document.close();
  w.focus();
  w.print();
}
</script>

<template>
  <div class="printer-pane" tabindex="0" @focus="emit('focus')" @mousedown="emit('focus')">
    <div class="toolbar">
      <button class="toggle" :title="sidebarOpen ? '一覧を隠す' : '一覧を表示'" @click="sidebarOpen = !sidebarOpen">
        {{ sidebarOpen ? "«" : "»" }}
      </button>
      <span class="badge">プリンター</span>
      <span class="muted">起動: {{ session?.startupCode ?? "-" }}</span>
      <span class="muted">受信 {{ reports.length }} 件</span>
      <span class="spacer"></span>
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
          <li v-if="reports.length === 0" class="empty">
            スプール待ち受け中…<br />
            <small>
              ホスト側で用紙タイプ問い合わせ（CPA3394）の応答待ちになることがあります。writer を用紙タイプ不問で
              起動すると毎回の「I」応答が不要になります:
            </small>
            <code class="cmd" @click="copyCmd" title="クリックでコピー">{{ formtypeCmd }}</code>
            <small>（既存 writer は <code>CHGWTR</code> の FORMTYPE(*ALL) でも可）</small>
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
        <pre v-if="selected">{{ selectedText }}</pre>
        <div v-else class="viewer-empty">スプールを選択すると帳票を表示します</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.printer-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  outline: none;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--crt-bezel, #333);
}
.badge {
  background: color-mix(in srgb, var(--t-green, #3f6) 20%, transparent);
  border: 1px solid var(--t-green, #3f6);
  border-radius: 3px;
  padding: 0 6px;
  font-size: 12px;
}
.muted {
  color: var(--muted, #888);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
/* ツールバーのボタンは F キー（.fk）と同じ CRT テイストに揃える */
.toolbar button {
  font-family: var(--mono);
  font-size: 11px;
  padding: 3px 9px;
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
  padding: 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--crt-bezel, #333) 60%, transparent);
}
.filter input {
  width: 100%;
  box-sizing: border-box;
  padding: 3px 6px;
  font-size: 12px;
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
  font-size: 11px;
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
  font-size: 11px;
}
.list li.empty {
  cursor: default;
  color: var(--muted, #888);
  text-align: center;
  padding: 16px 8px;
}
.list .meta {
  color: var(--muted, #888);
  font-size: 11px;
}
.viewer {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 8px;
}
.viewer pre {
  margin: 0;
  font-family: "DejaVu Sans Mono", "Courier New", monospace;
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
