<script setup lang="ts">
/**
 * 単一アプリ専用の最小画面（`embed.html`のルート）。`.aidev/works/20260924-vscode-extension/
 * design.md`「設計方針4」・architecture.md「コンポーネント/モジュール」。
 *
 * 既存のワークスペースUI（`App.vue`）のタブ帯・システム切替・ランチャーは一切持たない。
 * `app`（emulator/printer/spool/sql/ifs）に応じて対象ペイン1つだけをマウントする。
 * 接続前の待機画面に`SettingsForm`を置き、編集はその場で`.ts5250`へ自動保存する（`decisions.md` D23。
 * 以前はヘッダーの⚙からポップアップで開いていた——接続中に設定を変えても反映できないので廃止した）。
 *
 * **接続経路がapp種別で違う**（design.md「設計方針3」。tasks工程での訂正・`decisions.md` D3）:
 * - emulator/printer（セッション）: `ConnectPayload`の`host`/`port`/`user`/`password`等を直接
 *   `openSession()`/`openPrinterSession()`へ渡す（`WsOpen`の「ブラウザ直指定」モード）
 * - spool/sql/ifs: 拡張ホストが個人設定へ登録した`systemRef`
 *   （`own:<id>`）を、そのまま対象ペインの`system` propへ渡す（REST層がsystem参照を要求するため）
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { WsOpen } from "@ts5250/server";
import EmulatorPane from "./components/EmulatorPane.vue";
import PrinterPane from "./components/PrinterPane.vue";
import SpoolPane from "./components/SpoolPane.vue";
import SqlPane from "./components/SqlPane.vue";
import IfsPane from "./components/IfsPane.vue";
import SettingsForm from "./components/SettingsForm.vue";
import ViewSettingsMenu from "./components/ViewSettingsMenu.vue";
import DesignMenu from "./components/DesignMenu.vue";
import SessionInfo from "./components/SessionInfo.vue";
import { embedStore, postToHost } from "./stores/embed.js";
import { openSession, openPrinterSession, closeSession } from "./session-controller.js";
import { makePaneTabId } from "./paneLabels.js";
import { sessionsStore, type SessionMeta } from "./stores/sessions.js";
import { featureOf } from "./features.js";
import { REPORT_VIEW_KEYS, type ViewKey } from "./stores/viewSettings.js";
import type { EmbedAppKind, SettingsFormValues } from "./embed-protocol.js";
import { downloadScreenHtml } from "./screenExport.js";
import { settingsColumnsOf } from "./settingsLayout.js";

const props = defineProps<{ app: EmbedAppKind }>();

/**
 * 装置を掴むセッション（emulator・printer）か。**接続／切断・ヘッダーの名前とⓘはセッションだけ**
 * （`decisions.md` D19/D20）。spool/sql/ifsは操作ごとに接続するので「開く」だけ
 */
const isSession = computed(() => props.app === "emulator" || props.app === "printer");

const sessionId = ref<string | undefined>();
const connecting = ref(false);
const connectError = ref<string | undefined>();

/**
 * app種別ごとのペイン機能ID（`paneLabels.ts`の語彙）。**Recordのキーを`EmbedAppKind`から
 * 型で導出する**——三項演算子の連鎖（最後をelseで受ける書き方）だと、`EmbedAppKind`に
 * 種別が増えても既存のelse分岐にそのまま落ち、コンパイルエラーにならず気づけない
 * （taskcheck T6の指摘）。ここはRecordのキー網羅チェックに任せる
 */
const APP_FEATURES: Record<Exclude<EmbedAppKind, "emulator" | "printer">, string> = {
  spool: "spool:files",
  sql: "sql:query",
  ifs: "ifs:files"
};

/**
 * spool/sql/ifs用のタブIDとsystemRef。**両方揃って初めて意味を持つ**ので
 * 1つのcomputedにまとめる（`exactOptionalPropertyTypes`下で `system?: string` prop に
 * `string | undefined` を渡さずに済むよう、undefinedならペインごと出さない）
 */
