<script setup lang="ts">
import { ref, computed } from "vue";
import { logStore, type LogEntry } from "../stores/log.js";

const open = ref(false);
const filter = ref<"all" | "tx" | "rx" | "error">("all");
const expanded = ref<number | undefined>();

const shown = computed<LogEntry[]>(() =>
  logStore.entries.filter((e) => {
    if (filter.value === "all") return true;
    if (filter.value === "error") return e.error;
    return e.dir === filter.value;
  })
);

function download(): void {
  const blob = new Blob([logStore.toJsonl()], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "5250-log.jsonl";
  a.click();
  URL.revokeObjectURL(url);
}
const dirMark = (d: string): string => (d === "tx" ? "→" : d === "rx" ? "←" : "●");
</script>

<template>
  <div class="logpanel" :class="{ open }">
    <div class="head">
      <button class="title" @click="open = !open">{{ open ? "▾" : "▸" }} 操作ログ ({{ logStore.entries.length }})</button>
      <span class="tools" v-if="open">
        <button v-for="f in (['all', 'tx', 'rx', 'error'] as const)" :key="f" class="lbtn" :class="{ on: filter === f }" @click="filter = f">
          {{ f === "all" ? "全て" : f === "tx" ? "送信" : f === "rx" ? "受信" : "エラー" }}
        </button>
        <button class="lbtn" @click="logStore.clear()">クリア</button>
        <button class="lbtn" @click="download">⬇ JSONL</button>
      </span>
    </div>
    <div v-if="open" class="body">
      <template v-for="e in shown" :key="e.id">
        <div class="lg" :class="{ err: e.error }" @click="expanded = expanded === e.id ? undefined : e.id">
          <span class="t">{{ Math.round(e.ts) }}</span>
          <span class="d" :data-dir="e.dir">{{ dirMark(e.dir) }}</span>
          <span class="sid">{{ e.sessionId }}</span>
          <span class="k">{{ e.kind }}</span>
          <span class="m">{{ e.summary }}<em v-if="e.roundtripMs"> ({{ Math.round(e.roundtripMs) }}ms)</em></span>
        </div>
        <pre v-if="expanded === e.id && e.detail" class="detail">{{ JSON.stringify(e.detail, null, 2) }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.logpanel {
  border-top: 1px solid var(--crt-line);
  background: var(--crt-bezel);
  font-family: var(--mono);
}
.head {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  padding: 6px 10px;
}
.title {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
}
.tools {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.lbtn {
  font-size: 10.5px;
  padding: 2px 8px;
  background: var(--crt);
  color: var(--muted);
  border: 1px solid var(--crt-line);
  border-radius: 5px;
  cursor: pointer;
}
.lbtn.on {
  color: var(--t-green);
  border-color: var(--t-green);
}
.body {
  max-height: 180px;
  overflow-y: auto;
  background: var(--crt);
  padding: 4px 0;
}
.lg {
  display: flex;
  gap: 10px;
  padding: 2px 10px;
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
}
.lg.err {
  color: var(--t-red);
}
.d[data-dir="tx"] {
  color: var(--t-yellow);
}
.d[data-dir="rx"] {
  color: var(--t-turquoise);
}
.k {
  color: var(--t-white);
}
.detail {
  margin: 0;
  padding: 6px 24px;
  font-size: 10.5px;
  color: var(--muted);
  background: color-mix(in srgb, var(--t-green) 5%, transparent);
  overflow-x: auto;
}
</style>
