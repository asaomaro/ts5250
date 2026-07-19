<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { systemsStore } from "../stores/systems.js";
import LoadingBar from "./LoadingBar.vue";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";

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



const rows = ref<Row[]>([]);
const { visible: slowLoading, busy: loading, run } = useDelayedLoading();
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

/**
 * 取得元。**選択中システムをそのまま使う**——接続元をこのペインで選び直す必要はない。
 * 一覧はコマンドサーバー経由で、装置名も画面サイズも要らないのでシステムだけで足りる。
 */
function sourceBody(): Record<string, string> {
  return systemsStore.selected ? { system: systemsStore.selected } : {};
}

async function load(): Promise<void> {
  if (!systemsStore.selected) {
    error.value = "システムを選んでください";
    return;
  }
  error.value = "";
  actionResult.value = undefined;
  await run(async () => {
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
  }
  });
}

/** 破壊的な操作は確認を挟む */
async function act(action: string, target: Record<string, string>, confirmText?: string): Promise<void> {
  if (confirmText && !window.confirm(confirmText)) return;
  actionResult.value = undefined;
  await run(async () => {
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
  }
  });
}

const jobRows = computed(() => rows.value as JobRow[]);
const objectRows = computed(() => rows.value as ObjectRow[]);
const userRows = computed(() => rows.value as UserRow[]);

onMounted(() => {
  if (systemsStore.systems.length === 0) void systemsStore.refresh();
});

/**
 * システムが変わったら**表示中の行を捨てる**。
 *
 * 捨てないと、ヘッダーは新しいシステム名を出しているのに、並んでいるのは前のシステムの
 * ジョブ、という状態になる。誤って別システムのジョブを終了しかねない。
 * 自動で取り直さないのは、切り替えただけで意図しない問い合わせを飛ばさないため。
 */
watch(
  () => systemsStore.selected,
  () => {
    rows.value = [];
    error.value = "";
    actionResult.value = undefined;
  }
);
</script>

<template>
  <div class="host-list admin">
    <header>
      <h2>{{ title }}</h2>

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
    <LoadingBar v-if="slowLoading" label="取得しています…" />

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
/* 見出し・罫線は管理画面（AdminPane）に揃える。
   以前は未定義の var(--border, #444) を参照しており、ダークテーマでは
   トークンの外にある濃い線が引かれていた */
header { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
h2 { margin: 0; font-size: 13px; font-family: var(--mono); font-weight: 700; }
label { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--muted); }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 5px 8px; text-align: left; font-size: 13px; }
th { color: var(--muted); font-weight: 600; font-size: 12px; }
.actions { display: flex; gap: 6px; }
.actions button { font-size: 12px; padding: 2px 8px; }
.danger { border-color: #c62828; color: #c62828; }
.error { color: #c62828; }
.ok { color: var(--accent); }
.empty { color: var(--muted); text-align: center; }
</style>
