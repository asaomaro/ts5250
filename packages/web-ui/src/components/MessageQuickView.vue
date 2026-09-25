<script setup lang="ts">
/**
 * ステータスバーの「✉ メッセージあり」（`StatusBar.vue`の`.msgwait`）をクリックしたときの
 * クイックビュー（`20260924-vscode-extension` D12。利用者要望）。
 *
 * `MessagePane.vue`（待ち行列を読む・応答する・消す・送るのフル機能。ランチャーの
 * 「メッセージ」から開く）の縮小版——**「今この画面に来ている通知を素早く読んで、
 * 必要なら照会に答える」だけに絞る**。消す・送るは持たない（誤操作の芽を増やさない。
 * フル機能が要るならランチャーから`MessagePane`を開く）。
 *
 * `system`（`own:<id>`等の参照）が要る——emulatorの直接接続にも
 * `syncSystem`で付加的に登録するようになった（`decisions.md` D12）。
 * 呼び出し側（`StatusBar.vue`）は`state.systemRef`が無ければこの部品自体を出さない。
 */
import { ref, onMounted } from "vue";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";

const props = defineProps<{ systemRef: string; defaultQueue?: string | undefined }>();
const emit = defineEmits<{ (e: "close"): void }>();

interface Msg {
  key: string;
  id: string | null;
  type: string | null;
  severity: number | null;
  text: string | null;
  secondLevel: string | null;
  timestamp: string | null;
  fromUser: string | null;
  fromJob: string | null;
}

const messages = ref<Msg[]>([]);
const error = ref("");
const notice = ref("");
const { visible: loading, busy, run: withBusy } = useDelayedLoading();
/** 応答の入力欄（キーごと） */
const replies = ref<Record<string, string>>({});

/** 既定はサインオン中の利用者自身の待ち行列（IBM iの標準——各ユーザー profile に
 *  同名の待ち行列が既定で紐づく）。無ければ`QSYSOPR`（`MessagePane.vue`と同じ既定）。 */
