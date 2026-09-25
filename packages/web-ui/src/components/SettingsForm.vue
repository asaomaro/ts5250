<script setup lang="ts">
/**
 * 接続情報の設定フォーム（`embed.html`専用。design.md「設計方針6」）。
 *
 * VSCode標準のQuickInputではなく、画面と地続きのフォームにする（利用者の希望）。
 * その代わり、QuickInputなら無料で付いてくるキーボード操作・フォーカス管理
 * （AC-I3/AC-I4）をここで自前実装する——`InfoPopover.vue`のバックドロップ意匠は借りるが、
 * あちらはフォーカストラップを持たない。
 */
import { nextTick, onMounted, ref } from "vue";
import type { SettingsFormValues } from "../embed-protocol.js";

const props = defineProps<{ initial?: SettingsFormValues }>();
const emit = defineEmits<{ (e: "save", v: SettingsFormValues): void; (e: "cancel"): void }>();

const host = ref(props.initial?.host ?? "");
const port = ref(props.initial?.port !== undefined ? String(props.initial.port) : "");
const tls = ref(props.initial?.tls ?? true);
const ccsid = ref(props.initial?.ccsid !== undefined ? String(props.initial.ccsid) : "");
const deviceName = ref(props.initial?.deviceName ?? "");
const user = ref(props.initial?.user ?? "");
const password = ref("");

const formEl = ref<HTMLFormElement>();
const firstField = ref<HTMLInputElement>();

onMounted(() => {
  void nextTick(() => firstField.value?.focus());
});

function save(): void {
  const v: SettingsFormValues = { host: host.value };
  if (port.value !== "") v.port = Number(port.value);
  v.tls = tls.value;
  if (ccsid.value !== "") v.ccsid = Number(ccsid.value);
  if (deviceName.value !== "") v.deviceName = deviceName.value;
  if (user.value !== "") v.user = user.value;
  if (password.value !== "") v.password = password.value;
  emit("save", v);
}

function cancel(): void {
  emit("cancel");
}

/**
 * **フォーカストラップ**（AC-I3）。`Tab`/`Shift+Tab`がフォーム外へ出ないよう、
 * 最後の要素→最初の要素・最初の要素→最後の要素へ手動で回す。`Escape`はキャンセル
 * （AC-I2/AC-I4）。ブラウザ標準のTab順に任せると、フォームの外（背後の画面）へ
 * フォーカスが漏れる。
 */
function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.preventDefault();
    cancel();
    return;
  }
  if (ev.key !== "Tab" || !formEl.value) return;
  const focusables = Array.from(
    formEl.value.querySelectorAll<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.hasAttribute("disabled"));
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  if (ev.shiftKey && document.activeElement === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && document.activeElement === last) {
    ev.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <div class="backdrop" @click="cancel" @mousedown.stop></div>
  <form ref="formEl" class="settings-form" @click.stop @mousedown.stop @keydown="onKeydown" @submit.prevent="save">
    <div class="row">
      <label for="sf-host">ホスト</label>
      <input id="sf-host" ref="firstField" v-model="host" type="text" required />
    </div>
    <div class="row">
      <label for="sf-port">ポート</label>
      <input id="sf-port" v-model="port" type="text" inputmode="numeric" placeholder="既定" />
    </div>
    <div class="row">
      <label for="sf-tls">TLS</label>
      <input id="sf-tls" v-model="tls" type="checkbox" />
    </div>
    <div class="row">
      <label for="sf-ccsid">CCSID</label>
      <input id="sf-ccsid" v-model="ccsid" type="text" inputmode="numeric" placeholder="既定" />
    </div>
    <div class="row">
      <label for="sf-device">装置名</label>
      <input id="sf-device" v-model="deviceName" type="text" placeholder="自動" />
    </div>
    <div class="row">
      <label for="sf-user">ユーザー</label>
      <input id="sf-user" v-model="user" type="text" autocomplete="username" />
    </div>
    <div class="row">
      <label for="sf-password">パスワード</label>
      <input id="sf-password" v-model="password" type="password" autocomplete="current-password" />
    </div>
    <div class="actions">
      <button type="button" @click="cancel">キャンセル</button>
      <button type="submit">保存</button>
    </div>
  </form>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.4);
}
.settings-form {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 41;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 280px;
  background: var(--crt-bezel, #1a1f1a);
  border: 1px solid var(--crt-line, #333);
  border-radius: 8px;
  padding: 14px;
  box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.5);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row label {
  width: 6em;
  flex: none;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
}
.row input[type="text"],
.row input[type="password"] {
  flex: 1;
  font-family: var(--mono);
  font-size: 12px;
  padding: 4px 6px;
  background: var(--input-bg, #0b0f0b);
  color: var(--fg, #d9e3da);
  border: 1px solid var(--crt-line, #333);
  border-radius: 4px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.actions button {
  font-family: var(--mono);
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid var(--crt-line, #333);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
</style>
