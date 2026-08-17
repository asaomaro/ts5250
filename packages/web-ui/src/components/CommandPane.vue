<script setup lang="ts">
/**
 * **CL コマンドのプロンプト**（実機の F4 に当たるもの）。
 *
 * コマンド名を入れると、そのコマンドの**定義**（`QCDRCMDD`）を引いてパラメータを並べる。
 * 説明・必須・既定値・選べる値が分かるので、**コマンドの書き方を覚えていなくても打てる**。
 *
 * **引用と検証はサーバーがやる**——規則を写すと二重管理になり、片方だけ直る。
 * この画面は値の入れ物で、**組み上がった文字列を見せる**のが仕事。
 */
import { ref, computed } from "vue";
import LoadingBar from "./LoadingBar.vue";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";

const props = defineProps<{ tabId: string; active?: boolean; system?: string }>();

interface Param {
  keyword: string;
  type: string;
  required: boolean;
  maxValues: number;
  length?: number;
  restricted: boolean;
  default?: string;
  prompt?: string;
  specialValues: string[];
  qualifiers?: Param[];
}
interface Template {
  name: string;
  library: string;
  prompt?: string;
  maxPositional: number;
  parameters: Param[];
}

const command = ref("CRTLIB");
const library = ref("*LIBL");
const tpl = ref<Template | undefined>();
const values = ref<Record<string, string>>({});
const { visible: loading, busy, run: withBusy } = useDelayedLoading();
const error = ref("");
/** サーバーが組んだ正確な文字列（「確かめる」の結果） */
const built = ref("");
const result = ref<
  | {
      command: string;
      success: boolean;
      returnCode: number;
      messages: { id?: string; text?: string; severity?: number }[];
    }
  | undefined
>();

/**
 * **この画面で扱えないパラメータ。**
 *
 * `ELEM`（`KWD((A B) (C D))` のような入れ子）は欄を出さない——
 * 出すと「入れたのに効かない」になる。**名前は挙げる**（黙って落とさない）。
 */
const unsupported = computed(() => (tpl.value?.parameters ?? []).filter((p) => p.type === "ELEM"));
const shown = computed(() => (tpl.value?.parameters ?? []).filter((p) => p.type !== "ELEM"));

/** 選択肢にするか。**決まった値しか受けない**（`Rstd=YES`）ものだけ */
const isChoice = (p: Param): boolean => p.restricted && p.specialValues.length > 0;

/** 値を触ったら、確かめた文字列は**古くなる**ので捨てる（古い文字列を見せない） */
function touched(): void {
  built.value = "";
}

/** 必須なのに空のもの。**押す前に**分かるように */
const missing = computed(() =>
  shown.value.filter((p) => p.required && (values.value[p.keyword] ?? "").trim() === "")
);

const canFetch = computed(() => !!props.system && command.value.trim() !== "");
const canRun = computed(() => tpl.value !== undefined && missing.value.length === 0 && !busy.value);

/**
 * 組み上がりの**下書き**。引用の規則はサーバーにしかないので、ここは「だいたいこう出る」。
 * **正確なものは「確かめる」で取る**（サーバーに組ませるだけで実行しない）。
 */
const preview = computed(() => {
  if (tpl.value === undefined) return "";
  const parts = [tpl.value.name];
  for (const p of shown.value) {
    const v = (values.value[p.keyword] ?? "").trim();
    if (v === "") continue;
    parts.push(`${p.keyword}(${v})`);
  }
  return parts.join(" ");
});

async function fetchTemplate(): Promise<void> {
  if (!canFetch.value || busy.value) return;
  error.value = "";
  result.value = undefined;
  await withBusy(async () => {
    const res = await fetch("/api/host/command/template", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: { system: props.system },
        command: command.value.trim().toUpperCase(),
        library: library.value.trim().toUpperCase()
      })
    });
    const body = await res.json();
    if (!res.ok) {
      error.value = `${body.code ?? "エラー"}: ${body.error ?? res.statusText}`;
      tpl.value = undefined;
      return;
    }
    tpl.value = body as Template;
    // **既定値は欄に入れない**——空欄＝ホストの既定、が CL の作法。
    // 入れてしまうと「消したのに既定が効かない」ことになる
    values.value = {};
  }).catch((e: unknown) => {
    error.value = e instanceof Error ? e.message : String(e);
  });
}

/** サーバーに**組ませるだけ**（実行しない）。F4 の値打ちは実行前に目で見られること */
async function build(): Promise<void> {
  if (tpl.value === undefined || busy.value) return;
  error.value = "";
  await withBusy(async () => {
    const res = await fetch("/api/host/command/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: { system: props.system },
        command: tpl.value!.name,
        library: library.value.trim().toUpperCase(),
        values: values.value
      })
    });
    const body = await res.json();
    if (!res.ok) {
      error.value = `${body.code ?? "エラー"}: ${body.error ?? res.statusText}`;
      built.value = "";
      return;
    }
    built.value = body.command as string;
  }).catch((e: unknown) => {
    error.value = e instanceof Error ? e.message : String(e);
  });
}

