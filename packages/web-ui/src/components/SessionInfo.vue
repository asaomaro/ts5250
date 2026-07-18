<script setup lang="ts">
import { computed } from "vue";
import { sessionsStore } from "../stores/sessions.js";
import { requestJobInfo } from "../session-controller.js";

const props = defineProps<{ sessionId: string }>();
defineEmits<{ (e: "close"): void }>();

const state = computed(() => sessionsStore.get(props.sessionId));
const job = computed(() => state.value?.job);
const locked = computed(() => state.value?.snapshot?.keyboardLocked ?? false);
// プリンターセッションはジョブ情報を持たない（表示セッション専用）
const isPrinter = computed(() => state.value?.kind === "printer");

function fetchJob(): void {
  requestJobInfo(props.sessionId);
}
</script>

<template>
  <div v-if="state" class="popover" @mousedown.stop>
    <!-- 表示セッション: ジョブ情報 / プリンター: 起動応答＋受信件数 -->
    <div class="row" v-if="!isPrinter">
      <span>ジョブ</span>
      <b v-if="job">{{ job.number }}/{{ job.user }}/{{ job.name }}</b>
      <button v-else class="btn" :disabled="locked" @click="fetchJob">🔄 ジョブ情報を取得</button>
    </div>
    <template v-if="isPrinter">
      <div class="row"><span>種別</span><b>プリンター</b></div>
      <div class="row"><span>起動</span><b>{{ state.startupCode ?? "-" }}</b></div>
      <div class="row"><span>受信</span><b>{{ state.reports?.length ?? 0 }} 件</b></div>
    </template>
    <div class="row"><span>ラベル</span><b>{{ state.label }}</b></div>
    <div class="row"><span>状態</span><b>{{ state.connected ? "接続中" : "切断" }}{{ state.readOnly ? " (閲覧専用)" : "" }}</b></div>
    <div class="row" v-if="state.snapshot"><span>画面</span><b>{{ state.snapshot.rows }}x{{ state.snapshot.cols }}</b></div>
  </div>
</template>

<style scoped>
.popover {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 20;
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
  width: 5em;
  color: var(--muted);
}
.row b {
  color: var(--t-green);
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
