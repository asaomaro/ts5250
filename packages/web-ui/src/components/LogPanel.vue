<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { logStore, type LogEntry } from "../stores/log.js";

/**
 * 操作ログ。**エミュレーターの下端に重ねて**スライド表示する。
 * 領域を押し広げると画面が縮んで 5250 の桁組みが変わるため、覆いかぶせる形にした。
 */
const props = defineProps<{
  /** このセッションのログだけを出す。未指定なら全件（従来の全体表示） */
  sessionId?: string;
  /** 開いているか。**トグルはフッター（StatusBar）が持つ**——2 行にしないため */
  open?: boolean;
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const filter = ref<"all" | "tx" | "rx" | "error">("all");
const expanded = ref<number | undefined>();

const shown = computed<LogEntry[]>(() =>
  logStore.entries.filter((e) => {
    if (props.sessionId !== undefined && e.sessionId !== props.sessionId) return false;
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

const bodyEl = ref<HTMLElement>();
/** 最下部にいるか。数 px の余裕を持たせる（端数で判定が揺れるため） */
function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}
function toBottom(): void {
  const el = bodyEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/**
 * 新しい行に追従する。**最下部にいるときだけ**——
 * 過去を遡って読んでいる最中に飛ばされると、追っていた行を見失う。
 * flush: "pre" で描画前に位置を測り、描画後に寄せる。
 */
watch(
  () => shown.value.length,
  (_n, _o) => {
    const el = bodyEl.value;
    const follow = !el || atBottom(el);
    if (!follow) return;
    void nextTick(toBottom);
  },
  { flush: "pre" }
);

/** 開いたときは最新を見せる（前回の位置を覚えていても、まず見たいのは今の状況） */
watch(
  () => props.open,
  (open) => {
    if (open) void nextTick(toBottom);
  }
);
</script>

<template>
  <div v-if="open" class="logpanel">
    <div class="head">
      <span class="tools">
        <button v-for="f in (['all', 'tx', 'rx', 'error'] as const)" :key="f" class="lbtn" :class="{ on: filter === f }" @click="filter = f">
          {{ f === "all" ? "全て" : f === "tx" ? "送信" : f === "rx" ? "受信" : "エラー" }}
        </button>
        <button class="lbtn" @click="logStore.clear()">クリア</button>
        <button class="lbtn" @click="download">⬇ JSONL</button>
        <button class="lbtn close" title="閉じる" @click="emit('close')">✕</button>
      </span>
    </div>
    <div ref="bodyEl" class="body">
      <template v-for="e in shown" :key="e.id">
        <div class="lg" :class="{ err: e.error }" @click="expanded = expanded === e.id ? undefined : e.id">
          <span class="t">{{ Math.round(e.ts) }}</span>
          <span class="d" :data-dir="e.dir">{{ dirMark(e.dir) }}</span>
          <span v-if="!sessionId" class="sid">{{ e.sessionId }}</span>
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
  /* 下端に重ねる。押し広げると 5250 の表示領域が縮み、桁組みが変わってしまう */
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 5;
  border-top: 1px solid var(--crt-line);
  background: color-mix(in srgb, var(--crt-bezel) 94%, transparent);
  backdrop-filter: blur(2px);
  font-family: var(--mono);
  /* 件数に依らず画面の半分。開くたびに高さが変わると読む位置を見失う */
  height: 50%;
  display: flex;
  flex-direction: column;
  animation: slide-up 0.18s ease;
}
@keyframes slide-up {
  from {
    transform: translateY(100%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .logpanel {
    animation: none;
  }
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
  /* 親（.logpanel）が高さを決めるので、ここで上限を持たない。
     以前の max-height: 180px は、親が内容に合わせて伸びていた頃の名残 */
  flex: 1;
  min-height: 0;
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
