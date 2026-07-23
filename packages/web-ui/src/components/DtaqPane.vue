<script setup lang="ts">
/**
 * データ待ち行列（DTAQ）の覗き見・送受信パネル。
 *
 * **一覧は SQL サービス経由（観測）、送受信・管理は自前プロトコル**（design 判断 3）。
 * 自前プロトコルには「全エントリを覗く」操作が無いため、一覧だけ `DATA_QUEUE_ENTRIES` を使う。
 * 一覧の text は CCSID の都合で best-effort（EBCDIC 解釈）——真値は hex 列を見る。
 */
import { ref, computed } from "vue";
import { systemsStore } from "../stores/systems.js";
import LoadingBar from "./LoadingBar.vue";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";
import {
  send,
  receive,
  create,
  clear,
  deleteQueue,
  attributes,
  listEntries,
  isValidObjectName,
  DtaqRequestError,
  type DtaqEncoding,
  type DtaqAttributes,
  type DtaqListedEntry,
  type ReceiveResult
} from "../dtaqApi.js";

defineProps<{ tabId: string }>();

const source = () => ({ system: systemsStore.selected });
const { visible: slowLoading, busy, run } = useDelayedLoading();

const library = ref("");
const name = ref("");
const actionError = ref("");
const message = ref("");

// 送信
const sendData = ref("");
const sendEncoding = ref<DtaqEncoding>("utf8");
const sendKey = ref("");
// 受信
const recvEncoding = ref<DtaqEncoding>("utf8");
const recvPeek = ref(true);
const recvWait = ref(0);
const recvKey = ref("");
const received = ref<ReceiveResult["entry"] | undefined>(undefined);
// 作成
const createMaxLen = ref(256);
const createType = ref<"FIFO" | "LIFO" | "KEYED">("FIFO");
const createKeyLen = ref(16);
const createSaveSender = ref(false);
// 表示
const attrs = ref<DtaqAttributes | undefined>(undefined);
const entries = ref<DtaqListedEntry[]>([]);
const listed = ref(false);

const queueReady = computed(
  () => isValidObjectName(library.value) && isValidObjectName(name.value)
);
/**
 * 状態行に出す案内文（エラーより下位）。
 * **案内と操作結果を 1 つの行に寄せる**——別々の `<p>` を出し入れすると行数が変わり、
 * 下のフォームや表が上下に飛ぶ
 */
const statusNote = computed(() => {
  if (!systemsStore.selected) return "システムを選んでください。";
  if (!queueReady.value)
    return "ライブラリーとキュー名を入力してください（英数字と $ # @ _ . のみ・10 文字まで）。";
  return message.value;
});
const disabled = computed(() => busy.value || !systemsStore.selected || !queueReady.value);
const keyed = computed(() => createType.value === "KEYED");

/** 操作を包んで、エラーは日本語文言に、成功は note に落とす */
async function act(what: string, fn: () => Promise<void>): Promise<void> {
  actionError.value = "";
  message.value = "";
  try {
    await run(fn);
    message.value = what;
  } catch (e) {
    actionError.value = e instanceof DtaqRequestError ? e.message : String(e);
  }
}

async function onSend(): Promise<void> {
  await act("送信しました", async () => {
    await send(source(), library.value, name.value, {
      data: sendData.value,
      encoding: sendEncoding.value,
      ...(sendKey.value !== "" ? { key: sendKey.value } : {})
    });
    sendData.value = "";
  });
}

async function onReceive(peek: boolean): Promise<void> {
  actionError.value = "";
  message.value = "";
  // **前回の結果は消さない**——応答が返るまでの間だけ結果欄が畳まれると、
  // 下のレイアウトが一瞬詰まってから戻り、上下に飛んで見える
  try {
    const res = await run(() =>
      receive(source(), library.value, name.value, {
        wait: Math.max(0, recvWait.value),
        peek,
        encoding: recvEncoding.value,
        ...(recvKey.value !== "" ? { key: recvKey.value, search: "EQ" } : {})
      })
    );
    received.value = res.entry;
    message.value = res.entry === null ? "エントリはありませんでした" : peek ? "先頭を覗きました" : "受信しました";
  } catch (e) {
    // 失敗したときだけ畳む（古い結果をエラーの下に残すと、どちらが今の状態か分からない）
    received.value = undefined;
    actionError.value = e instanceof DtaqRequestError ? e.message : String(e);
  }
}

async function onCreate(): Promise<void> {
  await act("作成しました", () =>
    create(source(), library.value, name.value, {
      maxEntryLength: createMaxLen.value,
      type: createType.value,
      ...(keyed.value ? { keyLength: createKeyLen.value } : {}),
      saveSender: createSaveSender.value
    })
  );
}

