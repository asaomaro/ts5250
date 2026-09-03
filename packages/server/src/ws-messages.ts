import type { ScreenSnapshot } from "@ts5250/tn5250";
import type { WsVtFrame } from "./vt-wire.js";
import type { PcCommandEvent } from "./session-manager.js";
import type { SessionJob } from "./session-manager.js";
import type { MacroSecretRef } from "./macro-types.js";
import type { WatchView, WatchEntryView } from "./watch-registry.js";
import type { ServiceState } from "./service-state.js";

export type { WsVtFrame, WsVtLine, WsVtRun, WsVtStyle } from "./vt-wire.js";

/** WebSocket メッセージ型（server が定義し web-ui が type-only import で共有。spec「Web 向けプロトコル」） */

// ---- client → server ----
export interface WsOpen {
  type: "open";
  /**
   * **既存のセッションへ繋ぐ**（新規に開かない）。
   *
   * MCP や HLLAPI が開いた画面を、あとからブラウザで見るための口。
   * **自分のものだけ**（`SessionManager.get` の所有者検査を通す）。
   * これを指定したときは他の接続指定（`system` / `host` 等）を見ない。
   */
  sessionId?: string;
  /** セッション種別（既定 display）。printer は TN5250E プリンターセッション */
  kind?: "display" | "printer";
  /**
   * **端末の種類**（既定 5250）。
   *
   * `kind` と混ぜていないのは**軸が直交する**ため——あちらはセッションの種別（画面／プリンター）で、
   * こちらは端末の種類。1 つの列挙に畳むと `kind: "printer"` × `terminal: "3270"`
   * （TN3270E プリンター）を足したくなったときに破綻する。
   *
   * **`vt` は文字モード**——フィールドも AID キーも無く、専用のペインで描く。
   * 画面のやり取りも別メッセージ（`vt-*`）になる。
   */
  terminal?: "5250" | "3270" | "vt";
  /**
   * **3270 のモデル**（既定 2）。代替画面サイズを決める。
   *
   * **2（24x80）と 5（27x132）だけ**受ける。モデル 3（32 行）・4（43 行）は
   * web-ui が話す `ScreenSnapshot` の `rows: 24 | 27` に収まらないので、**入口で断る**
   * （型を曲げるより、対応するときに web-ui ごと広げる）。
   */
  model?: 2 | 5;
  /** システム参照（`srv:<name>` / `own:<id>`）。接続先と資格情報を決める */
  system?: string;
  /** セッション設定参照。指定すると親システムまで一意に決まる（基本形） */
  session?: string;
  host?: string;
  port?: number;
  ccsid?: number;
  /** 画面サイズ。27x132 は端末タイプで申告し、ホストが対応画面でのみ使う（既定 24x80） */
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  enhanced?: boolean;
  tls?: boolean;
  /**
   * **VT の画面の大きさ**（`terminal: "vt"` のときだけ）。ブラウザがペインを測って渡す。
   * `screenSize` と分けているのは、VT が固定の 2 種類ではなく**任意**だから。
   */
  vtRows?: number;
  vtCols?: number;
  /**
   * **VT の文字符号化**（既定 `utf-8`）。
   *
   * `ccsid` とは軸が違う——あちらは IBM i にコードページを申告するためのもので、
   * こちらは画面に流れるバイト列の読み方。
   */
  encoding?: "utf-8" | "shift_jis" | "euc-jp";
  /** RFC 4777 自動サインオン（host 直指定時。system/session 指定時はシステム側の signon を使う） */
  user?: string;
  password?: string;
  readOnly?: boolean;
}
/** フィールドの指し方（index、または画面座標） */
export type WsFieldRef = number | { row: number; col: number };

/**
 * 1 フィールドへの書き込み。値そのものか、**マクロの秘密への参照**のいずれか（spec D11）。
 *
 * 参照形にしているのは、マクロに保存したパスワードを**ブラウザに一度も渡さない**ため。
 * クライアントは平文も暗号文も持たず、サーバーが所有者を検証したうえで復号し、
 * ホストへ書く直前に値へ差し替える（`ws-handler.onKey`）。
 */
export type WsKeyField =
  | { field: WsFieldRef; value: string }
  | { field: WsFieldRef; secretRef: MacroSecretRef };

