<script setup lang="ts">
/**
 * **記述（PCML）からプログラムを呼ぶ。**
 *
 * `pgm:call` は位置指定——構造体は base64 の手詰めになり、桁ずれが型で止まらない。
 * こちらは `.pcml` を読んで、**名前で**出し入れする。
 *
 * 記述の出どころは**コンパイラ**（`CRTBNDRPG ... PGMINFO(*PCML) INFOSTMF('/…')`）。
 * だから既定は **IFS の道**を指定する形にしてある。貼り付けもできる。
 *
 * **並べる欄はサーバーの組み立てと同じ規則**で決める（構造体は入れ子、配列は件数ぶん）。
 * ただし**組むのはサーバー**——ここは見せるだけで、正しさの判断は 1 か所に置く。
 */
import { ref, computed } from "vue";
import LoadingBar from "./LoadingBar.vue";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";

const props = defineProps<{ tabId: string; active?: boolean; system?: string }>();

interface Field {
  /** 名前なしの予約域は `""` */
  name: string;
  /** 予約域は `""`（名前では触れない） */
  path: string;
  type: string;
  usage: "input" | "output" | "inputoutput";
  /** 整数、または長さを持つ別項目の完全名 */
  length?: number | string;
  precision?: number;
  ccsid?: number;
  init?: string;
  count?: number | string;
  fields?: Field[];
}

interface Program {
  name: string;
  path?: string;
  entrypoint?: string;
  threadsafe?: boolean;
  fields: Field[];
}

/** 画面に並べる 1 行（葉、または構造体の見出し） */
interface Row {
  /** **予約域は `""`**（名前で触れない）。表の鍵には使えないので `key` を別に持つ */
  path: string;
  key: string;
  label: string;
  depth: number;
  /** 見出し（構造体・配列の親）は入力欄を持たない */
  heading: boolean;
  type: string;
  usage: "input" | "output" | "inputoutput";
  hint: string;
}

const source = ref<"path" | "text">("path");
const path = ref("");
const text = ref("");
const doc = ref<{ version?: string; programs: Program[] } | undefined>();
const chosen = ref("");
const values = ref<Record<string, string>>({});
const { visible: loading, busy, run: withBusy } = useDelayedLoading();
const error = ref("");
const result = ref<
  | {
      success: boolean;
      returnCode: number;
      called?: string;
      messages: { id?: string; text?: string }[];
      values: Record<string, string>;
    }
  | undefined
>();

const program = computed(() => doc.value?.programs.find((p) => p.name === chosen.value));

/** その項目の型を人に読める形で（長さと桁が合っているかを目で確かめられるように） */
function hintOf(f: Field): string {
  // **長さは名前でありうる**（`length="bytesReturned"`）。その場合は名前を出す
  const n = f.length;
  switch (f.type) {
    case "char":
      return `文字 ${n}`;
    case "byte":
      return `生バイト ${n}（base64）`;
    case "packed":
      return `詰め 10 進 ${n}.${f.precision ?? 0}`;
    case "zoned":
      return `ゾーン 10 進 ${n}.${f.precision ?? 0}`;
    case "int":
      // **符号は precision で決まる**（16/32/64 が符号なし）
      return `整数 ${n} バイト${typeof n === "number" && f.precision === n * 8 ? "・符号なし" : ""}`;
    case "float":
      return `浮動小数 ${n} バイト`;
    default:
      return f.type;
  }
}

/**
 * `count` を件数に解く。決まらなければ `undefined`（並べようがない）。
 *
 * **呼んだあとの結果を先に見る**——IBM の書式は件数を出力で知らせる
 * （`count="numberOfSupplementalGroups"`）。呼ぶ前は並べようがないが、
 * 呼んだあとは並べられる。
 */
function countOf(f: Field): number | undefined {
  if (f.count === undefined) return 1;
  if (typeof f.count === "number") return f.count;
  const raw = result.value?.values?.[f.count] ?? values.value[f.count] ?? initOf(f.count);
  if (raw === undefined || !/^\d+$/u.test(raw.trim())) return undefined;
  return Number.parseInt(raw.trim(), 10);
}