async function run(): Promise<void> {
  if (!canRun.value || tpl.value === undefined) return;
  error.value = "";
  result.value = undefined;
  await withBusy(async () => {
    const res = await fetch("/api/host/command/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: { system: props.system },
        command: tpl.value!.name,
        library: library.value.trim().toUpperCase(),
        values: values.value
      })
    });
    const body = await res.json();
    if (!res.ok) {
      error.value = `${body.code ?? "エラー"}: ${body.error ?? res.statusText}`;
      return;
    }
    result.value = body;
  }).catch((e: unknown) => {
    error.value = e instanceof Error ? e.message : String(e);
  });
}
</script>

<template>
  <div class="pane" :data-tab="props.tabId">
    <LoadingBar v-if="loading" />
    <div class="head">
      <b>コマンドの入力支援</b>
      <span class="note">コマンドの定義を引いて欄を並べる（実機の F4 に当たる）</span>
    </div>

    <div class="form">
      <label>コマンド <input v-model="command" size="10" placeholder="CRTLIB" /></label>
      <label>ライブラリー <input v-model="library" size="10" placeholder="*LIBL" /></label>
      <button :disabled="!canFetch || busy" @click="fetchTemplate">引く</button>
    </div>

    <p v-if="error" class="err">{{ error }}</p>

    <template v-if="tpl">
      <div class="head">
        <b>{{ tpl.name }}</b>
        <span class="note">{{ tpl.prompt }}（{{ tpl.library }}）</span>
      </div>

      <table class="args">
        <thead>
          <tr><th>キーワード</th><th>説明</th><th>値</th><th>既定 / 制限</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in shown" :key="p.keyword">
            <td>
              <span class="kwd">{{ p.keyword }}</span>
              <span v-if="p.required" class="req" title="必須">*</span>
            </td>
            <td class="note">{{ p.prompt }}</td>
            <td>
              <select v-if="isChoice(p)" v-model="values[p.keyword]" :data-kwd="p.keyword" @change="touched">
                <!-- 空＝ホストの既定に任せる -->
                <option value="">（既定）</option>
                <option v-for="v in p.specialValues" :key="v" :value="v">{{ v }}</option>
              </select>
              <input
                v-else
                v-model="values[p.keyword]"
                :data-kwd="p.keyword"
                :maxlength="p.maxValues > 1 ? undefined : p.length"
                size="24"
                :placeholder="p.maxValues > 1 ? '空白区切りで複数' : ''"
                @input="touched"
              />
            </td>
            <td class="note">
              <span v-if="p.default">既定 {{ p.default }}</span>
              <span v-if="p.length"> / {{ p.length }} 桁</span>
              <span v-if="p.maxValues > 1"> / 最大 {{ p.maxValues }} 個</span>
              <span v-if="p.qualifiers"> / 修飾 {{ p.qualifiers.length }} 段</span>
            </td>
          </tr>
        </tbody>
      </table>

      <p v-if="unsupported.length" class="note">
        この画面では扱えないパラメータ:
        <b>{{ unsupported.map((p) => p.keyword).join(", ") }}</b>
        （入れ子の要素。コマンド文字列を直接打つ経路を使ってください）
      </p>

      <div class="section">
        <div class="preview" data-testid="preview">{{ built || preview }}</div>
        <p v-if="built" class="note">サーバーが組んだ文字列（引用込み）</p>
        <p v-if="missing.length" class="err">
          必須が空です: {{ missing.map((p) => p.keyword).join(", ") }}
        </p>
        <button class="ghost" :disabled="tpl === undefined || busy" @click="build">確かめる</button>
        <button :disabled="!canRun" @click="run">実行</button>
      </div>
    </template>

    <div v-if="result" class="section">
      <div class="preview" data-testid="ran">{{ result.command }}</div>
      <p :class="result.success ? 'ok' : 'err'">
        {{ result.success ? "成功" : "失敗" }}（戻りコード {{ result.returnCode }}）
      </p>
      <ul class="msgs">
        <li v-for="(m, i) in result.messages" :key="i">
          <b>{{ m.id }}</b> {{ m.text }}
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.pane {
  padding: 0.6rem;
  overflow: auto;
  height: 100%;
}
.head {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  margin-bottom: 0.5rem;
}
.note,
.dim {
  color: color-mix(in srgb, currentColor 55%, transparent);
  font-size: 0.85rem;
}
.form {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 0.6rem;
}
.args {
  border-collapse: collapse;
  margin-bottom: 0.4rem;
}
.args th,
.args td {
  padding: 0.15rem 0.4rem;
  text-align: left;
  font-size: 0.9rem;
  vertical-align: top;
}
.kwd {
  font-family: var(--screen-mono, monospace);
}
.req {
  color: #b00;
  margin-left: 0.15rem;
}
.preview {
  font-family: var(--screen-mono, monospace);
  padding: 0.3rem 0.4rem;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
  margin-bottom: 0.4rem;
}
.section {
  margin-top: 0.8rem;
}
.msgs {
  margin: 0.3rem 0;
  padding-left: 1.2rem;
}
.err {
  color: #b00;
}
.ok {
  color: #0a0;
}
</style>
