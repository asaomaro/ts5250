<script setup lang="ts">
import { ref, computed, onMounted } from "vue";

/**
 * ジョブ・オブジェクト・ユーザーの一覧。
 *
 * 管理画面と同じ「特殊なタブ ID」方式で開く（`list:jobs` 等）。
 * 見える範囲は IBM i の権限が決めるため、アプリ側で追加の制限は掛けない。
 */
const props = defineProps<{ tabId: string }>();
/** jobs | objects | users */
const kind = computed(() => props.tabId.replace(/^list:/, ""));

interface JobRow {
  name: string;
  user: string;
  number: string;
  status: string;
  type: string;
  subtype: string;
}
interface ObjectRow {
  name: string;
  library: string;
  type: string;
}
interface UserRow {
  name: string;
  isGroup: boolean;
  groupProfile: string;
  text: string;
}
type Row = JobRow | ObjectRow | UserRow;

interface SourceOption {
  kind: "connection" | "profile";
  id: string;
  label: string;
}

const sources = ref<SourceOption[]>([]);
const selectedSource = ref("");
const rows = ref<Row[]>([]);
const loading = ref(false);
const error = ref("");
/** 操作の結果。成功でもメッセージが出るため配列で持つ */
const actionResult = ref<{ ok: boolean; text: string } | undefined>();

// 絞り込み
const jobUser = ref("");
const jobType = ref("*");
const objLibrary = ref("*LIBL");
const objType = ref("*ALL");
const userSelection = ref<"*USER" | "*GROUP" | "*MEMBER">("*USER");

const title = computed(
  () => ({ jobs: "ジョブ", objects: "オブジェクト", users: "ユーザー" })[kind.value] ?? kind.value
);

function sourceBody(): Record<string, string> {
  const opt = sources.value.find((s) => `${s.kind}:${s.id}` === selectedSource.value);
  if (!opt) return {};
  return opt.kind === "connection" ? { connection: opt.id } : { profile: opt.id };
}

async function loadSources(): Promise<void> {
  const out: SourceOption[] = [];
  try {
    const conns = await (await fetch("/api/connections")).json();
    for (const c of conns.connections ?? []) {
      out.push({ kind: "connection", id: c.id, label: `${c.name}（自分の設定）` });
    }
  } catch {
    /* 接続設定が無くても続行する */
  }
  try {
    const profs = await (await fetch("/api/profiles")).json();
    for (const p of profs.profiles ?? []) {
      out.push({ kind: "profile", id: p.name, label: `${p.name}（サーバー設定）` });
    }
  } catch {
    /* サーバー設定が見えない利用者もいる */
  }
  sources.value = out;
  if (!selectedSource.value && out[0]) selectedSource.value = `${out[0].kind}:${out[0].id}`;
}

