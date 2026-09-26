<script setup lang="ts">
/**
 * 接続情報の設定フォーム（`embed.html`専用。design.md「設計方針6」）。
 *
 * **接続前の待機画面にそのまま置く**（`decisions.md` D23。以前はヘッダーの⚙で開くポップアップで、
 * 「保存」ボタンを押しても`.ts5250`は未保存のまま・接続中の画面には反映されなかった）。
 * 保存ボタンは無く、**値が変わるたびに`change`を出す**——ファイルへの書き込み（間引き）は
 * 呼び出し側（`EmbedApp.vue`）が行う。初期値（`initial`）は生成時に1度だけ読む。
 * 外でファイルが書き換えられたときは、呼び出し側が`key`を変えて作り直す
 */
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import type { SettingsFormValues, EmbedAppKind, WatermarkValue } from "../embed-protocol.js";
import { HOST_CODE_PAGE_OPTIONS, hostCodePageOptionId, hostCodePageOptionOf } from "../hostCodePages.js";
import { SCREEN_SIZES, DEFAULT_SCREEN_SIZE, type ScreenSize } from "../screenSizes.js";
import { WATERMARK_DEFAULTS, WATERMARK_VARS } from "../composables/watermark.js";

const props = defineProps<{ initial?: SettingsFormValues; app: EmbedAppKind }>();
const emit = defineEmits<{ (e: "change", v: SettingsFormValues): void }>();

const host = ref(props.initial?.host ?? "");
const port = ref(props.initial?.port !== undefined ? String(props.initial.port) : "");
// **未指定はTLS無し**——サーバーは`tls === true`のときだけTLSにする（`ws-handler.ts`）。以前は`?? true`で、
// `tls`を書いていないファイルの設定を開くとTLSにチェックが入り、別の項目だけ変えて保存しても
// `"tls": true`が書かれて黙ってTLS接続に変わっていた（D19。本来のアプリも既存の編集は`?? false`）
const tls = ref(props.initial?.tls ?? false);
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
// **`terminal`/`screenSize`はemulatorのみ、`deviceName`はセッション（emulator・printer）のみ意味を持つ**
// （`embed-protocol.ts`の`ConnectPayload`のドキュメント注記どおり）。spool/sql/ifsではフォーム自体に出さない
const terminal = ref<"5250" | "3270">(props.initial?.terminal ?? "5250");
const screenSize = ref<ScreenSize>(props.initial?.screenSize ?? DEFAULT_SCREEN_SIZE);
const deviceName = ref(props.initial?.deviceName ?? "");
// **ウォーターマーク（画面に重ねる透かし）はemulatorのみ**（`ConfigCard.vue`の`wmForm`と
// 同じフォーム構成——透かしはIBM iへ送らないブラウザだけの表示設定なので、装置名等と
// 同じ「emulatorのみ意味を持つ」欄に並べる。`20260924-vscode-extension` D16。
// 濃さは保存が0〜1・入力が%で単位が違うため、`ConfigCard.vue`と同じく別状態に開く）
const initialWm: WatermarkValue | undefined = props.initial?.watermark;
const wmForm = reactive({
  enabled: initialWm !== undefined && initialWm.enabled !== false,
  text: initialWm?.text ?? "",
  opacityPct: Math.round((initialWm?.opacity ?? WATERMARK_DEFAULTS.opacity) * 100),
  size: initialWm?.size ?? WATERMARK_DEFAULTS.size,
  layout: initialWm?.layout ?? WATERMARK_DEFAULTS.layout,
  angle: initialWm?.angle ?? WATERMARK_DEFAULTS.angle,
  /** false＝端末の前景色に追従（テーマ・スキンに合う）。true のときだけ color を送る */
  useColor: initialWm?.color !== undefined,
  color: initialWm?.color ?? "#808080"
});
/** 透かしの文字に使える差し込み変数（`{host}` 等）の説明 */
const WM_VAR_HINT = WATERMARK_VARS.map((v) => `{${v.key}}=${v.label}`).join(" / ");
const user = ref(props.initial?.user ?? "");
const password = ref("");

const firstField = ref<HTMLInputElement>();

// ホストが空（作ったばかりのファイル）のときだけホスト欄へ。設定済みなら「接続」を押すだけのことが多い
onMounted(() => {
  if (!host.value) void nextTick(() => firstField.value?.focus());
});

/** ポートは空（既定）か1〜65535の整数。**打ちかけの不正値では保存しない**——保存すると`port`が消える */
const portInvalid = computed(() => {
  const t = port.value.trim();
  if (t === "") return false;
  return !/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 65535;
});

/** フォームの値を保存値へ畳む。不正な値があれば`undefined`（保存しない） */
function build(): SettingsFormValues | undefined {
  if (portInvalid.value) return undefined;
  const v: SettingsFormValues = { host: host.value.trim() };
  if (port.value.trim() !== "") v.port = Number(port.value.trim());
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
    const wm = buildWatermark();
    if (wm) v.watermark = wm;
  }
  if ((props.app === "emulator" || props.app === "printer") && deviceName.value !== "") v.deviceName = deviceName.value;
  if (user.value !== "") v.user = user.value;
  if (password.value !== "") v.password = password.value;
  return v;
}

