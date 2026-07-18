<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import { sessionsStore, type SpoolReportView } from "../stores/sessions.js";

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
      <button :disabled="!selected" @click="saveText">テキスト保存</button>
      <button :disabled="!selected" @click="downloadPdf">PDF ダウンロード</button>
      <button :disabled="!selected" @click="printReport">印刷</button>
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
          </li>
        </ul>
      </div>
      <div class="viewer">
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
