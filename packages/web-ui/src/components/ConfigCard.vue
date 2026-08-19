<script setup lang="ts">
/**
 * システム / セッション設定のカード。**その場でフォームに開く**（専用の設定画面を持たない）。
 *
 * 一覧とフォームを同じ場所に置くのは、編集したい対象の隣から入れば、
 * 開いた時点で対象が確定するため——別画面へ移ると「どれを直すんだったか」を選び直すことになる。
 */
import { computed, reactive, ref, watch } from "vue";
import type { PublicSession, PublicSystem } from "@ts5250/server";
import { SYSTEM_COLOR_COUNT, systemColorVar } from "../composables/systemColor.js";
import { systemsStore, type SessionConfigForm, type SystemForm } from "../stores/systems.js";
import { sessionsStore } from "../stores/sessions.js";
import InfoPopover from "./InfoPopover.vue";
import { MSG_WATCH_CONSUMES } from "../composables/opMessages.js";
import { HOST_CODE_PAGES, DEFAULT_CCSID, DEFAULT_SPOOL_CCSID } from "../hostCodePages.js";
import { SCREEN_SIZES, DEFAULT_SCREEN_SIZE } from "../screenSizes.js";
import { WATERMARK_DEFAULTS, WATERMARK_VARS } from "../composables/watermark.js";

const props = defineProps<{
  kind: "system" | "session";
  system?: PublicSystem;
  session?: PublicSession;
  /** 新規作成のカードか */
  creating?: boolean;
  /** セッション新規作成時の親システム */
  parentSystem?: string;
  /** いま選択中のシステムか（一覧の中で現在地を示す） */
  selected?: boolean;
  /** 一覧表示（横並びの行）にするか。親の表示モードを受け取る */
  dense?: boolean;
  /** このセッションが接続処理中か（接続待ちの表示に使う） */
  connecting?: boolean;
  /**
   * この設定のセッションが既に開いているか。
   * 開いていれば「接続」ではなく「開く」（既存タブへ戻る）を出す。システムを切り替えて戻ると
   * メニューにはこのカードしか出ず、タブが生きていることが見えないため、そのまま「接続」を
   * 押して 2 本目を開いてしまう。装置名を固定しているとホストが弾く。
   */
  opened?: boolean;
}>();

const emit = defineEmits<{
  (e: "done"): void;
  (e: "cancel"): void;
  (e: "select", ref: string): void;
  (e: "open", ref: string): void;
  /** 開いていても**あえて**もう 1 本開く */
  (e: "openNew", ref: string): void;
}>();

/**
 * このシステムで**接続中**のセッション数。カードの「セッション N」は設定の数なので、
 * それだけでは今つながっているのかが分からない（切り替えて戻ったときに一番知りたい情報）。
 */
const connectedCount = computed(() =>
  props.kind === "system" && props.system ? sessionsStore.connectedCount(props.system.ref) : 0
);

const editing = ref(props.creating === true);
const busy = ref(false);
const error = ref("");
const notice = ref("");

/** サーバー設定に置くか。編集可能なときだけ選べる（既定は自分の設定） */
const source = ref<"server" | "personal">("personal");
/** チェック 1 つで表す（既定は自分の設定）。保存経路は従来どおり `source` を見る */
const isServerSource = computed({
  get: () => source.value === "server",
  set: (v: boolean) => {
    source.value = v ? "server" : "personal";
  }
});

// exactOptionalPropertyTypes 下では省略可能プロパティに undefined を代入できないため、
// フォームの型は「undefined を取りうる」ものとして別に定義する
type SysFormState = { [K in keyof SystemForm]: SystemForm[K] | undefined };
type SesFormState = { [K in keyof SessionConfigForm]: SessionConfigForm[K] | undefined };

const sysForm = reactive<SysFormState>({
  name: "",
  host: "",
  tls: true,
  ccsid: DEFAULT_CCSID,
  spoolCcsid: DEFAULT_SPOOL_CCSID
});
const sesForm = reactive<SesFormState>({
  name: "",
  system: "",
  sessionType: "display",
  terminal: "5250" as "5250" | "3270",
  model3270: 2 as 2 | 5,
  screenSize: DEFAULT_SCREEN_SIZE,
  deviceName: "",
  rescueAction: "hold" as "hold" | "delete",
  transformTo: "",
  // 既定は「切らない」（`20260802-config-form-polish` で「サーバー既定に従う」を廃止）
  idleTimeout: "never",
  autoStart: undefined,
  dtaqWatch: undefined
});

/**
 * 開いた直後（サービスならサーバー起動直後）に待ち受けを始めるか。
 *
 * **未設定＝始める。** 既定を「始めない」にすると、アップグレードで
 * 「開いても何も起きない」に変わってしまう（`20260801-service-lifecycle-model` design D3）。
 * ✅ のときは**キーごと書かない**——設定ファイルに既定値を書き散らさない。
 */
const autoStartOn = computed({
  get: () => sesForm.autoStart !== false,
  set: (v: boolean) => {
    sesForm.autoStart = v ? undefined : false;
  }
});

/**
 * 監視するキューの入力。**ネストしたオブジェクトへ直接 v-model しない**——
 * `sesForm.dtaqWatch` は未設定（undefined）から始まるので、
 * そのまま束ねるとキー入力の 1 文字目で例外になる。
 */
const watchLibrary = computed({
  get: () => sesForm.dtaqWatch?.library ?? "",
  set: (v: string) => {
    sesForm.dtaqWatch = { library: v, name: sesForm.dtaqWatch?.name ?? "", ...(sesForm.dtaqWatch?.encoding ? { encoding: sesForm.dtaqWatch.encoding } : {}) };
  }
});
const watchName = computed({
  get: () => sesForm.dtaqWatch?.name ?? "",
  set: (v: string) => {
    sesForm.dtaqWatch = { library: sesForm.dtaqWatch?.library ?? "", name: v, ...(sesForm.dtaqWatch?.encoding ? { encoding: sesForm.dtaqWatch.encoding } : {}) };
  }
});
const watchEncoding = computed({
  get: () => sesForm.dtaqWatch?.encoding ?? "utf8",
  set: (v: "utf8" | "base64" | "ebcdic") => {
    sesForm.dtaqWatch = { library: sesForm.dtaqWatch?.library ?? "", name: sesForm.dtaqWatch?.name ?? "", encoding: v };
  }
});

/**
 * 待ち受けるメッセージ待ち行列の入力。**理由は `watchLibrary` と同じ**
 * （未設定から始まるので、ネストへ直接束ねると 1 文字目で例外になる）。
 */
const msgWatchField = <K extends "library" | "name">(key: K) =>
  computed({
    get: () => sesForm.msgWatch?.[key] ?? "",
    set: (v: string) => {
      sesForm.msgWatch = { library: "", name: "", ...sesForm.msgWatch, [key]: v };
    }
  });
const msgLibrary = msgWatchField("library");
const msgName = msgWatchField("name");
const msgOnlyInquiry = computed({
  get: () => sesForm.msgWatch?.onlyInquiry === true,
  set: (v: boolean) => {
    sesForm.msgWatch = { library: "", name: "", ...sesForm.msgWatch, onlyInquiry: v };
  }
});
const msgIncludeExisting = computed({
  get: () => sesForm.msgWatch?.includeExisting === true,
  set: (v: boolean) => {
    sesForm.msgWatch = { library: "", name: "", ...sesForm.msgWatch, includeExisting: v };
  }
});

/** 「無操作で切る」の選択肢（分）。任意の数値を打たせるほどの要求ではないので選択式にする */
const IDLE_MINUTES = [5, 10, 15, 30, 60, 120, 240];
/**
 * 実際の選択肢。**設定ファイルに直接書かれた値（1〜1440 の任意）が一覧に無ければ足す。**
 * 足さないと select が空欄で描かれ、「設定されていない」ように見えてしまう
 * （値そのものは保持されるので、黙って消えるより分かりにくい）。
 */