const queue = (): string => props.defaultQueue?.trim() || "QSYSOPR";

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(`/api/host/messages${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { system: props.systemRef }, ...body })
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    error.value = `${(json["code"] as string) ?? "エラー"}: ${(json["error"] as string) ?? res.statusText}`;
    return undefined;
  }
  return json;
}

/**
 * 取得の中身だけ（`busy`ガード無し）。**`refresh()`と`reply()`の両方から呼ぶ**——
 * `reply()`は自分の`withBusy`の中で読み直すため、ここでさらに`busy.value`を見ると
 * （`refresh()`が持つガード）外側の`withBusy`がまだ`busy`を立てたままで**常にfalseへ
 * 短絡し、読み直しが起きない**（実装時にテストで踏んだ。`MessagePane.vue`の`refresh()`/
 * `reply()`も同じ組み合わせ方をしており、同じ穴がある——直すなら合わせて）。
 */
async function fetchMessages(): Promise<void> {
  const r = await post("", { queue: queue(), max: 50 });
  if (r) messages.value = (r["messages"] as Msg[]) ?? [];
}

async function refresh(): Promise<void> {
  if (busy.value) return;
  error.value = "";
  await withBusy(fetchMessages).catch((e: unknown) => (error.value = e instanceof Error ? e.message : String(e)));
}

/** ホストが返したメッセージを1行にする（失敗の理由をそのまま見せる。`MessagePane.vue`と同じ） */
function hostMessage(r: Record<string, unknown>): string {
  const ms = (r["messages"] as { id?: string; text?: string }[]) ?? [];
  return ms.map((m) => `${m.id ?? ""} ${m.text ?? ""}`).join(" / ") || "失敗しました";
}

async function reply(m: Msg): Promise<void> {
  const text = (replies.value[m.key] ?? "").trim();
  if (text === "" || busy.value) return;
  error.value = "";
  notice.value = "";
  await withBusy(async () => {
    const r = await post("/reply", { queue: queue(), key: m.key, reply: text });
    if (r) {
      notice.value = r["success"] === true ? "応答しました" : hostMessage(r);
      delete replies.value[m.key];
      await fetchMessages(); // refresh()ではなく素の再取得（busyガードの二重掛けを避ける）
    }
  }).catch((e: unknown) => (error.value = e instanceof Error ? e.message : String(e)));
}

const isInquiry = (m: Msg): boolean => m.type === "INQUIRY";
const sevHigh = (m: Msg): boolean => m.severity !== null && m.severity >= 40;

onMounted(refresh);
</script>

<template>
  <!-- バックドロップ: 外側クリックで閉じる（本体は click.stop で伝播させない。
       docs/UI-DESIGN.md「情報ポップオーバー」） -->
  <div class="backdrop" @click="emit('close')" @mousedown.stop></div>
  <div class="msgqv" role="dialog" aria-label="メッセージ" @click.stop @mousedown.stop>
    <div class="head">
      <span class="title">メッセージ（{{ queue() }}）</span>
      <button class="fk" :disabled="busy" title="再読み込み" @click="refresh">↻</button>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
    <p v-if="notice" class="ok">{{ notice }}</p>
    <p v-if="!loading && !busy && messages.length === 0 && !error" class="dim">メッセージはありません</p>
    <ul v-if="messages.length" class="list">
      <li v-for="m in messages" :key="m.key" :class="{ inq: isInquiry(m) }">
        <div class="row1">
          <span class="id">{{ m.id ?? "-" }}</span>
          <span v-if="m.severity !== null" class="sev" :class="{ hi: sevHigh(m) }">{{ m.severity }}</span>
          <span class="from">{{ m.fromUser || m.fromJob || "" }}</span>
        </div>
        <div class="text">{{ m.text }}</div>
        <!-- **応答は照会にだけ出す**（`MessagePane.vue`と同じ理由——出せない行に入力欄が
             あると誤操作を誘う） -->
        <div v-if="isInquiry(m)" class="reply">
          <input v-model="replies[m.key]" placeholder="応答（例: G / C）" size="14" @keydown.enter="reply(m)" />
          <button class="fk" :disabled="busy || !(replies[m.key] ?? '').trim()" @click="reply(m)">応答する</button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: transparent;
}
/* **下から生えるトリガ**（ステータスバー＝画面下部）なので上へ開く。
   ヘッダーのポップオーバー（`top: calc(100% + 6px)`）とは逆 */
.msgqv {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 91;
  width: 300px;
  /* `ViewSettingsMenu`/`DesignMenu`と同じ上限（`20260924-vscode-extension` D9の教訓：
     画面の高さが低いと中身が画面からはみ出し、ページ全体がスクロールしてしまう） */
  max-height: 74vh;
  overflow-y: auto;
  padding: 8px;
  background: var(--crt-bezel);
  border: 1px solid var(--crt-line);
  border-radius: 10px;
  box-shadow: 0 16px 44px -14px rgba(0, 0, 0, 0.45);
  font-family: var(--sans);
  font-size: 12px;
  color: var(--muted);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.title {
  font-weight: 600;
  color: var(--t-turquoise);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.list li {
  padding: 6px;
  border-radius: 6px;
  border: 1px solid var(--crt-line);
}
.list li.inq {
  border-color: var(--t-yellow);
}
.row1 {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-family: var(--mono);
  font-size: 10.5px;
}
.id {
  color: var(--t-green);
}
.sev.hi {
  color: var(--t-red);
  font-weight: 600;
}
.from {
  margin-left: auto;
  color: var(--muted);
}
.text {
  margin-top: 3px;
  white-space: pre-wrap;
  word-break: break-word;
}
.reply {
  margin-top: 6px;
  display: flex;
  gap: 6px;
}
.reply input {
  font-family: var(--mono);
  font-size: 11px;
  background: var(--crt);
  color: inherit;
  border: 1px solid var(--crt-line);
  border-radius: 5px;
  padding: 2px 6px;
}
.fk {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 2px 8px;
  background: var(--crt);
  color: var(--muted);
  border: 1px solid var(--crt-line);
  border-radius: 5px;
  cursor: pointer;
}
.fk:hover {
  color: var(--t-green);
  border-color: var(--t-green);
}
.fk:disabled {
  opacity: 0.5;
  cursor: default;
}
.dim {
  color: var(--muted);
}
.err {
  color: var(--t-red);
}
.ok {
  color: var(--t-green);
}
</style>
