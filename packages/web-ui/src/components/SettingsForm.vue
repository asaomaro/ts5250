<script setup lang="ts">
import ConnectionTimingFields from "./ConnectionTimingFields.vue";
/**
 * 接続情報の設定フォーム（`embed.html`専用。design.md「設計方針6」）。
 *
 * **接続前の待機画面にそのまま置く**（`decisions.md` D23。以前はヘッダーの⚙で開くポップアップで、
 * 「保存」ボタンを押しても設定ファイルは未保存のまま・接続中の画面には反映されなかった）。
 * **値が変わるたびに`change`を出す**——ファイルへの書き込みは呼び出し側（`EmbedApp.vue`）が「保存」ボタンで行う（D33）。初期値（`initial`）は生成時に1度だけ読む。
 * 外でファイルが書き換えられたときは、呼び出し側が`key`を変えて作り直す
 */
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { embedConnectionError, type SettingsFormValues, type EmbedAppKind, type WatermarkValue } from "../embed-protocol.js";
import { HOST_CODE_PAGE_OPTIONS, SPOOL_CODE_PAGES, DEFAULT_SPOOL_CCSID, hostCodePageOptionId, hostCodePageOptionOf } from "../hostCodePages.js";
import { SCREEN_SIZES, DEFAULT_SCREEN_SIZE, type ScreenSize } from "../screenSizes.js";
import { WATERMARK_DEFAULTS, WATERMARK_VARS } from "../composables/watermark.js";
import { settingsColumnsOf } from "../settingsLayout.js";

const props = defineProps<{ initial?: SettingsFormValues; app: EmbedAppKind }>();
/** `undefined`＝打ちかけの不正な値がある（呼び出し側は保存・接続を止める） */
const emit = defineEmits<{ (e: "change", v: SettingsFormValues | undefined): void }>();

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
const allowPcCommand = ref(props.initial?.allowPcCommand ?? false);
const enhanced = ref(props.initial?.enhanced ?? false);
const deviceNameRetry = ref(props.initial?.deviceNameRetry ?? false);
const keepAlive = ref(props.initial?.keepAlive ?? false);
const keepAliveOptions = ref(props.initial?.keepAliveOptions);
const connectionHold = ref(props.initial?.connectionHold ?? "never");
const associatedPrinter = ref(props.initial?.associatedPrinter ?? "");
const pcAllow = ref(props.initial?.pcCommand?.allow?.join("\n") ?? "");
const pcTimeoutSec = ref(props.initial?.pcCommand?.timeoutMs !== undefined ? String(props.initial.pcCommand.timeoutMs / 1000) : "");
const autoPdfDir = ref(props.initial?.printer?.autoPdfDir ?? "");
const autoPrint = ref(props.initial?.printer?.autoPrint ?? "");
const ifsPath = ref(props.initial?.ifsPath ?? "");
const sqlInitial = ref(props.initial?.sqlInitial ?? "");
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
// **スプールの復号CCSID**（spoolのみ。`ConfigCard.vue`のシステムの「スプール CCSID」と同じ一覧）。
// 5250画面用のコードページとは別——送らないとサーバーの既定（273）で復号され、日本語のスプールが化ける。
// 一覧に無い値でも、開いて保存しただけで消さない（`unrecognizedCcsid`と同じ理由）
const spoolCcsid = ref<number | "unset">(props.initial?.spoolCcsid ?? "unset");
const spoolCcsidIsListed = (n: number | "unset"): boolean => n === "unset" || SPOOL_CODE_PAGES.some((p) => p.ccsid === n);
const user = ref(props.initial?.user ?? "");
const password = ref("");

// ホスト欄は`v-for`の中にあり、そこでの`ref`は配列になる——フォームから引く
const formEl = ref<HTMLFormElement>();
/** 列ごとの束（`settingsLayout.ts`。カード幅を決める`EmbedApp.vue`と同じ表を読む） */
const columns = computed(() => settingsColumnsOf(props.app));

// ホストが空（作ったばかりのファイル）のときだけホスト欄へ。設定済みなら「接続」を押すだけのことが多い
onMounted(() => {
  if (!host.value) void nextTick(() => formEl.value?.querySelector<HTMLInputElement>("#sf-host")?.focus());
});

/** ポートは空（既定）か1〜65535の整数。**打ちかけの不正値では保存しない**——保存すると`port`が消える */
const portInvalid = computed(() => {
  const t = port.value.trim();
  if (t === "") return false;
  return !/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 65535;
});

