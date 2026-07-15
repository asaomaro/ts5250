<script setup lang="ts">
import { ref } from "vue";
import type { AidKey } from "@as400web/core";
import { keybindingsStore, comboOf } from "../stores/keybindings.js";

defineEmits<{ (e: "close"): void }>();

const AID_KEYS: AidKey[] = [
  "Enter", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
  "PageUp", "PageDown", "Clear", "Help", "Print", "SysReq", "Attn"
];

const capturing = ref(false);
const newCombo = ref("");
const newAid = ref<AidKey>("F1");

function captureKey(ev: KeyboardEvent): void {
  if (!capturing.value) return;
  ev.preventDefault();
  if (ev.key === "Control" || ev.key === "Shift" || ev.key === "Alt") return;
  newCombo.value = comboOf(ev);
  capturing.value = false;
}
function add(): void {
  if (newCombo.value) keybindingsStore.set(newCombo.value, newAid.value);
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

      <p class="hint">既定（F1–F24・Enter・PageUp/Down 等）に加え、任意のキーコンボを AID に割り当てられます。</p>

      <table class="kb-table">
        <tbody>
          <tr v-for="(aid, combo) in keybindingsStore.bindings" :key="combo">
            <td><code>{{ combo }}</code></td>
            <td>→ {{ aid }}</td>
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
        <select v-model="newAid">
          <option v-for="k in AID_KEYS" :key="k" :value="k">{{ k }}</option>
        </select>
        <button class="add" :disabled="!newCombo" @click="add">追加</button>
      </div>
      <button class="reset" @click="keybindingsStore.reset()">全てリセット</button>
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