export interface WsKey {
  type: "key";
  key: string;
  cursor?: { row: number; col: number };
  fields?: WsKeyField[];
  /**
   * **SysReq のときだけ意味を持つ**: システム要求行に打たれた文字列。
   * 別メッセージ型にしないのは、readOnly ゲート・監査・busy 対応付けといった歯止めを
   * key 経路と二重に書かないため（片方への付け忘れを構造的に防ぐ）。
   *
   * **マクロの秘密（`fields[].secretRef`）を別経路にしなかったのも同じ理由**——
   * 秘密こそ readOnly ゲートと監査を確実に通す必要がある（spec D11）。
   */
  sysReqText?: string;
}
export interface WsCloseReq {
  type: "close";
}
/**
 * 利用者が触った合図（入力・カーソル移動）。アイドル判定の `lastActivity` を進めるためだけに使う。
 *
 * **payload を持たない。** 入力値は AID キーを押すまで送らない約束で、`edits` の中身を早く送ると
 * 秘密（マクロの `secretRef`）の扱いが変わってしまう。**将来ここに値を足してはならない**
 * ——足した時点で「打鍵のたびに入力値が流れる」設計に変わる（spec 方針4）。
 */
export interface WsActivity {
  type: "activity";
}
/** ハートビートの応答（`ping` への返し）。半開きソケットの検出に使う */
export interface WsPong {
  type: "pong";
}
/** GUI 選択フィールドの選択状態変更（ローカル・ホスト送信なし） */
export interface WsGuiSelect {
  type: "gui-select";
  fieldId: number;
  choiceIndex: number;
  selected?: boolean;
}
/** GUI 選択フィールドの確定送信（AID/Enter を Read 応答として送る） */
export interface WsGuiSubmit {
  type: "gui-submit";
  fieldId: number;
  key?: string;
  cursor?: { row: number; col: number };
}
/**
 * **監視（サービス型の常駐ジョブ）のメッセージ。**
 *
 * `open`（5250 セッション）を**要さない**——監視コンソールは pane タブで、
 * セッションを持たないタブだから（`20260723-dtaq-watch-notify` research F6）。
 * 監視そのものはサーバーのレジストリが所有し、WS は**購読するだけ**。
 * **WS が切れても監視は止まらない**のがこの設計の核心（research F1）。
 */
export interface WsWatchSubscribe {
  type: "watch-subscribe";
}
/** 保存済みセッション設定（`srv:` / `own:`。種別 `dtaqwatch`）から監視を始める */
export interface WsWatchStart {
  type: "watch-start";
  session: string;
}
export interface WsWatchStop {
  type: "watch-stop";
  watchId: string;
}
/** 履歴の取得（タブを開き直したとき・行を選んだとき） */
export interface WsWatchHistoryReq {
  type: "watch-history";
  watchId: string;
}

/**
 * 待ち受けの開始／停止。**プリンターと監視で同じ操作**（`20260801-service-start-stop`）。
 *
 * 監視は `watch-start` / `watch-stop` を既に持つが、あちらは
 * 「定義から**作って**始める」意味。こちらは**既にあるものの待ち受けを切り替える**。
 */
export interface WsPrinterStart {
  type: "printer-start";
  sessionId: string;
}
export interface WsPrinterStop {
  type: "printer-stop";
  sessionId: string;
}
/** 停止した監視の再開（`watch-start` は新規作成なので別に要る） */
export interface WsWatchResume {
  type: "watch-resume";
  watchId: string;
}
/**
 * **定義からプリンターサービスを立ち上げる**（`20260801-services-pane`）。
 *
 * `printer-start` は「**登録済みのもの**の待ち受けを始める」意味なので、
 * **一度も開いていない定義には効かない**——サービス一覧から開始できるようにするには
 * 「定義から作って始める」口が要る。監視の `watch-start` と同じ役割。
 *
 * **タブは開かない**（`open` と違ってセッションを画面に紐づけない）。サービスは
 * ブラウザが居なくても動くものなので、見に行くのと動かすのを分ける。
 */
export interface WsPrinterServiceStart {
  type: "printer-service-start";
  session: string;
}

/**
 * **VT への入力。**
 *
 * 打鍵を**意味のまま**送り、バイト列への符号化は server が行う（spec D4）。
 * `DECCKM` / `DECKPAM` / bracketed paste / マウスの様式は server の `VtTerminal` が
 * 持っているので、ブラウザ側で符号化すると**モードの写しを 2 つ持つ**ことになり必ずずれる。
 */
