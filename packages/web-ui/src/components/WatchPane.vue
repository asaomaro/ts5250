<script setup lang="ts">
/**
 * データ待ち行列の**監視コンソール**（`20260723-dtaq-watch-notify`）。
 *
 * 既存の「データ待ち行列」タブ（pull 型・押したときだけ要求）とは**別のアプリ**。
 * こちらは push 型で、**サーバーが常駐して待ち続ける**——ブラウザを閉じても、
 * このタブを閉じても監視は止まらない（requirement）。
 *
 * したがってこのコンポーネントは**状態を持たない**。真実はサーバーのレジストリにあり、
 * ここは `watchesStore`（サーバーの写し）を描くだけ。開いたときに購読し直すことで、
 * 閉じていた間の到着が履歴に揃う。
 *
 * **監視は消費する**（エントリを取り出して消す）。その注意は開始時だけでなく**常時**出す。
 */
import { onMounted, watch } from "vue";
import { watchesStore } from "../stores/watches.js";
import { workspaceStore } from "../stores/workspace.js";
import { MSG_WATCH_CONSUMES } from "../composables/opMessages.js";

defineProps<{ tabId: string }>();

onMounted(() => {
  void watchesStore.connect();
  // **タブを開いたら未読は解消**（プリンターと同じ挙動。requirement）
  watchesStore.markRead();
});

// 開いている間に届いた分も既読にする（見えているのにバッジが増え続けるのを避ける）
watch(
  () => watchesStore.totalUnread,
  (n) => {
    if (n > 0) watchesStore.markRead();
  }
);

const at = (ms: number): string => new Date(ms).toLocaleTimeString("ja-JP", { hour12: false });

/** 監視の追加はセッション段から（requirement: 起動口はセッション設定） */
function addWatch(): void {
  workspaceStore.showLauncher = true;
}
</script>

<template>
  <div class="watch">
    <p class="warn">⚠ {{ MSG_WATCH_CONSUMES }}</p>
    <p v-if="watchesStore.error" class="err">{{ watchesStore.error }}</p>

    <div class="cols">
      <section class="list">
        <div class="head">
          <span>監視中</span>
          <button class="btn ghost" @click="addWatch">＋ 監視を追加</button>
        </div>
        <p v-if="watchesStore.watches.length === 0" class="empty">
          監視はありません。「＋ 監視を追加」からセッション設定（種別: 待ち行列監視）を選んで接続してください。
        </p>
        <table v-else>
          <thead>
            <tr>
              <th>キュー</th>
              <th class="n">受信</th>
              <th class="n">未読</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="w in watchesStore.watches"
              :key="w.id"
              :class="{ sel: w.id === watchesStore.selected }"
              @click="watchesStore.select(w.id)"
            >
              <td>{{ w.label }}</td>
              <td class="n">{{ w.received }}</td>
              <td class="n">
                <span v-if="watchesStore.unreadOf(w.id) > 0" class="badge">
                  {{ watchesStore.unreadOf(w.id) }}
                </span>
              </td>
              <td>
                <span class="state" :class="w.state" :title="w.error ?? ''">
                  {{
                    w.state === "listening"
                      ? "監視中"
                      : w.state === "reconnecting"
                        ? "再接続中"
                        : w.state === "stopped"
                          ? "停止中"
                          : "エラー"
                  }}
                </span>
              </td>
              <td>
                <!--
                  **停止と開始を出し分ける。** 停止しても行は残る（#254）ので、
                  ここが「開始」に変わらないと止めたものを二度と再開できない。
                  `start` ではなく `resume` を送る——`start` は定義から**作る**ので
                  二重に掛かり、消費するエントリを取り合う
                -->
                <button
                  v-if="w.state === 'stopped' || w.state === 'error'"
                  class="btn ghost"
                  title="このキューの待ち受けを再開します"
                  @click.stop="watchesStore.resume(w.id)"
                >
                  開始
                </button>
                <button
                  v-else
                  class="btn ghost"
                  title="待ち受けを止めます（キューのエントリはホスト側に残ります）"
                  @click.stop="watchesStore.stop(w.id)"
                >
                  停止
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="hist">
        <div class="head">
          <span>
            履歴
            <template v-if="watchesStore.selected">
              — {{ watchesStore.watches.find((w) => w.id === watchesStore.selected)?.label }}
            </template>
          </span>
        </div>
        <p v-if="watchesStore.history.length === 0" class="empty">まだ届いていません。</p>
        <ol v-else class="entries">
          <!-- 新しいものを上に出す（届いた瞬間に気づくのが目的） -->
          <li v-for="e in [...watchesStore.history].reverse()" :key="e.seq">
            <span class="seq">#{{ e.seq }}</span>
            <span class="ts">{{ at(e.at) }}</span>
            <span class="text">{{ e.text }}</span>
            <span class="bytes">{{ e.bytes }}B</span>
            <span v-if="e.sender" class="sender" :title="e.sender">送信者あり</span>
          </li>
        </ol>
      </section>
    </div>
  </div>
</template>

<style scoped>
.watch {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 12px;
}
/* **ペイン全体はスクロールさせない。** スクロールさせるのは内側の 1 箇所だけ
   （`docs/UI-DESIGN.md` の二重スクロールの注意） */
.cols {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) 1.4fr;
  gap: 12px;
  min-height: 0;
}
.list,
.hist {
  display: flex;
  min-height: 0;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  font-weight: 600;
}
.warn {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--warn-line, var(--line));
  border-radius: 8px;
  background: var(--warn-bg, transparent);
  color: var(--ink);
}
.err {
  margin: 0;
  color: var(--danger, crimson);
}
.empty {
  margin: 0;
  padding: 12px;
  color: var(--muted);
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
}
th.n,
td.n {
  width: 4em;
  text-align: right;
}
tbody tr {
  cursor: pointer;
}
tbody tr.sel {
  background: var(--sel, rgb(0 0 0 / 6%));
}
.badge {
  display: inline-block;
  min-width: 1.4em;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--card);
  font-size: 0.8em;
  text-align: center;
}
.state.listening {
  color: var(--ok, green);
}
/* **停止中は「正常だが動いていない」。** 監視中と同じ色にすると、
   止めたことに気づかないまま帳票やエントリを待ってしまう */
.state.stopped {
  color: var(--muted, gray);
}
.state.reconnecting {
  color: var(--warn, darkorange);
}
.state.error {
  color: var(--danger, crimson);
}
.entries {
  margin: 0;
  padding: 6px 10px;
  overflow-y: auto; /* スクロールするのはここだけ */
  list-style: none;
}
.entries li {
  display: flex;
  gap: 0.8em;
  align-items: baseline;
  padding: 3px 0;
  border-bottom: 1px solid var(--line);
  font-family: var(--mono, monospace);
  font-size: 0.9em;
}
.seq,
.ts,
.bytes,
.sender {
  color: var(--muted);
  white-space: nowrap;
}
.text {
  flex: 1;
  overflow-wrap: anywhere;
}
</style>
