<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import type { PublicProfile, PublicConnection } from "@as400web/server";
import { connectionsStore, type ConnectionForm } from "../stores/connections.js";
import { openSession, openPrinterSession } from "../session-controller.js";
import { HOST_CODE_PAGES, DEFAULT_CCSID, isKatakanaCcsid } from "../hostCodePages.js";
import { SCREEN_SIZES, DEFAULT_SCREEN_SIZE } from "../screenSizes.js";

const emit = defineEmits<{ (e: "connected", sessionId: string): void }>();

const profiles = ref<PublicProfile[]>([]);
const error = ref("");
const connecting = ref(false);
const showForm = ref(false);
type ConnForm = {
  id?: string;
  name: string;
  host: string;
  port?: number;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  tls?: boolean;
  sessionType?: "display" | "printer";
  autoSignon?: boolean;
  user?: string;
  password?: string;
};
const emptyForm = (): ConnForm => ({
  name: "",
  host: "",
  ccsid: DEFAULT_CCSID,
  screenSize: DEFAULT_SCREEN_SIZE,
  sessionType: "display"
});
const form = ref<ConnForm>(emptyForm());

// カタカナ系コードページ（930/5026）は英小文字が大文字化される旨を案内する
const showKatakanaHint = computed(() => isKatakanaCcsid(form.value.ccsid));

onMounted(async () => {
  try {
    const res = await fetch("/api/profiles");
    const body = (await res.json()) as { profiles: PublicProfile[] };
    profiles.value = body.profiles;
  } catch {
    /* サーバー未起動時は空。共有プロファイルだけ使える */
  }
  // ユーザー接続設定はサーバー保存（認証オフ=全件 / オン=自分のみ）
  await connectionsStore.refresh();
});

async function connectProfile(p: PublicProfile): Promise<void> {
  await doConnect({ type: "open", profile: p.name }, p.name, p.sessionType);
}

/** カード / 一覧の表示切り替え（端末ごとに localStorage で保持） */
const VIEW_KEY = "as400.connectView";
const viewMode = ref<"card" | "list">(
  (typeof localStorage !== "undefined" && localStorage.getItem(VIEW_KEY) === "list") ? "list" : "card"
);
function setViewMode(m: "card" | "list"): void {
  viewMode.value = m;
  if (typeof localStorage !== "undefined") localStorage.setItem(VIEW_KEY, m);
}

async function connectSaved(c: PublicConnection): Promise<void> {
  // 保存済み接続は ID 参照で開く（host/資格情報はサーバーが解決・復号する）
  await doConnect({ type: "open", connection: c.id }, c.name, c.sessionType);
}

/** 編集で hasSecret のとき、パスワード欄は空＝据え置き（サーバーには値を返せない） */
const editingHasSecret = ref(false);

function editConn(c: PublicConnection): void {
  form.value = {
    id: c.id,
    name: c.name,
    host: c.host,
    ccsid: c.ccsid ?? DEFAULT_CCSID,
    screenSize: c.screenSize ?? DEFAULT_SCREEN_SIZE,
    sessionType: c.sessionType,
    password: "",
    ...(c.port !== undefined ? { port: c.port } : {}),
    ...(c.deviceName !== undefined ? { deviceName: c.deviceName } : {}),
    ...(c.tls !== undefined ? { tls: c.tls } : {}),
    ...(c.autoSignon !== undefined ? { autoSignon: c.autoSignon } : {}),
    ...(c.signonUser !== undefined ? { user: c.signonUser } : {})
  };
  editingHasSecret.value = c.hasSecret;
  showForm.value = true;
}

