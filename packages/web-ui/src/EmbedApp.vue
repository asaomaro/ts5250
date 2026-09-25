<script setup lang="ts">
/**
 * 単一アプリ専用の最小画面（`embed.html`のルート）。`.aidev/works/20260924-vscode-extension/
 * design.md`「設計方針4」・architecture.md「コンポーネント/モジュール」。
 *
 * 既存のワークスペースUI（`App.vue`）のタブ帯・システム切替・ランチャーは一切持たない。
 * `app`（emulator/printer/sql/ifs）に応じて対象ペイン1つだけをマウントし、設定ボタンで
 * `SettingsForm`を開閉する。
 *
 * **接続経路がapp種別で違う**（design.md「設計方針3」。tasks工程での訂正・`decisions.md` D3）:
 * - emulator: `ConnectPayload`の`host`/`port`/`user`/`password`等を直接`openSession()`へ渡す
 *   （`WsOpen`の「ブラウザ直指定」モード。system登録不要）
 * - printer(スプール表示)/sql/ifs: 拡張ホストが個人設定へ登録した`systemRef`
 *   （`own:<id>`）を、そのまま対象ペインの`system` propへ渡す（REST層がsystem参照を要求するため）
 */
import { computed, ref, watch } from "vue";
import type { WsOpen } from "@ts5250/server";
import EmulatorPane from "./components/EmulatorPane.vue";
import SpoolPane from "./components/SpoolPane.vue";
import SqlPane from "./components/SqlPane.vue";
import IfsPane from "./components/IfsPane.vue";
import SettingsForm from "./components/SettingsForm.vue";
import { embedStore, postToHost } from "./stores/embed.js";
import { openSession, closeSession } from "./session-controller.js";
import { makePaneTabId } from "./paneLabels.js";
import type { SessionMeta } from "./stores/sessions.js";
import type { EmbedAppKind, SettingsFormValues } from "./embed-protocol.js";

const props = defineProps<{ app: EmbedAppKind }>();

const showSettings = ref(false);
const sessionId = ref<string | undefined>();
const connecting = ref(false);
const connectError = ref<string | undefined>();

/**
 * app種別ごとのペイン機能ID（`paneLabels.ts`の語彙）。**Recordのキーを`EmbedAppKind`から
 * 型で導出する**——三項演算子の連鎖（最後をelseで受ける書き方）だと、`EmbedAppKind`に
 * 種別が増えても既存のelse分岐にそのまま落ち、コンパイルエラーにならず気づけない
 * （taskcheck T6の指摘）。ここはRecordのキー網羅チェックに任せる
 */
const APP_FEATURES: Record<Exclude<EmbedAppKind, "emulator">, string> = {
  printer: "spool:files",
  sql: "sql:query",
  ifs: "ifs:files"
};

/**
 * printer(スプール表示)/sql/ifs用のタブIDとsystemRef。**両方揃って初めて意味を持つ**ので
 * 1つのcomputedにまとめる（`exactOptionalPropertyTypes`下で `system?: string` prop に
 * `string | undefined` を渡さずに済むよう、undefinedならペインごと出さない）
 */
const restTarget = computed(() => {
  const ref = embedStore.connect?.systemRef;
  if (!ref || props.app === "emulator") return undefined;
  return { tabId: makePaneTabId(APP_FEATURES[props.app], ref), system: ref };
});

