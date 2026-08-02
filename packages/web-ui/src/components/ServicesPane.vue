<script setup lang="ts">
/**
 * **サーバー側サービスの一覧**（`20260801-services-pane`）。
 *
 * プリンターと待ち行列を**同じ表**に並べる。利用者にとっては「サーバーで動き続けるもの」で
 * 1 つの概念であり、種別は行の属性でしかない。
 *
 * ## タブを開いても接続は増えない
 *
 * 一覧は REST、操作は WS（`open` を要さないメッセージだけ）。**見に行くために繋がない**
 * ——サービスはブラウザが居なくても動くものなので、見るのと動かすのを分ける。
 *
 * ## 見えるが押せないことがある
 *
 * 一覧は誰にでも出す（帳票が来ない理由が「止まっているから」なら、それが分からないと
 * 問い合わせるしかない）。**操作は admin だけ**なので、押せない相手にはボタンを出さない。
 */
import { onUnmounted, computed, watch } from "vue";
import { servicesStore } from "../stores/services.js";
import type { PrinterRow, WatchRow } from "@as400web/server";

/**
 * `active`: **いま見えているか**（`20260802-keep-pane-state`）。開いたタブは切り替えても
 * アンマウントせず `v-show` で隠すようになったので、「マウント中＝見えている」ではない。
 */
const props = defineProps<{ tabId: string; active?: boolean }>();

/**
 * **見えている間だけ定期取得する。**
 *
 * `servicesStore.open()` は `setInterval` で一覧を取り直し続ける。以前は
 * 「マウント中ずっと」で、それがタブを見ている間と同義だった。隠れたまま生き続ける今
 * そのままにすると、**見ていないのに問い合わせを投げ続ける**。
 */
watch(
  () => props.active,
  (on) => {
    if (on) void servicesStore.open();
    else servicesStore.close();
  },
  { immediate: true }
);
// タブを閉じたときも確実に止める（`active` の変化を伴わずに消えることがある）
onUnmounted(() => servicesStore.close());

/** プリンターと待ち行列を 1 つの表に畳む（利用者から見れば同じ「サービス」） */
interface Row {
  kind: "printer" | "watch";
  ref: string;
  name: string;
  state: string;
  error?: string;
  service: boolean;
  autoStart: boolean;
  /** 動いている実体があるか（無ければ「停止中」でも実体が無い＝一度も上がっていない） */
  running: boolean;
  detail: string;
  hasOutput?: boolean;
  /** 定義が変わったが、いまの接続には効いていない（開始し直しで反映される） */
  stale?: boolean;
  /** 転送が設定されているか（URL は画面に来ない） */
  hasWebhook?: boolean;
  /** **転送を諦めた件数＝失われたデータの数**。0 でなければ目立たせる */
  undelivered?: number;
}

const rows = computed<Row[]>(() => [
  ...servicesStore.printers.map(
    (p: PrinterRow): Row => ({
      kind: "printer",
      ref: p.ref,
      name: p.name,
      state: p.state,
      ...(p.error !== undefined ? { error: p.error } : {}),
      service: p.service,
      autoStart: p.autoStart,
      running: p.id !== undefined,
      hasOutput: p.hasOutput,
      ...(p.stale ? { stale: true } : {}),
      detail:
        p.receivedTotal !== undefined
          ? `帳票 ${p.receivedTotal} 件${p.buffered !== undefined && p.buffered < p.receivedTotal ? `（保持 ${p.buffered}）` : ""}`
          : ""
    })
  ),
  ...servicesStore.watches.map(
    (w: WatchRow): Row => ({
      kind: "watch",
      ref: w.ref,
      name: w.name,
      state: w.state,
      ...(w.error !== undefined ? { error: w.error } : {}),
      service: w.service,
      autoStart: w.autoStart,
      running: w.id !== undefined,
      ...(w.stale ? { stale: true } : {}),
      ...(w.hasWebhook ? { hasWebhook: true } : {}),
      ...(w.undelivered ? { undelivered: w.undelivered } : {}),
      detail: w.received !== undefined ? `エントリ ${w.received} 件${w.label ? ` — ${w.label}` : ""}` : ""
    })
  )
]);

/** 待ち受けている（接続を持っている）か。**停止中と再接続中を混ぜない**（意図と障害は別物） */
const listening = (r: Row): boolean => r.state === "listening" || r.state === "reconnecting";

function stateLabel(r: Row): string {
  if (r.state === "listening") return r.kind === "watch" ? "監視中" : "待ち受け中";
  if (r.state === "reconnecting") return "再接続中";
  if (r.state === "error") return "エラー";
  // **一度も上がっていないものを「停止中」と言い切らない**——止めた覚えが無いのに
  // 「停止中」と出ると、誰かが止めたように読める
  return r.running ? "停止中" : "未起動";
}

const kindLabel = (r: Row): string => (r.kind === "printer" ? "🖨 プリンター" : "👁 待ち行列");

function toggle(r: Row): void {
  if (r.kind === "printer") {
    const p = servicesStore.printers.find((x) => x.ref === r.ref);
    if (p) void (listening(r) ? servicesStore.stopPrinter(p) : servicesStore.startPrinter(p));
  } else {
    const w = servicesStore.watches.find((x) => x.ref === r.ref);
    if (w) void (listening(r) ? servicesStore.stopWatch(w) : servicesStore.startWatch(w));
  }
}

/** プリンターの警告（自動出力の失敗）。**編集できる相手にしか届かない**（文面にパスが載りうる） */
const warnings = computed(() =>
  servicesStore.printers.flatMap((p) => (p.warnings ?? []).map((w) => ({ name: p.name, ...w })))
);
const at = (ms: number): string => new Date(ms).toLocaleString("ja-JP", { hour12: false });
</script>