/** 件数を決める項目が出力なら、呼ぶ前には決まらない（入れようがない） */
function countHint(f: Field): string {
  const ref = String(f.count);
  const target = fieldAt(ref);
  return target?.usage === "output"
    ? `件数は ${ref} で決まります。**呼ぶまで分かりません**`
    : `件数が ${ref} で決まります。先に入れてください`;
}

/** 完全名から記述の項目を引く */
function fieldAt(fullPath: string): Field | undefined {
  const parts = fullPath.replace(/\(\d+\)/gu, "").split(".");
  if (!program.value || parts[0] !== program.value.name) return undefined;
  let list: Field[] = program.value.fields;
  let found: Field | undefined;
  for (const part of parts.slice(1)) {
    found = list.find((f) => f.name === part);
    if (!found) return undefined;
    list = found.fields ?? [];
  }
  return found;
}

/** 完全名から記述の `init` を引く */
function initOf(fullPath: string): string | undefined {
  return fieldAt(fullPath)?.init;
}

/**
 * 記述を行に開く（サーバーの組み立てと同じ順序・同じ名前）。
 *
 * **名前の無い項目（予約域）も出す**——バイトを占めているので、
 * 隠すと「なぜ長さが合わないのか」が画面から分からなくなる。ただし触れない。
 */
function rowsOf(
  fields: readonly Field[],
  depth: number,
  prefix: string,
  addressable: boolean,
  keyPrefix: string
): Row[] {
  const out: Row[] = [];
  for (const [at, f] of fields.entries()) {
    const mine = addressable && f.name !== "";
    const base = mine ? (prefix === "" ? f.path : `${prefix}.${f.name}`) : "";
    const key = `${keyPrefix}/${at}`;
    const label = mine ? f.name : "（予約）";
    const n = countOf(f);
    if (n === undefined) {
      out.push({
        path: base,
        key,
        label,
        depth,
        heading: true,
        type: f.type,
        usage: f.usage,
        hint: countHint(f)
      });
      continue;
    }
    for (let i = 0; i < n; i++) {
      const here = !mine || f.count === undefined ? base : `${base}(${i + 1})`;
      const shown = f.count === undefined ? label : `${label}(${i + 1})`;
      const rowKey = f.count === undefined ? key : `${key}#${i}`;
      if (f.type === "struct") {
        out.push({
          path: here,
          key: rowKey,
          label: shown,
          depth,
          heading: true,
          type: "struct",
          usage: f.usage,
          hint: "構造体"
        });
        out.push(...rowsOf(f.fields ?? [], depth + 1, here, mine, rowKey));
      } else {
        out.push({
          path: here,
          key: rowKey,
          label: shown,
          depth,
          heading: false,
          type: f.type,
          usage: f.usage,
          hint: hintOf(f)
        });
      }
    }
  }
  return out;
}

const rows = computed<Row[]>(() =>
  program.value ? rowsOf(program.value.fields, 0, "", true, program.value.name) : []
);

/** 値を入れる欄を出すか（出力専用と予約域はホストの領分） */
const editable = (r: Row): boolean => !r.heading && r.path !== "" && r.usage !== "output";

const canLoad = computed(() =>
  source.value === "text" ? text.value.trim() !== "" : !!props.system && path.value.trim() !== ""
);

async function load(): Promise<void> {
  if (!canLoad.value || busy.value) return;
  error.value = "";
  result.value = undefined;
  doc.value = undefined;
  await withBusy(async () => {
    const res = await fetch("/api/host/pcml/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        // **貼り付けでも接続を添える**——`minvrm` を持つ記述はホストの版が要る
        source.value === "text"
          ? { ...(props.system ? { source: { system: props.system } } : {}), text: text.value }
          : { source: { system: props.system }, path: path.value.trim() }
      )
    });
    const body = await res.json();
    if (!res.ok) {
      error.value = `${body.code ?? "エラー"}: ${body.error ?? res.statusText}`;
      return;
    }
    doc.value = body;
    chosen.value = body.programs?.[0]?.name ?? "";
    // **見えているものがそのまま送られる**ようにする。
    // 記述の `init` があればそれを、無ければ空を置く——空欄を「未指定」にすると、
    // 空白 20 桁を送りたいだけの欄でサーバーに断られ、理由が画面から分からない
    values.value = {};
    for (const r of rows.value) {
      if (!editable(r)) continue;
      values.value[r.path] = initOf(r.path) ?? "";
    }
  }).catch((e: unknown) => {
    error.value = e instanceof Error ? e.message : String(e);
  });
}