async function deleteConn(c: PublicConnection): Promise<void> {
  if (typeof confirm === "function" && !confirm(`接続「${c.name}」を削除しますか？`)) return;
  try {
    await connectionsStore.remove(c.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function newConn(): void {
  form.value = emptyForm();
  editingHasSecret.value = false;
  showForm.value = true;
}

async function doConnect(
  open: Parameters<typeof openSession>[0],
  label: string,
  sessionType?: "display" | "printer"
): Promise<void> {
  error.value = "";
  connecting.value = true;
  try {
    const id =
      sessionType === "printer" ? await openPrinterSession(open, label) : await openSession(open, label);
    emit("connected", id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    connecting.value = false;
  }
}

async function saveForm(): Promise<void> {
  if (!form.value.name || !form.value.host) return;
  const f = form.value;
  const payload: ConnectionForm = {
    name: f.name,
    host: f.host,
    sessionType: f.sessionType ?? "display",
    ...(f.port !== undefined ? { port: f.port } : {}),
    ...(f.ccsid !== undefined ? { ccsid: f.ccsid } : {}),
    ...(f.screenSize !== undefined ? { screenSize: f.screenSize } : {}),
    ...(f.deviceName ? { deviceName: f.deviceName } : {}),
    ...(f.tls !== undefined ? { tls: f.tls } : {}),
    ...(f.autoSignon ? { autoSignon: true } : {}),
    // 自動サインオン有効時のみ資格情報。パスワード空欄は「据え置き」= 未送信（サーバーが既存を保持）
    ...(f.autoSignon && f.user ? { signonUser: f.user } : {}),
    ...(f.autoSignon && f.password ? { password: f.password } : {})
  };
  try {
    if (f.id) await connectionsStore.update(f.id, payload);
    else await connectionsStore.create(payload);
    showForm.value = false;
    form.value = emptyForm();
    editingHasSecret.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function cancelForm(): void {
  showForm.value = false;
  form.value = emptyForm();
  editingHasSecret.value = false;
}
</script>

<template>
  <div class="connect">
    <div class="head">
      <h2>接続</h2>
      <div class="view-toggle" role="group" aria-label="表示切り替え">
        <button
          type="button"
          :class="{ active: viewMode === 'card' }"
          title="カード表示"
          @click="setViewMode('card')"
        >
          ▦ カード
        </button>
        <button
          type="button"
          :class="{ active: viewMode === 'list' }"
          title="一覧表示"
          @click="setViewMode('list')"
        >
          ☰ 一覧
        </button>
      </div>
    </div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>

    <div class="list" :class="'view-' + viewMode">
      <button
        v-for="p in profiles"
        :key="'srv-' + p.name"
        class="card"
        :disabled="connecting"
        @click="connectProfile(p)"
      >
        <span class="chips">
          <span class="kind" :class="p.sessionType">
            {{ p.sessionType === "printer" ? "🖨 プリンター" : "🖥 表示" }}
          </span>
        </span>
        <b>{{ p.name }}</b>
        <span v-if="p.autoSignon" title="自動サインオン">⚡</span>
        <small>{{ p.host }}{{ p.port ? ":" + p.port : "" }}{{ p.tls ? " TLS" : "" }}</small>
      </button>

      <div v-for="c in connectionsStore.connections" :key="'conn-' + c.id" class="card loc-card">
        <button class="card-main" :disabled="connecting" @click="connectSaved(c)">
          <span class="chips">
            <span class="kind" :class="c.sessionType ?? 'display'">
              {{ c.sessionType === "printer" ? "🖨 プリンター" : "🖥 表示" }}
            </span>
          </span>
          <b>{{ c.name }}</b>
          <span v-if="c.autoSignon" title="自動サインオン">⚡</span>
          <small>{{ c.host }}{{ c.port ? ":" + c.port : "" }}{{ c.tls ? " TLS" : "" }}</small>
        </button>
        <div class="card-actions">
          <button class="icon-btn" title="編集" @click.stop="editConn(c)">✎</button>
          <button class="icon-btn danger" title="削除" @click.stop="deleteConn(c)">🗑</button>
        </div>
      </div>

      <button class="card add" @click="newConn">＋ 新規接続</button>
    </div>

    <form v-if="showForm" class="form" @submit.prevent="saveForm">
      <h3>{{ form.id ? "接続を編集" : "新規接続" }}</h3>
      <div class="row">
        <input v-model="form.name" placeholder="名称" required />
        <input v-model="form.host" placeholder="ホスト" required />
      </div>
      <div class="row">
        <input v-model.number="form.port" type="number" placeholder="ポート (既定 23 / TLS 992)" />
        <input v-model="form.deviceName" placeholder="デバイス名 (任意)" />
      </div>
      <div class="row">
        <label class="field">
          <span class="field-label">セッション種別</span>
          <select v-model="form.sessionType">
            <option value="display">表示（5250 画面）</option>
            <option value="printer">プリンター（スプール受信）</option>
          </select>
        </label>
      </div>
      <p v-if="form.sessionType === 'printer'" class="note">
        ※ プリンターセッションはホストのスプール出力（帳票・ジョブログ等）を受信して表示します。
        受信するには、ホスト側でスプールをこのデバイスの出力キューへ回す必要があります
        （ライターの用紙タイプ問い合わせに応答待ちになる場合があります）。
      </p>
      <div class="row">
        <label class="field">
          <span class="field-label">ホストコードページ</span>
          <select v-model.number="form.ccsid">
            <option v-for="p in HOST_CODE_PAGES" :key="p.ccsid" :value="p.ccsid">{{ p.label }}</option>
          </select>
        </label>
        <label v-if="form.sessionType !== 'printer'" class="field">
          <span class="field-label">画面サイズ</span>
          <select v-model="form.screenSize">
            <option v-for="s in SCREEN_SIZES" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </label>
      </div>
      <p v-if="form.sessionType !== 'printer' && form.screenSize === '27x132'" class="note">
        ※ 27x132 は端末タイプでホストに申告する設定です。実際にどちらで描くかはホストが画面ごとに決めるため、
        27x132 版を持たない画面（サインオン・メニュー等）は 24x80 のまま表示されます。
      </p>
      <p v-if="showKatakanaHint" class="note">
        ※ カタカナ系コードページ（930 / 5026）では、実機（ACS）同様に半角英小文字を入力すると大文字になります。
        英小文字をそのまま入力するには 939 / 1399 / 5035 を選択してください。
      </p>
      <label class="check"><input v-model="form.tls" type="checkbox" /> TLS で接続</label>
      <label class="check"><input v-model="form.autoSignon" type="checkbox" /> 自動サインオン（RFC 4777）</label>
      <div v-if="form.autoSignon" class="row">
        <input v-model="form.user" placeholder="ユーザー" autocomplete="off" />
        <input
          v-model="form.password"
          type="password"
          :placeholder="editingHasSecret ? 'パスワード（設定済み・変更時のみ入力）' : 'パスワード'"
          autocomplete="off"
        />
      </div>
      <p v-if="form.autoSignon" class="note">
        ※ パスワードはサーバーで暗号化して保存されます（AES-256-GCM）。ブラウザや API には平文を返しません。
        サーバーに暗号鍵（AS400_SECRET_KEY）が未設定の場合、パスワード保存は無効です。
      </p>
      <div class="row">
        <button type="submit">保存</button>
        <button type="button" class="ghost" @click="cancelForm">キャンセル</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.connect {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 16px;
}
h2 {
  font-family: var(--mono);
}
.err {
  color: #c62828;
  font-family: var(--mono);
}
.list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  color: var(--ink);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.card:hover {
  border-color: var(--accent);
}
.card.add {
  border-style: dashed;
  align-items: center;
  color: var(--accent);
}
small {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
}
.form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.form input,
.form select {
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
}
.form .field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 120px;
}
.form .field-label {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
}
.form .field select {
  width: 100%;
}
.form button {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
.form h3 {
  width: 100%;
  margin: 0;
  font-family: var(--mono);
  font-size: 14px;
}
.form .row {
  display: flex;
  gap: 8px;
  width: 100%;
  flex-wrap: wrap;
}
.form .row input {
  flex: 1;
  min-width: 120px;
}
.form .check {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  font-size: 13px;
  color: var(--ink);
  cursor: pointer;
}
.form .check input {
  width: auto;
}
.form .note {
  width: 100%;
  margin: 0;
  font-size: 11px;
  color: var(--muted);
}
.form button.ghost {
  background: transparent;
  color: var(--muted);
  border-color: var(--line);
}
/* ブラウザ保存カード: 接続領域＋編集/削除ボタン */
.loc-card {
  flex-direction: row;
  align-items: stretch;
  padding: 0;
  gap: 0;
}
.card-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 14px;
  background: transparent;
  border: none;
  color: var(--ink);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.card-actions {
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line);
}
.icon-btn {
  flex: 1;
  padding: 4px 10px;
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
}
.icon-btn:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.icon-btn.danger:hover {
  background: color-mix(in srgb, #c62828 18%, transparent);
  color: #c62828;
}
/* ヘッダ（タイトル＋表示切り替え） */
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.view-toggle {
  display: flex;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.view-toggle button {
  padding: 4px 12px;
  background: var(--card);
  color: var(--muted);
  border: none;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.view-toggle button + button {
  border-left: 1px solid var(--line);
}
.view-toggle button.active {
  background: var(--accent-soft);
  color: var(--accent);
}
/* 種別チップ（サーバー/ブラウザ ＋ 表示/プリンター） */
.chips {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.kind {
  font-family: var(--mono);
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 4px;
  border: 1px solid var(--line);
  color: var(--muted);
  white-space: nowrap;
}
.kind.printer {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
/* 一覧表示: 1 列・各カードを横並びのコンパクト行にする */
.list.view-list {
  grid-template-columns: 1fr;
  gap: 4px;
}
.list.view-list .card {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}
.list.view-list .loc-card {
  padding: 0;
}
.list.view-list .card-main {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}
.list.view-list .card.add {
  justify-content: center;
}
.list.view-list .card small,
.list.view-list .card-main small {
  margin-left: auto;
}
</style>