// 生成時（初期値の反映）は出さない——開いただけでファイルを書き換えないため
watch([host, port, tls, codePageId, terminal, screenSize, deviceName, wmForm, user, password], () => {
  const v = build();
  if (v) emit("change", v);
}, { deep: true });

/** 数値入力を範囲に収める（空欄にするとNaNが入るので、そのときは既定へ戻す。`ConfigCard.vue`と同じ） */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * `wmForm`を保存値へ畳む。**文字が空なら設定ごと無し**にする——文字の無い透かしは
 * 描きようがなく、既定値だけの残骸を`.ts5250`に残さないため（`ConfigCard.vue`の
 * `buildWatermark`と同じ判断）。
 */
function buildWatermark(): WatermarkValue | undefined {
  const text = wmForm.text.trim();
  if (!text) return undefined;
  const wm: WatermarkValue = {
    text,
    opacity: clamp(wmForm.opacityPct, 2, 100, 12) / 100,
    size: clamp(wmForm.size, 8, 200, WATERMARK_DEFAULTS.size),
    layout: wmForm.layout,
    angle: clamp(wmForm.angle, -90, 90, WATERMARK_DEFAULTS.angle)
  };
  if (!wmForm.enabled) wm.enabled = false;
  if (wmForm.useColor) wm.color = wmForm.color;
  return wm;
}

</script>

<template>
  <form class="settings-form" @submit.prevent>
    <div class="row">
      <label for="sf-host">ホスト</label>
      <input id="sf-host" ref="firstField" v-model="host" type="text" required />
    </div>
    <div class="row">
      <label for="sf-port">ポート</label>
      <input id="sf-port" v-model="port" type="text" inputmode="numeric" placeholder="既定" :aria-invalid="portInvalid" />
    </div>
    <p v-if="portInvalid" class="field-error">ポートは 1〜65535 の数字で入力してください</p>
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
    <div v-if="app === 'emulator' || app === 'printer'" class="row">
      <label for="sf-device">装置名</label>
      <!-- プリンターは装置名が実質必須（多くのホストはプリンター装置の自動構成を断る。D20） -->
      <input id="sf-device" v-model="deviceName" type="text" :placeholder="app === 'printer' ? '例: PRT01（プリンター装置名）' : '自動'" />
    </div>
    <!-- ウォーターマーク（画面に重ねる透かし。ACSの透かしと同じ用途——本番機と検証機を
         一目で見分ける）。emulatorのみ。文字を入れて初めて設定になるので、文字を先頭に
         置き、細かい見え方は文字があるときだけ出す（`ConfigCard.vue`と同じ構成） -->
    <template v-if="app === 'emulator'">
      <div class="row">
        <label for="sf-wm-text">透かし文字</label>
        <input
          id="sf-wm-text"
          v-model="wmForm.text"
          type="text"
          placeholder="空欄なら表示しません（例: {host}）"
          :title="`差し込み変数: ${WM_VAR_HINT}`"
        />
      </div>
      <template v-if="wmForm.text.trim()">
        <div class="row">
          <label for="sf-wm-enabled">透かし表示</label>
          <input id="sf-wm-enabled" v-model="wmForm.enabled" type="checkbox" title="文字を残したまま切れます" />
        </div>
        <div class="row">
          <label for="sf-wm-layout">透かし配置</label>
          <select id="sf-wm-layout" v-model="wmForm.layout">
            <option value="tile">並べる（画面全体）</option>
            <option value="center">中央に1つ</option>
          </select>
        </div>
        <div class="row">
          <label for="sf-wm-opacity">透かし濃さ（%）</label>
          <input id="sf-wm-opacity" v-model.number="wmForm.opacityPct" type="number" min="2" max="100" step="1" />
        </div>
        <div class="row">
          <label for="sf-wm-size">透かし大きさ（px）</label>
          <input id="sf-wm-size" v-model.number="wmForm.size" type="number" min="8" max="200" step="1" />
        </div>
        <div class="row">
          <label for="sf-wm-angle">透かし角度（度）</label>
          <input id="sf-wm-angle" v-model.number="wmForm.angle" type="number" min="-90" max="90" step="5" />
        </div>
        <div class="row">
          <label for="sf-wm-usecolor">透かし色</label>
          <select id="sf-wm-usecolor" v-model="wmForm.useColor">
            <option :value="false">画面の文字色に合わせる</option>
            <option :value="true">指定する</option>
          </select>
        </div>
        <div v-if="wmForm.useColor" class="row">
          <label for="sf-wm-color">色（選択）</label>
          <input id="sf-wm-color" v-model="wmForm.color" type="color" aria-label="透かしの色" />
        </div>
      </template>
    </template>
    <div class="row">
      <label for="sf-user">ユーザー</label>
      <input id="sf-user" v-model="user" type="text" autocomplete="username" />
    </div>
    <div class="row">
      <label for="sf-password">パスワード</label>
      <input id="sf-password" v-model="password" type="password" autocomplete="current-password" />
    </div>
  </form>
</template>

<style scoped>
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.field-error {
  margin: 0;
  font-size: 11.5px;
  color: var(--t-red, #e06c6c);
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
.row input[type="number"],
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
.row input[type="color"] {
  width: 40px;
  height: 22px;
  padding: 1px 2px;
  background: var(--input-bg, #0b0f0b);
  border: 1px solid var(--crt-line, #333);
  border-radius: 4px;
  cursor: pointer;
}
</style>
