<script setup lang="ts">
import { ref, onMounted } from "vue";
import type { AidKey } from "@ts5250/tn5250";
import {
  keybindingsStore,
  comboOf,
  isViewBinding,
  viewKeyOf,
  isMacroBinding,
  macroIdOf,
  isLocalBinding,
  localActionOf,
  type BindingTarget
} from "../stores/keybindings.js";
import { LOCAL_EDIT_ACTIONS, type LocalEditAction } from "../composables/useKeymap.js";
import { VIEW_ITEMS, viewItem, viewSettings } from "../stores/viewSettings.js";
import { macrosStore } from "../stores/macros.js";

defineEmits<{ (e: "close"): void }>();

const AID_KEYS: AidKey[] = [
  "Enter", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
  "PageUp", "PageDown", "Clear", "Help", "Print", "SysReq", "Attn"
];

const capturing = ref(false);
const newCombo = ref("");
const newTarget = ref<BindingTarget>("F1");

/** ローカル編集キーの表示名（利用者に見える文言はここ 1 か所に置く） */
const LOCAL_EDIT_LABEL: Record<LocalEditAction, string> = {
  "field-exit": "Field Exit（欄の残りを消して右寄せ・次の欄へ）",
  "erase-eof": "Erase EOF（カーソルから欄末尾まで消去）",
  "erase-input": "Erase Input（すべての入力欄をクリア）",
  "field-minus": "Field−（数値欄を負の値として確定・次の欄へ）",
  "field-plus": "Field+（数値欄を正の値として確定・次の欄へ）",
  "dup": "Dup（カーソルから欄末尾までを複写文字で埋める）"
};

/** 割当先の表示名。表示設定は「項目名（順送り）＋現在値」で分かるようにする。 */
function targetLabel(t: string): string {
  // 消したマクロに紐づいたままのバインドは、id をそのまま出すより「削除済み」と分かる方がよい
  if (isMacroBinding(t)) {
    const m = macrosStore.get(macroIdOf(t));
    return m ? `マクロ: ${m.name}（再生）` : "マクロ: 削除済み";
  }
  if (isLocalBinding(t)) return LOCAL_EDIT_LABEL[localActionOf(t)] ?? t;
  if (!isViewBinding(t)) return t;
  const item = viewItem(viewKeyOf(t));
  if (!item) return t;
  const cur = item.opts.find((o) => o.value === viewSettings.settings[item.key]);
  return `${item.label}（順送り${cur ? `・現在: ${cur.label}` : ""}）`;
}

// マクロ一覧はサーバー保存なので、パネルを開いたときに取り込む
onMounted(() => {
  if (!macrosStore.loaded) void macrosStore.refresh();
});

function captureKey(ev: KeyboardEvent): void {
  if (!capturing.value) return;
  ev.preventDefault();
  if (ev.key === "Control" || ev.key === "Shift" || ev.key === "Alt") return;
  newCombo.value = comboOf(ev);
  capturing.value = false;
}
function add(): void {
  if (newCombo.value) keybindingsStore.set(newCombo.value, newTarget.value);
  newCombo.value = "";
}
</script>

<template>
  <div class="kb-overlay" @click.self="$emit('close')">
    <div class="kb-panel" @keydown="captureKey">
      <div class="kb-head">
        <b>キーバインド編集</b>
        <button class="x" @click="$emit('close')">✕</button>
      </div>

      <p class="hint">
        既定（F1–F24・Enter・PageUp/Down 等）に加え、任意のキーコンボを AID キーや<b>表示設定の切り替え</b>、
        <b>ローカル編集キー</b>に割り当てられます。表示設定は押すたびに次の値へ順送りし、切り替わると画面下部に
        通知が出ます。ローカル編集キーはホストへ送らず端末内で完結します。
      </p>

      <table class="kb-table">
        <tbody>
          <tr v-for="(target, combo) in keybindingsStore.bindings" :key="combo">
            <td><code>{{ combo }}</code></td>
            <td>→ {{ targetLabel(String(target)) }}</td>
            <td><button class="del" @click="keybindingsStore.remove(String(combo))">削除</button></td>
          </tr>
          <tr v-if="Object.keys(keybindingsStore.bindings).length === 0">
            <td colspan="3" class="empty">カスタムバインドなし</td>
          </tr>
        </tbody>
      </table>

      <div class="kb-add">
        <button class="capture" :class="{ on: capturing }" @click="capturing = true">
          {{ capturing ? "キーを押してください…" : newCombo || "キーを設定" }}
        </button>
        <span>→</span>
        <select v-model="newTarget">
          <optgroup label="AID キー（ホストへ送る）">
            <option v-for="k in AID_KEYS" :key="k" :value="k">{{ k }}</option>
          </optgroup>
          <optgroup label="表示設定（順送り）">
            <option v-for="i in VIEW_ITEMS" :key="i.key" :value="`view:${i.key}`">
              {{ i.label }}（{{ i.opts.map((o) => o.label).join(" → ") }}）
            </option>
          </optgroup>
          <!-- ローカル編集キー（5250 の端末内操作。ホストへは送らない） -->
          <optgroup label="ローカル編集キー（ホストへ送らない）">
            <option v-for="a in LOCAL_EDIT_ACTIONS" :key="a" :value="`local:${a}`">
              {{ LOCAL_EDIT_LABEL[a] }}
            </option>
          </optgroup>
          <!-- マクロ再生（ACS の「マクロをキーに割り当てる」相当。spec D10）。
               保存済みが無いときは空の optgroup を出さない -->
          <optgroup v-if="macrosStore.macros.length > 0" label="マクロ（再生）">
            <option v-for="m in macrosStore.macros" :key="m.id" :value="`macro:${m.id}`">
              {{ m.name }}{{ m.hasSecret ? " 🔑" : "" }}
            </option>
          </optgroup>
        </select>
        <button class="add" :disabled="!newCombo" @click="add">追加</button>
      </div>
      <button class="reset" title="カスタム分を捨てて初期設定に戻す" @click="keybindingsStore.reset()">
        初期設定に戻す
      </button>
    </div>
  </div>
</template>

<style scoped>
.kb-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: grid;
  place-items: center;
  z-index: 50;
}
.kb-panel {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 16px;
  min-width: 360px;
  max-width: 90vw;
  font-family: var(--sans);
}
.kb-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.x {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--muted);
}
.hint {
  font-size: 12px;
  color: var(--muted);
}
.kb-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 12px;
}
.kb-table td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--line);
}
.empty {
  color: var(--muted);
  text-align: center;
}
.kb-add {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 12px 0;
}
.capture,
.add,
.del,
.reset {
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
  cursor: pointer;
  font: inherit;
}
.capture.on {
  border-color: var(--accent);
  color: var(--accent);
}
.add {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
select {
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
}
</style>
