<script setup lang="ts">
/**
 * **メッセージ待ち行列。**
 *
 * 主目的は**照会メッセージへの応答**——応答しないとジョブが止まったままになる。
 * いままで `DSPMSG` の画面を操作するしか手が無かった。
 *
 * **消す操作は戻せない**ので、一覧を読んだだけでは消えない（明示的な操作にする）。
 */
import { ref, computed } from "vue";
import LoadingBar from "./LoadingBar.vue";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";

const props = defineProps<{ tabId: string; active?: boolean; system?: string }>();

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

const queue = ref("QSYSOPR");
const library = ref("QSYS");
const onlyInquiry = ref(false);
const messages = ref<Msg[]>([]);
const error = ref("");
const notice = ref("");
const { visible: loading, busy, run: withBusy } = useDelayedLoading();
/** 応答の入力欄（キーごと） */
const replies = ref<Record<string, string>>({});
const expanded = ref<Record<string, boolean>>({});

const canRun = computed(() => !!props.system && queue.value.trim() !== "");

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(`/api/host/messages${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { system: props.system }, ...body })
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    error.value = `${(json["code"] as string) ?? "エラー"}: ${(json["error"] as string) ?? res.statusText}`;
    return undefined;
  }
  return json;
}

const target = () => ({ queue: queue.value.trim(), library: library.value.trim() || undefined });

async function refresh(): Promise<void> {
  if (!canRun.value || busy.value) return;
  error.value = "";
  await withBusy(async () => {
    const r = await post("", { ...target(), onlyInquiry: onlyInquiry.value, max: 200 });
    if (r) messages.value = (r["messages"] as Msg[]) ?? [];
  }).catch((e: unknown) => (error.value = e instanceof Error ? e.message : String(e)));
}

async function reply(m: Msg): Promise<void> {
  const text = (replies.value[m.key] ?? "").trim();
  if (text === "" || busy.value) return;
  error.value = "";
  notice.value = "";
  await withBusy(async () => {
    const r = await post("/reply", { ...target(), key: m.key, reply: text });
    if (r) {
      notice.value = r["success"] === true ? "応答しました" : hostMessage(r);
      delete replies.value[m.key];
      await refresh();
    }
  }).catch((e: unknown) => (error.value = e instanceof Error ? e.message : String(e)));
}

/** ホストが返したメッセージを 1 行にする（失敗の理由をそのまま見せる） */
function hostMessage(r: Record<string, unknown>): string {
  const ms = (r["messages"] as { id?: string; text?: string }[]) ?? [];
  return ms.map((m) => `${m.id ?? ""} ${m.text ?? ""}`).join(" / ") || "失敗しました";
}

async function remove(m?: Msg): Promise<void> {
  // **戻せない操作**なので確かめる
  const what = m ? `このメッセージ（${m.id ?? m.type ?? ""}）` : `${queue.value} のメッセージ全部`;
  if (!window.confirm(`${what}を消します。戻せません。`)) return;
  error.value = "";
  notice.value = "";
  await withBusy(async () => {
    const r = await post("/remove", { ...target(), ...(m ? { key: m.key } : {}) });
    if (r) {
      notice.value = r["success"] === true ? "消しました" : hostMessage(r);
      await refresh();
    }
  }).catch((e: unknown) => (error.value = e instanceof Error ? e.message : String(e)));
}

// ---- 送信 ----
const send = ref({ text: "", toUser: "", toQueue: "", inquiry: false });
const sendOpen = ref(false);

async function doSend(): Promise<void> {
  if (send.value.text.trim() === "" || busy.value) return;
  error.value = "";
  notice.value = "";
  await withBusy(async () => {
    const to = send.value.toUser.trim()
      ? { toUser: send.value.toUser.trim() }
      : { toQueue: send.value.toQueue.trim() || queue.value.trim(), toLibrary: library.value.trim() || undefined };
    const r = await post("/send", {
      text: send.value.text,
      ...to,
      ...(send.value.inquiry ? { inquiry: true } : {})
    });
    if (r) {
      notice.value = r["success"] === true ? "送りました" : hostMessage(r);
      send.value.text = "";
      await refresh();
    }
  }).catch((e: unknown) => (error.value = e instanceof Error ? e.message : String(e)));
}

const isInquiry = (m: Msg): boolean => m.type === "INQUIRY";
const sevClass = (m: Msg): string => (m.severity !== null && m.severity >= 40 ? "sev-hi" : "");
</script>

<template>
  <div class="pane" :data-tab="props.tabId">
    <LoadingBar v-if="loading" />
    <div class="form">
      <label>ライブラリー <input v-model="library" size="8" placeholder="QSYS / *LIBL" /></label>
      <label>待ち行列 <input v-model="queue" size="10" placeholder="QSYSOPR" /></label>
      <label class="chk">
        <input v-model="onlyInquiry" type="checkbox" />
        <!-- 応答しないとジョブが止まったままになるので、ここだけ見たい場面が多い -->
        応答待ちだけ
      </label>
      <button :disabled="!canRun || busy" @click="refresh">読む</button>
      <button class="ghost" @click="sendOpen = !sendOpen">送る…</button>
      <button class="ghost danger" :disabled="!canRun || busy" @click="remove()">全部消す</button>
    </div>

    <div v-if="sendOpen" class="send">
      <input v-model="send.text" placeholder="本文" size="40" />
      <label>利用者 <input v-model="send.toUser" size="8" placeholder="（空なら待ち行列へ）" /></label>
      <label class="chk"><input v-model="send.inquiry" type="checkbox" /> 応答を求める</label>
      <button :disabled="busy || send.text.trim() === ''" @click="doSend">送信</button>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
    <p v-if="notice" class="ok">{{ notice }}</p>

    <table v-if="messages.length" class="msgs">
      <thead>
        <tr><th>種別</th><th>ID</th><th>重大度</th><th>本文</th><th>送信元</th><th></th></tr>
      </thead>
      <tbody>
        <template v-for="m in messages" :key="m.key">
          <tr :class="{ inq: isInquiry(m) }">
            <td>{{ isInquiry(m) ? "応答待ち" : m.type }}</td>
            <td>{{ m.id ?? "-" }}</td>
            <td :class="sevClass(m)">{{ m.severity ?? "-" }}</td>
            <td class="txt" @click="expanded[m.key] = !expanded[m.key]">{{ m.text }}</td>
            <td>{{ m.fromUser ?? "-" }}</td>
            <td>
              <button class="ghost" @click="remove(m)">消す</button>
            </td>
          </tr>
          <!-- **応答は照会にだけ出す。** 出せない行に入力欄があると誤操作を誘う -->
          <tr v-if="isInquiry(m)" class="reply">
            <td></td>
            <td colspan="5">
              <input
                v-model="replies[m.key]"
                placeholder="応答（例: G / C / YES）"
                size="20"
                @keydown.enter="reply(m)"
              />
              <button :disabled="busy || !(replies[m.key] ?? '').trim()" @click="reply(m)">応答する</button>
              <span class="dim">キー {{ m.key }}</span>
            </td>
          </tr>
          <tr v-if="expanded[m.key] && m.secondLevel" class="second">
            <td></td>
            <td colspan="5"><pre>{{ m.secondLevel }}</pre></td>
          </tr>
        </template>
      </tbody>
    </table>
    <p v-else-if="!busy" class="dim">メッセージはありません（「読む」を押してください）</p>
  </div>
</template>

<style scoped>
.pane {
  padding: 0.6rem;
  overflow: auto;
  height: 100%;
}
.form,
.send {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}
.send {
  padding: 0.4rem;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 4px;
}
.chk {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.msgs {
  border-collapse: collapse;
  width: 100%;
}
.msgs th,
.msgs td {
  padding: 0.15rem 0.4rem;
  text-align: left;
  font-size: 0.9rem;
  vertical-align: top;
}
/* **応答待ちを目立たせる**——ここを見落とすとジョブが止まったままになる */
.inq {
  background: color-mix(in srgb, orange 18%, transparent);
  font-weight: 600;
}
.sev-hi {
  color: #b00;
  font-weight: 600;
}
.txt {
  cursor: pointer;
}
.reply td {
  padding-bottom: 0.4rem;
}
.second pre {
  margin: 0;
  white-space: pre-wrap;
  font-size: 0.85rem;
}
.dim {
  color: color-mix(in srgb, currentColor 55%, transparent);
}
.err {
  color: #b00;
}
.ok {
  color: #0a0;
}
.danger {
  color: #b00;
}
</style>