<template>
  <div class="services">
    <p class="lead">
      サーバーで動き続けるサービスの一覧です。<strong>ブラウザを閉じても止まりません。</strong>
      <span v-if="!servicesStore.editable" class="ro">（操作は管理者のみ）</span>
    </p>
    <p v-if="servicesStore.error" class="err">{{ servicesStore.error }}</p>

    <section class="list">
      <div class="head">
        <span>サービス</span>
        <button class="btn ghost" :disabled="Boolean(servicesStore.busy)" @click="servicesStore.refresh()">
          更新
        </button>
      </div>
      <p v-if="servicesStore.loaded && rows.length === 0" class="empty">
        サービスの定義がありません。セッション設定で種別「プリンター」を作り
        「サービスとして使う」に ✅ を入れるか、種別「待ち行列監視」を作ってください。
      </p>
      <p v-else-if="!servicesStore.loaded" class="empty">読み込み中…</p>
      <table v-else>
        <thead>
          <tr>
            <th>名前</th>
            <th>種別</th>
            <th>状態</th>
            <th>起動</th>
            <th>実績</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.ref">
            <td>
              {{ r.name }}
              <!-- 出力設定の**有無**だけ。パスもプリンター名も画面には来ない -->
              <span v-if="r.hasOutput" class="chip" title="PDF 保存 / 自動印刷の設定があります">出力あり</span>
              <span v-if="r.hasWebhook" class="chip" title="届いたエントリを転送する設定があります">転送あり</span>
              <span v-if="r.kind === 'printer' && !r.service" class="chip warn" title="サービス ☐ の定義です">
                対話型
              </span>
              <!-- **「直したのに効いていない」を黙らせない。** 設定を保存しても
                   動いているサービスは落とさないので、ここで知らせて止めどきを委ねる -->
              <span
                v-if="r.stale"
                class="chip warn"
                title="設定が変わっています。停止 → 開始で反映されます（いまの接続は変更前の設定で動いています）"
              >
                要再起動
              </span>
            </td>
            <td class="k">{{ kindLabel(r) }}</td>
            <td>
              <span class="state" :class="r.state" :title="r.error ?? ''">{{ stateLabel(r) }}</span>
              <span v-if="r.error" class="reason" :title="r.error">{{ r.error }}</span>
            </td>
            <td class="k">{{ r.autoStart ? "自動" : "手動" }}</td>
            <td class="k">
              {{ r.detail }}
              <!-- **監視は消費するので、これは失われたデータの数。** 目立たせないと
                   「黙って消えた」に気づけない -->
              <span
                v-if="r.undelivered"
                class="lost"
                :title="`転送できずに諦めたエントリです。監視は取り出して消すため、元に戻せません`"
              >
                ⚠ 未達 {{ r.undelivered }} 件
              </span>
            </td>
            <td>
              <!-- **押しても 403 になるボタンを出さない。** 一覧は見えても操作は admin だけ -->
              <button
                v-if="servicesStore.editable"
                class="btn ghost"
                :disabled="servicesStore.busy === r.ref"
                :title="listening(r) ? '待ち受けを止めます（受信済みは残ります）' : '待ち受けを始めます'"
                @click="toggle(r)"
              >
                {{ listening(r) ? "停止" : "開始" }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- **ブラウザが居ない間の失敗はここでしか気づけない。** タブを開いていないと
         自動出力の警告は溜まるだけで誰も見ない（`20260801-printer-session-residency`） -->
    <section v-if="warnings.length" class="list warns">
      <div class="head"><span>自動出力の警告</span></div>
      <ol class="entries">
        <li v-for="(w, i) in [...warnings].reverse()" :key="i">
          <span class="ts">{{ at(w.at) }}</span>
          <span class="nm">{{ w.name }}</span>
          <span class="msg">{{ w.message }}</span>
        </li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
.services {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 12px;
}
.lead {
  margin: 0;
  color: var(--ink);
}
.ro {
  color: var(--muted);
}
.err {
  margin: 0;
  color: var(--danger, crimson);
}
.list {
  display: flex;
  min-height: 0;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
}
/* **スクロールするのは内側の 1 箇所だけ**（`docs/UI-DESIGN.md` の二重スクロールの注意） */
.warns {
  min-height: 0;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  font-weight: 600;
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
td.k,
th:nth-child(2),
th:nth-child(4) {
  color: var(--muted);
  white-space: nowrap;
}
.chip {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 9px;
  font-size: 0.78em;
  color: var(--muted);
}
.chip.warn {
  border-color: var(--warn, darkorange);
  color: var(--warn, darkorange);
}
/* **失われたデータの数。** 状態の色分けとは別に、行の中で目に入るようにする */
.lost {
  display: block;
  color: var(--danger, crimson);
  font-weight: 600;
}
/* 状態の色分けは監視コンソール・プリンターと揃える（同じ意味に同じ色） */
.state.listening {
  color: var(--ok, green);
}
.state.stopped {
  color: var(--muted, gray);
}
.state.reconnecting {
  color: var(--warn, darkorange);
}
.state.error {
  color: var(--danger, crimson);
}
.reason {
  display: block;
  color: var(--muted);
  font-size: 0.85em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 28em;
}
.entries {
  margin: 0;
  padding: 6px 10px;
  overflow-y: auto;
  list-style: none;
}
.entries li {
  display: flex;
  gap: 0.8em;
  align-items: baseline;
  padding: 3px 0;
  border-bottom: 1px solid var(--line);
  font-size: 0.9em;
}
.ts,
.nm {
  color: var(--muted);
  white-space: nowrap;
}
.msg {
  flex: 1;
  overflow-wrap: anywhere;
}
</style>
