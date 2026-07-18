<script setup lang="ts">
import { computed } from "vue";
import { sessionsStore } from "../stores/sessions.js";
import { requestJobInfo } from "../session-controller.js";

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

const state = computed(() => sessionsStore.get(props.sessionId));
const job = computed(() => state.value?.job);
const locked = computed(() => state.value?.snapshot?.keyboardLocked ?? false);
// プリンターセッションはジョブ情報を持たない（表示セッション専用）
const isPrinter = computed(() => state.value?.kind === "printer");

/** 接続設定の情報行（重複は state 側に統一。資格情報の平文は出さない） */
const metaRows = computed<{ label: string; value: string }[]>(() => {
  const s = state.value;
  if (!s) return [];
  const m = s.meta ?? {};
  const rows: { label: string; value: string }[] = [];
  rows.push({ label: "種別", value: isPrinter.value ? "プリンター" : "表示" });
  if (m.host) rows.push({ label: "ホスト", value: `${m.host}${m.port ? ":" + m.port : ""}` });
  const ccsid = s.ccsid ?? m.ccsid;
  if (ccsid !== undefined) rows.push({ label: "CCSID", value: String(ccsid) });
  // 画面: 実際のサイズ（snapshot）を主に、設定 screenSize が異なる場合のみ併記
  if (s.snapshot) {
    const actual = `${s.snapshot.rows}x${s.snapshot.cols}`;
    const setSize = m.screenSize && m.screenSize !== actual ? `（設定 ${m.screenSize}）` : "";
    rows.push({ label: "画面", value: `${actual}${setSize}` });
  } else if (m.screenSize) {
    rows.push({ label: "画面サイズ", value: m.screenSize });
  }
  if (m.deviceName) rows.push({ label: "デバイス名", value: m.deviceName });
  if (m.tls) rows.push({ label: "TLS", value: "有効" });
  if (m.autoSignon) rows.push({ label: "自動サインオン", value: m.signonUser ? `有効（${m.signonUser}）` : "有効" });
  return rows;
});

function fetchJob(): void {
  requestJobInfo(props.sessionId);
}
</script>

<template>
  <template v-if="state">
    <!-- バックドロップ: 外側クリックで閉じる -->
    <div class="backdrop" @click="emit('close')" @mousedown.stop></div>
    <div class="popover" @mousedown.stop @click.stop>
      <!-- 接続設定の情報（種別・ホスト・CCSID・画面・デバイス名・TLS・サインオン） -->
      <div class="row" v-for="(r, i) in metaRows" :key="'m' + i"><span>{{ r.label }}</span><b>{{ r.value }}</b></div>
      <!-- 表示セッション: ジョブ情報 -->
      <div class="row" v-if="!isPrinter">
        <span>ジョブ</span>
        <b v-if="job">{{ job.number }}/{{ job.user }}/{{ job.name }}</b>
        <button v-else class="btn" :disabled="locked" @click="fetchJob">🔄 ジョブ情報を取得</button>
      </div>
      <!-- プリンター: 起動応答＋受信件数 -->
      <template v-if="isPrinter">
        <div class="row"><span>起動</span><b>{{ state.startupCode ?? "-" }}</b></div>
        <div class="row"><span>受信</span><b>{{ state.reports?.length ?? 0 }} 件</b></div>
      </template>
      <div class="row"><span>ラベル</span><b>{{ state.label }}</b></div>
      <div class="row">
        <span>状態</span><b>{{ state.connected ? "接続中" : "切断" }}{{ state.readOnly ? " (閲覧専用)" : "" }}</b>
      </div>
    </div>
  </template>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  background: transparent;
}
.popover {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 21;
  min-width: 240px;
  background: var(--crt-bezel);
  border: 1px solid var(--crt-line);
  border-radius: 8px;
  padding: 8px;
  box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.5);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  font-family: var(--mono);
  font-size: 11.5px;
}
.row > span:first-child {
  width: 6em;
  flex: none;
  color: var(--muted);
}
.row b {
  color: var(--t-green);
  word-break: break-all;
}
.btn {
  padding: 4px 10px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  font-size: 11px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
