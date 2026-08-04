<script setup lang="ts">
/**
 * **プログラム呼び出し**（画面を経由せずに RPG / COBOL / システム提供のプログラムを呼ぶ）。
 *
 * 引数は**型で書く**——文字・詰め 10 進・ゾーン 10 進・2 進。
 * 型で表せない構造体は「生バイト（base64）」で渡せる（逃げ道）。
 *
 * **数値も文字列で入力する。** `number` は 2^53 を超えると精度を失い、
 * 金額のような値が静かに誤る（サーバー側も文字列でやり取りしている）。
 */
import { ref, computed } from "vue";
import LoadingBar from "./LoadingBar.vue";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";

const props = defineProps<{ tabId: string; active?: boolean; system?: string }>();

type ArgType = "char" | "packed" | "zoned" | "bin" | "bytes" | "null";
type Dir = "in" | "out" | "inout";

interface ArgRow {
  type: ArgType;
  dir: Dir;
  value: string;
  length: number;
  digits: number;
  decimals: number;
  bytes: 2 | 4 | 8;
}

const newRow = (): ArgRow => ({
  type: "char",
  dir: "in",
  value: "",
  length: 10,
  digits: 15,
  decimals: 5,
  bytes: 4
});

const program = ref("QCMDEXC");
const library = ref("QSYS");
const args = ref<ArgRow[]>([newRow()]);
// 0.5 秒を超えたときだけ読み込み表示を出す（一瞬で終わる呼び出しでちらつかせない）
const { visible: loading, busy, run: withBusy } = useDelayedLoading();
const error = ref("");
const result = ref<
  | {
      success: boolean;
      returnCode: number;
      messages: { id?: string; text?: string; severity?: number }[];
      outputs: (string | null)[];
    }
  | undefined
>();

/** その型で意味を持つ入力欄だけを出す（意味の無い欄を並べると誤入力を誘う） */
const needsValue = (a: ArgRow): boolean => a.type !== "null" && a.dir !== "out";
const needsLength = (a: ArgRow): boolean => a.type === "char" || a.type === "bytes";
const needsDigits = (a: ArgRow): boolean => a.type === "packed" || a.type === "zoned";

/** 画面の行 → API の引数（**要らない項目は送らない**——型ごとに意味が違う） */
function toArg(a: ArgRow): Record<string, unknown> {
  const out: Record<string, unknown> = { type: a.type };
  if (a.type === "null") return out;
  out["dir"] = a.dir;
  if (needsValue(a)) out["value"] = a.value;
  if (needsLength(a)) out["length"] = a.length;
  if (needsDigits(a)) {
    out["digits"] = a.digits;
    out["decimals"] = a.decimals;
  }
  if (a.type === "bin") out["bytes"] = a.bytes;
  return out;
}

const canRun = computed(() => !!props.system && program.value.trim() !== "" && library.value.trim() !== "");

async function run(): Promise<void> {
  if (!canRun.value || busy.value) return;
  error.value = "";
  result.value = undefined;
  await withBusy(async () => {
    const res = await fetch("/api/host/program", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: { system: props.system },
        program: program.value.trim().toUpperCase(),
        library: library.value.trim().toUpperCase(),
        args: args.value.map(toArg)
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

/** `QCMDEXC` の呼び方を入れる（この API の使い方が一番分かりやすい例） */
function fillQcmdexc(): void {
  const cmd = "DSPLIBL";
  program.value = "QCMDEXC";
  library.value = "QSYS";
  args.value = [
    { ...newRow(), type: "char", dir: "in", value: cmd, length: cmd.length },
    { ...newRow(), type: "packed", dir: "in", value: String(cmd.length), digits: 15, decimals: 5 }
  ];
}
</script>

<template>
  <div class="pane" :data-tab="props.tabId">
    <LoadingBar v-if="loading" />
    <div class="head">
      <b>プログラム呼び出し</b>
      <span class="note">画面を経由せずに呼ぶ。数値も文字列で入れる（大きな値で精度を失わないため）</span>
    </div>

    <div class="form">
      <label>ライブラリー <input v-model="library" size="10" placeholder="QSYS / *LIBL" /></label>
      <label>プログラム <input v-model="program" size="10" placeholder="QCMDEXC" /></label>
      <button :disabled="!canRun || busy" @click="run">呼び出す</button>
      <button class="ghost" @click="fillQcmdexc">例を入れる</button>
    </div>

    <table class="args">
      <thead>
        <tr><th>型</th><th>向き</th><th>値</th><th>長さ / 桁</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="(a, i) in args" :key="i">
          <td>
            <select v-model="a.type">
              <option value="char">文字</option>
              <option value="packed">詰め 10 進</option>
              <option value="zoned">ゾーン 10 進</option>
              <option value="bin">2 進</option>
              <option value="bytes">生バイト(base64)</option>
              <option value="null">ヌル</option>
            </select>
          </td>
          <td>
            <select v-if="a.type !== 'null'" v-model="a.dir">
              <option value="in">入力</option>
              <option value="out">出力</option>
              <option value="inout">入出力</option>
            </select>
          </td>
          <td>
            <input v-if="needsValue(a)" v-model="a.value" size="24" />
            <span v-else class="dim">—</span>
          </td>
          <td>
            <input v-if="needsLength(a)" v-model.number="a.length" type="number" min="0" size="5" />
            <template v-else-if="needsDigits(a)">
              <input v-model.number="a.digits" type="number" min="1" max="63" size="3" title="桁数" />
              .
              <input v-model.number="a.decimals" type="number" min="0" max="63" size="3" title="小数位" />
            </template>
            <select v-else-if="a.type === 'bin'" v-model.number="a.bytes">
              <option :value="2">2</option>
              <option :value="4">4</option>
              <option :value="8">8</option>
            </select>
            <span v-else class="dim">—</span>
          </td>
          <td><button class="ghost" @click="args.splice(i, 1)">削除</button></td>
        </tr>
      </tbody>
    </table>
    <button class="ghost" @click="args.push(newRow())">＋ 引数を足す</button>

    <p v-if="error" class="err">{{ error }}</p>

    <div v-if="result" class="section">
      <p :class="result.success ? 'ok' : 'err'">
        {{ result.success ? "成功" : "失敗" }}（戻り {{ result.returnCode }}）
      </p>
      <ul v-if="result.messages.length" class="msgs">
        <li v-for="(m, i) in result.messages" :key="i">
          <b>{{ m.id }}</b> {{ m.text }}
        </li>
      </ul>
      <table v-if="result.outputs.length" class="args">
        <thead><tr><th>引数</th><th>出力</th></tr></thead>
        <tbody>
          <tr v-for="(o, i) in result.outputs" :key="i">
            <td>{{ i + 1 }}</td>
            <!-- **入力専用の位置は null**（読むものが無い） -->
            <td>{{ o === null ? "—" : o }}</td>
          </tr>
        </tbody>
      </table>
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
