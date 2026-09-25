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
import type { SettingsFormValues, EmbedAppKind } from "../embed-protocol.js";
import { HOST_CODE_PAGE_OPTIONS, hostCodePageOptionId, hostCodePageOptionOf } from "../hostCodePages.js";
import { SCREEN_SIZES, DEFAULT_SCREEN_SIZE, type ScreenSize } from "../screenSizes.js";

const props = defineProps<{ initial?: SettingsFormValues; app: EmbedAppKind }>();
const emit = defineEmits<{ (e: "save", v: SettingsFormValues): void; (e: "cancel"): void }>();

const host = ref(props.initial?.host ?? "");
const port = ref(props.initial?.port !== undefined ? String(props.initial.port) : "");
const tls = ref(props.initial?.tls ?? true);
// **CCSID は自由入力ではなく、ACS の「ホスト・コード・ページ」一覧から選ばせる**
// （`ConfigCard.vue`の`sysCodePageId`/`sesCodePageId`と同じ1本の選択肢。930はKatakana/
// Katakana Extendedの2エントリを持つので、CCSID単体ではなくこのidが唯一の選択軸になる）
const codePageId = ref(hostCodePageOptionId(props.initial?.ccsid, props.initial?.katakanaVariant) ?? "unset");
// **一覧に無いCCSID（例: 5026/5035。ACSの接続設定画面にも無い値。`hostCodePages.ts`のdoc
// コメント参照）を手編集で持つファイルを開いたときの保険。** `codePageId`が"unset"のまま
// 保存すると`v.ccsid`が付かず、`handleSave`側が`else delete next.ccsid`で消してしまう
// ——ホストコード欄を一切触らず他の項目だけ変えて保存しても値が消えるのは事故なので、
// 一覧に無いだけで指定自体はあった元の値を、選ばれなかった間はそのまま持ち回す
const unrecognizedCcsid = codePageId.value === "unset" ? props.initial?.ccsid : undefined;
// **`terminal`/`screenSize`/`deviceName`はemulatorのみ意味を持つ**（`embed-protocol.ts`の
// `ConnectPayload`のドキュメント注記どおり）。printer(スプール表示)/sql/ifsではフォーム自体に出さない
const terminal = ref<"5250" | "3270">(props.initial?.terminal ?? "5250");
const screenSize = ref<ScreenSize>(props.initial?.screenSize ?? DEFAULT_SCREEN_SIZE);
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
  if (codePageId.value !== "unset") {
    const opt = hostCodePageOptionOf(codePageId.value);
    if (opt) {
      v.ccsid = opt.ccsid;
      if (opt.katakanaVariant !== undefined) v.katakanaVariant = opt.katakanaVariant;
    }
  } else if (unrecognizedCcsid !== undefined) {
    v.ccsid = unrecognizedCcsid;
  }
  if (props.app === "emulator") {
    v.terminal = terminal.value;
    // 3270はモデルでサイズが決まる（`.ts5250`はモデル指定を持たない。design.md参照）ので送らない
    if (terminal.value !== "3270") v.screenSize = screenSize.value;
    if (deviceName.value !== "") v.deviceName = deviceName.value;
  }
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
    formEl.value.querySelectorAll<HTMLElement>('input, select, button, [tabindex]:not([tabindex="-1"])')
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
      <label for="sf-ccsid">ホストコードページ</label>
      <select id="sf-ccsid" v-model="codePageId">
        <option value="unset">未指定（既定）</option>
        <option v-for="o in HOST_CODE_PAGE_OPTIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
      </select>
    </div>
    <div v-if="app === 'emulator'" class="row">
      <label for="sf-terminal">端末の種類</label>
      <select id="sf-terminal" v-model="terminal">
        <option value="5250">5250（IBM i）</option>
        <option value="3270">3270（メインフレーム）</option>
      </select>
    </div>
    <div v-if="app === 'emulator' && terminal !== '3270'" class="row">
      <label for="sf-screensize">画面サイズ</label>
      <select id="sf-screensize" v-model="screenSize">
        <option v-for="s in SCREEN_SIZES" :key="s.value" :value="s.value">{{ s.label }}</option>
      </select>
    </div>
    <div v-if="app === 'emulator'" class="row">
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
  min-width: 340px;
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
  width: 9.5em;
  flex: none;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
}
.row input[type="text"],
.row input[type="password"],
.row select {
  flex: 1;
  min-width: 0;
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
