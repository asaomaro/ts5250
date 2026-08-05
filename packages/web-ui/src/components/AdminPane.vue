<script setup lang="ts">
import { openSession } from "../session-controller.js";
import { ref, computed, watch } from "vue";
import LoadingBar from "./LoadingBar.vue";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";
import { paneFeatureOf } from "../paneLabels.js";

/**
 * `tabId`: このペインのタブ ID。
 * `active`: **いま見えているか**（`20260802-keep-pane-state`）。開いたタブは切り替えても
 * アンマウントせず `v-show` で隠すので、「マウント中＝見えている」ではなくなった。
 * 裏で働き続けてよいかの判断はこれで行う。
 */
const props = defineProps<{ tabId: string; active?: boolean }>();
/**
 * users | sessions | logs
 *
 * 管理タブは今のところ `scoped: false` で開くのでシステムは付かない（`LauncherPane`）。
 * それでも `paneFeatureOf` を通すのは、**付いた瞬間に黙って壊れる**形を残さないため
 * ——一覧ペインが同じ書き方でそうなった（`unknown list kind: jobs@own:s-…`）。
 */
const view = computed(() => paneFeatureOf(props.tabId).replace(/^admin:/, ""));

interface PublicUser {
  username: string;
  role: "admin" | "user";
  tokenCount: number;
}
interface SessionRow {
  id: string;
  kind: string;
  owner?: string;
  host: string;
  origin: string;
  connectedAt: string;
}
/**
 * **自分が開けるセッション**（`/api/sessions`。admin でも自分の分だけ）。
 *
 * 一覧そのものは admin API（全利用者）だが、**「開く」は自分のものにしか出さない**
 * ——admin が既定で他人の画面を開く導線は作らない
 * （`20260803-hllapi-bridge` で `Connect("A")` の既定を自分に限定したのと同じ判断）。
 */
interface OwnSession {
  sessionId: string;
  host?: string;
  origin?: string;
  connectedAt?: string;
  name?: string;
  viewers: number;
  reservedBy?: string;
}
interface LogRow {
  ts: number;
  op: string;
  result: string;
  code?: string;
  sessionId?: string;
}

const users = ref<PublicUser[]>([]);
const sessions = ref<SessionRow[]>([]);
const own = ref<OwnSession[]>([]);
const ownOf = (id: string): OwnSession | undefined => own.value.find((o) => o.sessionId === id);
/**
 * 表に出す行。**自分のセッションは必ず出す**（admin の一覧が使えない環境でも）。
 * admin の一覧が取れていれば、そちらの情報（所有者・種別）で補う。
 */
const rows = computed<SessionRow[]>(() => {
  const byId = new Map(sessions.value.map((r) => [r.id, r]));
  for (const o of own.value) {
    if (!byId.has(o.sessionId)) {
      byId.set(o.sessionId, {
        id: o.sessionId,
        kind: "display",
        host: o.host ?? "-",
        origin: o.origin ?? "-",
        connectedAt: o.connectedAt ?? ""
      });
    }
  }
  return [...byId.values()];
});
const logs = ref<LogRow[]>([]);
const error = ref("");
const issued = ref<{ username: string; token: string } | undefined>();

// 新規ユーザー
const nu = ref({ username: "", password: "", role: "user" as "admin" | "user" });

async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res;
}

const { visible: loading, busy, run } = useDelayedLoading();

