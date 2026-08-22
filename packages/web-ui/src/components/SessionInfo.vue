<script setup lang="ts">
import { computed } from "vue";
import { sessionsStore, type PcCommandView } from "../stores/sessions.js";

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

/**
 * PC コマンド（STRPCCMD）の履歴。**新しいものを上**に出す（直近の実行を探しに来るため）。
 * 履歴が無ければ節ごと出さない（有効・無効の別だけは 1 行で示す）。
 */
const pcCommands = computed(() => [...(state.value?.pcCommands ?? [])].reverse());

/**
 * 実行先の言い換え。**ブラウザが localhost に繋いでいれば、サーバー＝この PC** である
 * （5250 セッションを持つプロセスの機械で動くため）。そうでなければサーバー機で動いている。
 * 利用者が「どっちの PC でコマンドが動いたのか」で迷わないようにするための表示。
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function whereText(hostname: string): string {
  return LOOPBACK.has(location.hostname) ? `このPC（${hostname}）` : `サーバー（${hostname}）`;
}

/** 実行結果の 1 行表示。設定で実行しなかった場合も理由を出す（黙って何もしない、を避ける） */
function outcomeText(e: PcCommandView): string {
  const o = e.outcome;
  if (!o) return "実行中";
  switch (o.status) {
    case "ran":
      return o.exitCode === 0 ? "完了" : `終了コード ${o.exitCode ?? "-"}`;
    case "started":
      return "起動（完了を待たない）";
    case "disabled":
      return "無効（実行しない）";
    case "denied":
      return "許可リスト外";
    case "failed":
      return `失敗: ${o.error}`;
    default:
      return "実行中";
  }
}

const timeText = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** 接続設定の情報行（重複は state 側に統一。資格情報の平文は出さない） */
const metaRows = computed<{ label: string; value: string }[]>(() => {
  const s = state.value;
  if (!s) return [];
  const m = s.meta ?? {};
  const rows: { label: string; value: string }[] = [];
  // **端末の種類まで出す。** `kind` は画面／プリンターしか言わないので、
  // 表示セッションを一律 `5250端末` と書くと 3270 のセッションが 5250 に見える
  const terminal =
    m.terminal === "3270" ? "3270端末" : m.terminal === "vt" ? "VT端末" : "5250端末";
  rows.push({ label: "種別", value: isPrinter.value ? "プリンター" : terminal });
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
      <!--
        PC コマンド（STRPCCMD）。ホストが画面に隠して送ってくるので、
        何を・どこで実行したかをここで確認できるようにする
      -->
      <template v-if="!isPrinter">
        <div class="row">
          <span>PC コマンド</span><b>{{ state.pcCommandEnabled ? "有効" : "無効" }}</b>
        </div>
        <div v-for="(e, i) in pcCommands" :key="'p' + i" class="row pcrow">
          <span>{{ timeText(e.at) }}</span>
          <b>
            <span class="pccmd">{{ e.command }}</span>
            <span class="pcmeta">{{ outcomeText(e) }} / {{ whereText(e.hostname) }}</span>
          </b>
        </div>
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
/* PC コマンドはコマンド全文を見せたいので折り返す。結果は 1 段下げて小さく */
.pcrow b {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.pccmd {
  word-break: break-all;
}
.pcmeta {
  color: var(--muted);
  font-size: 10.5px;
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