const canCall = computed(() => !!props.system && !!program.value && !program.value.entrypoint);

async function call(): Promise<void> {
  if (!canCall.value || busy.value) return;
  error.value = "";
  result.value = undefined;
  await withBusy(async () => {
    const res = await fetch("/api/host/pcml/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: { system: props.system },
        ...(source.value === "text" ? { text: text.value } : { path: path.value.trim() }),
        program: chosen.value,
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
      <b>PCML から呼び出し</b>
      <span class="note">
        記述はコンパイラが吐く（<code>CRTBNDRPG … PGMINFO(*PCML) INFOSTMF('/…')</code>）。
        構造体も配列も名前で扱える
      </span>
    </div>

    <div class="form">
      <label><input v-model="source" type="radio" value="path" /> IFS から</label>
      <label><input v-model="source" type="radio" value="text" /> 貼り付け</label>
      <input
        v-if="source === 'path'"
        v-model="path"
        size="40"
        placeholder="/home/&lt;user&gt;/mypgm.pcml"
        data-testid="pcml-path"
      />
      <button :disabled="!canLoad || busy" data-testid="pcml-load" @click="load">読み込む</button>
    </div>
    <textarea
      v-if="source === 'text'"
      v-model="text"
      rows="6"
      class="paste"
      placeholder="&lt;pcml version=&quot;6.0&quot;&gt; …"
      data-testid="pcml-text"
    ></textarea>

    <p v-if="error" class="err" data-testid="pcml-error">{{ error }}</p>

    <div v-if="doc" class="section">
      <div class="form">
        <label>
          プログラム
          <select v-model="chosen" data-testid="pcml-program">
            <option v-for="p in doc.programs" :key="p.name" :value="p.name">{{ p.name }}</option>
          </select>
        </label>
        <span v-if="program?.path" class="note">{{ program.path }}</span>
        <button :disabled="!canCall || busy" data-testid="pcml-call" @click="call">呼ぶ</button>
      </div>

      <!-- **サービスプログラムはこの経路では呼べない**——呼び方が別物で、
           間違えると分かりにくい失敗になる -->
      <p v-if="program?.entrypoint" class="err">
        {{ program.name }} は entrypoint（{{ program.entrypoint }}）を持つサービスプログラムです。
        この画面では呼べません
      </p>

      <table class="args">
        <thead>
          <tr><th>項目</th><th>型</th><th>向き</th><th>値</th><th>結果</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.key" :class="{ heading: r.heading }">
            <td :style="{ paddingLeft: `${0.4 + r.depth * 1}rem` }">{{ r.label }}</td>
            <td class="dim">{{ r.hint }}</td>
            <td class="dim">
              {{ r.usage === "input" ? "入力" : r.usage === "output" ? "出力" : "入出力" }}
            </td>
            <td>
              <input
                v-if="editable(r)"
                v-model="values[r.path]"
                size="22"
                :data-kwd="r.path"
              />
              <span v-else class="dim">—</span>
            </td>
            <td :data-out="r.path || undefined">{{ r.path ? (result?.values?.[r.path] ?? "") : "" }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="result" class="section">
      <p :class="result.success ? 'ok' : 'err'" data-testid="pcml-result">
        {{ result.success ? "成功" : "失敗" }}（戻り {{ result.returnCode }}）
        <span v-if="result.called" class="note">呼び先 {{ result.called }}</span>
      </p>
      <ul v-if="result.messages.length" class="msgs">
        <li v-for="(m, i) in result.messages" :key="i"><b>{{ m.id }}</b> {{ m.text }}</li>
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
.paste {
  width: 100%;
  font-family: monospace;
  margin-bottom: 0.6rem;
}
.args {
  border-collapse: collapse;
  margin-bottom: 0.4rem;
  width: 100%;
}
.args th,
.args td {
  padding: 0.15rem 0.4rem;
  text-align: left;
  font-size: 0.9rem;
}
.args tr.heading {
  font-weight: 600;
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