const restTarget = computed(() => {
  const ref = embedStore.connect?.systemRef;
  if (!ref || props.app === "emulator" || props.app === "printer") return undefined;
  return { tabId: makePaneTabId(APP_FEATURES[props.app], ref), system: ref };
});

/**
 * `⚙ 表示`（`ViewSettingsMenu`）を出す対象。`App.vue`の`viewMenuTarget`と同じ判断
 * （emulatorは全項目、printer/spoolは帳票向けに絞った`REPORT_VIEW_KEYS`のみ。
 * sql/ifsは5250画面でも帳票でもないので出さない）を、この画面の状態から導く
 */
const viewMenuTarget = computed<{ sessionId: string; keys?: readonly ViewKey[] } | undefined>(() => {
  if (props.app === "emulator") return sessionId.value ? { sessionId: sessionId.value } : undefined;
  // プリンターセッションはセッションID、スプールはタブIDを鍵にする（`App.vue`と同じ）
  if (props.app === "printer") return sessionId.value ? { sessionId: sessionId.value, keys: REPORT_VIEW_KEYS } : undefined;
  if (props.app === "spool" && restTarget.value) return { sessionId: restTarget.value.tabId, keys: REPORT_VIEW_KEYS };
  return undefined;
});

watch(
  () => embedStore.connect,
  async (payload) => {
    if (!payload) return;
    if (!isSession.value) return; // spool/sql/ifsはsystemRefをpropsへ渡すだけで済む
    // **二重発火を防ぐ**（`composables/openConfigured.ts`の`if (connecting.value) return;`と
    // 同じ理由）。`await openSession()`の最中にもう一度`connect`/`saved`が来ると、
    // 後から解決した方が`sessionId`を上書きし、先勝ちのセッションが孤児のまま残る
    // （taskcheck T6の指摘）
    if (connecting.value) return;
    // **再接続時（connectが再び来たとき）、前のセッションを畳んでから開き直す。** 畳まずに`sessionId`を
    // 上書きすると、サーバー側に古いセッションが孤児として残り続ける
    // （taskcheck cross: `01-embed-ui`の自己点検で発見）
    if (sessionId.value) closeSession(sessionId.value);
    sessionId.value = undefined;
    connecting.value = true;
    connectError.value = undefined;
    try {
      const printer = props.app === "printer";
      // プリンターは`kind:"printer"`で開く。サーバーの直接接続の経路は出力設定（自動PDF・自動印刷）を
      // 受け付けない（信頼設定。`ws-handler.ts`の`onOpenPrinter`）——.ts5250からは帳票を受けて見るだけ
      const open: WsOpen = { type: "open", host: payload.host, ...(printer ? { kind: "printer" as const } : {}) };
      if (payload.port !== undefined) open.port = payload.port;
      if (payload.tls !== undefined) open.tls = payload.tls;
      if (payload.ccsid !== undefined) open.ccsid = payload.ccsid;
      if (payload.deviceName !== undefined) open.deviceName = payload.deviceName;
      if (!printer) {
        if (payload.katakanaVariant !== undefined) open.katakanaVariant = payload.katakanaVariant;
        if (payload.terminal !== undefined) open.terminal = payload.terminal;
        if (payload.screenSize !== undefined) open.screenSize = payload.screenSize;
        if (payload.enhanced !== undefined) open.enhanced = payload.enhanced;
      }
      if (payload.user !== undefined) open.user = payload.user;
      if (payload.password !== undefined) open.password = payload.password;
      // ⓘ（`SessionInfo`）に出す情報。本来のアプリはセッション設定から同じものを載せる（D19）
      const meta: SessionMeta = { host: payload.host, ...(printer ? { sessionType: "printer" as const } : {}) };
      if (payload.port !== undefined) meta.port = payload.port;
      if (payload.tls !== undefined) meta.tls = payload.tls;
      if (payload.ccsid !== undefined) meta.ccsid = payload.ccsid;
      if (payload.screenSize !== undefined) meta.screenSize = payload.screenSize;
      if (payload.password !== undefined) meta.autoSignon = true;
      if (payload.terminal !== undefined) meta.terminal = payload.terminal;
      if (payload.deviceName !== undefined) meta.deviceName = payload.deviceName;
      if (payload.user !== undefined) meta.signonUser = payload.user;
      // **`configRef`を持たない直接接続向けの持ち回り先**（`EmulatorPane.vue`の
      // `watermarkConfig`がここへフォールバックする。`decisions.md` D16）
      if (payload.watermark !== undefined) meta.watermark = payload.watermark;
      // **`systemRef`はemulatorでも付加的に乗る**（`decisions.md` D12。拡張ホスト側が
      // `syncSystem`で登録済み）。無くても接続自体は成立する——`SessionState.systemRef`が
      // 無いままなら、StatusBarのメッセージ表示ボタンはsystem参照を要求するREST機能を
      // 使えないだけで、5250画面そのものには影響しない
      // 名前は本来のアプリのタブ名（セッション設定の名前）に当たるもの＝ファイル名（D19）
      const label = payload.title ?? payload.host;
      sessionId.value = printer
        ? await openPrinterSession(open, label, meta, payload.systemRef)
        : await openSession(open, label, meta, payload.systemRef);
    } catch (e) {
      connectError.value = e instanceof Error ? e.message : String(e);
    } finally {
      connecting.value = false;
    }
  },
  { immediate: true }
);