const idleMinuteOptions = computed(() => {
  const v = sesForm.idleTimeout;
  const list = typeof v === "number" && !IDLE_MINUTES.includes(v) ? [...IDLE_MINUTES, v] : IDLE_MINUTES;
  return [...list].sort((a, b) => a - b);
});
/**
 * プリンターのサーバー側出力。**信頼設定**なのでサーバー設定のプリンターでのみ編集できる。
 *
 * `service` は「サービスとして常駐するか」＝**意図**であって、出力設定の有無から導出しない
 * （「開いている間だけ PDF に落とす」も「常駐して溜めるだけ」も表現できるように）。
 *
 * `rest` は**フォームが編集しない項目**（`pdfFontPath` / `pdfFontName`）。
 * 更新はオブジェクトごと置き換えなので、**読み込んで送り返さないと消える**。
 */
const printerForm = reactive({
  service: false,
  autoPdfDir: "",
  autoPrint: "",
  pageSize: "",
  fontSize: undefined as number | undefined,
  rest: {} as Record<string, unknown>
});
/**
 * PC コマンド（STRPCCMD）の実行設定。**信頼設定**なのでサーバー設定の表示セッションでのみ編集できる。
 * 値は編集できる相手にだけ返る（`includeTrusted`）ので、読み込んで送り返す。
 */
const pcForm = reactive({ enabled: false, timeoutSec: undefined as number | undefined, allow: "" });
/**
 * 待ち行列サービスの転送先。**信頼設定**（サーバーから外へ出ていくデータ経路）。
 *
 * `secret` は**返ってこない**（`hasSecret` だけ）。`system.password` と同じ約束で、
 * **空で送れば既存を保つ**——そうしないと名前を直して保存しただけで認証が外れる。
 */
const hookForm = reactive({
  url: "",
  secret: "",
  hasSecret: false,
  secretEnv: "",
  secretHeader: "",
  timeoutSec: undefined as number | undefined,
  maxAttempts: undefined as number | undefined
});
/**
 * ウォーターマーク（表示セッションのみ）。
 *
 * 保存値は `sesForm` に混ぜず**別の状態に開く**——濃さは保存が 0〜1・入力が % で単位が違い、
 * 色は「既定に従う」と「指定する」の 2 段階だからである。保存時に 1 つのオブジェクトへ畳む。
 */
const wmForm = reactive({
  enabled: false,
  text: "",
  opacityPct: Math.round(WATERMARK_DEFAULTS.opacity * 100),
  size: WATERMARK_DEFAULTS.size as number,
  layout: WATERMARK_DEFAULTS.layout as "tile" | "center",
  angle: WATERMARK_DEFAULTS.angle as number,
  /** false＝端末の前景色に追従（テーマ・スキンに合う）。true のときだけ color を送る */
  useColor: false,
  color: "#808080"
});
/** 透かしの文字に使える差し込み変数（`{host}` 等）の説明 */
const WM_VAR_HINT = WATERMARK_VARS.map((v) => `{${v.key}}=${v.label}`).join(" / ");

/**
 * 編集対象がサーバー設定か（信頼設定の欄を出す・保存先を選ぶ判定に使う）。
 *
 * セッションは**選んだ親システムと同じ側**にしか置けない（config-store のスコープ規定）。
 * 新規セッションには `props.session` がまだ無いので、`props.system?.ref ?? props.session?.ref`
 * では常に未定義に落ちて `source.value`（システム作成用の select。セッションには無い）を見てしまい、
 * 常に「自分の設定」を選んだのと同じ扱いになっていた——親がサーバー設定のシステムだと、
 * セッションは個人設定ファイルに追加されて `system ... not found` になる。
 * 新規作成中は `sesForm.system`（フォームで選んだ親システムの参照）で判定する。
 */
const isServer = computed(() => {
  if (props.kind === "system") {
    const r = props.system?.ref;
    return r ? r.startsWith("srv:") : source.value === "server";
  }
  const r = props.session?.ref ?? sesForm.system;
  return r?.startsWith("srv:") ?? false;
});
/**
 * この設定を編集できるか。**サーバー設定は編集権限があるときだけ**——
 * 押しても 403 になるボタンは出さない（認可の実体はサーバー側で、ここは体験のため）。
 */
const canEdit = computed(() => !isServer.value || systemsStore.editable);

/** printer 出力（信頼設定）を編集できるか。**サーバー設定のプリンターセッションかつ編集権限があるときだけ** */
const canEditPrinter = computed(
  () => props.kind === "session" && isServer.value && systemsStore.editable && sesForm.sessionType === "printer"
);
/**
 * 転送設定を編集できるか。**サーバー設定の待ち行列監視かつ編集権限があるときだけ**。
 * `canEditPrinter` と同じ形——**新しい認可条件を作らない**（散らすと食い違う）。
 */
const canEditWebhook = computed(
  () => props.kind === "session" && isServer.value && systemsStore.editable && sesForm.sessionType === "dtaqwatch"
);
/** PC コマンドは 5250 画面の標識で届くので、**表示セッションだけ**が持つ */
const canEditPcCommand = computed(
  () =>
    // **セッションカードだけ。** `sesForm.sessionType` は初期値が `display` なので、
    // システムカードでも真になり **PC コマンド欄がシステムに出ていた**（利用者の報告）。
    // PC コマンドは 5250 画面の標識で届くもので、システム（接続先）の設定ではない
    props.kind === "session" &&
    isServer.value &&
    systemsStore.editable &&
    sesForm.sessionType === "display"
);

function loadSystem(): void {
  const s = props.system;
  if (!s) return;
  sysForm.name = s.name;
  sysForm.host = s.host;
  sysForm.port = s.port;
  sysForm.tls = s.tls ?? false;
  sysForm.ccsid = s.ccsid ?? DEFAULT_CCSID;
  sysForm.spoolCcsid = s.spoolCcsid ?? DEFAULT_SPOOL_CCSID;
  sysForm.color = s.color; // 未設定のまま＝自動（ref から割り当てる）
  sysForm.autoSignon = s.autoSignon;
  sysForm.signonUser = s.signonUser ?? "";
  // パスワードは返らない。**空のまま送れば既存が保たれる**（サーバー側でそう扱う）
  sysForm.password = "";
}

function loadSession(): void {
  const s = props.session;
  if (!s) {
    sesForm.system = props.parentSystem ?? systemsStore.menuSystem ?? "";
    return;
  }
  loadWatermark(s.watermark);
  loadPcCommand(s.pcCommand);
  loadPrinter(s);
  loadWebhook(s);
  sesForm.name = s.name;
  sesForm.autoStart = s.autoStart;
  sesForm.system = s.system;
  sesForm.sessionType = s.sessionType;
  sesForm.terminal = s.terminal ?? "5250";
  sesForm.model3270 = s.model3270 ?? 2;
  sesForm.deviceName = s.deviceName ?? "";
  sesForm.rescueAction = s.rescueAction ?? "hold";
  sesForm.transformTo = s.transformTo ?? "";
  sesForm.screenSize = s.screenSize ?? DEFAULT_SCREEN_SIZE;
  sesForm.ccsid = s.ccsid;
  sesForm.enhanced = s.enhanced;
  // **「サーバー既定に従う」は選べなくした**（`20260802-config-form-polish`）。
  // 未設定の定義（手書きの profiles.json など）は「切らない」として開く
  // ——出荷時のサーバー既定が「切らない」なので、開いた時点の意味は変わらない
  sesForm.idleTimeout = s.idleTimeout ?? "never";
  // 監視の設定はオブジェクトごと置き換わるので、**編集しなくても読み込んで送り返す**
  sesForm.dtaqWatch = s.dtaqWatch ? { ...s.dtaqWatch } : undefined;
}