watch(
  () => embedStore.connect,
  async (payload) => {
    if (!payload) return;
    showSettings.value = false;
    if (props.app !== "emulator") return; // printer/sql/ifsはsystemRefをpropsへ渡すだけで済む
    // **二重発火を防ぐ**（`composables/openConfigured.ts`の`if (connecting.value) return;`と
    // 同じ理由）。`await openSession()`の最中にもう一度`connect`/`saved`が来ると、
    // 後から解決した方が`sessionId`を上書きし、先勝ちのセッションが孤児のまま残る
    // （taskcheck T6の指摘）
    if (connecting.value) return;
    // **設定ボタンでの再接続時、前のセッションを畳んでから開き直す。** 畳まずに`sessionId`を
    // 上書きすると、サーバー側に古いセッションが孤児として残り続ける
    // （taskcheck cross: `01-embed-ui`の自己点検で発見）
    if (sessionId.value) closeSession(sessionId.value);
    sessionId.value = undefined;
    connecting.value = true;
    connectError.value = undefined;
    try {
      const open: WsOpen = { type: "open", host: payload.host };
      if (payload.port !== undefined) open.port = payload.port;
      if (payload.tls !== undefined) open.tls = payload.tls;
      if (payload.ccsid !== undefined) open.ccsid = payload.ccsid;
      if (payload.katakanaVariant !== undefined) open.katakanaVariant = payload.katakanaVariant;
      if (payload.terminal !== undefined) open.terminal = payload.terminal;
      if (payload.deviceName !== undefined) open.deviceName = payload.deviceName;
      if (payload.screenSize !== undefined) open.screenSize = payload.screenSize;
      if (payload.enhanced !== undefined) open.enhanced = payload.enhanced;
      if (payload.user !== undefined) open.user = payload.user;
      if (payload.password !== undefined) open.password = payload.password;
      const meta: SessionMeta = { host: payload.host };
      if (payload.terminal !== undefined) meta.terminal = payload.terminal;
      if (payload.deviceName !== undefined) meta.deviceName = payload.deviceName;
      sessionId.value = await openSession(open, "embed", meta);
    } catch (e) {
      connectError.value = e instanceof Error ? e.message : String(e);
    } finally {
      connecting.value = false;
    }
  },
  { immediate: true }
);

const settingsInitial = computed<SettingsFormValues>(() => {
  const c = embedStore.connect;
  const v: SettingsFormValues = { host: c?.host ?? "" };
  if (c?.port !== undefined) v.port = c.port;
  if (c?.tls !== undefined) v.tls = c.tls;
  if (c?.ccsid !== undefined) v.ccsid = c.ccsid;
  if (c?.deviceName !== undefined) v.deviceName = c.deviceName;
  if (c?.user !== undefined) v.user = c.user;
  return v;
});

function onSave(v: SettingsFormValues): void {
  postToHost({ type: "save", payload: v });
  showSettings.value = false;
}
</script>

<template>
  <div class="embed-root">
    <header class="embed-header">
      <button class="settings-btn" title="設定" @click="showSettings = true">⚙</button>
    </header>
    <div class="embed-body">
      <template v-if="app === 'emulator'">
        <EmulatorPane v-if="sessionId" :session-id="sessionId" :focused="true" />
        <p v-else-if="connecting" class="status">接続中…</p>
        <p v-else-if="connectError" class="status error">{{ connectError }}</p>
        <p v-else-if="embedStore.error" class="status error">{{ embedStore.error }}</p>
        <p v-else class="status">設定を待っています…</p>
      </template>
      <template v-else-if="restTarget">
        <SpoolPane v-if="app === 'printer'" :tab-id="restTarget.tabId" :active="true" :system="restTarget.system" />
        <SqlPane v-else-if="app === 'sql'" :tab-id="restTarget.tabId" :active="true" :system="restTarget.system" />
        <IfsPane v-else :tab-id="restTarget.tabId" :active="true" :system="restTarget.system" />
      </template>
      <p v-else-if="embedStore.error" class="status error">{{ embedStore.error }}</p>
      <p v-else class="status">設定を待っています…</p>
    </div>
    <SettingsForm v-if="showSettings" :initial="settingsInitial" @save="onSave" @cancel="showSettings = false" />
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
  justify-content: flex-end;
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
.status {
  margin: auto;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--muted);
}
.status.error {
  color: var(--t-red, #e06c6c);
}
</style>
