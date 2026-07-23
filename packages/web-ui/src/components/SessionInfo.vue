<script setup lang="ts">
import { computed } from "vue";
import { sessionsStore } from "../stores/sessions.js";

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

const state = computed(() => sessionsStore.get(props.sessionId));
const job = computed(() => state.value?.job);
/**
 * ジョブの表示。番号まで分かれば従来と同じ `番号/ユーザー/名前`、
 * 装置名しか分からなければ名前だけ（手サインオンでは誰のジョブか特定できない）
 */
const jobText = computed(() => {
  const j = job.value;
  if (!j) return "";
  return j.number !== undefined && j.user !== undefined
    ? `${j.number}/${j.user}/${j.name}`
    : j.name;
});
// プリンターセッションはジョブ情報を持たない（表示セッション専用）
const isPrinter = computed(() => state.value?.kind === "printer");

/** 接続設定の情報行（重複は state 側に統一。資格情報の平文は出さない） */
const metaRows = computed<{ label: string; value: string }[]>(() => {
  const s = state.value;
  if (!s) return [];
  const m = s.meta ?? {};
  const rows: { label: string; value: string }[] = [];
  rows.push({ label: "種別", value: isPrinter.value ? "プリンター" : "5250端末" });
  if (m.host) rows.push({ label: "ホスト", value: `${m.host}${m.port ? ":" + m.port : ""}` });
  const ccsid = s.ccsid ?? m.ccsid;
  if (ccsid !== undefined) rows.push({ label: "CCSID", value: String(ccsid) });
  // 画面: 表示セッションのみ（プリンターは画面を持たない）。実サイズ主＋設定差分のみ併記
  if (!isPrinter.value) {
    if (s.snapshot) {
      const actual = `${s.snapshot.rows}x${s.snapshot.cols}`;
      const setSize = m.screenSize && m.screenSize !== actual ? `（設定 ${m.screenSize}）` : "";
      rows.push({ label: "画面", value: `${actual}${setSize}` });
    } else if (m.screenSize) {
      rows.push({ label: "画面サイズ", value: m.screenSize });
    }
  }
  // **実際に割り当てられた装置名**を優先する（ホスト採番なら設定値は空）。
  // 設定と違う名前になっていたら、そのことが分かるように併記する
  const actualDevice = s.job?.name;
  const configured = m.deviceName;
  if (actualDevice) {
    const differs = configured && configured !== actualDevice ? `（設定 ${configured}）` : "";
    rows.push({ label: "デバイス名", value: `${actualDevice}${differs}` });
  } else if (configured) {
    rows.push({ label: "デバイス名", value: configured });
  }
  if (m.tls) rows.push({ label: "TLS", value: "有効" });
  if (m.autoSignon) rows.push({ label: "自動サインオン", value: m.signonUser ? `有効（${m.signonUser}）` : "有効" });
  return rows;
});

</script>

<template>
  <template v-if="state">
    <!-- バックドロップ: 外側クリックで閉じる -->
    <div class="backdrop" @click="emit('close')" @mousedown.stop></div>
    <div class="popover" @mousedown.stop @click.stop>
      <!-- 接続設定の情報（種別・ホスト・CCSID・画面・デバイス名・TLS・サインオン） -->
      <div class="row" v-for="(r, i) in metaRows" :key="'m' + i"><span>{{ r.label }}</span><b>{{ r.value }}</b></div>
      <!--
        表示セッション: ジョブ情報。**接続時に自動で入る**（画面には触れない）。
        番号・ユーザーは引けたときだけなので、装置名だけのこともある。
        何も分からなければ**行ごと出さない**——押しても何も起きないボタンを残さないため
      -->
      <div class="row" v-if="!isPrinter && job">
        <span>ジョブ</span>
        <b class="jobval">{{ jobText }}</b>
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
  min-width: 260px;
  width: max-content;
  max-width: 360px;
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
  width: 7.5em;
  flex: none;
  white-space: nowrap;
  color: var(--muted);
}
.row b {
  color: var(--t-green);
  word-break: break-all;
}
/* ジョブ情報（番号/ユーザー/名前）は折り返さない */
.jobval {
  white-space: nowrap;
  word-break: normal;
}
.btn {
  white-space: nowrap;
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