/**
 * PC コマンドの保存値をフォームへ開く。**必ず開く**——更新はオブジェクトごと置き換えなので、
 * 読み込まずに保存すると許可パターンが黙って消える（＝設定が緩くなる）。
 * 編集できない相手には値が返らない（サーバーが `includeTrusted` で絞る）ので、その場合は空のまま。
 */
function loadPcCommand(pc: PublicSession["pcCommand"]): void {
  pcForm.enabled = pc?.enabled === true;
  pcForm.timeoutSec = pc?.timeoutMs !== undefined ? Math.round(pc.timeoutMs / 1000) : undefined;
  pcForm.allow = (pc?.allow ?? []).join("\n");
}

/**
 * プリンターの出力設定をフォームへ開く。**必ず開く**——更新はオブジェクトごと置き換えなので、
 * 読み込まずに保存すると **PDF 保存先も自動印刷先も黙って消える**（名前を直しただけで消えていた）。
 *
 * 値が返るのは編集できる相手だけ（サーバーが `includeTrusted` で絞る）。返らない場合は
 * `service` / `hasOutput` のフラグしか無いので、そもそも保存フォームを出さない
 * （`canEditPrinter` が false）。
 */
/**
 * 転送設定をフォームへ開く。**秘密は空のまま**（返ってこない）。
 * 「設定済み」の表示だけ出し、空で保存すれば据え置きになる。
 */
function loadWebhook(s: PublicSession): void {
  const w = s.webhook;
  hookForm.url = w?.url ?? "";
  hookForm.secret = "";
  hookForm.hasSecret = w?.hasSecret === true;
  hookForm.secretEnv = w?.secretEnv ?? "";
  hookForm.secretHeader = w?.secretHeader ?? "";
  hookForm.timeoutSec = w?.timeoutMs !== undefined ? Math.round(w.timeoutMs / 1000) : undefined;
  hookForm.maxAttempts = w?.maxAttempts;
}

function loadPrinter(s: PublicSession): void {
  const p = s.printer;
  // フラグは誰にでも返る。値が返らない相手でも ✅ の現状だけは正しく描ける
  printerForm.service = (p?.service ?? s.service) === true;
  printerForm.autoPdfDir = p?.autoPdfDir ?? "";
  printerForm.autoPrint = p?.autoPrint ?? "";
  printerForm.pageSize = p?.pageSize ?? "";
  printerForm.fontSize = p?.fontSize;
  // 編集欄を持たない項目（フォント指定）。**そのまま送り返す**ために取っておく
  const { service: _s, autoPdfDir: _d, autoPrint: _p, pageSize: _g, fontSize: _f, ...rest } = p ?? {};
  printerForm.rest = rest;
}

/** 保存値をフォームへ開く（未設定なら既定のまま＝文字が空＝透かしなし） */
function loadWatermark(wm: PublicSession["watermark"]): void {
  // 設定があれば既定は表示。`enabled: false` は「文字を残したまま切ってある」状態
  wmForm.enabled = wm !== undefined && wm.enabled !== false;
  wmForm.text = wm?.text ?? "";
  wmForm.opacityPct = Math.round((wm?.opacity ?? WATERMARK_DEFAULTS.opacity) * 100);
  wmForm.size = wm?.size ?? WATERMARK_DEFAULTS.size;
  wmForm.layout = wm?.layout ?? WATERMARK_DEFAULTS.layout;
  wmForm.angle = wm?.angle ?? WATERMARK_DEFAULTS.angle;
  wmForm.useColor = wm?.color !== undefined;
  wmForm.color = wm?.color ?? "#808080";
}

/** 数値入力を範囲に収める（空欄にすると NaN が入るので、そのときは既定へ戻す） */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * フォームを保存値へ畳む。**文字が空なら設定ごと無し**にする——
 * 文字の無い透かしは描きようがなく、既定値だけの残骸を設定ファイルに残さないため。
 */
function buildWatermark(): SessionConfigForm["watermark"] {
  const text = wmForm.text.trim();
  if (!text) return undefined;
  const wm: NonNullable<SessionConfigForm["watermark"]> = {
    text,
    opacity: clamp(wmForm.opacityPct, 2, 100, 12) / 100,
    size: clamp(wmForm.size, 8, 200, WATERMARK_DEFAULTS.size),
    layout: wmForm.layout,
    angle: clamp(wmForm.angle, -90, 90, WATERMARK_DEFAULTS.angle)
  };
  // 既定（表示する）は書かない。切ってあるときだけ明示する
  if (!wmForm.enabled) wm.enabled = false;
  if (wmForm.useColor) wm.color = wmForm.color;
  return wm;
}

watch(
  () => [props.system, props.session, editing.value],
  () => {
    if (!editing.value) return;
    if (props.kind === "system") loadSystem();
    else loadSession();
  },
  { immediate: true }
);

function startEdit(): void {
  error.value = "";
  notice.value = "";
  editing.value = true;
}

function cancel(): void {
  editing.value = false;
  error.value = "";
  if (props.creating) emit("cancel");
}

function validate(): string | undefined {
  if (props.kind === "system") {
    if (!sysForm.name?.trim()) return "名前を入力してください";
    if (!sysForm.host?.trim()) return "ホストを入力してください";
    if (sysForm.port !== undefined && (sysForm.port < 1 || sysForm.port > 65535)) {
      return "ポートは 1〜65535 の範囲で指定してください";
    }
    if (sysForm.autoSignon && !sysForm.signonUser?.trim()) {
      return "自動サインオンにはユーザー名が必要です";
    }
    return undefined;
  }
  if (!sesForm.name?.trim()) return "名前を入力してください";
  if (!sesForm.system) return "システムを選んでください";
  return undefined;
}