/** 入力状態を保存値へ組み立てる。検証は build で行う。 */
function buildValues(): SettingsFormValues {
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
  if (props.app === "spool" && spoolCcsid.value !== "unset") v.spoolCcsid = spoolCcsid.value;
  if (props.app === "emulator") {
    v.terminal = terminal.value;
    v.allowPcCommand = allowPcCommand.value;
    v.enhanced = enhanced.value;
    v.associatedPrinter = associatedPrinter.value;
    const pc: NonNullable<SettingsFormValues["pcCommand"]> = {};
    const allow = pcAllow.value.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
    if (allow.length) pc.allow = allow;
    if (pcTimeoutSec.value.trim() !== "") pc.timeoutMs = Number(pcTimeoutSec.value) * 1000;
    v.pcCommand = pc;
    // 3270はモデルでサイズが決まる（設定ファイルはモデル指定を持たない。design.md参照）ので送らない
    if (terminal.value !== "3270") v.screenSize = screenSize.value;
    const wm = buildWatermark();
    if (wm) v.watermark = wm;
  }
  if (props.app === "emulator" || props.app === "printer") {
    if (deviceName.value !== "") v.deviceName = deviceName.value;
    v.deviceNameRetry = deviceNameRetry.value;
    v.keepAlive = keepAlive.value;
    if (keepAliveOptions.value !== undefined) v.keepAliveOptions = keepAliveOptions.value;
    if (props.app === "emulator" && terminal.value === "5250") v.connectionHold = connectionHold.value;
  }
  if (props.app === "printer") {
    const printer: NonNullable<SettingsFormValues["printer"]> = {};
    if (autoPdfDir.value.trim()) printer.autoPdfDir = autoPdfDir.value.trim();
    if (autoPrint.value.trim()) printer.autoPrint = autoPrint.value.trim();
    v.printer = printer;
  }
  if (props.app === "ifs") v.ifsPath = ifsPath.value.trim();
  if (props.app === "sql") v.sqlInitial = sqlInitial.value;
  if (user.value !== "") v.user = user.value;
  if (password.value !== "") v.password = password.value;
  return v;
}

/** 不正な詳細設定を保存させない。画面・ファイル・メッセージは同じ検証を通す。 */
const settingsError = computed(() => embedConnectionError(buildValues()));
/** 保存可能な値だけを呼び出し元へ渡す。不正な入力は undefined として保存・接続を止める。 */
function build(): SettingsFormValues | undefined {
  return portInvalid.value || settingsError.value ? undefined : buildValues();
}

// 生成時（初期値の反映）は出さない——開いただけでファイルを書き換えないため
// **`flush: "sync"`**——入力の直後（同じ処理の中）に「接続」が押されても、その時点で呼び出し側が変更を知っているようにする。
// 既定（描画前にまとめて）だと、入力と押下が同じ処理で起きたとき`change`が押下より後に届き、保存を飛ばして古い設定で繋いだ
// （実際の VSCode で再現。D34）
watch([host, port, tls, codePageId, spoolCcsid, terminal, screenSize, deviceName, allowPcCommand, enhanced, deviceNameRetry, keepAlive, keepAliveOptions, connectionHold, associatedPrinter, pcAllow, pcTimeoutSec, autoPdfDir, autoPrint, ifsPath, sqlInitial, wmForm, user, password], () => emit("change", build()), {
  deep: true,
  flush: "sync"
});