export interface WsVtInput {
  type: "vt-input";
  /** 名前つきのキー（`ArrowUp` / `F5` / `Enter` …）。`@ts5250/vt` の `VtKeyName` */
  key?: string;
  /** 打った文字（IME の確定でまとめて来ることがある） */
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** 貼り付け（bracketed paste が有効なら server が包む） */
  paste?: string;
  /** マウス（報告が有効なときだけ server が送る） */
  mouse?: {
    button: "left" | "middle" | "right" | "wheelUp" | "wheelDown";
    row: number;
    col: number;
    kind: "down" | "up" | "move";
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
  };
}

/** VT の画面の大きさが変わった（ペインの寸法から測った値）。NAWS でホストへ伝わる */
export interface WsVtResize {
  type: "vt-resize";
  rows: number;
  cols: number;
}

export type WsClientMessage =
  | WsOpen
  | WsVtInput
  | WsVtResize
  | WsKey
  | WsCloseReq
  | WsGuiSelect
  | WsGuiSubmit
  | WsPrinterOutput
  | WsActivity
  | WsPong
  | WsWatchSubscribe
  | WsWatchStart
  | WsWatchStop
  | WsWatchHistoryReq
  | WsWatchResume
  | WsPrinterServiceStart
  | WsPrinterStart
  | WsPrinterStop
  | WsReserveBreak;

// ---- server → client ----
export interface WsOpened {
  type: "opened";
  sessionId: string;
  screen: ScreenSnapshot;
  /** セッションの実効ホストコードページ（CCSID）。既定 37 */
  ccsid: number;
  /** ジョブ識別子。接続直後は装置名（＝ジョブ名）だけのことがある */
  job?: SessionJob;
  /**
   * PC コマンド（STRPCCMD）の実行が有効か。**信頼設定なので値は返さず有無だけ**。
   * 無効でもホストへの応答は返るので、利用者には「実行しない理由」を示すために使う
   */
  pcCommand: boolean;
  /** 予約中ならその表示名。**後から入ったタブにも今の状態を伝える** */
  reservedBy?: string;
  /**
   * **留守中に実行された PC コマンド**（受信順。無ければ載せない）。
   *
   * `pc-command` は購読者にしか届かないので、ブラウザを閉じている間に届いたコマンドは
   * **実行されたのに誰にも知らされなかった**。繋ぎ直しで渡して、後から追えるようにする。
   */
  pcCommands?: PcCommandEvent[];
}
export interface WsScreen {
  type: "screen";
  screen: ScreenSnapshot;
}
/**
 * 予約（HLLAPI の `Reserve`）の状態が変わった。
 *
 * **画面と別のメッセージにしている**——予約は画面を変えずに始まり・終わるので、
 * `screen` に相乗りさせると開始と解除を取りこぼす。
 *
 * これを受けた画面は入力を止め、**誰が触っているか**を出す。止めないと、
 * 打ちかけが自動操作の変えた別の画面へ送られる。
 */
export interface WsReserved {
  type: "reserved";
  /** 予約している主体の表示名。**解除されたら省略される** */
  by?: string;
}
/** 予約を強制的に外す（利用者の非常口）。自動化が落ちて `Release` を送れないとき用 */
export interface WsReserveBreak {
  type: "reserve-break";
}
/**
 * ジョブ識別子の通知（**サーバー発のみ**）。
 *
 * 装置名は接続直後の `opened` に載る。ユーザー・番号はコマンドサーバーで引けたときに
 * 遅れて届くので、このメッセージで足す。**クライアントから要求する口は無い**——
 * 取得は画面に触れずに自動で行われる（DSPJOB を打つ旧経路は廃止した）。
 */
export interface WsJobInfoRes {
  type: "jobinfo";
  job: SessionJob;
}
/**
 * AID 送信の処理が終わった合図。
 *
 * **画面が返らないキーがあるため必要**——応答画面は screen イベントで push されるが、
 * ホストが表示を変えない場合はイベントが起きず、クライアントの「応答待ち」が永久に残る。
 * sendAid の完了そのものを伝えることで、画面の有無に依らず待ちを解ける。
 *
 * **Attn / SysReq には送らない**——フラグレコードは応答を待たないので解くべき待ちが無く、
 * 送ると「応答待ちの最中に押した Attn が元の待ちを解く」ことになる（`ws-handler.onKey`）。
 */