/**
 * **接続を持つのはセッション（emulator・printer）だけ**（`decisions.md` D19/D20。サーバーの実装で確かめた）——
 * スプール・IFSは操作ごとに接続して閉じ、SQLはサーバーのプールが接続を持つ（タブ単位の接続が無い）。
 * だからセッションは「接続／切断」、それ以外は「開く」だけ（切断は無い）。「開く」を残すのは、
 * 開いた瞬間にペインがホストへ一覧を取りに行くため——設定だけ直したいときに取得を走らせない
 */
const openLabel = computed(() => (isSession.value ? "接続" : "開く"));

/**
 * 「接続」「開く」ボタン押下。拡張ホストへ要求を送るだけ——実際に開くのは`embedStore.connect`の変化を見る上の watch。
 * **間引き中の保存を先に送る**——拡張ホストはメッセージを順に処理するので、`save`→`connect`の順に届けば
 * 保存し終えたファイルで接続する（D23）
 */
function requestConnect(): void {
  flushSave();
  postToHost({ type: "connect" });
}

/**
 * 設定フォームの入力中の値。**「接続」ボタンの可否と種類の表示はこちらを見る**——`embedStore.loaded`は
 * 保存（間引き）の往復が済むまで古い。ファイルが外で書き換えられたら（`loadedRev`が進む）捨てる
 */
const draft = ref<SettingsFormValues | undefined>();
watch(
  () => embedStore.loadedRev,
  () => {
    cancelPendingSave();
    draft.value = undefined;
  }
);

/** 自動保存の間引き（ms）。1文字ごとにファイルへ書くと、VSCodeの元に戻す履歴が1文字単位になる */
const SAVE_DEBOUNCE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSave: SettingsFormValues | undefined;

/**
 * 自動保存の状態（D24）。保存ボタンが無いので、**保存されたかを画面に出す**——出さないと
 * 「接続を押したときに保存されるのか」が分からない（利用者の質問）
 */
const saveState = ref<"idle" | "pending" | "saving" | "saved">("idle");
const saveStateLabel = computed(() =>
  ({ idle: "", pending: "変更を保存します…", saving: "保存しています…", saved: "自動保存しました" })[saveState.value]
);
watch(
  () => embedStore.savedRev,
  () => {
    // 応答を待つ間に次の入力が来ていたら（pending）、そちらの表示を残す
    if (saveState.value === "saving") saveState.value = "saved";
  }
);
watch(
  () => embedStore.error,
  (e) => {
    if (e !== undefined) saveState.value = "idle"; // 失敗はエラー欄が出す
  }
);

function onFormChange(v: SettingsFormValues): void {
  draft.value = v;
  saveState.value = "pending";
  pendingSave = v;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}
