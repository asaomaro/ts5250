<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import type { PublicProfile, PublicConnection } from "@as400web/server";
import { connectionsStore, type ConnectionForm } from "../stores/connections.js";
import { openSession, openPrinterSession } from "../session-controller.js";
import type { SessionMeta } from "../stores/sessions.js";
import { authStore } from "../stores/auth.js";
import InfoPopover from "./InfoPopover.vue";
import { HOST_CODE_PAGES, DEFAULT_CCSID, isKatakanaCcsid } from "../hostCodePages.js";
import { SCREEN_SIZES, DEFAULT_SCREEN_SIZE } from "../screenSizes.js";

const emit = defineEmits<{ (e: "connected", sessionId: string): void }>();

const profiles = ref<PublicProfile[]>([]);
/** 共有プロファイルを UI から編集できるか（認証オフ または admin かつファイル由来。サーバーが判定） */
const profilesEditable = ref(false);
const error = ref("");
const connecting = ref(false);
const showForm = ref(false);
type ConnForm = {
  id?: string;
  /** 編集対象。connection=ユーザー接続 / profile=共有プロファイル */
  kind: "connection" | "profile";
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
  // プロファイルのみ: PDF 自動蓄積・自動印刷（信頼設定・サーバー保存）
  autoPdfDir?: string;
  autoPrint?: string;
  pdfFontPath?: string;
  pdfFontName?: string;
  pageSize?: string;
  fontSize?: number;
};
const emptyForm = (): ConnForm => ({
  kind: "connection",
  name: "",
  host: "",
  ccsid: DEFAULT_CCSID,
  screenSize: DEFAULT_SCREEN_SIZE,
  sessionType: "display"
});
const form = ref<ConnForm>(emptyForm());
const isProfileForm = computed(() => form.value.kind === "profile");
const isNew = computed(() => !form.value.id);

// ---- 環境判定（所有 共有/個人 の出し分け） ----
/** 認証オフ（マルチユーザーでない）＝所有概念を見せない・全て共有 */
const authOff = computed(() => !authStore.enabled);
const isAdmin = computed(() => authStore.isAdmin);
/**
 * 新規作成で所有（共有/個人）を選べるか＝admin のみ（認証オフ=共有固定 / 一般=個人固定）。
 * 共有（profiles）が書き込めない構成（--profiles 未指定）では選択肢にならないので false。
 */
const canChooseOwnership = computed(() => !authOff.value && isAdmin.value && profilesEditable.value);
const formTitle = computed(() =>
  isNew.value
    ? "新規設定"
    : authOff.value
      ? "設定を編集"
      : isProfileForm.value
        ? "共有設定を編集"
        : "個人接続を編集"
);
function onOwnershipChange(e: Event): void {
  setOwnership((e.target as HTMLSelectElement).value as "shared" | "personal");
}

// カタカナ系コードページ（930/5026）は英小文字が大文字化される旨を案内する
const showKatakanaHint = computed(() => isKatakanaCcsid(form.value.ccsid));

async function refreshProfiles(): Promise<void> {
  try {
    const res = await fetch("/api/profiles");
    const body = (await res.json()) as { profiles: PublicProfile[]; editable?: boolean };
    profiles.value = body.profiles;
    profilesEditable.value = body.editable ?? false;
  } catch {
    /* サーバー未起動時は空。共有プロファイルだけ使える */
  }
}

onMounted(async () => {
  await refreshProfiles();
  // ユーザー接続設定はサーバー保存（認証オフ=全件 / オン=自分のみ）
  await connectionsStore.refresh();
});

/** カード ⓘ で開いている情報ポップオーバーの対象キー（'srv-<name>' / 'conn-<id>'） */
const infoFor = ref<string | undefined>();
function toggleInfo(key: string): void {
  infoFor.value = infoFor.value === key ? undefined : key;
}

type ConnLike = {
  host?: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  sessionType?: "display" | "printer";
  autoSignon?: boolean;
  signonUser?: string;
};