export interface WsKeyDone {
  type: "key-done";
  sessionId: string;
  /**
   * 完了時点の画面。**タイムアウト復帰で必要**——ホストがアンロックを伴う応答を返さないと
   * screen イベントが出ないまま `keyboardLocked: true` の画面が残り、UI の 🔒 が消えない。
   * sendAid の戻り値には解除後の画面が入っているので、それを必ず届ける。
   */
  screen: ScreenSnapshot;
  /** ホスト応答を待たずタイムアウトで復帰したか */
  timedOut: boolean;
}

export interface WsError {
  type: "error";
  code: string;
  message: string;
  fatal: boolean;
}
export interface WsClosed {
  type: "closed";
  reason: string;
}
/** 出力（PDF 保存・自動印刷）の警告 1 件 */
export interface PrinterOutputWarning {
  at: number;
  message: string;
}
/** プリンターセッションを開いた（待ち受けの状態＋自動出力の状態） */
export interface WsPrinterOpened {
  type: "printer-opened";
  sessionId: string;
  /**
   * 待ち受けの状態。**「開く（登録する）」と「待ち受ける」は別**
   * （`20260801-service-start-stop`）——`autoStart ☐` の定義は
   * 開いても `stopped` のままで、利用者の開始操作を待つ
   */
  state: ServiceState;
  /**
   * `state === "error"` のときの理由。
   *
   * ⚠ **後から繋いだ画面にも渡す。** `printer-state` の push は**繋いでいる間しか届かない**ので、
   * 誰も見ていない間に止まった常駐プリンターは、朝ブラウザを開いても
   * **「エラー」とだけ出て理由が無い**状態になっていた（VT の切断理由と同じ形）。
   */
  error?: string;
  /**
   * 起動応答コード（`I902` 等）。**待ち受けていなければ無い**——
   * 接続していないので、ホストから応答をもらっていない
   */
  startupCode?: string;
  /** サーバー側の自動出力設定があるか（UI のトグル表示条件） */
  hasOutput: boolean;
  /** 自動出力の実行時 有効/無効 */
  outputEnabled: boolean;
  /** 既存の出力警告（後から画面を開いても直近の失敗が分かるように配送） */
  outputWarnings: PrinterOutputWarning[];
  /** 既受信スプールの自動出力結果（後から画面を開いても成否が分かるように配送） */
  outputStatuses: SpoolOutputStatusMsg[];
  /**
   * **バッファ済みの帳票**（`20260801-printer-attach-by-ref`）。
   *
   * 常駐中に届いたぶんを、開き直したブラウザへ渡す——これが無いと
   * 「繋がったが閉じている間のものは見えない」になる。
   * 上限（サーバー側 `REPORT_LIMIT`）を超えた古いものは落ちているので、
   * **総数は `receivedTotal` を見る**
   */
  reports: SpoolReportMsg[];
  /** 累計受信数（**落ちた分も含む**）。`reports.length` との差が「落ちた数」 */
  receivedTotal: number;
}
/**
 * 電文に載せる 1 スプール（帳票）。`pages` は等幅グリッド（生 SCS は載せない）。
 *
 * **`receivedAt` は任意**（`20260802-printer-report-history`）——Electron 同梱版のように
 * サーバーと web-ui の版がずれる経路があるので、無ければ受け手が現在時刻で押す
 * 従来の見え方に落ちる。壊れないほうを既定にする。
 */
export interface SpoolReportMsg {
  id: string;
  pages: { rows: number; cols: number; lines: string[] }[];
  /** サーバーが受け取った時刻（epoch ms）。**開いた時刻ではない** */
  receivedAt?: number;
}
/** 1 スプールに対する自動出力の結果（成功も含む）。設定が無い側はキーを省略する */
export interface SpoolOutputStatusMsg {
  spoolId: string;
  at: number;
  skipped?: boolean;
  pdf?: { ok: boolean; path?: string; error?: string };
  print?: { ok: boolean; printer?: string; error?: string };
}
/** 受信スプールの自動出力結果（PDF 作成・印刷の成否）を通知する */
export interface WsPrinterOutputResult {
  type: "printer-output-result";
  sessionId: string;
  status: SpoolOutputStatusMsg;
}
/** 自動出力が失敗した（PDF 保存 / lp 印刷）。非同期に発生するので push する */
export interface WsPrinterWarn {
  type: "printer-warn";
  sessionId: string;
  at: number;
  message: string;
}
/** 自動出力の有効/無効が変わった（クライアントの切替に対する応答） */
export interface WsPrinterOutputState {
  type: "printer-output-state";
  sessionId: string;
  enabled: boolean;
}
/** スプール（帳票）1 件を受信した。pages は等幅グリッド（生 SCS は載せない） */
export interface WsReport {
  type: "report";
  sessionId: string;
  report: SpoolReportMsg;
}
/**
 * PC コマンド（STRPCCMD）の実行状況。**サーバー発のみ**（開始時と完了時の 2 回）。
 *
 * ホストが 5250 の画面データに隠して送ってきたコマンドを、サーバープロセスが動いている機械で
 * 実行したことを利用者に見せる。`hostname` は実行先＝ローカル PC かサーバー機かの手がかり。
 */