function cancelPendingSave(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  pendingSave = undefined;
  if (saveState.value === "pending") saveState.value = "idle";
}
function flushSave(): void {
  const v = pendingSave;
  cancelPendingSave();
  if (!v) return;
  saveState.value = "saving";
  postToHost({ type: "save", payload: v });
}
// タブを閉じる直前の入力も落とさない
onBeforeUnmount(flushSave);
window.addEventListener("pagehide", flushSave);
onBeforeUnmount(() => window.removeEventListener("pagehide", flushSave));

/**
 * 設定の列数（`SettingsForm`と同じ表`settingsLayout.ts`を読む）。カードの幅はこれで決める——親（`.status.idle`）は
 * 中身の幅に縮むので%が効かず、固定幅でないとカードも縮む（D22/D23で踏んだ）。狭い画面は`max-width`で縮み、
 * フォームの`grid`が1列へ折り返す（D24）
 */
const settingsColumns = computed(() => settingsColumnsOf(props.app).length);
const cardWidth = computed(() => `${settingsColumns.value * 300 + 48}px`);

/** 接続先のホストが決まっているか（入力中の値を優先） */
const hasHost = computed(() => ((draft.value ?? embedStore.loaded)?.host ?? "").trim() !== "");

/**
 * 「切断」（セッション）／「閉じる」（spool/sql/ifs）ボタン押下。どちらも待機画面（設定）へ戻る。
 * spool/sql/ifsは接続を持たないが、戻らないと設定を変えられない（D23で設定は待機画面にだけ置いた）。
 * セッションでは`{type:"close"}`を送ってセッションを閉じる——ファイルを閉じる
 * だけだとサーバーは再接続の猶予（90秒）の間セッション＝装置を保持する（D17で実測）。
 * **ファイルの内容は変えない**——`embedStore.loaded`は触らないので、次に「接続」を押せば同じ設定で開ける
 */
function disconnect(): void {
  if (sessionId.value) closeSession(sessionId.value);
  sessionId.value = undefined;
  showInfo.value = false;
  embedStore.connect = undefined;
  connectError.value = undefined;
}

/** ヘッダー左の名前（本来のアプリのタブ名と同じく、セッションの`label`） */
const sessionLabel = computed(() => (sessionId.value ? sessionsStore.get(sessionId.value)?.label : undefined));
/** ヘッダー左のⓘ（本来のアプリのタブと同じ`SessionInfo`を出す） */
const showInfo = ref(false);

/**
 * 待機表示に出す「これは何か」（利用者の要望。D19）。ボタンだけだとエミュレータなのか
 * スプールなのか分からない。種類と一行説明はランチャーのカードと同じ文言（`features.ts`）
 */
const idleInfo = computed(() => {
  const c = draft.value ?? embedStore.loaded;
  let kind: string;
  let desc: string;
  if (props.app === "emulator") {
    const is3270 = c?.terminal === "3270";
    kind = is3270 ? "3270端末" : "5250端末";
    desc = is3270 ? "メインフレームの3270画面に接続して操作する。" : "IBM i の5250画面に接続して操作する。";
  } else if (props.app === "printer") {
    kind = "プリンター";
    desc = "ホストのプリンター装置として待ち受け、届いた帳票を表示する。";
  } else {
    const f = featureOf(APP_FEATURES[props.app]);
    kind = f?.name ?? props.app;
    desc = f?.desc ?? "";
  }
  return { kind, desc };
});
const idleError = computed(() => connectError.value ?? embedStore.error);

/** 設定フォームの初期値。**ファイルの現在値だけを見る**（以前は接続時の値を優先しており、保存後も古い値が出た。D23） */
const settingsInitial = computed<SettingsFormValues>(() => {
  const c = embedStore.loaded;
  const v: SettingsFormValues = { host: c?.host ?? "" };
  if (c?.port !== undefined) v.port = c.port;
  if (c?.tls !== undefined) v.tls = c.tls;
  if (c?.ccsid !== undefined) v.ccsid = c.ccsid;
  if (c?.katakanaVariant !== undefined) v.katakanaVariant = c.katakanaVariant;
  if (c?.terminal !== undefined) v.terminal = c.terminal;
  if (c?.screenSize !== undefined) v.screenSize = c.screenSize;
  if (c?.watermark !== undefined) v.watermark = c.watermark;
  if (c?.deviceName !== undefined) v.deviceName = c.deviceName;
  if (c?.user !== undefined) v.user = c.user;
  return v;
});