/** PublicConnection/PublicProfile から SessionMeta を作る（undefined は載せない） */
function toMeta(o: ConnLike): SessionMeta {
  const m: SessionMeta = {};
  if (o.host !== undefined) m.host = o.host;
  if (o.port !== undefined) m.port = o.port;
  if (o.tls !== undefined) m.tls = o.tls;
  if (o.ccsid !== undefined) m.ccsid = o.ccsid;
  if (o.screenSize !== undefined) m.screenSize = o.screenSize;
  if (o.deviceName !== undefined) m.deviceName = o.deviceName;
  if (o.sessionType !== undefined) m.sessionType = o.sessionType;
  if (o.autoSignon !== undefined) m.autoSignon = o.autoSignon;
  if (o.signonUser !== undefined) m.signonUser = o.signonUser;
  return m;
}

/** 情報ポップオーバーの行（設定の全情報） */
function infoRows(name: string, source: string, o: ConnLike): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    { label: "名称", value: name },
    { label: "区分", value: source },
    { label: "ホスト", value: `${o.host ?? "-"}${o.port ? ":" + o.port : ""}` },
    { label: "種別", value: o.sessionType === "printer" ? "プリンター" : "5250端末" }
  ];
  if (o.tls) rows.push({ label: "TLS", value: "有効" });
  if (o.ccsid !== undefined) rows.push({ label: "CCSID", value: String(o.ccsid) });
  if (o.screenSize) rows.push({ label: "画面サイズ", value: o.screenSize });
  if (o.deviceName) rows.push({ label: "デバイス名", value: o.deviceName });
  rows.push({
    label: "自動サインオン",
    value: o.autoSignon ? (o.signonUser ? `有効（${o.signonUser}）` : "有効") : "無効"
  });
  return rows;
}

async function connectProfile(p: PublicProfile): Promise<void> {
  await doConnect({ type: "open", profile: p.name }, p.name, p.sessionType, toMeta(p));
}

function editProfile(p: PublicProfile): void {
  form.value = {
    kind: "profile",
    id: p.name, // 改名検知のため元の名前を保持
    name: p.name,
    host: p.host,
    sessionType: p.sessionType, // 種別は編集で変更しないが、表示・printer 欄の判定に必要
    ccsid: p.ccsid ?? DEFAULT_CCSID,
    screenSize: p.screenSize ?? DEFAULT_SCREEN_SIZE,
    password: "",
    ...(p.port !== undefined ? { port: p.port } : {}),
    ...(p.deviceName !== undefined ? { deviceName: p.deviceName } : {}),
    ...(p.tls !== undefined ? { tls: p.tls } : {}),
    ...(p.autoSignon ? { autoSignon: true } : {}),
    ...(p.signonUser !== undefined ? { user: p.signonUser } : {}),
    // printer 出力設定（編集者にのみ露出される）
    ...(p.printer?.autoPdfDir !== undefined ? { autoPdfDir: p.printer.autoPdfDir } : {}),
    ...(p.printer?.autoPrint !== undefined ? { autoPrint: p.printer.autoPrint } : {}),
    ...(p.printer?.pdfFontPath !== undefined ? { pdfFontPath: p.printer.pdfFontPath } : {}),
    ...(p.printer?.pdfFontName !== undefined ? { pdfFontName: p.printer.pdfFontName } : {}),
    ...(p.printer?.pageSize !== undefined ? { pageSize: p.printer.pageSize } : {}),
    ...(p.printer?.fontSize !== undefined ? { fontSize: p.printer.fontSize } : {})
  };
  // 既存の自動サインオン（passwordEnv も含む）があればパスワードは据え置き扱い
  editingHasSecret.value = p.autoSignon;
  showForm.value = true;
}

async function deleteProfile(p: PublicProfile): Promise<void> {
  if (typeof confirm === "function" && !confirm(`プロファイル「${p.name}」を削除しますか？`)) return;
  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(p.name)}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    await refreshProfiles();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
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
  await doConnect({ type: "open", connection: c.id }, c.name, c.sessionType, toMeta(c));
}

/** 編集で hasSecret のとき、パスワード欄は空＝据え置き（サーバーには値を返せない） */
const editingHasSecret = ref(false);