export interface WsPcCommand {
  type: "pc-command";
  sessionId: string;
  event: PcCommandEvent;
}

/** client → server: 自動出力の有効/無効を切り替える */
export interface WsPrinterOutput {
  type: "printer-output";
  enabled: boolean;
}
/**
 * ハートビート（server → client）。クライアントは `pong` を返す。
 *
 * 半開きソケット（TCP が死んでいるのに close イベントが来ない）を検出するために要る。
 * **既定を永続にした代償**——`onSocketClose` が発火しない事故が起きると、
 * 壁時計タイマーが無くなった以上セッションが永久に残る。
 */
export interface WsPing {
  type: "ping";
}

/** 監視の一覧（購読直後・開始・停止のあとに配る） */
export interface WsWatchList {
  type: "watch-list";
  watches: WatchView[];
}
/** 到着 1 件の push。**画面に触れなくても気づける**ための唯一の経路 */
export interface WsWatchEntry {
  type: "watch-entry";
  watchId: string;
  entry: WatchEntryView;
  /** 累計受信件数（履歴が落ちても増え続ける） */
  received: number;
}
/** プリンターの待ち受け状態が変わった。**黙って止まらない**ため（監視と同じ扱い） */
export interface WsPrinterState {
  type: "printer-state";
  sessionId: string;
  state: ServiceState;
  /** `state === "error"` のときの理由 */
  error?: string;
  /** 待ち受けを始めたときの起動応答コード */
  startupCode?: string;
}

/** 状態の変化（`listening` / `reconnecting` / `error` / `stopped`）。**黙って止まらない**ため */
export interface WsWatchState {
  type: "watch-state";
  watchId: string;
  state: WatchView["state"];
  error?: string;
}
export interface WsWatchHistoryRes {
  type: "watch-history";
  watchId: string;
  entries: WatchEntryView[];
}

/**
 * **VT のセッションが開いた。** 最初の 1 通だけ全行が入る（以降は `vt-frame` の差分）。
 */
export interface WsVtOpened {
  type: "vt-opened";
  sessionId: string;
  frame: WsVtFrame;
  /** 実効の符号化 */
  encoding: string;
  /** IBM i か（画面側の案内を変えるのに使う） */
  ibmI: boolean;
  /** ホストがエコーを握ったか＝文字モードが成立しているか */
  hostEchoes: boolean;
}

/** VT の画面の差分（`vt-wire.ts` の `VtFrameBuilder` が作る） */
export interface WsVtFrameMessage {
  type: "vt-frame";
  frame: WsVtFrame;
}

/**
 * ホストが `ECHO` を握ったかが変わった。**画面に変化が無いときはこちらで届く。**
 *
 * 交渉は接続の直後に終わるとは限らないので、`vt-opened` の値を握ったままにすると
 * 「エコーを返していません」の案内が出たまま残る。
 */
export interface WsVtEcho {
  type: "vt-echo";
  hostEchoes: boolean;
}

/** `OSC 0/2` のタイトル。タブ名に使う */
export interface WsVtTitle {
  type: "vt-title";
  title: string;
}

export type WsServerMessage =
  | WsVtOpened
  | WsVtFrameMessage
  | WsVtTitle
  | WsVtEcho
  | WsWatchList
  | WsWatchEntry
  | WsWatchState
  | WsPrinterState
  | WsWatchHistoryRes
  | WsPing
  | WsOpened
  | WsScreen
  | WsReserved
  | WsJobInfoRes
  | WsError
  | WsClosed
  | WsKeyDone
  | WsPrinterOpened
  | WsPrinterWarn
  | WsPrinterOutputState
  | WsPrinterOutputResult
  | WsPcCommand
  | WsReport;
