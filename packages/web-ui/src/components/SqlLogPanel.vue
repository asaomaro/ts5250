<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import type { SqlLogEntry } from "../sqlLog.js";

/**
 * SQL 実行ログのドロワー。
 *
 * 5250 セッションの操作ログ（`LogPanel.vue`）と**同じ作法**で開く——
 * 状態は親（SqlPane）が持ち、トグルはフッターに置き、パネルは結果領域に重ねる。
 * 押し広げる形にすると開閉のたびに表の高さが変わり、読んでいた行を見失う。
 *
 * ⚠ **ここには SQL 文がそのまま出る。** 監査ログ（`audit.ts`）が
 * 「フィールド値を記録しない」方針なのに対し、SQL 文には値が含まれうるため、
 * この記録は**画面の中だけ**に留める（サーバーへ送らない・ファイルにも落とさない）。
 */
const props = defineProps<{ entries: SqlLogEntry[]; open: boolean }>();
const emit = defineEmits<{ close: []; clear: [] }>();

const bodyEl = ref<HTMLElement | null>(null);

/** 下端に貼り付いているときだけ最新へ追従する（読んでいる途中で飛ばさない） */
function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

function toBottom(): void {
  const el = bodyEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(
  () => props.entries.length,
  () => {
    const el = bodyEl.value;
    if (el && !atBottom(el)) return;
    void nextTick(toBottom);
  },
  { flush: "pre" }
);

watch(
  () => props.open,
  (open) => {
    if (open) void nextTick(toBottom);
  }
);

function clockOf(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** 1 行に収めるため、改行と連続空白を潰す（全文は title で読める） */
function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
</script>

<template>
  <div v-if="open" class="sqllog" role="log" aria-label="SQL 実行ログ">
    <div class="head">
      <strong>実行ログ</strong>
      <span class="muted">{{ entries.length }} 件・この画面を閉じると消えます</span>
      <span class="spacer"></span>
      <button class="link" :disabled="!entries.length" @click="emit('clear')">消去</button>
      <button class="link" @click="emit('close')">閉じる</button>
    </div>
    <div ref="bodyEl" class="body">
      <p v-if="!entries.length" class="empty">まだ実行していません。</p>
      <div v-for="e in entries" :key="e.id" class="row" :class="{ err: e.status === 'error', connect: e.kind === 'connect' }">
        <span class="ts">{{ clockOf(e.ts) }}</span>
        <span class="ms">{{ e.ms }}ms</span>
        <span class="outcome">
          <template v-if="e.status === 'error'">失敗</template>
          <template v-else-if="e.kind === 'connect'">接続</template>
          <template v-else-if="e.kind === 'more'">+{{ e.rowCount }} 件</template>
          <template v-else>{{ e.rowCount }} 件{{ e.hasMore ? "（続きあり）" : "" }}</template>
        </span>
        <span v-if="e.kind === 'connect'" class="sql conn">
          {{ e.target }}
          <template v-if="e.job"> job={{ e.job }}</template>
          <template v-else> （ジョブ情報を返さないホストです）</template>
        </span>
        <span v-else class="sql" :title="e.sql">{{ oneLine(e.sql) }}</span>
        <span v-if="e.detail" class="detail" :title="e.detail">{{ e.detail }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 結果領域の下端に**重ねる**。押し広げると表の高さが変わり、読む位置を見失う */
.sqllog {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 5;
  height: 50%;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--line);
  background: var(--card);
  box-shadow: 0 -4px 12px rgb(0 0 0 / 12%);
  animation: sqllog-up 0.18s ease;
}
@keyframes sqllog-up {
  from { transform: translateY(100%); }
}
@media (prefers-reduced-motion: reduce) {
  .sqllog { animation: none; }
}
.head {
  flex: none;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}
.spacer { flex: 1; }
.muted { color: var(--muted); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0; }
.empty { color: var(--muted); text-align: center; font-size: 12px; margin: 12px 0; }
.row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 3px 10px;
  font-family: var(--mono);
  font-size: 12px;
  white-space: nowrap;
}
.row:hover { background: var(--accent-soft); }
/* 接続の行は SQL の行と見分けが付くようにする */
.row.connect { background: color-mix(in srgb, var(--accent) 5%, transparent); }
.conn { color: var(--muted); }
.ts { color: var(--muted); }
/* 数字が伸び縮みしても右がずれないように幅を固定する */
.ms { color: var(--muted); min-width: 7ch; text-align: right; font-variant-numeric: tabular-nums; }
.outcome { min-width: 12ch; }
.sql { overflow: hidden; text-overflow: ellipsis; flex: 1; }
.detail { color: var(--muted); }
.row.err .outcome, .row.err .detail { color: #c62828; }
button.link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 12px; padding: 0; }
button.link:disabled { color: var(--muted); cursor: default; }
</style>