function editConn(c: PublicConnection): void {
  form.value = {
    kind: "connection",
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
  // 既定の所有: 認証オフ or admin は共有（profile）、一般ユーザーは個人（connection）。
  // ただし共有が書き込めない構成（--profiles 未指定＝editable=false）では個人にフォールバックする。
  const shared = (authOff.value || isAdmin.value) && profilesEditable.value;
  form.value = { ...emptyForm(), kind: shared ? "profile" : "connection" };
  editingHasSecret.value = false;
  showForm.value = true;
}
/** 新規フォームの所有（共有/個人）を admin が切り替える */
function setOwnership(o: "shared" | "personal"): void {
  form.value.kind = o === "shared" ? "profile" : "connection";
}

/** admin が既存設定の所有を移動する（共有⇄個人）。移動後は一覧を再取得 */
async function moveOwnership(to: "shared" | "personal"): Promise<void> {
  const f = form.value;
  if (!f.id) return;
  const kind = f.kind === "profile" ? "profile" : "connection";
  try {
    const res = await fetch("/api/settings/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, id: f.id, to })
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; warnings?: string[] };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    if (body.warnings?.length) error.value = "移動しました（注意: " + body.warnings.join(" / ") + "）";
    await refreshProfiles();
    await connectionsStore.refresh();
    showForm.value = false;
    form.value = emptyForm();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function doConnect(
  open: Parameters<typeof openSession>[0],
  label: string,
  sessionType?: "display" | "printer",
  meta?: SessionMeta
): Promise<void> {
  error.value = "";
  connecting.value = true;
  try {
    const id =
      sessionType === "printer"
        ? await openPrinterSession(open, label, meta)
        : await openSession(open, label, meta);
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
  if (f.kind === "profile") return saveProfileForm(f);
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

/** 共有プロファイルの保存（接続フィールドのみ。signon/PDF 等の信頼設定はサーバーが保持） */
async function saveProfileForm(f: ConnForm): Promise<void> {
  const payload = {
    name: f.name,
    host: f.host,
    // 種別は新規作成時のみ採用される（更新ではサーバーが既存を維持）
    ...(f.sessionType !== undefined ? { sessionType: f.sessionType } : {}),
    ...(f.port !== undefined ? { port: f.port } : {}),
    ...(f.ccsid !== undefined ? { ccsid: f.ccsid } : {}),
    ...(f.screenSize !== undefined ? { screenSize: f.screenSize } : {}),
    ...(f.deviceName ? { deviceName: f.deviceName } : {}),
    ...(f.tls !== undefined ? { tls: f.tls } : {}),
    // 常に明示送信（オフにしたら signon を解除できるようにする）
    autoSignon: !!f.autoSignon,
    ...(f.autoSignon && f.user ? { signonUser: f.user } : {}),
    // パスワード空欄は据え置き（未送信）。サーバーが既存の passwordEnv/passwordEnc を保持
    ...(f.autoSignon && f.password ? { password: f.password } : {}),
    // printer 出力設定は常に送る（全空なら server 側でブロック削除＝クリア）
    printer: {
      ...(f.autoPdfDir ? { autoPdfDir: f.autoPdfDir } : {}),
      ...(f.autoPrint ? { autoPrint: f.autoPrint } : {}),
      ...(f.pdfFontPath ? { pdfFontPath: f.pdfFontPath } : {}),
      ...(f.pdfFontName ? { pdfFontName: f.pdfFontName } : {}),
      ...(f.pageSize ? { pageSize: f.pageSize } : {}),
      ...(f.fontSize !== undefined ? { fontSize: f.fontSize } : {})
    }
  };
  try {
    const res = f.id
      ? await fetch(`/api/profiles/${encodeURIComponent(f.id)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        })
      : await fetch("/api/profiles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    await refreshProfiles();
    showForm.value = false;
    form.value = emptyForm();
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
  <!-- 接続中（クリック〜セッション確立まで）のローディング表示 -->
  <div v-if="connecting" class="connecting" role="status" aria-live="polite">
    <div class="spinner" aria-label="接続中"></div>
    <span>接続中…</span>
  </div>
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
      <div v-for="p in profiles" :key="'srv-' + p.name" class="card loc-card">
        <button class="card-main" :disabled="connecting" @click="connectProfile(p)">
          <span class="chips">
            <span class="kind" :class="p.sessionType">
              {{ p.sessionType === "printer" ? "🖨 プリンター" : "🖥 5250端末" }}
            </span>
            <span v-if="!authOff" class="kind shared" title="共有（全員から見える）">共有</span>
          </span>
          <b>{{ p.name }}</b>
          <span v-if="p.autoSignon" title="自動サインオン">⚡</span>
          <small>
            {{ p.host }}{{ p.port ? ":" + p.port : "" }}{{ p.tls ? " TLS" : "" }}{{ p.deviceName ? " · " + p.deviceName : "" }}
          </small>
        </button>
        <div class="card-actions">
          <button class="icon-btn" title="情報" @click.stop="toggleInfo('srv-' + p.name)">ⓘ</button>
          <template v-if="profilesEditable">
            <button class="icon-btn" title="編集" @click.stop="editProfile(p)">✎</button>
            <button class="icon-btn danger" title="削除" @click.stop="deleteProfile(p)">🗑</button>
          </template>
        </div>
        <InfoPopover
          v-if="infoFor === 'srv-' + p.name"
          :rows="infoRows(p.name, '共有プロファイル', p)"
          @close="infoFor = undefined"
        />
      </div>

      <div v-for="c in connectionsStore.connections" :key="'conn-' + c.id" class="card loc-card">
        <button class="card-main" :disabled="connecting" @click="connectSaved(c)">
          <span class="chips">
            <span class="kind" :class="c.sessionType ?? 'display'">
              {{ c.sessionType === "printer" ? "🖨 プリンター" : "🖥 5250端末" }}
            </span>
            <span v-if="!authOff" class="kind personal" title="個人（自分だけ）">個人</span>
          </span>
          <b>{{ c.name }}</b>
          <span v-if="c.autoSignon" title="自動サインオン">⚡</span>
          <small>
            {{ c.host }}{{ c.port ? ":" + c.port : "" }}{{ c.tls ? " TLS" : "" }}{{ c.deviceName ? " · " + c.deviceName : "" }}
          </small>
        </button>
        <div class="card-actions">
          <button class="icon-btn" title="情報" @click.stop="toggleInfo('conn-' + c.id)">ⓘ</button>
          <button class="icon-btn" title="編集" @click.stop="editConn(c)">✎</button>
          <button class="icon-btn danger" title="削除" @click.stop="deleteConn(c)">🗑</button>
        </div>
        <InfoPopover
          v-if="infoFor === 'conn-' + c.id"
          :rows="infoRows(c.name, '保存済み接続', c)"
          @close="infoFor = undefined"
        />
      </div>

      <button class="card add" @click="newConn">＋ 新規接続</button>
    </div>

    <form v-if="showForm" class="form" @submit.prevent="saveForm">
      <h3>{{ formTitle }}</h3>
      <!-- 所有（共有/個人）: 新規かつ admin のみ選択。認証オフ=共有固定 / 一般=個人固定なので出さない -->
      <div v-if="isNew && canChooseOwnership" class="row">
        <label class="field">
          <span class="field-label">所有</span>
          <select :value="isProfileForm ? 'shared' : 'personal'" @change="onOwnershipChange">
            <option value="shared">共有（全員から見える）</option>
            <option value="personal">個人（自分だけ）</option>
          </select>
        </label>
      </div>
      <!-- 種別: 新規は選択、編集は固定（変更不可） -->
      <div class="row">
        <label class="field">
          <span class="field-label">セッション種別</span>
          <select v-if="isNew" v-model="form.sessionType">
            <option value="display">5250端末（表示）</option>
            <option value="printer">プリンター（スプール受信）</option>
          </select>
          <span v-else class="fixed-type">
            {{ form.sessionType === "printer" ? "🖨 プリンター" : "🖥 5250端末" }}（種別は変更できません）
          </span>
        </label>
      </div>
      <p v-if="isProfileForm && !authOff" class="note">
        ※ 共有設定は全員から見えます。接続情報・自動サインオン{{ form.sessionType === "printer" ? "・PDF 出力設定" : "" }}を
        編集できます（パスワードは暗号化保存）。運用者が env で設定した passwordEnv はサーバー側で保持します。
      </p>
      <div class="row">
        <input v-model="form.name" placeholder="名称" required />
        <input v-model="form.host" placeholder="ホスト" required />
      </div>
      <div class="row">
        <input v-model.number="form.port" type="number" placeholder="ポート (既定 23 / TLS 992)" />
        <input v-model="form.deviceName" placeholder="デバイス名 (任意)" />
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
      <label class="check">
        <input v-model="form.autoSignon" type="checkbox" /> 自動サインオン（RFC 4777）
      </label>
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
      <!-- プロファイルのみ: PDF 自動蓄積 / 物理自動印刷（サーバー側の信頼設定） -->
      <template v-if="isProfileForm && form.sessionType === 'printer'">
        <h4 class="subhead">PDF 自動蓄積 / 自動印刷（サーバー設定）</h4>
        <div class="row">
          <label class="field">
            <span class="field-label">PDF 自動蓄積フォルダ（autoPdfDir）</span>
            <input v-model="form.autoPdfDir" placeholder="/var/spool/as400-pdf（サーバー上のパス）" autocomplete="off" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span class="field-label">自動印刷プリンター名（autoPrint）</span>
            <input v-model="form.autoPrint" placeholder="OfficePrinter（サーバー上のプリンター名）" autocomplete="off" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span class="field-label">用紙サイズ（任意）</span>
            <input v-model="form.pageSize" placeholder="LETTER / A4" autocomplete="off" />
          </label>
          <label class="field">
            <span class="field-label">フォントサイズ（任意）</span>
            <input v-model.number="form.fontSize" type="number" placeholder="8" />
          </label>
        </div>
        <p class="note">
          ※ 受信スプールを**サーバー上**の指定フォルダへ PDF 保存し、指定プリンターへ <code>lp</code> で自動印刷します。
          パス・プリンター名は**サーバーのローカル**を指します。空にすると自動蓄積/印刷は無効になります。
          （この設定は認証オフ、または admin のときだけ編集できます）
        </p>
      </template>
      <!-- 所有の変更（admin・編集時のみ）: 共有⇄個人へ移動 -->
      <div v-if="!isNew && canChooseOwnership" class="row move-row">
        <button v-if="!isProfileForm" type="button" class="ghost" @click="moveOwnership('shared')">共有にする</button>
        <button v-else type="button" class="ghost" @click="moveOwnership('personal')">個人にする</button>
        <span class="move-note">所有を切り替えます（保存とは別に即時反映）</span>
      </div>
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
  position: relative;
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
.subhead {
  width: 100%;
  margin: 6px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--muted);
}
.form .note code {
  font-family: var(--mono);
  background: var(--accent-soft);
  padding: 0 4px;
  border-radius: 3px;
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
.kind.display {
  border-color: var(--t-blue);
  color: var(--t-blue);
  background: color-mix(in srgb, var(--t-blue) 14%, transparent);
}
.kind.shared {
  border-style: dashed;
  opacity: 0.85;
}
.kind.personal {
  border-style: dotted;
  opacity: 0.85;
}
/* 編集時の種別（変更不可）表示 */
.fixed-type {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--ink);
  padding: 4px 0;
}
.move-row {
  align-items: center;
  gap: 10px;
}
.move-note {
  font-size: 11px;
  color: var(--muted);
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
/* 一覧モードはアクションアイコンを横並びにして行高を抑える（表示件数を増やす） */
.list.view-list .card-actions {
  flex-direction: row;
  align-items: center;
}
.list.view-list .icon-btn {
  flex: none;
}
/* 接続中オーバーレイ（クリック〜セッション確立まで） */
.connecting {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  color: #e8efe8;
  font-family: var(--mono);
  font-size: 13px;
  cursor: progress;
}
.spinner {
  width: 34px;
  height: 34px;
  border: 3px solid color-mix(in srgb, var(--accent, #3ddc84) 30%, transparent);
  border-top-color: var(--accent, #3ddc84);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2s;
  }
}
</style>