async function load(): Promise<void> {
  if (!selectedSource.value) {
    error.value = "接続設定を選んでください";
    return;
  }
  loading.value = true;
  error.value = "";
  actionResult.value = undefined;
  try {
    const body: Record<string, unknown> = { source: sourceBody(), max: 200 };
    if (kind.value === "jobs") {
      body["jobs"] = { ...(jobUser.value ? { user: jobUser.value } : {}), type: jobType.value };
    } else if (kind.value === "objects") {
      body["objects"] = { library: objLibrary.value, type: objType.value };
    } else {
      body["users"] = { selection: userSelection.value };
    }
    const res = await fetch(`/api/host/list/${kind.value}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      error.value = data.error ?? "取得に失敗しました";
      rows.value = [];
      return;
    }
    rows.value = data.items ?? [];
  } catch (e) {
    error.value = `取得に失敗しました: ${String(e)}`;
  } finally {
    loading.value = false;
  }
}

/** 破壊的な操作は確認を挟む */
async function act(action: string, target: Record<string, string>, confirmText?: string): Promise<void> {
  if (confirmText && !window.confirm(confirmText)) return;
  loading.value = true;
  actionResult.value = undefined;
  try {
    const res = await fetch("/api/host/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: sourceBody(), action, target })
    });
    const data = await res.json();
    if (!res.ok) {
      actionResult.value = { ok: false, text: data.error ?? "操作に失敗しました" };
      return;
    }
    const msgs = (data.messages ?? [])
      .map((m: { id: string; text: string }) => `${m.id} ${m.text}`)
      .join(" / ");
    actionResult.value = {
      ok: data.success,
      text: data.success ? `実行しました${msgs ? `: ${msgs}` : ""}` : `失敗: ${msgs}`
    };
    if (data.success) await load();
  } catch (e) {
    actionResult.value = { ok: false, text: `操作に失敗しました: ${String(e)}` };
  } finally {
    loading.value = false;
  }
}

const jobRows = computed(() => rows.value as JobRow[]);
const objectRows = computed(() => rows.value as ObjectRow[]);
const userRows = computed(() => rows.value as UserRow[]);

onMounted(loadSources);
</script>

<template>
  <div class="host-list admin">
    <header>
      <h2>{{ title }}一覧</h2>
      <label>
        接続
        <select v-model="selectedSource">
          <option v-for="s in sources" :key="`${s.kind}:${s.id}`" :value="`${s.kind}:${s.id}`">
            {{ s.label }}
          </option>
        </select>
      </label>

      <template v-if="kind === 'jobs'">
        <label>ユーザー <input v-model="jobUser" placeholder="*ALL" size="10" /></label>
        <label>
          種別
          <select v-model="jobType">
            <option value="*">すべて</option>
            <option value="B">バッチ</option>
            <option value="I">対話</option>
          </select>
        </label>
      </template>
      <template v-else-if="kind === 'objects'">
        <label>ライブラリ <input v-model="objLibrary" size="10" /></label>
        <label>種別 <input v-model="objType" size="8" /></label>
      </template>
      <template v-else>
        <label>
          対象
          <select v-model="userSelection">
            <option value="*USER">ユーザー</option>
            <option value="*GROUP">グループ</option>
            <option value="*MEMBER">メンバー</option>
          </select>
        </label>
      </template>

      <button :disabled="loading" @click="load">{{ loading ? "取得中…" : "取得" }}</button>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="actionResult" :class="actionResult.ok ? 'ok' : 'error'">{{ actionResult.text }}</p>

    <table v-if="kind === 'jobs' && jobRows.length">
      <thead>
        <tr><th>番号</th><th>ユーザー</th><th>ジョブ名</th><th>状態</th><th>種別</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="j in jobRows" :key="`${j.number}/${j.user}/${j.name}`">
          <td>{{ j.number }}</td><td>{{ j.user }}</td><td>{{ j.name }}</td>
          <td>{{ j.status }}</td><td>{{ j.type }}{{ j.subtype }}</td>
          <td class="actions">
            <button @click="act('job-hold', { jobName: j.name, jobUser: j.user, jobNumber: j.number })">保留</button>
            <button @click="act('job-release', { jobName: j.name, jobUser: j.user, jobNumber: j.number })">解放</button>
            <button
              class="danger"
              @click="act('job-end', { jobName: j.name, jobUser: j.user, jobNumber: j.number }, `ジョブ ${j.number}/${j.user}/${j.name} を終了します。よろしいですか？`)"
            >終了</button>
          </td>
        </tr>
      </tbody>
    </table>

    <table v-else-if="kind === 'objects' && objectRows.length">
      <thead><tr><th>ライブラリ</th><th>名前</th><th>種別</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="o in objectRows" :key="`${o.library}/${o.name}/${o.type}`">
          <td>{{ o.library }}</td><td>{{ o.name }}</td><td>{{ o.type }}</td>
          <td class="actions">
            <button
              class="danger"
              @click="act('object-delete', { objectName: o.name, objectLibrary: o.library, objectType: o.type }, `${o.library}/${o.name}（${o.type}）を削除します。元に戻せません。よろしいですか？`)"
            >削除</button>
          </td>
        </tr>
      </tbody>
    </table>

    <table v-else-if="kind === 'users' && userRows.length">
      <thead><tr><th>名前</th><th>種類</th><th>グループ</th><th>説明</th></tr></thead>
      <tbody>
        <tr v-for="u in userRows" :key="u.name">
          <td>{{ u.name }}</td>
          <td>{{ u.isGroup ? "グループ" : "ユーザー" }}</td>
          <td>{{ u.groupProfile }}</td>
          <td>{{ u.text }}</td>
        </tr>
      </tbody>
    </table>

    <p v-else-if="!loading && !error" class="empty">
      接続を選んで「取得」を押してください。表示される範囲は IBM i の権限によります。
    </p>
  </div>
</template>

<style scoped>
.host-list { padding: 12px; overflow: auto; height: 100%; }
header { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
h2 { margin: 0; font-size: 1rem; }
label { display: inline-flex; gap: 4px; align-items: center; font-size: 0.85rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
th, td { border-bottom: 1px solid var(--border, #444); padding: 4px 8px; text-align: left; }
th { font-weight: 600; }
.actions { display: flex; gap: 4px; }
.actions button { font-size: 0.75rem; padding: 2px 6px; }
.danger { color: #c00; }
.error { color: #c00; }
.ok { color: #080; }
.empty { opacity: 0.7; font-size: 0.9rem; }
</style>
