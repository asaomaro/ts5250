<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import type { PublicProfile } from "@as400web/server";
import { settingsStore, type SavedConnection } from "../stores/settings.js";
import { openSession } from "../session-controller.js";
import { HOST_CODE_PAGES, DEFAULT_CCSID, isKatakanaCcsid } from "../hostCodePages.js";

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
  deviceName?: string;
  tls?: boolean;
  autoSignon?: boolean;
  user?: string;
  password?: string;
};
const emptyForm = (): ConnForm => ({ name: "", host: "", ccsid: DEFAULT_CCSID });
const form = ref<ConnForm>(emptyForm());

// カタカナ系コードページ（930/5026）は英小文字が大文字化される旨を案内する
const showKatakanaHint = computed(() => isKatakanaCcsid(form.value.ccsid));

onMounted(async () => {
  try {
    const res = await fetch("/api/profiles");
    const body = (await res.json()) as { profiles: PublicProfile[] };
    profiles.value = body.profiles;
  } catch {
    /* サーバー未起動時は空。ブラウザ保存の接続だけ使える */
  }
});

async function connectProfile(p: PublicProfile): Promise<void> {
  await doConnect({ type: "open", profile: p.name }, p.name);
}

async function connectSaved(c: SavedConnection): Promise<void> {
  const open = {
    type: "open" as const,
    host: c.host,
    ...(c.port !== undefined ? { port: c.port } : {}),
    ...(c.ccsid !== undefined ? { ccsid: c.ccsid } : {}),
    ...(c.deviceName !== undefined ? { deviceName: c.deviceName } : {}),
    ...(c.tls ? { tls: true } : {}),
    // 自動サインオン有効時のみ資格情報を送る（オフなら signon 画面に着地）
    ...(c.autoSignon && c.user ? { user: c.user, password: c.password ?? "" } : {})
  };
  settingsStore.markConnected(c.id, Date.now());
  await doConnect(open, c.name);
}

function editConn(c: SavedConnection): void {
  // 旧データ（ccsid 未設定）は既定コードページを選択済み扱いにする
  form.value = { ...c, ccsid: c.ccsid ?? DEFAULT_CCSID };
  showForm.value = true;
}

function deleteConn(c: SavedConnection): void {
  if (typeof confirm === "function" && !confirm(`接続「${c.name}」を削除しますか？`)) return;
  settingsStore.remove(c.id);
}

function newConn(): void {
  form.value = emptyForm();
  showForm.value = true;
}

async function doConnect(open: Parameters<typeof openSession>[0], label: string): Promise<void> {
  error.value = "";
  connecting.value = true;
  try {
    const id = await openSession(open, label);
    emit("connected", id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    connecting.value = false;
  }
}

function saveForm(): void {
  if (!form.value.name || !form.value.host) return;
  // 自動サインオン無効なら資格情報は保存しない
  const conn = { ...form.value };
  if (!conn.autoSignon) {
    delete conn.user;
    delete conn.password;
  }
  settingsStore.save(conn);
  showForm.value = false;
  form.value = emptyForm();
}

function cancelForm(): void {
  showForm.value = false;
  form.value = emptyForm();
}
</script>

<template>
  <div class="connect">
    <h2>接続</h2>
    <p v-if="error" class="err" role="alert">{{ error }}</p>

    <div class="list">
      <button
        v-for="p in profiles"
        :key="'srv-' + p.name"
        class="card"
        :disabled="connecting"
        @click="connectProfile(p)"
      >
        <span class="src srv">サーバー</span>
        <b>{{ p.name }}</b>
        <span v-if="p.autoSignon" title="自動サインオン">⚡</span>
        <small>{{ p.host }}{{ p.port ? ":" + p.port : "" }}{{ p.tls ? " TLS" : "" }}</small>
      </button>

      <div v-for="c in settingsStore.connections" :key="'loc-' + c.id" class="card loc-card">
        <button class="card-main" :disabled="connecting" @click="connectSaved(c)">
          <span class="src loc">ブラウザ</span>
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
          <span class="field-label">ホストコードページ</span>
          <select v-model.number="form.ccsid">
            <option v-for="p in HOST_CODE_PAGES" :key="p.ccsid" :value="p.ccsid">{{ p.label }}</option>
          </select>
        </label>
      </div>
      <p v-if="showKatakanaHint" class="note">
        ※ カタカナ系コードページ（930 / 5026）では、実機（ACS）同様に半角英小文字を入力すると大文字になります。
        英小文字をそのまま入力するには 939 / 1399 / 5035 を選択してください。
      </p>
      <label class="check"><input v-model="form.tls" type="checkbox" /> TLS で接続</label>
      <label class="check"><input v-model="form.autoSignon" type="checkbox" /> 自動サインオン（RFC 4777）</label>
      <div v-if="form.autoSignon" class="row">
        <input v-model="form.user" placeholder="ユーザー" autocomplete="off" />
        <input v-model="form.password" type="password" placeholder="パスワード" autocomplete="off" />
      </div>
      <p v-if="form.autoSignon" class="note">※ 資格情報はこの端末のブラウザ（localStorage）に平文保存されます。</p>
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
.src {
  font-family: var(--mono);
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 4px;
}
.src.srv {
  background: var(--accent-soft);
  color: var(--accent);
}
.src.loc {
  border: 1px dashed var(--line);
  color: var(--muted);
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
</style>