/**
 * 今の画面をHTMLで保存する（`App.vue`の`saveScreenHtml`と同じ機能をVSCode拡張側にも出す。
 * 利用者の要望）。**サーバーへ往復しない**——`downloadScreenHtml`はブラウザ側のスナップショットを
 * その場でHTML化しBlob URL経由でダウンロードさせる。VSCodeのWebView内でこれを動かすには、
 * shellの`<iframe>`（`webviewHtml.ts`）に`allow-downloads`のsandboxトークンが要る
 * （Playwrightで実際に再現して確認済み——無いとダウンロードが黙ってブロックされる）
 */
function saveScreenHtml(): void {
  if (sessionId.value) downloadScreenHtml(sessionId.value);
}
</script>

<template>
  <div class="embed-root">
    <header class="embed-header">
      <!-- 左: 名前とⓘ（本来のアプリのタブと同じ。D19）。接続中のセッション（emulator・printer）だけ——ⓘはセッションの情報なので -->
      <div v-if="isSession && sessionId" class="title-group">
        <span class="title">{{ sessionLabel }}</span>
        <span class="info-wrap">
          <button class="info" title="セッション情報" @click="showInfo = !showInfo">ⓘ</button>
          <SessionInfo v-if="showInfo" :session-id="sessionId" @close="showInfo = false" />
        </span>
      </div>
      <!-- 今の画面を自己完結HTMLで保存（`App.vue`の`⬇ HTML`と同じ機能） -->
      <button
        v-if="app === 'emulator' && sessionId"
        class="settings-btn"
        title="今の画面を HTML で保存する（見えているとおり・単体で開ける）"
        @click="saveScreenHtml"
      >
        ⬇ HTML
      </button>
      <!-- 切断（D17）。**セッション（emulator・printer）だけ**——他は接続を持たない（D19）。
           spool/sql/ifsは「閉じる」で待機画面（設定）へ戻る（D23） -->
      <button v-if="isSession && sessionId" class="settings-btn" title="切断する" @click="disconnect">切断</button>
      <button v-if="!isSession && restTarget" class="settings-btn" title="閉じて設定に戻る" @click="disconnect">閉じる</button>
      <ViewSettingsMenu
        v-if="viewMenuTarget"
        :key="viewMenuTarget.sessionId"
        :session-id="viewMenuTarget.sessionId"
        :keys="viewMenuTarget.keys"
      />
      <DesignMenu />
    </header>
    <div class="embed-body">
      <EmulatorPane v-if="app === 'emulator' && sessionId" :session-id="sessionId" :focused="true" />
      <PrinterPane v-else-if="app === 'printer' && sessionId" :session-id="sessionId" :focused="true" />
      <template v-else-if="!isSession && restTarget">
        <SpoolPane v-if="app === 'spool'" :tab-id="restTarget.tabId" :active="true" :system="restTarget.system" />
        <SqlPane v-else-if="app === 'sql'" :tab-id="restTarget.tabId" :active="true" :system="restTarget.system" />
        <IfsPane v-else :tab-id="restTarget.tabId" :active="true" :system="restTarget.system" />
      </template>
      <p v-else-if="connecting" class="status">接続中…</p>
      <!-- 待機表示: 何の機能か・どこへ繋ぐかを出す（D19）。エラーもここに出す——ボタンと別分岐にすると
           失敗後に押し直せない（D17） -->
      <div v-else class="status idle">
        <div class="idle-card" :style="{ width: cardWidth }">
          <div class="kind">{{ idleInfo.kind }}</div>
          <p class="desc">{{ idleInfo.desc }}</p>
          <p v-if="embedStore.loaded?.title" class="file">
            {{ embedStore.loaded.title }}.ts5250
            <!-- 保存ボタンは無い——編集は自動で保存される。そのことと結果をここに出す（D24） -->
            <span class="save-state" role="status">{{ saveStateLabel || "設定は編集すると自動で保存されます" }}</span>
          </p>
          <!-- ボタンは設定の上——設定済みなら押すだけのことが多く、欄（透かし等）が多いと下はスクロールしないと見えない -->
          <p v-if="idleError" class="error">{{ idleError }}</p>
          <button class="connect-btn" :disabled="!hasHost" :title="hasHost ? '' : 'ホストを入力してください'" @click="requestConnect">{{ openLabel }}</button>
          <!-- 設定はここで編集し、その場で自動保存する（D23）。ファイルが読めないとき（loaded無し）は出さない
               ——壊れたファイルを入力1つで上書きしないため -->
          <SettingsForm v-if="embedStore.loaded" :key="embedStore.loadedRev" :initial="settingsInitial" :app="app" @change="onFormChange" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.embed-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: var(--bg, #0b0f0b);
  color: var(--fg, #d9e3da);
}
.embed-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 4px 8px;
  flex: none;
}
.settings-btn {
  font-size: 14px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--crt-line, #333);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.embed-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
/* **ペインに幅いっぱいを与え、かつ縮められるようにする**（`decisions.md` D18）。
   行方向のflexの子は内容幅になる——IFSは1200px中652pxしか使わず右が空き、
   SQLは横に長い結果で4420pxまで膨らんでページ全体が横スクロールしていた（実測）。
   `min-width: 0`が無いと子の最小幅＝内容幅のままで、結果グリッド自身の横スクロールが効かない。
   本来のアプリは`.pane-slot`（ブロック要素）に載せるので、この問題が起きない */
.embed-body > * {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
/* `flex: 0 1 auto`で上の「幅いっぱい」を打ち消す——ペインではなく文言なので、伸ばすと`margin: auto`の
   横方向が効かず「接続中…」が左端に寄る（縦だけ中央になる。利用者の報告） */
.status {
  flex: 0 1 auto;
  margin: auto;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--muted);
}
.status .error {
  color: var(--t-red, #e06c6c);
}
.idle-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  /* 幅は列数から`:style`で与える（`cardWidth`）。狭い画面では親のmax-widthで縮める */
  max-width: 100%;
  box-sizing: border-box;
  padding: 18px 24px;
  border: 1px solid var(--crt-line, #333);
  border-radius: 8px;
}
.idle-card .kind {
  font-size: 16px;
  font-weight: 600;
  color: var(--fg, #d9e3da);
}
.idle-card .desc {
  margin: 0;
  text-align: center;
}
.idle-card .file {
  margin: 0;
  font-size: 12px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 12px;
}
.idle-card .save-state {
  color: var(--muted);
}
.idle-card .error {
  margin: 0;
}
/* ヘッダー左の名前とⓘ。右の操作群を押しやる（`margin-right: auto`はこの1つだけ） */
.title-group {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  min-width: 0;
}
.title-group .title {
  font-family: var(--mono);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.info-wrap {
  position: relative;
}
.info-wrap .info {
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 2px;
  font-size: 13px;
}
.info-wrap .info:hover {
  color: var(--fg, #d9e3da);
}
/* 設定の欄が増えて（透かし等）縦に収まらないときは、待機画面の中でスクロールする（D23） */
.status.idle {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-height: 100%;
  max-width: 100%;
  overflow-y: auto;
  padding: 12px 16px;
  box-sizing: border-box;
}
.connect-btn {
  font-family: var(--mono);
  font-size: 13px;
  padding: 6px 20px;
  border-radius: 6px;
  border: 1px solid var(--t-green, #4caf6a);
  background: transparent;
  color: var(--t-green, #4caf6a);
  cursor: pointer;
}
.connect-btn:disabled {
  border-color: var(--crt-line, #333);
  color: var(--muted);
  cursor: default;
}
</style>