async function onClear(): Promise<void> {
  actionError.value = "";
  message.value = "";
  try {
    // クリアと（表示中なら）一覧の取り直しを 1 つの run に入れ、**最後に**メッセージを出す。
    // 先に message を立てて onList を呼ぶと、onList 冒頭の message リセットで消える
    await run(async () => {
      await clear(source(), library.value, name.value);
      // クリアが通った時点でメッセージを立てる（`listEntries` は message を触らないので消えない）。
      // 直後の取り直しが失敗しても「クリアはできた」ことは残す
      message.value = "クリアしました";
      if (listed.value) entries.value = await listEntries(source(), library.value, name.value);
    });
  } catch (e) {
    actionError.value = e instanceof DtaqRequestError ? e.message : String(e);
  }
}

async function onDelete(): Promise<void> {
  actionError.value = "";
  message.value = "";
  try {
    await run(() => deleteQueue(source(), library.value, name.value));
    // **成功したときだけ**表示を畳む。失敗（使用中など）でパネルを消すと、
    // まだ存在するのに「消えた」ように見える
    attrs.value = undefined;
    entries.value = [];
    listed.value = false;
    message.value = "削除しました";
  } catch (e) {
    actionError.value = e instanceof DtaqRequestError ? e.message : String(e);
  }
}

async function onAttributes(): Promise<void> {
  actionError.value = "";
  message.value = "";
  try {
    attrs.value = await run(() => attributes(source(), library.value, name.value));
  } catch (e) {
    attrs.value = undefined;
    actionError.value = e instanceof DtaqRequestError ? e.message : String(e);
  }
}

async function onList(): Promise<void> {
  actionError.value = "";
  message.value = "";
  try {
    entries.value = await run(() => listEntries(source(), library.value, name.value));
    listed.value = true;
  } catch (e) {
    actionError.value = e instanceof DtaqRequestError ? e.message : String(e);
  }
}

defineExpose({ onSend, onReceive, onCreate, onClear, onDelete, onAttributes, onList });
</script>