async function refresh(): Promise<void> {
  error.value = "";
  await run(async () => {
  try {
    if (view.value === "users") users.value = (await (await api("/api/admin/users")).json()).users;
    else if (view.value === "sessions") {
      // **主たる出所は `/api/sessions`**（自分の分）。これは常に登録されている。
      // admin の一覧（全利用者）は**あれば足す**——`registerAdminRoutes` は監査の
      // 設定があるときだけ登録されるので、無い環境で一覧が空になってはいけない
      own.value = (await (await api("/api/sessions")).json()).sessions;
      sessions.value = await api("/api/admin/sessions")
        .then(async (r) => (await r.json()).sessions as SessionRow[])
        .catch(() => []);
    }
    else if (view.value === "logs") logs.value = (await (await api("/api/admin/logs")).json()).events;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
  });
}

async function createUser(): Promise<void> {
  try {
    await api("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(nu.value)
    });
    nu.value = { username: "", password: "", role: "user" };
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function deleteUser(username: string): Promise<void> {
  if (typeof confirm === "function" && !confirm(`ユーザー「${username}」を削除しますか？`)) return;
  try {
    await api(`/api/admin/users/${encodeURIComponent(username)}`, { method: "DELETE" });
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function issueToken(username: string): Promise<void> {
  try {
    const { token } = (await (await api(`/api/admin/users/${encodeURIComponent(username)}/token`, { method: "POST" })).json()) as { token: string };
    issued.value = { username, token };
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
/**
 * **既にあるセッションをこのタブで開く**（新規に接続しない）。
 *
 * MCP や HLLAPI が開いた画面を、あとから人が見るための導線。
 * すでに別のタブが見ていても構わない——**両方に画面と予約の通知が届く**。
 */
async function attach(id: string): Promise<void> {
  const o = ownOf(id);
  try {
    await openSession({ type: "open", sessionId: id }, o?.name ?? id.slice(0, 8));
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function terminate(id: string): Promise<void> {
  try {
    await api(`/api/admin/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * **`onMounted` では足りない**——同じグループ内でタブを切り替えると Vue が
 * このコンポーネントを再利用するため、mount が起きず取得されないまま空表示になる。
 * 見ている対象（view）に追従させる。
 */
watch(view, refresh, { immediate: true });
</script>

<template>
  <!-- tabindex: Alt+矢印でのペイン移動時に実フォーカスを受けられるようにする -->
  <div class="admin" tabindex="0">
    <div class="bar">
      <b>{{ view === "users" ? "ユーザー管理" : view === "sessions" ? "セッション管理" : "ログ" }}</b>
      <button class="ghost" :disabled="busy" @click="refresh">再読み込み</button>
    </div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <LoadingBar v-if="loading" />

    <!-- ユーザー管理 -->
    <div v-if="view === 'users'" class="section">
      <p v-if="issued" class="token">
        トークン発行（{{ issued.username }}）: <code>{{ issued.token }}</code>
        <small>— この画面を閉じると再表示できません</small>
      </p>
      <table>
        <thead><tr><th>ユーザー</th><th>role</th><th>トークン</th><th></th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.username">
            <td>{{ u.username }}</td>
            <td>{{ u.role }}</td>
            <td>{{ u.tokenCount }}</td>
            <td class="actions">
              <button @click="issueToken(u.username)">トークン発行</button>
              <button class="danger" @click="deleteUser(u.username)">削除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <form class="new" @submit.prevent="createUser">
        <input v-model="nu.username" placeholder="ユーザー名" required />
        <input v-model="nu.password" type="password" placeholder="パスワード" required />
        <select v-model="nu.role"><option value="user">user</option><option value="admin">admin</option></select>
        <button type="submit">追加</button>
      </form>
    </div>

    <!-- セッション管理 -->
    <div v-else-if="view === 'sessions'" class="section">
      <table>
        <thead>
          <tr>
            <th>種別</th><th>所有者</th><th>ホスト</th><th>由来</th><th>接続</th>
            <th title="このセッションを見ているタブの数">見ている</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in rows" :key="s.id">
            <td>{{ s.kind }}</td>
            <td>{{ s.owner ?? "-" }}</td>
            <td>{{ s.host }}</td>
            <td>{{ s.origin }}</td>
            <td>{{ s.connectedAt ? new Date(s.connectedAt).toLocaleString() : "-" }}</td>
            <td>
              {{ ownOf(s.id)?.viewers ?? "-" }}
              <span v-if="ownOf(s.id)?.reservedBy" class="resv">{{ ownOf(s.id)?.reservedBy }} が操作中</span>
            </td>
            <td>
              <!-- **開くのは自分のものだけ**。他人の画面を開く導線は作らない -->
              <button v-if="ownOf(s.id)" @click="attach(s.id)">開く</button>
              <button class="danger" @click="terminate(s.id)">切断</button>
            </td>
          </tr>
          <tr v-if="rows.length === 0"><td colspan="7" class="empty">セッションなし</td></tr>
        </tbody>
      </table>
    </div>

    <!-- ログ -->
    <div v-else class="section">
      <table class="logs">
        <thead><tr><th>時刻</th><th>op</th><th>result</th><th>code</th></tr></thead>
        <tbody>
          <tr v-for="(l, i) in logs" :key="i" :class="{ err: l.result === 'error' }">
            <td>{{ new Date(l.ts).toLocaleTimeString() }}</td>
            <td>{{ l.op }}</td>
            <td>{{ l.result }}</td>
            <td>{{ l.code ?? "" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
/* ペイン自体はスクロールさせない。スクロールは .section の中だけに閉じ込め、
   見出し（.bar）と列見出し（thead）を常に見えるようにする */
.admin { height: 100%; overflow: hidden; padding: 10px; font-size: 13px; display: flex; flex-direction: column; min-height: 0; }
.section { flex: 1 1 auto; min-height: 0; overflow: auto; }
.bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex: none; }
.bar b { font-family: var(--mono); }
.err { color: #c62828; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); }
/* 列見出しはスクロールしても残す。border-collapse: collapse では sticky な th の罫線が
   一緒にスクロールして消えるので、罫線は box-shadow で描く。背景色も必須（行が透ける） */
th {
  color: var(--muted);
  font-weight: 600;
  font-size: 12px;
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--card);
  border-bottom: none;
  box-shadow: inset 0 -1px 0 var(--line);
}
.actions { display: flex; gap: 6px; }
button { font-size: 12px; padding: 2px 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--card); color: var(--ink); cursor: pointer; }
button.ghost { color: var(--muted); }
button.danger { border-color: #c62828; color: #c62828; }
.new { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.new input, .new select { padding: 5px 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--bg); color: var(--ink); }
.token { background: color-mix(in srgb, var(--accent, #3a7) 12%, transparent); padding: 6px 10px; border-radius: 6px; }
.token code { word-break: break-all; }
.empty { color: var(--muted); text-align: center; }
.logs tr.err td { color: #c62828; }
</style>