/** 数値入力を範囲に収める（空欄にするとNaNが入るので、そのときは既定へ戻す。`ConfigCard.vue`と同じ） */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * `wmForm`を保存値へ畳む。**文字が空なら設定ごと無し**にする——文字の無い透かしは
 * 描きようがなく、既定値だけの残骸を設定ファイルに残さないため（`ConfigCard.vue`の
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
  <!-- **欄を役割で束ね、束を横に並べる**（D24。縦1列だとemulatorは縦スクロールが出た）。列の幅は
       `grid`の`auto-fit`で決まり、狭い画面では自然に1列へ折り返す -->
  <form ref="formEl" class="settings-form" @submit.prevent>
    <p v-if="settingsError" class="field-error settings-error" role="alert">{{ settingsError }}</p>
    <div v-for="(col, i) in columns" :key="i" class="col">
      <template v-for="g in col" :key="g">
        <fieldset v-if="g === 'connection'" class="group">
          <legend>接続先</legend>
          <div class="row">
            <label for="sf-host">ホスト</label>
            <input id="sf-host" v-model="host" type="text" required />
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
            <label for="sf-ccsid">コードページ</label>
            <select id="sf-ccsid" v-model="codePageId" title="ホストコードページ">
              <option value="unset">未指定（既定）</option>
              <option v-for="o in HOST_CODE_PAGE_OPTIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>
          </div>
          <div v-if="app === 'emulator' || app === 'printer'" class="row">
            <label for="sf-keepalive" title="TCPキープアライブ">キープアライブ</label>
            <input id="sf-keepalive" v-model="keepAlive" type="checkbox" />
          </div>
          <p v-if="app === 'emulator' || app === 'printer'" class="field-hint">無通信の接続をネットワーク機器が切断する環境向けです（既定は無効）</p>
          <div v-if="app === 'spool'" class="row">
            <label for="sf-spool-ccsid">スプール CCSID</label>
            <select id="sf-spool-ccsid" v-model="spoolCcsid" title="スプールの復号 CCSID（5250 画面用のコードページとは別）">
              <option value="unset">未指定（{{ DEFAULT_SPOOL_CCSID }}）</option>
              <option v-if="!spoolCcsidIsListed(spoolCcsid)" :value="spoolCcsid">{{ spoolCcsid }}</option>
              <option v-for="p in SPOOL_CODE_PAGES" :key="p.ccsid" :value="p.ccsid">{{ p.label }}</option>
            </select>
          </div>
          <p v-if="app === 'spool'" class="field-hint">日本語のスプールが化けるときは、ホストに合わせて 930・939・1399・5026・5035 から選びます</p>
        </fieldset>
        <fieldset v-else-if="g === 'signon'" class="group">
          <legend>サインオン</legend>
          <div class="row">
            <label for="sf-user">ユーザー</label>
            <input id="sf-user" v-model="user" type="text" autocomplete="username" />
          </div>
          <div class="row">
            <label for="sf-password">パスワード</label>
            <input id="sf-password" v-model="password" type="password" autocomplete="current-password" />
          </div>
        </fieldset>
        <fieldset v-else-if="g === 'device'" class="group">
          <legend>{{ app === "printer" ? "プリンター装置" : "端末" }}</legend>
          <ConnectionTimingFields :enabled="keepAlive" :options="keepAliveOptions" :hold="connectionHold"
            :show-hold="app === 'emulator' && terminal === '5250'" @options="keepAliveOptions = $event" @hold="connectionHold = $event" />
          <div v-if="app === 'emulator'" class="row">
            <label for="sf-terminal">種類</label>
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
          <div class="row">
            <label for="sf-device">装置名</label>
            <!-- プリンターは装置名が実質必須（多くのホストはプリンター装置の自動構成を断る。D20） -->
            <input id="sf-device" v-model="deviceName" type="text" :placeholder="app === 'printer' ? '例: PRT01' : '自動'" />
          </div>
          <p v-if="app === 'printer'" class="field-hint">未設定だと、自動構成をホストが許す場合だけ繋がります</p>
          <div v-if="app === 'printer' || terminal === '5250'" class="row">
            <label for="sf-device-retry">装置名競合回避</label>
            <input id="sf-device-retry" v-model="deviceNameRetry" type="checkbox" />
          </div>
          <p v-if="app === 'printer' || terminal === '5250'" class="field-hint">装置名が使用中の場合に末尾の数字を繰り上げて再試行します（既定は無効）</p>
          <template v-if="app === 'emulator' && terminal === '5250'">
            <div class="row">
              <label for="sf-enhanced">拡張5250 GUI</label>
              <input id="sf-enhanced" v-model="enhanced" type="checkbox" />
            </div>
            <div class="row">
              <label for="sf-associated-printer">関連プリンター</label>
              <input id="sf-associated-printer" v-model="associatedPrinter" type="text" placeholder="装置名（未指定ならホストの既定）" />
            </div>
          </template>
        </fieldset>
        <fieldset v-else-if="g === 'pc-command' && terminal === '5250'" class="group">
          <legend>PC コマンド（STRPCCMD）</legend>
          <label class="pc-command-option" for="sf-pc-command">
            <input id="sf-pc-command" v-model="allowPcCommand" type="checkbox" />
            ホストからのPCコマンド実行を許可する
          </label>
          <p class="field-hint">拡張機能のローカルサーバーが動作している環境で実行します（次回接続から適用）</p>
          <div class="row top">
            <label for="sf-pc-allow">許可パターン</label>
            <textarea id="sf-pc-allow" v-model="pcAllow" rows="3" placeholder="正規表現を1行1件（全体一致）。空なら制限なし" />
          </div>
          <p class="field-hint">prog:notepad のようにプログラム名でも指定できます</p>
          <div class="row">
            <label for="sf-pc-timeout" title="ホストが完了を待つ時間の上限">待ち時間（秒）</label>
            <input id="sf-pc-timeout" v-model="pcTimeoutSec" type="text" inputmode="decimal" placeholder="60（既定）" />
          </div>
        </fieldset>
        <fieldset v-else-if="g === 'printer-output'" class="group">
          <legend>プリンター出力</legend>
          <div class="row">
            <label for="sf-pdf-dir">PDF保存先</label>
            <input id="sf-pdf-dir" v-model="autoPdfDir" type="text" placeholder="空欄なら自動保存しない" />
          </div>
          <div class="row">
            <label for="sf-auto-print">自動印刷先</label>
            <input id="sf-auto-print" v-model="autoPrint" type="text" placeholder="プリンター名（空欄なら自動印刷しない）" />
          </div>
          <p class="field-hint">保存先・印刷先は拡張機能のローカルサーバーが動作している環境のものを指定します</p>
        </fieldset>
        <fieldset v-else-if="g === 'initial'" class="group">
          <legend>{{ app === 'ifs' ? '初期フォルダー' : '初期SQL' }}</legend>
          <div v-if="app === 'ifs'" class="row">
            <label for="sf-ifs-path">IFSパス</label>
            <input id="sf-ifs-path" v-model="ifsPath" type="text" placeholder="/（既定）" />
          </div>
          <template v-else>
            <div class="row top">
              <label for="sf-sql-initial">SQL文</label>
              <textarea id="sf-sql-initial" v-model="sqlInitial" rows="5" placeholder="開いたときに入力欄へセットします" />
            </div>
            <p class="field-hint">自動実行はしません</p>
          </template>
        </fieldset>
        <fieldset v-else-if="g === 'watermark'" class="group">
          <legend>透かし</legend>
          <div class="row">
            <label for="sf-wm-text">文字</label>
            <input
              id="sf-wm-text"
              v-model="wmForm.text"
              type="text"
              placeholder="空欄なら表示しない（例: {host}）"
              :title="`差し込み変数: ${WM_VAR_HINT}`"
            />
          </div>
          <template v-if="wmForm.text.trim()">
            <div class="row">
              <label for="sf-wm-enabled">表示</label>
              <input id="sf-wm-enabled" v-model="wmForm.enabled" type="checkbox" title="文字を残したまま切れます" />
            </div>
            <div class="row">
              <label for="sf-wm-layout">配置</label>
              <select id="sf-wm-layout" v-model="wmForm.layout">
                <option value="tile">並べる（画面全体）</option>
                <option value="center">中央に1つ</option>
              </select>
            </div>
            <div class="row">
              <label for="sf-wm-opacity">濃さ（%）</label>
              <input id="sf-wm-opacity" v-model.number="wmForm.opacityPct" type="number" min="2" max="100" step="1" />
            </div>
            <div class="row">
              <label for="sf-wm-size">大きさ（px）</label>
              <input id="sf-wm-size" v-model.number="wmForm.size" type="number" min="8" max="200" step="1" />
            </div>
            <div class="row">
              <label for="sf-wm-angle">角度（度）</label>
              <input id="sf-wm-angle" v-model.number="wmForm.angle" type="number" min="-90" max="90" step="5" />
            </div>
            <div class="row">
              <label for="sf-wm-usecolor">色</label>
              <select id="sf-wm-usecolor" v-model="wmForm.useColor">
                <option :value="false">画面の文字色に合わせる</option>
                <option :value="true">指定する</option>
              </select>
              <input v-if="wmForm.useColor" id="sf-wm-color" v-model="wmForm.color" type="color" aria-label="透かしの色" />
            </div>
          </template>
        </fieldset>
      </template>
    </div>
  </form>
</template>

<style scoped>
.settings-form {
  display: grid;
  /* 列は最小260px。カードの幅（`EmbedApp.vue`が列数から決める）に収まる数だけ横に並び、狭ければ折り返す */
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px 16px;
  align-items: start;
  width: 100%;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 8px 10px 10px;
  min-width: 0;
  border: 1px solid var(--crt-line, #333);
  border-radius: 6px;
}
.group legend {
  padding: 0 4px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--fg, #d9e3da);
}
.field-error,
.field-hint {
  margin: 0;
  font-size: 11.5px;
}
.field-error {
  color: var(--t-red, #e06c6c);
}
.field-hint {
  color: var(--muted);
}
.settings-error {
  grid-column: 1 / -1;
}
.row.top {
  align-items: flex-start;
}
.pc-command-option {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row label {
  width: 7em;
  flex: none;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
}
.row input[type="text"],
.row input[type="password"],
.row input[type="number"],
.row textarea,
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