async function save(): Promise<void> {
  const invalid = validate();
  if (invalid) {
    error.value = invalid;
    return;
  }
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    if (props.kind === "system") {
      const form = { ...sysForm, name: sysForm.name!.trim(), host: sysForm.host!.trim() } as SystemForm;
      if (!form.autoSignon) {
        // 明示オフ。サーバーは autoSignon:false を「解除」として扱う
        form.autoSignon = false;
        delete form.signonUser;
        delete form.password;
      } else if (!form.password) {
        // 空なら送らない＝既存のパスワードを保つ
        delete form.password;
      }
      if (props.creating) {
        form.source = source.value;
        await systemsStore.createSystem(form);
      } else {
        await systemsStore.updateSystem(props.system!.ref, form);
      }
    } else {
      const form = { ...sesForm, name: sesForm.name!.trim() } as SessionConfigForm;
      // transformTo は printer 専用。空文字だとサーバーの min(1) で 400 になるので、
      // sessionType によらず「空なら送らない」を常に通す（display の既定 "" 対策）
      const tt = (sesForm.transformTo ?? "").trim();
      if (tt) form.transformTo = tt;
      else delete form.transformTo;
      // **既定（5250）は保存しない**——設定ファイルに既定値を書き散らさない。
      // 3270 のときは画面サイズ（5250 の語彙）を送らず、代わりにモデルを送る
      if (sesForm.terminal === "3270") {
        form.terminal = "3270";
        form.model3270 = sesForm.model3270 ?? 2;
        delete form.screenSize;
        delete form.enhanced;
      } else {
        delete form.terminal;
        delete form.model3270;
      }
      // `idleTimeout` は常に明示値（「切らない」or 分）。**選択肢から「サーバー既定に従う」を
      // 外した**ので、画面から保存した定義は必ず自分の値を持つ
      // （`--idle-timeout` は、手書きで未指定のままの定義にだけ効く）
      // **種別と監視設定の整合を揃える。** サーバーは parse で弾くので、
      // 揃えないと「保存できません」だけが返って理由が分からない
      if (form.sessionType === "dtaqwatch") {
        const w = sesForm.dtaqWatch;
        form.dtaqWatch = {
          library: (w?.library ?? "").trim().toUpperCase(),
          name: (w?.name ?? "").trim().toUpperCase(),
          ...(w?.encoding ? { encoding: w.encoding } : {})
        };
        delete form.screenSize;
        delete form.enhanced;
        delete form.watermark;
        delete form.rescueAction;
        delete form.transformTo;
      } else if (form.sessionType === "msgwatch") {
        const w = sesForm.msgWatch;
        form.msgWatch = {
          library: (w?.library ?? "").trim().toUpperCase(),
          name: (w?.name ?? "").trim().toUpperCase(),
          ...(w?.onlyInquiry ? { onlyInquiry: true } : {}),
          ...(w?.includeExisting ? { includeExisting: true } : {})
        };
        delete form.dtaqWatch;
        delete form.screenSize;
        delete form.enhanced;
        delete form.watermark;
        delete form.rescueAction;
        delete form.transformTo;
      } else {
        delete form.msgWatch;
        delete form.dtaqWatch;
      }
      if (form.sessionType === "printer") {
        // 既定（保留）はわざわざ保存しない——設定ファイルに既定値を書き散らさない
        if (sesForm.rescueAction === "delete") form.rescueAction = "delete";
        delete form.screenSize;
        delete form.enhanced;
        delete form.watermark; // 透かしは画面のもの。プリンターには持たせない
        // 端末の種類は display のもの
        delete form.terminal;
        delete form.model3270;
      } else {
        // display は printer 専用項目を送らない
        delete form.rescueAction;
        // **表示セッションに「自動で待ち受け開始」は無い**（画面なので常に開く）。
        // 種別を変えたときに古い値が残らないよう、ここで落とす
        if (form.sessionType === "display") delete form.autoStart;
        // 更新はオブジェクトごと置き換えなので、**編集していなくても送り返す**（省略＝削除になる）
        const wm = buildWatermark();
        if (wm) form.watermark = wm;
        else delete form.watermark;
      }
      if (canEditPcCommand.value) {
        const allow = pcForm.allow
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        // 無効かつ既定のままなら書かない（設定ファイルに既定値を書き散らさない）
        if (pcForm.enabled || allow.length > 0 || pcForm.timeoutSec !== undefined) {
          const pc: NonNullable<SessionConfigForm["pcCommand"]> = { enabled: pcForm.enabled };
          if (pcForm.timeoutSec !== undefined) pc.timeoutMs = Math.round(pcForm.timeoutSec * 1000);
          if (allow.length > 0) pc.allow = allow;
          form.pcCommand = pc;
        }
      }
      if (canEditWebhook.value) {
        const url = hookForm.url.trim();
        if (url) {
          const w: NonNullable<SessionConfigForm["webhook"]> = { url };
          // **平文は「入力したときだけ」送る。** 空なら送らない＝既存を保つ
          if (hookForm.secret) w.secret = hookForm.secret;
          if (hookForm.secretEnv.trim()) w.secretEnv = hookForm.secretEnv.trim();
          if (hookForm.secretHeader.trim()) w.secretHeader = hookForm.secretHeader.trim();
          if (hookForm.timeoutSec !== undefined) w.timeoutMs = Math.round(hookForm.timeoutSec * 1000);
          if (hookForm.maxAttempts !== undefined) w.maxAttempts = hookForm.maxAttempts;
          form.webhook = w;
        }
        // URL が空＝転送しない。**キーごと送らない**（更新は置き換えなので消える）
      }
      if (canEditPrinter.value) {
        // **編集しない項目も送り返す**（フォント指定など）。更新はオブジェクトごと置き換えなので、
        // 落とすと消える
        const p = { ...printerForm.rest } as NonNullable<SessionConfigForm["printer"]>;
        // 既定（サービスでない）はわざわざ書かない——設定ファイルに既定値を書き散らさない
        if (printerForm.service) p.service = true;
        if (printerForm.autoPdfDir.trim()) p.autoPdfDir = printerForm.autoPdfDir.trim();
        if (printerForm.autoPrint.trim()) p.autoPrint = printerForm.autoPrint.trim();
        if (printerForm.pageSize.trim()) p.pageSize = printerForm.pageSize.trim();
        if (printerForm.fontSize !== undefined) p.fontSize = printerForm.fontSize;
        if (Object.keys(p).length > 0) form.printer = p;
      }
      if (props.creating) {
        form.source = isServer.value ? "server" : "personal";
        const created = await systemsStore.createSession(form);
        notice.value = `${created.name} を作成しました`;
      } else {
        await systemsStore.updateSession(props.session!.ref, form);
      }
    }
    // 新規作成のカードは表示用の実体（system / session）を持たない。
    // ここで編集を閉じると「実体なしの表示」を一瞬描いて落ちるため、閉じるのは親に任せる
    if (!props.creating) editing.value = false;
    emit("done");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  const name = props.system?.name ?? props.session?.name ?? "";
  if (!globalThis.confirm(`${name} を削除しますか？`)) return;
  busy.value = true;
  error.value = "";
  try {
    if (props.kind === "system") await systemsStore.removeSystem(props.system!.ref);
    else await systemsStore.removeSession(props.session!.ref);
    emit("done");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** セッション種別のアイコンと表記。旧 UI にあった見分けを引き継ぐ */
const typeIcon = computed(() =>
  props.session?.sessionType === "printer"
    ? "🖨"
    : props.session?.sessionType === "dtaqwatch"
      ? "👁"
      : props.session?.sessionType === "msgwatch"
        ? "🔔"
        : "🖥"
);
/**
 * 一覧の札。**画面のセッションは端末の種類まで出す**——
 * `sessionType` は「何をするか」しか言わないので、`display` を一律 `5250 端末` と
 * 呼ぶと 3270 のセッションが 5250 に見える。一覧はここでしか見分けられない。
 */
const typeLabel = computed(() =>
  props.session?.sessionType === "printer"
    ? "プリンター"
    : props.session?.sessionType === "dtaqwatch"
      ? "待ち行列監視"
      : props.session?.sessionType === "msgwatch"
        ? "メッセージ待ち受け"
        : props.session?.terminal === "3270"
          ? "3270 端末"
          : "5250 端末"
);

/** 詳細（ⓘ）の開閉。旧 UI にあった接続設定の詳細表示を引き継ぐ */
const showInfo = ref(false);

/**
 * 詳細の行。**セッションは親システムの接続情報も併せて出す**——
 * 分離したことで「このセッションがどこへ繋ぐか」が 1 枚のカードからは読めなくなったため、
 * ここで辿って見せる。
 */
const infoRows = computed(() => {
  const rows: { label: string; value: string }[] = [];
  if (props.kind === "system") {
    const o = props.system;
    if (!o) return rows;
    rows.push({ label: "名称", value: o.name });
    rows.push({ label: "区分", value: o.ref.startsWith("srv:") ? "サーバー設定" : "自分の設定" });
    rows.push({ label: "ホスト", value: `${o.host}${o.port ? ":" + o.port : ""}` });
    if (o.tls) rows.push({ label: "TLS", value: "有効" });
    if (o.ccsid !== undefined) rows.push({ label: "既定 CCSID", value: String(o.ccsid) });
    rows.push({
      label: "自動サインオン",
      value: o.autoSignon ? (o.signonUser ? `有効（${o.signonUser}）` : "有効") : "無効"
    });
    rows.push({ label: "セッション設定", value: `${systemsStore.sessionCount(o.ref)} 件` });
    return rows;
  }
  const o = props.session;
  if (!o) return rows;
  const parent = systemsStore.systems.find((x) => x.ref === o.system);
  rows.push({ label: "名称", value: o.name });
  rows.push({ label: "区分", value: o.ref.startsWith("srv:") ? "サーバー設定" : "自分の設定" });
  rows.push({
    label: "種別",
    value:
      o.sessionType === "printer"
        ? "プリンター"
        : o.sessionType === "dtaqwatch"
          ? "待ち行列監視"
          : o.sessionType === "msgwatch"
            ? "メッセージ待ち受け"
            : "5250 端末"
  });
  if (o.dtaqWatch) {
    rows.push({ label: "監視するキュー", value: `${o.dtaqWatch.library}/${o.dtaqWatch.name}` });
    rows.push({ label: "符号化", value: o.dtaqWatch.encoding ?? "utf8" });
  }
  if (o.msgWatch) {
    rows.push({ label: "待ち受ける待ち行列", value: `${o.msgWatch.library}/${o.msgWatch.name}` });
    rows.push({ label: "拾う範囲", value: o.msgWatch.onlyInquiry ? "応答待ちだけ" : "すべて" });
    rows.push({ label: "始める位置", value: o.msgWatch.includeExisting ? "既にあるぶんも" : "始めた後のぶんだけ" });
  }
  rows.push({ label: "システム", value: parent?.name ?? o.system });
  // 接続先と資格情報はシステム側が持つ。辿った結果をここに出す
  if (parent) {
    rows.push({ label: "ホスト", value: `${parent.host}${parent.port ? ":" + parent.port : ""}` });
    if (parent.tls) rows.push({ label: "TLS", value: "有効" });
    rows.push({
      label: "自動サインオン",
      value: parent.autoSignon ? (parent.signonUser ? `有効（${parent.signonUser}）` : "有効") : "無効"
    });
  }
  if (o.deviceName) rows.push({ label: "デバイス名", value: o.deviceName });
  // 待ち受けの始め方。**プリンターと待ち行列で同じ**なので同じ行に出す
  if (o.sessionType !== "display") {
    rows.push({
      label: "待ち受けの開始",
      value: o.autoStart === false ? "手動（開始ボタンで始める）" : "自動（開いたら始める）"
    });
  }
  if (o.sessionType === "printer") {
    rows.push({
      label: "サービス",
      // **出力設定の有無からは導出しない**（意図と能力は別の軸）
      value: o.service ? "サーバーに常駐する" : "常駐しない（開いている間だけ）"
    });
    rows.push({ label: "取得後の扱い", value: o.rescueAction === "delete" ? "削除する" : "保留にして残す" });
    rows.push({
      label: "印刷の経路",
      value: o.transformTo ? `ホスト変換 ${o.transformTo}（表示不可）` : "画面で見る（表示・PDF 可）"
    });
  }
  if (o.screenSize) rows.push({ label: "画面サイズ", value: o.screenSize });
  if (o.watermark) {
    const wm = o.watermark;
    const off = wm.enabled === false ? "（非表示）" : "";
    rows.push({ label: "ウォーターマーク", value: `${wm.text}${off}` });
  }
  rows.push({
    label: "CCSID",
    value: o.ccsid !== undefined ? String(o.ccsid) : `システムの既定${parent?.ccsid ? `（${parent.ccsid}）` : ""}`
  });
  // 未設定のときは行を出さない——サーバー側の既定（`--idle-timeout`）はブラウザから見えないので、
  // ここで「切らない」と書くと嘘になりうる
  if (o.idleTimeout !== undefined) {
    rows.push({
      label: "無操作で切る",
      value: o.idleTimeout === "never" ? "切らない" : `${o.idleTimeout} 分`
    });
  }
  return rows;
});
</script>

<template>
  <div class="card" :class="{ editing, current: selected && !editing, dense: dense && !editing }">
    <!-- 表示 -->
    <template v-if="!editing">
      <div class="nm">
        <span v-if="kind === 'session'" class="ticon" :title="typeLabel" aria-hidden="true">{{ typeIcon }}</span>
        {{ kind === "system" ? system?.name : session?.name }}
        <span v-if="kind === 'system' && system?.ref.startsWith('srv:')" class="chip">サーバー設定</span>
        <span v-if="kind === 'session'" class="chip type">{{ typeLabel }}</span>
      </div>
      <div v-if="kind === 'system'" class="meta">
        {{ system?.host }}<span v-if="system?.port">:{{ system.port }}</span>
        <span v-if="system?.tls"> TLS</span><br />
        {{ system?.autoSignon ? (system.signonUser ?? "自動サインオン") : "サインオンなし" }}
        <span v-if="system?.ccsid"> ccsid {{ system.ccsid }}</span>
      </div>
      <div v-else class="meta">
        <!-- 3270 は `screenSize` を持たない（モデルで決まる）ので、そのままだと空欄になる -->
        <span v-if="session?.terminal === '3270'">モデル {{ session?.model3270 ?? 2 }}</span>
        <span v-else-if="session?.screenSize">{{ session.screenSize }}</span
        ><br />
        {{ session?.deviceName || "装置名なし" }}
        <span v-if="session?.ccsid"> ccsid {{ session.ccsid }}</span>
      </div>
      <div class="foot">
        <div class="actions">
          <button v-if="kind === 'system'" class="btn" @click="emit('select', system!.ref)">
            {{ selected ? "メニューへ" : "選択" }}
          </button>
          <button v-else class="btn" :disabled="connecting" @click="emit('open', session!.ref)">
            <span v-if="connecting" class="dot" aria-hidden="true"></span>{{
              connecting ? "接続中…" : opened ? "開く" : "接続"
            }}
          </button>
          <button
            v-if="kind === 'session' && opened && !connecting"
            class="btn ghost"
            title="この設定でもう 1 本セッションを開く"
            @click="emit('openNew', session!.ref)"
          >
            ＋新規
          </button>
          <button v-if="canEdit" class="btn ghost" @click="startEdit">編集</button>
          <button class="info" title="詳細" @click.stop="showInfo = !showInfo">ⓘ</button>
          <InfoPopover v-if="showInfo" :rows="infoRows" @close="showInfo = false" />
        </div>
        <span v-if="kind === 'system'" class="count" title="このシステムのセッション設定と接続中の数">
          セッション {{ systemsStore.sessionCount(system!.ref) }}
          <span v-if="connectedCount > 0" class="live" title="接続中のセッション数"
            >接続 {{ connectedCount }}</span
          >
        </span>
      </div>
    </template>

    <!-- その場編集 -->
    <template v-else>
      <div class="nm">{{ kind === "system" ? "システム" : "セッション" }}{{ creating ? "を追加" : "を編集" }}</div>

      <div v-if="kind === 'system'" class="fgrid">
        <!--
          **見出しはその設定の名前そのもの**（`サーバー設定`）。カードのチップも ⓘ の詳細も
          同じ語を使っているので、ここだけ別の言い方（旧「保管場所」）にすると
          **同じものが 2 つあるように見える**。チェックの隣に言い直しも置かない
          ——見出しが名前を、チェックが入り切りを、補足が意味を担う。

          **「全員が使える」ではない。** サーバー設定は `assertProfileAccess` により
          **読むのも管理者だけ**。一般利用者に見えるのは「サービスが動いているか」だけ
          （`ServiceDef`。`20260801-services-pane`）。
        -->
        <label v-if="creating && systemsStore.editable" class="row full">
          <span class="cap">サーバー設定</span>
          <span class="tv"><input v-model="isServerSource" type="checkbox" /></span>
          <span class="hint">
            管理者だけが参照・編集できる共有の設定です。<strong>サービス（常駐）にできるのはこちらだけ</strong>
            ——プリンターの自動出力・待ち行列の転送も、サーバー設定のセッションにしか置けません。
          </span>
        </label>
        <label class="row"><span class="cap">名前</span><input v-model="sysForm.name" /></label>
        <label class="row"><span class="cap">ホスト</span><input v-model="sysForm.host" /></label>
        <label class="row"
          ><span class="cap">ポート</span><input v-model.number="sysForm.port" type="number" placeholder="既定"
        /></label>
        <label class="row"
          ><span class="cap">TLS</span><input v-model="sysForm.tls" type="checkbox" />
          <span class="hint">証明書を検証して接続</span></label
        >
        <label class="row">
          <span class="cap">既定 CCSID</span>
          <select v-model.number="sysForm.ccsid">
            <option v-for="p in HOST_CODE_PAGES" :key="p.ccsid" :value="p.ccsid">{{ p.label }}</option>
          </select>
        </label>
        <label class="row">
          <span class="cap">スプール CCSID</span>
          <select v-model.number="sysForm.spoolCcsid">
            <option v-for="p in HOST_CODE_PAGES" :key="p.ccsid" :value="p.ccsid">{{ p.label }}</option>
          </select>
          <span class="hint">スプールの SCS 用。上の 5250 画面用とは別</span>
        </label>
        <!--
          **システムカラー**（`20260802-tabs-own-system`）。異なるシステムのタブを
          並べたときの見分けに使う。持つのは**パレットの番号**だけで、色の実体は
          テーマ側（`--sys-*`）にある——設定に生の色を書くと、テーマを変えるたびに
          設定を直して回ることになる。
          **未設定は「自動」**（システム ref から決定的に割り当て）。登録しただけで区別が付く。
        -->
        <div class="row">
          <span class="cap">タブの色</span>
          <span class="swatches" role="radiogroup" aria-label="タブの色">
            <button
              type="button"
              class="swatch-btn auto"
              role="radio"
              :aria-checked="sysForm.color === undefined"
              :class="{ on: sysForm.color === undefined }"
              title="自動（名前から決める）"
              @click="sysForm.color = undefined"
            >
              自動
            </button>
            <button
              v-for="n in SYSTEM_COLOR_COUNT"
              :key="n"
              type="button"
              class="swatch-btn"
              role="radio"
              :aria-checked="sysForm.color === n"
              :class="{ on: sysForm.color === n }"
              :style="{ background: systemColorVar(n) }"
              :title="`色 ${n}`"
              :aria-label="`色 ${n}`"
              @click="sysForm.color = n"
            ></button>
          </span>
          <span class="hint">タブ・ヘッダー・メニューでの見分けに使います</span>
        </div>
        <label class="row"
          ><span class="cap">自動サインオン</span><input v-model="sysForm.autoSignon" type="checkbox"
        /></label>
        <template v-if="sysForm.autoSignon">
          <label class="row"><span class="cap">ユーザー</span><input v-model="sysForm.signonUser" /></label>
          <label class="row">
            <span class="cap">パスワード</span>
            <input v-model="sysForm.password" type="password" :placeholder="system?.autoSignon ? '変更しない' : ''" />
          </label>
        </template>
      </div>

      <div v-else class="fgrid">
        <label class="row">
          <span class="cap">システム</span>
          <select v-model="sesForm.system">
            <option v-for="s in systemsStore.systems" :key="s.ref" :value="s.ref">{{ s.name }}</option>
          </select>
        </label>
        <label class="row"><span class="cap">名前</span><input v-model="sesForm.name" /></label>
        <!--
          **「種類」と「端末の種類」は軸が違う**（`config-types.ts` の注記）。
          種類はセッションが何をするか（画面／プリンター／監視）、端末の種類はどの端末か。
          だから種類の選択肢に 5250 と書かない——書くと「5250 表示なのに 3270」になる。
          決めるものと決まるものを離さないため、端末の種類はすぐ隣に置く
          （この下の 画面サイズ／モデル が端末の種類で入れ替わる）。
        -->
        <label class="row">
          <span class="cap">種類</span>
          <select v-model="sesForm.sessionType" :disabled="!creating">
            <option value="display">表示（画面）</option>
            <option value="printer">プリンター</option>
            <option value="dtaqwatch">待ち行列監視</option>
            <option value="msgwatch">メッセージ待ち受け</option>
          </select>
        </label>
        <label v-if="sesForm.sessionType === 'display'" class="row">
          <span class="cap">端末の種類</span>
          <select v-model="sesForm.terminal">
            <option value="5250">5250（IBM i）</option>
            <option value="3270">3270（メインフレーム）</option>
          </select>
        </label>
        <label class="row"><span class="cap">装置名</span><input v-model="sesForm.deviceName" /></label>
        <label v-if="sesForm.sessionType === 'printer'" class="row">
          <span class="cap" title="ホストに印刷データへ変換させると、書式そのままで実プリンターへ流せます。代わりに画面表示と PDF は使えません">
            印刷の経路
          </span>
          <select v-model="sesForm.transformTo">
            <option value="">画面で見る（表示・PDF が使える）</option>
            <option value="*HP4">ホスト変換 *HP4（本来の印刷・表示不可）</option>
            <option value="*HP5">ホスト変換 *HP5（本来の印刷・表示不可）</option>
            <option value="*IBM4019">ホスト変換 *IBM4019（本来の印刷・表示不可）</option>
          </select>
        </label>
        <label v-if="sesForm.sessionType === 'printer'" class="row">
          <span class="cap" title="書き出しプログラムが処理できない帳票を取得したあと、ホスト側のスプールをどうするか">
            取得後の扱い
          </span>
          <select v-model="sesForm.rescueAction">
            <option value="hold">保留にして残す（既定）</option>
            <option value="delete">削除する</option>
          </select>
        </label>
        <!--
          待ち行列監視。**消費することを設定の場でも言う**——本番キューに掛けると業務が壊れる
          （requirement の明示要求。監視コンソールでも常時出す）
        -->
        <template v-if="sesForm.sessionType === 'dtaqwatch'">
          <label class="row">
            <span class="cap">ライブラリー</span>
            <input v-model="watchLibrary" maxlength="10" placeholder="MYLIB" />
          </label>
          <label class="row">
            <span class="cap">キュー名</span>
            <input v-model="watchName" maxlength="10" placeholder="ORDERQ" />
          </label>
          <label class="row">
            <span class="cap" title="本文の解釈。ebcdic はシステム CCSID のキュー">符号化</span>
            <select v-model="watchEncoding">
              <option value="utf8">utf8（テキスト）</option>
              <option value="ebcdic">ebcdic（システム CCSID）</option>
              <option value="base64">base64（バイナリ）</option>
            </select>
          </label>
          <p class="row full watchwarn">⚠ {{ MSG_WATCH_CONSUMES }}</p>
        </template>
        <!--
          メッセージ待ち受け。**消費しないので注意書きは出さない**——
          `*SAME` で読むのでメッセージは待ち行列に残り、照会には後から応答できる。
        -->
        <template v-if="sesForm.sessionType === 'msgwatch'">
          <label class="row">
            <span class="cap">ライブラリー</span>
            <input v-model="msgLibrary" maxlength="10" placeholder="QSYS" />
          </label>
          <label class="row">
            <span class="cap">待ち行列名</span>
            <input v-model="msgName" maxlength="10" placeholder="QSYSOPR" />
          </label>
          <label class="row">
            <span class="cap" title="応答しないとジョブが止まったままになるものだけを拾います">
              応答待ちだけ
            </span>
            <span class="tv"><input v-model="msgOnlyInquiry" type="checkbox" /></span>
          </label>
          <label class="row">
            <span
              class="cap"
              title="入れると、始める前から溜まっているものも流します。QSYSOPR では数百件が一度に届くことがあります"
            >
              既にあるぶんも
            </span>
            <span class="tv"><input v-model="msgIncludeExisting" type="checkbox" /></span>
          </label>
        </template>
        <!--
          待ち受けを自動で始めるか。**プリンターと待ち行列で同じ設定**（利用者の要望どおり）。
          表示セッションには無い——画面なので開いたら常に繋ぐ。
        -->
        <label v-if="sesForm.sessionType !== 'display'" class="row">
          <span
            class="cap"
            title="外すと、開いてもすぐには待ち受けません。開始ボタンを押すまで待ちます（サービスならサーバー起動時も同じ）"
          >
            自動起動
          </span>
          <span class="tv">
            <input v-model="autoStartOn" type="checkbox" />
            開いたら開始
          </span>
        </label>
        <label v-if="sesForm.sessionType === 'display' && sesForm.terminal !== '3270'" class="row">
          <span class="cap">画面サイズ</span>
          <select v-model="sesForm.screenSize">
            <option v-for="s in SCREEN_SIZES" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </label>
        <label v-if="sesForm.sessionType === 'display' && sesForm.terminal === '3270'" class="row">
          <span class="cap">モデル</span>
          <select v-model.number="sesForm.model3270">
            <option :value="2">2（24x80）</option>
            <option :value="5">5（27x132）</option>
          </select>
        </label>
        <label class="row">
          <span class="cap">CCSID</span>
          <select v-model.number="sesForm.ccsid">
            <option :value="undefined">システムの既定</option>
            <option v-for="p in HOST_CODE_PAGES" :key="p.ccsid" :value="p.ccsid">{{ p.label }}</option>
          </select>
        </label>
        <!--
          無操作で切るまでの時間。**「サーバー既定に従う」と「切らない」を別の選択肢にする**——
          既定は切らないが、運用者が --idle-timeout で有限に変えている場合があり、
          「既定のまま」と「このセッションは切らない」は違う意思表示になる。
        -->
        <label class="row">
          <span class="cap" title="この時間だけ何も操作しなければセッションを閉じます。入力中・カーソル移動中は操作として数えます">
            無操作で切る
          </span>
          <select v-model="sesForm.idleTimeout">
            <option value="never">切らない</option>
            <option v-for="m in idleMinuteOptions" :key="m" :value="m">{{ m }} 分</option>
          </select>
        </label>
      </div>

      <!--
        ウォーターマーク（表示セッションのみ）。文字を入れて初めて設定になるので、
        文字を先頭に置き、細かい見え方は文字があるときだけ出す。
      -->
      <div v-if="kind === 'session' && sesForm.sessionType === 'display'" class="wmsec">
        <div class="wmlabel">ウォーターマーク（画面に重ねる透かし）</div>
        <div class="fgrid">
          <!-- 文字が設定の本体。長い説明を折り返さずに置くため 1 行を全幅で使う -->
          <label class="row full">
            <span class="cap">文字</span>
            <input v-model="wmForm.text" placeholder="例: 本番 {system}" />
            <span class="hint">空欄なら透かしを出しません。差し込み変数: {{ WM_VAR_HINT }}</span>
          </label>
          <template v-if="wmForm.text.trim()">
            <label class="row">
              <span class="cap">表示</span>
              <input v-model="wmForm.enabled" type="checkbox" />
              <span class="hint">文字を残したまま切れます</span>
            </label>
            <label class="row">
              <span class="cap">配置</span>
              <select v-model="wmForm.layout">
                <option value="tile">並べる（画面全体）</option>
                <option value="center">中央に 1 つ</option>
              </select>
            </label>
            <!-- 単位はラベルに入れる（説明行を足すと欄ごとに 1 行ずつ縦に伸びるため） -->
            <label class="row">
              <span class="cap">濃さ（%）</span>
              <input v-model.number="wmForm.opacityPct" type="number" min="2" max="100" step="1" />
            </label>
            <label class="row">
              <span class="cap">大きさ（px）</span>
              <input v-model.number="wmForm.size" type="number" min="8" max="200" step="1" />
            </label>
            <label class="row">
              <span class="cap">角度（度）</span>
              <input v-model.number="wmForm.angle" type="number" min="-90" max="90" step="5" />
            </label>
            <label class="row">
              <span class="cap">色</span>
              <span class="colorpick">
                <select v-model="wmForm.useColor">
                  <option :value="false">画面の文字色に合わせる</option>
                  <option :value="true">指定する</option>
                </select>
                <input v-if="wmForm.useColor" v-model="wmForm.color" type="color" aria-label="透かしの色" />
              </span>
            </label>
          </template>
        </div>
      </div>

      <!--
        信頼設定。サーバー設定の表示セッションで、編集権限があるときだけ。
        **サーバー機での任意コマンド実行**なので、既定は無効で、危険性を画面にも書く
      -->
      <div v-if="canEditPcCommand" class="trusted">
        <div class="tlabel">PC コマンド（STRPCCMD・信頼設定）</div>
        <label class="row"
          ><span class="cap">実行を許可</span
          ><span class="tv"><input v-model="pcForm.enabled" type="checkbox" /> ホストからのコマンドを実行する</span>
        </label>
        <label class="row"
          ><span class="cap">待ち時間上限</span
          ><input v-model.number="pcForm.timeoutSec" type="number" min="1" placeholder="60（秒）"
        /></label>
        <label class="row top"
          ><span class="cap">許可パターン</span
          ><textarea v-model="pcForm.allow" rows="3" placeholder="正規表現を 1 行 1 件（全体一致）。空なら制限なし"></textarea>
        </label>
        <p class="warn">
          コマンドはこのサーバーが動いている機械で実行されます（自分の PC で起動していればその PC、
          サーバー運用ならサーバー機）
        </p>
      </div>

      <!--
        待ち行列サービスの転送先。**信頼設定**——サーバーから外へ出ていくデータ経路なので、
        個人設定には置けない（スキーマが弾く）。

        **警告をここに出すのが要点。** 監視は取り出して消すので、転送に失敗したぶんは
        元に戻せない。設定の場で言わないと、気づくのは事故の後になる。
      -->
      <div v-if="canEditWebhook" class="trusted">
        <div class="tlabel">待ち行列サービス（信頼設定）</div>
        <label class="row"
          ><span class="cap" title="届いたエントリをここへ POST します。空にすると転送しません"
            >転送先 URL</span
          ><input v-model="hookForm.url" placeholder="https://example.internal/hooks/order"
        /></label>
        <template v-if="hookForm.url.trim()">
          <label class="row"
            ><span class="cap">認証ヘッダー</span
            ><input v-model="hookForm.secretHeader" placeholder="Authorization（既定）"
          /></label>
          <label class="row"
            ><span class="cap" title="ここに入力した値は暗号化して保存します。空のままなら現在の設定を保ちます"
              >秘密</span
            ><input
              v-model="hookForm.secret"
              type="password"
              :placeholder="hookForm.hasSecret ? '設定済み（変更しない）' : '未設定'"
          /></label>
          <label class="row"
            ><span class="cap" title="秘密を環境変数から取る場合の変数名。設定ファイルには名前だけが残ります"
              >環境変数名</span
            ><input v-model="hookForm.secretEnv" placeholder="ORDER_HOOK_TOKEN"
          /></label>
          <label class="row"
            ><span class="cap">待ち時間上限</span
            ><input v-model.number="hookForm.timeoutSec" type="number" min="1" placeholder="10（秒）"
          /></label>
          <label class="row"
            ><span class="cap" title="この回数まで再試行して、届かなければ諦めます">諦めるまで</span
            ><input v-model.number="hookForm.maxAttempts" type="number" min="1" max="20" placeholder="5（回）"
          /></label>
          <p class="warn">
            ⚠ 監視はエントリを<strong>取り出して消します</strong>。転送に失敗したぶんは
            <strong>元に戻せません</strong>（諦めた件数は「サービス」画面に出ます）。
            サーバーの停止・再起動で未送分は失われます。
          </p>
        </template>
      </div>

      <!--
        信頼設定。サーバー設定のプリンターセッションで、編集権限があるときだけ。
        **サービス ✅ をここに置く理由**: `service` は printer スキーマ＝サーバー設定にしか無く、
        条件が `canEditPrinter` と完全に一致する。新しい認可条件を作らない（散らすと食い違う）
      -->
      <div v-if="canEditPrinter" class="trusted">
        <div class="tlabel">サーバー側のプリンターサービス（信頼設定）</div>
        <label class="row">
          <span class="cap" title="ブラウザを閉じてもサーバー側で待ち受け続けます。次に開いたときは同じものへ繋がります">
            サービスとして使う
          </span>
          <span class="tv">
            <input v-model="printerForm.service" type="checkbox" />
            サーバーに常駐して受け取り続ける
          </span>
        </label>
        <label class="row"
          ><span class="cap">PDF 保存先</span><input v-model="printerForm.autoPdfDir" placeholder="/var/spool/out"
        /></label>
        <label class="row"
          ><span class="cap">自動印刷</span><input v-model="printerForm.autoPrint" placeholder="プリンター名"
        /></label>
        <p v-if="printerForm.service" class="warn">
          帳票はブラウザが居なくてもサーバーが受け取ります。出力先を設定していない場合、
          受け取った帳票はサーバーのメモリにだけ残ります（上限を超えると古いものから落ちます）。
        </p>
      </div>

      <p v-if="error" class="err">{{ error }}</p>
      <p v-if="notice" class="ok">{{ notice }}</p>

      <div class="editfoot">
        <button class="btn" :disabled="busy" @click="save">保存</button>
        <button class="btn ghost" :disabled="busy" @click="cancel">取消</button>
        <button v-if="!creating" class="btn danger" :disabled="busy" @click="remove">削除</button>
        <span v-if="kind === 'session'" class="rest">ホスト・ユーザー・パスワードはシステムが持つ</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 12px 13px;
  background: var(--card);
  display: flex;
  flex-direction: column;
  /* InfoPopover を絶対配置する基準 */
  position: relative;
}
.info {
  border: none;
  background: none;
  color: var(--muted);
  padding: 2px 4px;
  font-size: 0.9rem;
  line-height: 1;
}
.info:hover {
  color: var(--accent);
  border-color: transparent;
}
/* 一覧表示: 横並びの 1 行にして高さを詰める（件数が多いときに見渡すため） */
.card.dense {
  flex-direction: row;
  align-items: center;
  gap: 14px;
  padding: 6px 12px;
}
.card.dense .nm {
  margin-bottom: 0;
  flex: 0 0 auto;
  min-width: 12ch;
}
.card.dense .meta {
  flex: 1;
  /* 2 行の情報を 1 行に畳む。<br> は改行しない扱いにする */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card.dense .meta :deep(br) {
  display: none;
}
.card.dense .meta :deep(br)::after {
  content: " ";
}
.card.dense .foot {
  margin-top: 0;
  padding-top: 0;
  flex: 0 0 auto;
  /* リスト表示は 1 行に戻す（ボタンの右にセッション数） */
  flex-direction: row;
  align-items: center;
}
.card.dense .count {
  margin-left: 6px;
}

/* 選択中のシステム。一覧の中で現在地が分かるようにする */
.card.current {
  border-color: var(--accent);
}
.card.editing {
  grid-column: 1 / -1;
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.nm {
  font-weight: 700;
  font-size: 0.88rem;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 7px;
}
.ticon {
  font-size: 0.95rem;
  line-height: 1;
}
.chip {
  font-size: 0.66rem;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
}
/* 種別は色を変えて、サーバー設定のバッジと区別する */
.chip.type {
  background: var(--line);
  color: var(--muted);
}
/* 接続待ちの回転。押した直後から反応が見えるようにする */
.dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 6px;
  border: 2px solid color-mix(in srgb, currentColor 35%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  vertical-align: -1px;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dot {
    animation-duration: 2.5s;
  }
}
.meta {
  font-family: var(--mono);
  font-size: 0.73rem;
  color: var(--muted);
  line-height: 1.55;
}
.foot {
  margin-top: auto;
  padding-top: 10px;
  display: flex;
  /* グリッド表示ではセッション数をボタンの上の行に出す（狭い幅で折り返さないように） */
  flex-direction: column-reverse;
  align-items: flex-start;
  gap: 6px;
}
.actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.count {
  font-size: 0.72rem;
  color: var(--muted);
  white-space: nowrap;
}
/* 接続中の数。設定の数と区別できるよう色を変える（0 のときは出さない） */
.live {
  margin-left: 6px;
  color: var(--t-green);
  font-weight: 600;
}
.btn {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  border-radius: 6px;
  padding: 4px 12px;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.btn.ghost {
  background: transparent;
  color: var(--accent);
}
.btn.danger {
  background: transparent;
  border-color: var(--line);
  color: var(--muted);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.fgrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 6px 20px;
  margin-top: 8px;
}
.row {
  display: grid;
  grid-template-columns: 104px 1fr;
  gap: 8px;
  /* 見出しと入力欄は**互いに**中央で揃える（1 行目の中で） */
  align-items: center;
  /**
   * **中身は上に詰める。**
   *
   * `.fgrid` の各行は「その行で一番高い欄」に合わせて伸びる。説明（`.hint`）を持つ欄は
   * 2 行ぶんの高さになるので、説明の無い隣の欄が**縦中央に浮いて見出しの位置がずれる**
   * （利用者の指摘）。`align-content` で上詰めにすると、説明の有無にかかわらず
   * **1 行目の高さが揃う**。
   */
  align-content: start;
  font-size: 0.8rem;
}
.cap {
  color: var(--muted);
  font-size: 0.76rem;
}
.row input[type="text"],
.row input:not([type]),
.row input[type="number"],
.row input[type="password"],
.row select {
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 3px 8px;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 0.76rem;
  width: 100%;
  box-sizing: border-box;
}
.row input[type="checkbox"] {
  justify-self: start;
}
/* チェックとその説明を 1 行に収める（トグルは高さがあるので縦位置を揃える） */
.tv {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.76rem;
  color: var(--ink);
}
.hint {
  grid-column: 2;
  font-size: 0.7rem;
  color: var(--muted);
}
.trusted {
  margin-top: 12px;
  padding: 10px 12px;
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
  border-radius: 0 7px 7px 0;
  display: grid;
  gap: 6px;
}
.tlabel {
  font-size: 0.74rem;
  font-weight: 700;
  color: var(--accent);
}
/* ウォーターマーク。**信頼設定（.trusted）とは別の意匠**にする——
   アクセントの縦帯は「サーバー側に効く設定」の合図なので、表示だけの設定には使わない */
.wmsec {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.wmlabel {
  font-size: 0.74rem;
  font-weight: 700;
  color: var(--muted);
}
/* 説明が長い行は全幅で使う（2 列に収めると折り返して行数が増える） */
.row.full {
  grid-column: 1 / -1;
}
/* 色: セレクトと見本を 1 行に収める（見本だけの行を足すと縦に伸びる） */
.colorpick {
  display: flex;
  align-items: center;
  gap: 6px;
}
.colorpick select {
  flex: 1;
  min-width: 0;
}
.row input[type="color"] {
  width: 40px;
  height: 24px;
  flex: none;
  padding: 1px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--paper);
}
.editfoot {
  margin-top: 14px;
  display: flex;
  gap: 7px;
  align-items: center;
}
.rest {
  margin-left: auto;
  color: var(--muted);
  font-size: 0.73rem;
}
.err {
  color: #c62828;
  font-size: 0.78rem;
  margin: 8px 0 0;
}
.ok {
  color: var(--accent);
  font-size: 0.78rem;
  margin: 8px 0 0;
}

/* システムカラーの選択。色そのものが選択肢なので、文字ではなく面で見せる */
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: center;
}
.swatch-btn {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 5px;
  cursor: pointer;
}
.swatch-btn.auto {
  width: auto;
  padding: 0 7px;
  font-size: 11px;
  background: var(--card);
  color: var(--muted);
}
.swatch-btn.on {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