<template>
  <section class="dtaq">
    <header class="head">
      <h2>データ待ち行列</h2>
      <label>ライブラリー
        <input v-model="library" maxlength="10" spellcheck="false" />
      </label>
      <label>キュー
        <input v-model="name" maxlength="10" spellcheck="false" />
      </label>
      <button :disabled="disabled" @click="onAttributes">属性</button>
      <button :disabled="disabled" @click="onList">一覧</button>
    </header>

    <!--
      読み込み中・エラー・案内・操作結果を **1 行の固定枠**にまとめる。
      それぞれを個別に出し入れすると行数が変わり、押すたびに下の表が上下に飛ぶ
    -->
    <div class="status">
      <LoadingBar v-if="slowLoading" label="データ待ち行列と通信しています" />
      <p v-else-if="actionError" class="error" role="alert">{{ actionError }}</p>
      <p v-else-if="statusNote" class="note" role="status">{{ statusNote }}</p>
    </div>

    <div class="cols">
      <!-- 送信 -->
      <fieldset>
        <legend>送信</legend>
        <textarea v-model="sendData" rows="3" placeholder="送るデータ" spellcheck="false"></textarea>
        <div class="row">
          <label>符号化
            <select v-model="sendEncoding">
              <option value="utf8">utf8</option>
              <option value="base64">base64（バイナリ）</option>
              <option value="ebcdic">ebcdic</option>
            </select>
          </label>
          <label>キー（任意）
            <input v-model="sendKey" placeholder="キー付きのみ" spellcheck="false" />
          </label>
          <button :disabled="disabled" @click="onSend">送信</button>
        </div>
      </fieldset>

      <!-- 受信 -->
      <fieldset>
        <legend>受信 / ピーク</legend>
        <div class="row">
          <label>符号化
            <select v-model="recvEncoding">
              <option value="utf8">utf8</option>
              <option value="base64">base64（バイナリ）</option>
              <option value="ebcdic">ebcdic</option>
            </select>
          </label>
          <label>待機秒
            <input v-model.number="recvWait" type="number" min="0" max="60" />
          </label>
          <label>キー（任意）
            <input v-model="recvKey" placeholder="キー検索 EQ" spellcheck="false" />
          </label>
        </div>
        <div class="row">
          <button :disabled="disabled" @click="onReceive(true)">ピーク（消費しない）</button>
          <button :disabled="disabled" @click="onReceive(false)">受信（取り出す）</button>
        </div>
        <div v-if="received !== undefined" class="result">
          <template v-if="received === null">（エントリはありません）</template>
          <template v-else>
            <div><b>データ</b>（{{ received.encoding }} / {{ received.bytes }} バイト）: <code>{{ received.data }}</code></div>
            <div v-if="received.senderInfo"><b>送信者</b>: <code>{{ received.senderInfo }}</code></div>
          </template>
        </div>
      </fieldset>

      <!-- 管理 -->
      <fieldset>
        <legend>管理</legend>
        <div class="row">
          <label>最大長
            <input v-model.number="createMaxLen" type="number" min="1" max="64512" />
          </label>
          <label>種別
            <select v-model="createType">
              <option value="FIFO">FIFO</option>
              <option value="LIFO">LIFO</option>
              <option value="KEYED">KEYED</option>
            </select>
          </label>
          <label v-if="keyed">キー長
            <input v-model.number="createKeyLen" type="number" min="1" max="256" />
          </label>
          <label><input v-model="createSaveSender" type="checkbox" /> 送信者情報</label>
        </div>
        <!-- 上の行は作成のパラメーター、この行は操作。削除は右端に離して誤クリックを避ける -->
        <div class="row">
          <button :disabled="disabled" @click="onCreate">作成</button>
          <button :disabled="disabled" @click="onClear">クリア</button>
          <button class="danger" :disabled="disabled" @click="onDelete">削除</button>
        </div>
        <p v-if="attrs" class="attrs">
          最大 {{ attrs.maxEntryLength }} バイト / {{ attrs.type }} /
          キー長 {{ attrs.keyLength }} / 送信者情報 {{ attrs.saveSender ? "あり" : "なし" }}
        </p>
      </fieldset>
    </div>

    <!-- 一覧（SQL 経由） -->
    <div v-if="listed" class="list">
      <p class="hint">
        一覧は SQL サービス（DATA_QUEUE_ENTRIES）で取得。text は EBCDIC 解釈の best-effort です——
        UTF-8/バイナリは化けるので、真値は hex 列か「受信」で確認してください。
      </p>
      <table>
        <thead>
          <tr><th>#</th><th>text（EBCDIC）</th><th>バイト</th><th>hex（先頭64）</th><th>登録</th><th>送信者</th></tr>
        </thead>
        <tbody>
          <tr v-for="e in entries" :key="e.position">
            <td>{{ e.position }}</td>
            <td><code>{{ e.textEbcdic }}</code></td>
            <td>{{ e.bytes }}</td>
            <td class="hex"><code>{{ e.hex }}</code></td>
            <td>{{ e.enqueuedAt }}</td>
            <td>{{ e.sender }}</td>
          </tr>
          <tr v-if="entries.length === 0"><td colspan="6" class="empty">（エントリなし）</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.dtaq {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: auto;
  background: var(--bg);
  color: var(--ink);
}
.head {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}
h2 { margin: 0; font-size: 13px; font-family: var(--mono); font-weight: 700; }
label { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--muted); }
input, select, textarea {
  background: var(--card);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 3px 6px;
  font-size: 13px;
}
input[type="number"] { width: 5em; }
textarea { width: 100%; font-family: var(--mono); resize: vertical; }
button {
  background: var(--accent-soft);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: not-allowed; }
/* 削除だけは行の右端へ離す（作成・クリアの隣で誤って押さないように） */
button.danger { color: #e66; margin-left: auto; }
.cols {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
}
fieldset {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  min-width: 260px;
  flex: 1;
}
legend { font-size: 12px; color: var(--accent); padding: 0 4px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
.result { margin-top: 8px; font-size: 13px; }
.result code { color: var(--accent); word-break: break-all; }
.attrs { margin: 6px 0 0; font-size: 12px; color: var(--muted); }
/* 状態行は**中身が無くても場所を取る**（高さを固定して、下のレイアウトを動かさない） */
.status {
  display: flex;
  align-items: center;
  min-height: 22px;
  padding: 2px 12px;
}
/* 枠の高さに収める（LoadingBar 既定の縦 padding だと行が伸びて飛ぶ） */
.status :deep(.loading) { padding: 0; font-size: 12px; }
.error { color: #e66; margin: 0; font-size: 12px; }
.note { color: var(--muted); margin: 0; font-size: 12px; }
.list { padding: 0 12px 12px; }
.hint { font-size: 11px; color: var(--muted); }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 4px 8px; text-align: left; font-size: 12px; }
th { color: var(--muted); font-weight: 600; }
td code { font-family: var(--mono); }
.hex { color: var(--muted); word-break: break-all; }
.empty { color: var(--muted); text-align: center; }
</style>
