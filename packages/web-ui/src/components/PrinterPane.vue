<script setup lang="ts">
import { computed } from "vue";
import { sessionsStore } from "../stores/sessions.js";

const props = defineProps<{ sessionId: string; focused?: boolean }>();
const emit = defineEmits<{ (e: "focus"): void }>();

const session = computed(() => sessionsStore.get(props.sessionId));
const reports = computed(() => session.value?.reports ?? []);
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
      <span class="badge">プリンター</span>
      <span class="muted">起動: {{ session?.startupCode ?? "-" }}</span>
      <span class="muted">受信 {{ reports.length }} 件</span>
      <span class="spacer"></span>
      <button :disabled="!selected" @click="saveText">テキスト保存</button>
      <button :disabled="!selected" @click="downloadPdf">PDF ダウンロード</button>
      <button :disabled="!selected" @click="printReport">印刷</button>
    </div>
    <div class="body">
      <ul class="list">
        <li v-if="reports.length === 0" class="empty">
          スプール待ち受け中…<br />
          <small>ホスト側で用紙タイプ問い合わせ等の応答待ちの可能性があります</small>
        </li>
        <li
          v-for="(r, i) in reports"
          :key="r.id"
          :class="{ sel: r.id === selectedId }"
          @click="selectReport(r.id)"
        >
          <span class="name">スプール {{ i + 1 }}</span>
          <span class="meta">{{ r.pages.length }}ページ</span>
        </li>
      </ul>
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
.toolbar button {
  font-size: 12px;
  padding: 2px 8px;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.list {
  flex: none;
  width: 200px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  border-right: 1px solid var(--crt-bezel, #333);
}
.list li {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  cursor: pointer;
  border-bottom: 1px solid color-mix(in srgb, var(--crt-bezel, #333) 50%, transparent);
}
.list li.sel {
  background: color-mix(in srgb, var(--t-green, #3f6) 14%, transparent);
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
