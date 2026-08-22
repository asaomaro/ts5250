import { randomUUID } from "node:crypto";
import { As400Error } from "@ts5250/base";
import { CommandConnection, listJobs } from "@ts5250/hostserver";
import { Session5250, PrinterSession, type ConnectOptions, type AidKey, type PcCommandRequest, type PrinterConnectOptions, type SpoolReport } from "@ts5250/tn5250";
import { childLog } from "./log.js";
import { rescueStuckSpools, type RescueAction } from "./spool-rescue.js";
import {
  runPcCommand,
  pcCommandHostname,
  type PcCommandConfig,
  type PcCommandOutcome
} from "./pc-command.js";
import { handleReport, type PrinterOutputConfig, type HandleReportResult } from "./printer-output.js";
import { holdsConnection, type ServiceState } from "./service-state.js";
import { ScreenRecorder } from "./screen-recorder.js";
import { assertOwner, type AuthUser } from "./auth.js";

const printerLog = childLog({ component: "printer-output" });
const sessionLog = childLog({ component: "session-5250" });

/**
 * 受信レコードを hex でログへ流すか（`AS400_TRACE_RECORDS=1` / `--trace-records`）。**障害切り分け専用**。
 * 画面の中身がログに残るので常用しない。
 *
 * **セッションを開くたびに評価する。** モジュール読み込み時に固定すると、
 * main が引数を解釈して環境変数を立てるより先に評価され、フラグが効かない。
 */
function traceRecordsEnabled(): boolean {
  return process.env.AS400_TRACE_RECORDS === "1";
}

/** PC コマンドの履歴保持件数（後から画面を開いても直近の実行が分かるように残す） */
const PC_COMMAND_HISTORY = 20;

export interface OpenOptions extends ConnectOptions {
  /** 閲覧専用セッション（set_fields/signon/run_steps と PageUp/Down 以外の AID を拒否） */
  readOnly?: boolean;
  /** 由来（プロファイル名 or "direct"）。list_sessions 表示用 */
  origin?: string;
  /** どの設定から開いたか。外部の自動化が安定した名前で指せるようにする */
  target?: SessionTarget;
  /** 所有者（認証ユーザー名）。認証時に per-user 分離で使う */
  owner?: string;
  /**
   * 装置名が使用中でホストに拒否されたとき、末尾の数字を繰り上げて再試行する。
   *
   * **既定 off。** 装置名を固定するのは「その名前で繋ぎたい」意図なので、黙って別名に
   * すり替えるのは裏切りになる。名前にこだわらないが確実に繋ぎたい運用のための任意設定。
   */
  deviceNameRetry?: boolean;
  /**
   * 書き出しできないスプールを取得したあと、ホスト側のスプールをどうするか。
   * **既定は保留**——削除は取り消せないので、利用者が明示的に選んだときだけ行う。
   */
  rescueAction?: RescueAction;
  /**
   * PC コマンド（STRPCCMD）の実行設定。**サーバー設定由来のセッションだけが持つ**（信頼設定）。
   * 未指定なら「実行しない」。検出と実行キーの応答は設定に関わらず行われる
   * （返さないとホストが待ち続けるため。research D5）
   */
  pcCommand?: PcCommandConfig;
  /**
   * このセッションのアイドルタイムアウト（ms、または `"never"`＝切らない）。
   * 未指定ならマネージャの既定（`SessionManagerOptions.idleTimeoutMs`）に従う。
   */
  idleTimeoutMs?: IdleLimit;
}

/**
 * アイドルタイムアウトの内部表現。ms、または `"never"`（＝切らない）。
 *
 * **`0` / `null` を「切らない」の印にしない**——未設定・転記漏れと見分けが付かなくなる
 * （spec 方針2）。設定ファイル側は「分」で持ち、`idleTimeoutToMs()` でここへ変換する。
 */
export type IdleLimit = number | "never";

/**
 * 切断を通知しない入口（MCP）に使うアイドル上限（ms）。
 *
 * この値は**安全網であって設定ではない**。MCP は `StreamableHTTPTransport` のツール呼び出しごとの
 * HTTP で、クライアントが落ちても通知が来ない（research F2）。従来の既定と同じ 30 分にしてある。
 */
export const ORPHAN_IDLE_TIMEOUT_MS = 30 * 60_000;

/** 常駐プリンターの既定の上限。表示の上限（8）とは別枠（design D3） */
export const DEFAULT_MAX_RESIDENT_PRINTERS = 4;

/**
 * 切断を通知しない入口（MCP）のアイドル上限を決める。**`"never"` は通さない。**
 *
 * ブラウザ経路は WS の切断とハートビートが孤児を回収するので永続でも安全だが、
 * MCP には回収する者が居ない。永続を許すと落ちたクライアントのセッションが残り続け、
 * `maxSessions` を食い潰して新規接続ができなくなる（装置記述も掴んだまま。research F2）。
 */
export function orphanSafeIdleTimeoutMs(v: IdleLimit | undefined): number {
  return typeof v === "number" ? v : ORPHAN_IDLE_TIMEOUT_MS;
}

/** 装置名の末尾数字を繰り上げる（WEBEMU01 → WEBEMU02）。数字が無ければ 2 を足す */
export function nextDeviceName(name: string): string | undefined {
  const m = /^(.*?)(\d+)$/.exec(name);
  if (!m) return name.length < 10 ? `${name}2` : undefined;
  const width = m[2]!.length;
  const next = Number(m[2]) + 1;
  const digits = String(next).padStart(width, "0");
  if (digits.length > width) return undefined; // 桁が増えるなら打ち止め（装置名は 10 文字まで）
  return `${m[1]}${digits}`;
}

/**
 * セッションのジョブ識別子。
 *
 * `name`（＝装置名）は**起動応答レコードから必ず取れる**（資格情報も往復も要らない）。
 * `user` / `number` はコマンドサーバーで引けたときだけ入る
 * （20260723-session-job-info-rework の research F1・F2）。
 */
export interface SessionJob {
  name: string;
  system?: string;
  user?: string;
  number?: string;
}

/**
 * セッションの予約（HLLAPI の `Reserve`/`Release`）。
 *
 * **自動操作の最中に人間が同じ画面へ書くのを止める。** 5250 は入力欄の値を AID と一緒に送るため、
 * ブラウザは Enter を押すまで打ちかけを手元に持っている。その間に自動操作が画面を変えると、
 * 打ちかけが**別の画面の欄へ**送られる。HLLAPI がこの排他を仕様として持っているのはそのため。
 */
export interface SessionReservation {
  /** 予約している主体を識別する不透明な値。**これと一致する書き手だけが通る** */
  holder: string;
  /** 画面に出す名前（例 `HLLAPI`）。利用者に「誰が触っているか」を見せる */
  label: string;
  /** 期限（epoch ms）。**過ぎたら無いものとして扱う** */
  expiresAt: number;
  /**
   * この予約の期限の長さ。**用途で違う。**
   *
   * HLLAPI は利用者が明示的に取り、長い自動化の間ずっと保つ（既定 2 分）。
   * MCP は道具の側が勝手に取り、書き終えたら手放したい（数秒）。
   * 定数 1 つでは両立しないので、**予約そのものが持つ**。
   */
  ttlMs: number;
}

/**
 * 予約の寿命。**呼び出しのたびに延びる**（`touchReservation`）。
 *
 * 期限を置くのは、接続層が状態を持たない＝**落ちた自動化は `Release` を送れない**ため。
 * これが無いと、Excel が落ちただけでセッションが永久に締め切られる。
 *
 * HLLAPI の `Wait`/`Pause` が最大 30 秒なので、その 4 倍を取る。
 * それでも詰まるときのために、**持ち主でなくても解除できる口**（`forceRelease`）を用意する
 * ——同じ利用者が自分のセッションを取り戻すだけなので、権限の穴にはならない。
 */
export const RESERVATION_TTL_MS = 120_000;

/**
 * **どの設定から開いたか。**
 *
 * 実行中のセッション id は起動のたびに変わるので、外部の自動化（HLLAPI・スクリプト）が
 * 「**どのシステムのどのセッション**を操作したいか」を書けるようにするための安定した名前。
 * 画面から直に host を指定して開いた場合は空になる（指せるのは id だけ）。
 */
export interface SessionTarget {
  /** システム参照（`srv:<id>` / `own:<id>`） */
  system?: string;
  /** セッション設定参照 */
  session?: string;
  /** 設定上の名前（利用者が付けた分かりやすい名前） */
  name?: string;
}

export interface SessionEntry {
  id: string;
  session: Session5250;
  readOnly: boolean;
  /** どの設定から開いたか（HLLAPI などが指定に使う） */
  target?: SessionTarget;
  /** 予約（`Reserve`）。期限切れの判定込みで読むには `reservationOf` を使う */
  reservation?: SessionReservation;
  /** 予約の変化の購読者。**単数枠にしない**理由は `pcCommandSubscribers` と同じ */
  reservationSubscribers?: Set<(r: SessionReservation | undefined) => void>;
  /**
   * 期限で予約を切るタイマー。
   *
   * **遅延評価では足りない。** `reservationOf` は読まれたときに刈るが、
   * 誰も読まなければ**ブラウザへ解除が通知されない**——サーバーは通す状態なのに、
   * 画面には覆いが出たまま人が締め出される（実機の E2E で踏んだ）。
   */
  reservationTimer?: ReturnType<typeof setTimeout>;
  /**
   * このセッションを見ているブラウザの数。
   *
   * **予約を取るかどうかの判断に使う**——見ている人が居なければ、締め出す相手が居ないので
   * 予約は儀式でしかない（MCP が自分で開いたセッションが典型）。
   *
   * **通知の購読（`reservationSubscribers` 等）の有無で代用しない。** あれは通知の口であって
   * 在席の印ではなく、通知が要らなくなった瞬間に判定が壊れる。
   */
  viewers: number;
  host: string;
  origin: string;
  connectedAt: string;
  lastActivity: number;
  /** 所有者（認証ユーザー名）。認証 OFF なら undefined */
  owner?: string;
  /** ジョブ識別子。接続直後に装置名だけ入り、引けたら user/number が足される */
  job?: SessionJob;
  /** PC コマンド（STRPCCMD）の実行が有効か。UI の出し分けに使う */
  pcCommandEnabled: boolean;
  /** PC コマンドの実行履歴（新しい順ではなく受信順。上限 `PC_COMMAND_HISTORY`） */
  pcCommands: PcCommandEvent[];
  /**
   * PC コマンドの実行状況の購読者。
   *
   * **単数枠にしない。** 1 枠で上書きしていた頃は、**2 つ目のタブが繋いだ時点で
   * 1 つ目の通知が止まり**、どちらかが閉じると**残った方の通知も消えた**。
   * `screen` は EventEmitter なので画面更新だけは両方に届き、
   * 「画面は同期するのに通知は片方にしか来ない」という中途半端な壊れ方をする。
   */
  pcCommandSubscribers?: Set<(e: PcCommandEvent) => void>;
  /**
   * 画面履歴の記録（**頼まれたときだけ**動く）。エビデンス HTML を束ねるために使う。
   * 常時記録しないのは、使わない画面でメモリを食い続けるうえ、画面に写る入力値が
   * 黙って溜まるため（`screen-recorder.ts`）。
   */
  recorder?: ScreenRecorder;
  /**
   * ジョブ識別子の解決（背後で走る）。**接続を待たせないので await しない**。
   * 呼び出し側が「取れたら表示に足す」ために購読できるよう、Promise だけ持たせる。
   * 解決できなければ `undefined` で終わる（失敗は握りつぶす）
   */
  jobResolved?: Promise<SessionJob | undefined>;
  /** このセッションのアイドルタイムアウト（`OpenOptions` 由来）。無ければマネージャ既定 */
  idleTimeoutMs?: IdleLimit;
}

/** PC コマンド 1 件の状況。開始時（`outcome` 無し）と完了時の 2 回積まれる */
export interface PcCommandEvent {
  at: number;
  command: string;
  wait: boolean;
  /** 実行先の機械名（サーバープロセスが動いている側） */
  hostname: string;
  outcome?: PcCommandOutcome;
}

/** 管理者画面向けのセッション要約（表示/プリンター統合） */
export interface SessionSummary {
  id: string;
  kind: "display" | "printer";
  owner?: string;
  host: string;
  origin: string;
  connectedAt: string;
}

export interface OpenPrinterOptions extends PrinterConnectOptions {
  /**
   * **サービスとして常駐する**（WS が切れても止めない）。定義の「サービスとして利用する ✅」由来。
   * **出力設定の有無から導出しない**（`20260801-service-lifecycle-model` design D3）
   */
  service?: boolean;
  /**
   * 開いた直後に待ち受けを開始するか（**未指定は開始する**）。
   * `false` なら登録だけして `stopped` のまま——利用者の開始操作を待つ
   */
  autoStart?: boolean;
  /**
   * 由来のセッション設定参照（`srv:` / `own:`）。**同じものを二度開いたときに繋ぎ直す鍵**。
   * 直接接続（ブラウザ指定）には無いので、その場合は毎回新規になる
   */
  ref?: string;
  origin?: string;
  /** サーバー側出力設定（PDF 自動蓄積・自動印刷）。プロファイル由来のみ渡す（信頼設定） */
  output?: PrinterOutputConfig;
  /** 所有者（認証ユーザー名）。認証時に per-user 分離で使う */
  owner?: string;
  /**
   * 装置名が使用中でホストに拒否されたとき、末尾の数字を繰り上げて再試行する。
   *
   * **既定 off。** 装置名を固定するのは「その名前で繋ぎたい」意図なので、黙って別名に
   * すり替えるのは裏切りになる。名前にこだわらないが確実に繋ぎたい運用のための任意設定。
   */
  deviceNameRetry?: boolean;
  /**
   * 書き出しできないスプールを取得したあと、ホスト側のスプールをどうするか。
   * **既定は保留**——削除は取り消せないので、利用者が明示的に選んだときだけ行う。
   */
  rescueAction?: RescueAction;
  /**
   * このプリンターセッションのアイドルタイムアウト（ms、または `"never"`）。
   * 未指定ならマネージャの既定に従う。
   */
  idleTimeoutMs?: IdleLimit;
}


/**
 * **サーバーが受け取った帳票**（`20260802-printer-report-history`）。
 *
 * `SpoolReport`（`@ts5250/tn5250`）はプロトコル層の「届いた 1 スプール」で、
 * **時計を持たない**。いつ受け取ったかはサーバーの関心事なので、ここで足す。
 *
 * これが無いと、常駐中に溜まった帳票を後から開いたときに受信時刻を
 * **クライアントが現在時刻で押す**ことになり、夜中に出た帳票が全部「いま届いた」になる。
 */
export type StoredReport = SpoolReport & { receivedAt: number };

/** プリンターセッションの保持単位（受信スプールをバッファし、wait_spool の待機を解決する） */
export interface PrinterEntry {
  id: string;
  /**
   * ホストへの接続。**待ち受けていないときは無い**（`state === "stopped"` / `"error"`）。
   *
   * 「エントリがある＝接続がある」ではなくなった（`20260801-service-start-stop`）——
   * 停止しても一覧に残して再開できるようにするため。
   * 装置を掴んだまま受け取らないのは実害があるので、**停止では必ず手放す**。
   */
  session?: PrinterSession;
  /** 待ち受けの状態。監視と同じ語彙（`service-state.ts`） */
  state: ServiceState;
  /** `state === "error"` のときの理由 */
  error?: string;
  /** 開き直すときに使う接続条件（保存しておく） */
  openOpts: OpenPrinterOptions;
  /** 状態が変わったときに呼ぶ（ws-handler が設定し、切断で解除する） */
  onState?: (s: { state: ServiceState; error?: string; startupCode?: string }) => void;
  host: string;
  origin: string;
  connectedAt: string;
  lastActivity: number;
  /** 所有者（認証ユーザー名）。認証 OFF なら undefined */
  owner?: string;
  /**
   * 受信済みスプール（順）。**上限あり**（`REPORT_LIMIT`）——常駐は何日も動くので、
   * 超えたら古いものから落とす。落ちた分も含めた総数は `receivedTotal`
   */
  reports: StoredReport[];
  /** 累計受信数（**落ちた分も含む**）。「何件来たか」を見失わないため */
  receivedTotal: number;
  /**
   * 由来のセッション設定参照（`srv:` / `own:`）。
   * **同じ定義を二度開いたときに繋ぎ直す鍵**（`20260801-printer-attach-by-ref`）。
   * 直接接続には無い
   */
  ref?: string;
  /** wait_spool が返した件数（次に返す位置） */
  delivered: number;
  /** 次のスプールを待つ待機者 */
  waiters: ((r: SpoolReport | undefined) => void)[];
  /** サーバー側出力設定（プロファイル由来）。未設定なら自動出力機能なし */
  output?: PrinterOutputConfig;
  /**
   * **サービスとして常駐する**（WS が切れても止めない）。
   * 定義の「サービスとして利用する ✅」由来で、サーバー設定のときだけ true になりうる。
   * **出力設定の有無から導出しない**（design D3）
   */
  service?: boolean;
  /** 実行時の自動出力 有効/無効（既定 true）。false の間は PDF 保存・自動印刷をしない */
  outputEnabled: boolean;
  /** 直近の出力警告（上限 20 件）。後から画面を開いても直近の失敗が分かるよう保持する */
  outputWarnings: { at: number; message: string }[];
  /** 警告の push フック（ws-handler が設定し、切断で解除する） */
  onOutputWarn?: (w: { at: number; message: string }) => void;
  /**
   * 帳票の push フック（ws-handler が設定し、切断で解除する）。
   *
   * **救出した帳票はセッションのイベントに乗らない**——ホストから届いたものではないため。
   * ws-handler が `session.on("report")` だけを見ていると救出分が画面に出ないので、
   * 配る側（`deliverReport`）から必ずこのフックを叩く。
   */
  onReport?: (r: StoredReport) => void;
  /** 書き出しできないスプールを拾う見張り（`startRescue`）。切断で止める */
  rescueTimer?: ReturnType<typeof setInterval> | undefined;
  /** 見張りが実行中か。前回が終わる前に次を走らせて二重取得しないための鍵 */
  rescueBusy?: boolean;
  /** スプールごとの自動出力の結果（受信順・上限あり）。成功も含めて画面に出す */
  outputStatuses: SpoolOutputStatus[];
  /** 結果の push フック（ws-handler が設定し、切断で解除する） */
  onOutputStatus?: (s: SpoolOutputStatus) => void;
  /** このセッションのアイドルタイムアウト（`OpenPrinterOptions` 由来）。無ければマネージャ既定 */
  idleTimeoutMs?: IdleLimit;
  /**
   * **常駐**（サービス型）。WS が切れても切らず、アイドル掃除でも消さない。
   *
   * **呼び出し側が指定するフラグではない**——`output`（自動出力設定）の有無から
   * `openPrinter` が決める。出力設定はサーバー設定由来のときしか供給されない
   * （`config-resolver.ts` の信頼境界 5 層目）ので、**常駐の条件は信頼境界とちょうど重なる**。
   * 別の判定軸を足すと、二つがずれたときに「設定が効かないのに常駐する」等が生える
   * （design D1）。
   */
  resident: boolean;
  /**
   * **定義が変わったが、いまの接続には効いていない**（`20260801-service-reconcile`）。
   *
   * 設定を保存しても動いているサービスは落とさない——名前の打ち間違いを直しただけで
   * 帳票の受け取りが切れるのは割に合わない。代わりにここを立てて画面に出し、
   * **いつ止めてよいかは利用者が決める**。開始し直せば消える（材料は差し替え済み）。
   */
  stale?: boolean;
}

/**
 * 1 スプールに対する自動出力の結果。
 * 設定が無い側は**キーごと省略**する（＝「設定なし」。`ok:false`＝失敗と区別する）。
 */
export interface SpoolOutputStatus {
  spoolId: string;
  at: number;
  /** 自動出力が無効（トグル OFF）でスキップした */
  skipped?: boolean;
  pdf?: { ok: boolean; path?: string; error?: string };
  print?: { ok: boolean; printer?: string; error?: string };
}

/** 出力警告の保持上限（メモリ肥大の防止） */
const OUTPUT_WARN_LIMIT = 20;

/**
 * 保持する帳票の上限（プリンターあたり）。
 *
 * **常駐化が持ち込んだ歯止め**（`20260801-printer-attach-by-ref`）——
 * WS 切断でセッションごと消えていた頃は自然に頭打ちになっていたが、
 * サービスとして何日も動くようになった以上、**無制限だと伸び続ける**。
 *
 * 警告（20）より多いのは、帳票が**成果物そのもの**だから。ただし 1 件が数十 KB に
 * なりうるので、無闇には増やさない。`autoPdfDir` があれば PDF がディスクに残るので、
 * ここから落ちても**最後の砦はファイルの方**。
 */
const REPORT_LIMIT = 50;
/** 出力結果の保持上限 */
const OUTPUT_STATUS_LIMIT = 100;

/**
 * handleReport の結果を UI 表示用のステータスに変換する。
 * **設定がある側だけキーを付ける**（設定なし＝キー省略、失敗＝ok:false）。
 */
function buildOutputStatus(
  spoolId: string,
  at: number,
  cfg: PrinterOutputConfig,
  r: HandleReportResult
): SpoolOutputStatus {
  const s: SpoolOutputStatus = { spoolId, at };
  if (cfg.autoPdfDir) {
    s.pdf = r.pdfPath
      ? { ok: true, path: r.pdfPath }
      : { ok: false, ...(r.pdfError !== undefined ? { error: r.pdfError } : {}) };
  }
  if (cfg.autoPrint) {
    s.print = r.printed
      ? { ok: true, printer: cfg.autoPrint }
      : { ok: false, printer: cfg.autoPrint, ...(r.printError !== undefined ? { error: r.printError } : {}) };
  }
  return s;
}

export interface SessionManagerOptions {
  maxSessions?: number;
  /**
   * アイドルタイムアウトの既定（ms、または `"never"`＝切らない）。**既定 `"never"`**。
   * エントリ個別の値（`OpenOptions.idleTimeoutMs`）が無いときに使う。
   *
   * **既定が永続なのは意図的。** WS の切断（`ws-handler.onSocketClose`）とハートビートが
   * 孤児を回収するので、壁時計タイマーは重複した安全網でしかない。一方でこのタイマーは
   * **WS が繋がったまま＝在席している利用者**を切っていた（research F1）。加えて、アイドル対話
   * ジョブの扱いは本来ホストの管轄（`QINACTITV`。多くの環境で `*NONE`）であり、こちらが
   * 30 分で切るのはホストの方針を先取りして上書きする行為だった。ACS も放置で切れない。
   *
   * 共有サーバーで有限に戻したい運用のために `--idle-timeout` を用意している。
   */
  idleTimeoutMs?: IdleLimit;
  /**
   * **常駐プリンターの上限**（既定 4）。表示セッションの上限とは別枠（design D3）。
   * 無制限に張らせないための歯止めで、`WatchRegistry` の `maxWatches` と同じ考え方。
   */
  maxResidentPrinters?: number;
  /** 書き出しできないスプールを拾う見張りの間隔（ミリ秒。既定 10 秒） */
  rescueIntervalMs?: number;
  /** 現在時刻（テスト注入用） */
  now?: () => number;
  /**
   * ジョブ識別子の照会。**テストで偽の応答を差し込むための口**。
   *
   * 既定はコマンドサーバー（`QGYOLJOB`）。これが無いと
   * 「1 件のときだけ採用」「資格情報が無ければ引かない」といった判断を、
   * 実機なしでは一切テストできない（host-ifs の `connect` と同じ考え方）。
   */
  lookupJobs?: LookupJobs;
}

/** 装置名とユーザーで対話ジョブを引く。返すのは一致したジョブ（0 件・複数件もありうる） */
export type LookupJobs = (
  target: { host: string; user: string; password: string; tls?: ConnectOptions["tls"] },
  filter: { name: string; user: string }
) => Promise<{ name: string; user: string; number: string }[]>;

/** 既定の照会: コマンドサーバーに繋いで QGYOLJOB を引き、使い終わったら閉じる */
const lookupJobsViaCommandServer: LookupJobs = async (target, filter) => {
  const conn = await CommandConnection.connect({
    host: target.host,
    user: target.user,
    password: target.password,
    ...(target.tls !== undefined ? { tls: target.tls } : {})
  });
  try {
    // 種別 I（対話）まで絞る。装置名だけでは**他人のジョブを掴む**（research F2）
    return await listJobs(conn, { ...filter, type: "I" }, { max: 5 });
  } finally {
    conn.close();
  }
};

/** ページング系 AID（readOnly セッションでも許可する閲覧操作） */
const READONLY_ALLOWED_KEYS: ReadonlySet<AidKey> = new Set<AidKey>(["PageUp", "PageDown"]);

/**
 * 複数セッションを保持・管理する（spec「セッション管理・並行性」）。
 * MCP と WebSocket が共有する。上限・アイドルタイムアウト・readOnly ゲートを担う。
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly printers = new Map<string, PrinterEntry>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: IdleLimit;
  private readonly maxResidentPrinters: number;
  /** 書き出しできないスプールを拾う見張りの間隔（既定 10 秒） */
  private readonly rescueIntervalMs: number;
  private readonly now: () => number;
  private readonly lookupJobs: LookupJobs;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SessionManagerOptions = {}) {
    this.maxSessions = opts.maxSessions ?? 8;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? "never";
    this.maxResidentPrinters = opts.maxResidentPrinters ?? DEFAULT_MAX_RESIDENT_PRINTERS;
    this.rescueIntervalMs = opts.rescueIntervalMs ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
    this.lookupJobs = opts.lookupJobs ?? lookupJobsViaCommandServer;
  }

  /** アイドルセッションの定期掃除を開始（サーバー起動時に呼ぶ）。テストでは呼ばなくてよい */
  startIdleSweep(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), intervalMs);
    this.sweepTimer.unref?.();
  }

  /**
   * 上限の判定に使う席数。**常駐プリンターは数えない**（design D3）。
   *
   * 上限は「同時に人が使う席」の数として決まっている。常駐は人が座っていないので、
   * 同じ枠を食うと**帳票を待たせておくと画面が開けない**という説明しにくい失敗になる。
   */
  get size(): number {
    return this.sessions.size + this.listeningPrinters(false);
  }

  /**
   * **待ち受け中のプリンターの数**（常駐 `true` / 非常駐 `false` で分ける）。
   *
   * 停止中・障害は数えない——**接続を持たないので枠を占める理由が無い**
   * （`20260801-service-start-stop`）。登録しただけのエントリが枠を食うと、
   * 「開いたのに開始できない」という自分で自分を締め出す状態になる。
   */
  private listeningPrinters(resident: boolean): number {
    let n = 0;
    for (const e of this.printers.values()) {
      if (e.resident === resident && holdsConnection(e.state)) n++;
    }
    return n;
  }

  async open(opts: OpenOptions): Promise<SessionEntry> {
    if (this.size >= this.maxSessions) {
      // **繋ぎに行く前に自分側で断っている。** CONNECT_FAILED（＝ホストへ繋げなかった）と
      // 混ぜると「ホストが落ちている」と「席が空いていない」が区別できない
      throw new As400Error("SESSION_LIMIT", `session limit reached (${this.maxSessions})`);
    }
    const id = opts.id ?? randomUUID();
    // 表示セッションの警告は既定で捨てられる（core の warn 既定が no-op）。
    // 配線しないと `unknown command 0x..` すら残らず、切り分け不能になる。
    // PC コマンド（STRPCCMD）。**検出と応答は常に行い、実行だけを設定で絞る**——
    // 応答を返さないとホストは待ち続ける（research D5）。設定が無ければ disabled として記録する
    const pcCommand = (cmd: PcCommandRequest): Promise<void> => this.handlePcCommand(id, cmd, opts.pcCommand);
    const connect = (deviceName?: string): Promise<Session5250> =>
      Session5250.connect({
        ...opts,
        ...(deviceName !== undefined ? { deviceName } : {}),
        id,
        warn: (m) => sessionLog.warn({ sessionId: id }, m),
        onPcCommand: pcCommand,
        traceRecords: traceRecordsEnabled()
      });
    let session: Session5250;
    try {
      session = await connect();
    } catch (err) {
      // 装置名の重複はホストが理由を返さずソケットを閉じる。設定で許されていれば名前を繰り上げて再試行
      if (!opts.deviceNameRetry || opts.deviceName === undefined) throw err;
      session = await this.retryWithNextDeviceName(opts.deviceName, connect, err);
    }
    const entry: SessionEntry = {
      id,
      session,
      readOnly: opts.readOnly ?? false,
      host: opts.host ?? "(injected)",
      origin: opts.origin ?? "direct",
      // **見ている人はまだ居ない。** ws-handler が繋いだ時点で足す
      viewers: 0,
      ...(opts.target !== undefined ? { target: opts.target } : {}),
      connectedAt: new Date(this.now()).toISOString(),
      lastActivity: this.now(),
      pcCommandEnabled: opts.pcCommand?.enabled === true,
      pcCommands: [],
      ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {})
    };
    // 起動応答レコードから分かる範囲（装置名＝ジョブ名・システム名）を先に載せる。
    // **追加の往復はゼロ**で、資格情報が無い環境でもここまでは必ず出せる
    const startup = session.startup;
    if (startup?.device) {
      entry.job = { name: startup.device, ...(startup.system ? { system: startup.system } : {}) };
    }
    this.sessions.set(id, entry);
    session.on("closed", () => this.sessions.delete(id));
    // 残り（ユーザー・番号）はコマンドサーバーで引く。**接続を待たせない**
    entry.jobResolved = this.resolveJob(entry, opts);
    return entry;
  }

  /**
   * PC コマンド（STRPCCMD）1 件を処理する。**投げない**——例外にすると core 側が
   * ホストへ実行キーを返す前に抜ける恐れがあり、ホストが待ち続ける（research D5）。
   *
   * 開始と完了の 2 回イベントを積む。`PAUSE(*NO)` は「起動した」で完了扱いになる。
   */
  private async handlePcCommand(
    id: string,
    cmd: PcCommandRequest,
    cfg: PcCommandConfig | undefined
  ): Promise<void> {
    const host = pcCommandHostname();
    const begin: PcCommandEvent = { at: this.now(), command: cmd.command, wait: cmd.wait, hostname: host };
    this.pushPcCommandEvent(id, begin);
    sessionLog.info(
      { sessionId: id, command: cmd.command, wait: cmd.wait, hostname: host },
      "PC command received from host"
    );
    let outcome: PcCommandOutcome;
    try {
      outcome = await runPcCommand(cmd, cfg);
    } catch (err) {
      outcome = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        durationMs: this.now() - begin.at
      };
    }
    sessionLog.info({ sessionId: id, command: cmd.command, outcome }, "PC command finished");
    this.pushPcCommandEvent(id, { ...begin, at: this.now(), outcome });
  }

  private pushPcCommandEvent(id: string, event: PcCommandEvent): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    entry.pcCommands.push(event);
    if (entry.pcCommands.length > PC_COMMAND_HISTORY) entry.pcCommands.shift();
    for (const fn of entry.pcCommandSubscribers ?? []) fn(event);
  }

  /**
   * ジョブ識別子（ユーザー・番号）をコマンドサーバーで引く。
   *
   * **資格情報が無ければ何もしない**——画面で手サインオンする使い方では誰のジョブか分からず、
   * 装置名だけで引くと**他人のジョブを掴む**（実機で同名ジョブが 2 件返った。research F2）。
   * 失敗は握りつぶす。ジョブ情報はセッションの成立条件ではない。
   */
  private async resolveJob(
    entry: SessionEntry,
    opts: OpenOptions
  ): Promise<SessionJob | undefined> {
    const device = entry.job?.name;
    if (!device || opts.user === undefined || opts.password === undefined) return undefined;
    const host = opts.host;
    if (host === undefined) return undefined;
    try {
      const jobs = await this.lookupJobs(
        {
          host,
          user: opts.user,
          password: opts.password,
          ...(opts.tls !== undefined ? { tls: opts.tls } : {})
        },
        { name: device, user: opts.user }
      );
      // **1 件に定まらなければ採用しない**（他人のジョブを出さない。research F2）
      const only = jobs.length === 1 ? jobs[0] : undefined;
      if (!only) {
        sessionLog.debug(
          { sessionId: entry.id, device, found: jobs.length },
          "job identity not resolved (not exactly one match)"
        );
        return entry.job;
      }
      // セッションが既に閉じていれば捨てる
      if (!this.sessions.has(entry.id)) return undefined;
      entry.job = { ...entry.job, name: only.name, user: only.user, number: only.number };
      return entry.job;
    } catch (err) {
      // ホストサーバーが使えない・権限が無い等。セッションには影響させない
      sessionLog.debug(
        { sessionId: entry.id, device, err: String(err) },
        "job identity lookup failed"
      );
      return entry.job;
    }
  }

  get(id: string, user?: AuthUser): SessionEntry {
    const entry = this.sessions.get(id);
    if (!entry) throw new As400Error("SESSION_NOT_FOUND", `session ${id} not found`);
    assertOwner(entry.owner, user); // 認証時は所有者/admin のみ（OFF は全通過）
    entry.lastActivity = this.now();
    return entry;
  }

  /** プリンターセッションを開く（TN5250E プリンター）。受信スプールをバッファする。 */
  /** 装置名を繰り上げながら再試行する（既定 5 回まで）。全滅したら最初のエラーを投げ直す */
  private async retryWithNextDeviceName(
    first: string,
    connect: (deviceName: string) => Promise<Session5250>,
    original: unknown
  ): Promise<Session5250> {
    let name: string | undefined = first;
    for (let i = 0; i < 5; i++) {
      name = name === undefined ? undefined : nextDeviceName(name);
      if (name === undefined) break;
      try {
        const s = await connect(name);
        sessionLog.warn({ deviceName: name }, `装置名 ${first} が使用中のため ${name} で接続した`);
        return s;
      } catch {
        // 次の名前へ
      }
    }
    throw original;
  }

  async openPrinter(opts: OpenPrinterOptions): Promise<PrinterEntry> {
    // **同じ定義を二度開いたら、繋ぎ直すのではなく既にあるものへ繋ぐ。**
    //
    // 装置名は**ホスト上で排他**なので、二本目は断られる（実機で 8903／装置使用中）。
    // 監視にも同じ規則があり（`watch-registry.ts`）、そのコメントが
    // **判定をサーバーに置く理由**を書いている——画面側だけで見ると、
    // リロード直後はまだ一覧が届いておらずすり抜ける。
    //
    // **状態は変えない。** 利用者が止めたものを、開き直しただけで勝手に再開しない
    if (opts.ref !== undefined) {
      const existing = [...this.printers.values()].find(
        (e) => e.ref === opts.ref && e.owner === opts.owner
      );
      if (existing) return existing;
    }
    // **常駐かどうかは「サービス ✅」で決まる**（`20260801-service-lifecycle-model` design D3）。
    // 以前は `output !== undefined` から導出していたが、それだと
    // 「開いている間だけ PDF に落とす」も「常駐して溜めるだけ」も表現できなかった。
    // **意図（サービス）と能力（出力設定）は別の軸**にする
    const resident = opts.service === true;
    if (resident) {
      if (this.listeningPrinters(true) >= this.maxResidentPrinters) {
        throw new As400Error(
          "SESSION_LIMIT",
          `resident printer limit reached (${this.maxResidentPrinters})`
        );
      }
    } else if (this.size >= this.maxSessions) {
      throw new As400Error("SESSION_LIMIT", `session limit reached (${this.maxSessions})`);
    }
    // ホスト変換で受けているなら、自動印刷は PDF に起こさず受信バイトをそのまま流す
    const output =
      opts.output && opts.transformTo !== undefined
        ? { ...opts.output, rawPrint: true }
        : opts.output;
    const id = opts.id ?? randomUUID();
    const entry: PrinterEntry = {
      id,
      state: "stopped",
      openOpts: { ...opts, id },
      host: opts.host ?? "(injected)",
      origin: opts.origin ?? "direct",
      connectedAt: new Date(this.now()).toISOString(),
      lastActivity: this.now(),
      ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
      reports: [],
      receivedTotal: 0,
      delivered: 0,
      waiters: [],
      ...(output !== undefined ? { output } : {}),
      outputEnabled: true, // 既定は有効（設定があれば従来どおり自動出力）
      outputWarnings: [],
      outputStatuses: [],
      resident,
      ...(opts.service !== undefined ? { service: opts.service } : {}),
      ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {})
    };
    this.printers.set(id, entry);
    // **`autoStart ☐` なら待ち受けない。** 「開く（登録する）」と「待ち受ける」は別
    // （`20260801-service-start-stop`）。既定は true なので、いままでどおり開いたら待ち受ける
    if (opts.autoStart !== false) await this.startPrinter(id);
    return entry;
  }

  /**
   * **開き直しの材料を差し替える**（`20260801-service-reconcile`）。
   *
   * 定義が直されたときに呼ぶ。**いまの接続は落とさない**——動いているサービスを
   * 設定の保存で切ると、その瞬間に流れている帳票の受け取りが切れる。
   *
   * @returns いま接続を持っていたか。持っていれば**新しい設定はまだ効いていない**ので、
   *   `stale` を立てて画面に出す（利用者が止めどきを決める）
   */
  updatePrinterOptions(id: string, opts: OpenPrinterOptions): boolean {
    const entry = this.printers.get(id);
    if (!entry) throw new As400Error("SESSION_NOT_FOUND", `printer ${id} not found`);
    entry.openOpts = { ...opts, id };
    // ホスト変換で受けているなら、自動印刷は PDF に起こさず受信バイトをそのまま流す
    const output =
      opts.output && opts.transformTo !== undefined ? { ...opts.output, rawPrint: true } : opts.output;
    if (output !== undefined) entry.output = output;
    else delete entry.output;
    const running = holdsConnection(entry.state);
    if (running) entry.stale = true;
    else delete entry.stale;
    return running;
  }

  /**
   * 待ち受けを開始する（接続してホストから受け取り始める）。
   *
   * `stopped` / `error` からのみ動く。**冪等**——既に待ち受けていれば何もしない
   * （画面から二重に押されても壊れない）。
   */
  async startPrinter(id: string, user?: AuthUser): Promise<PrinterEntry> {
    const entry = this.getPrinter(id, user);
    if (entry.state === "listening" || entry.state === "reconnecting") return entry;
    // ここから張る接続は**差し替え済みの材料**を使う。もう「効いていない」ではない
    delete entry.stale;
    if (!entry.resident && this.size >= this.maxSessions) {
      throw new As400Error("SESSION_LIMIT", `session limit reached (${this.maxSessions})`);
    }
    const opts = entry.openOpts;
    let session: PrinterSession;
    try {
      session = await PrinterSession.connect({ ...opts, id });
    } catch (e) {
      // **開始の失敗は状態に残す。** 例外だけだと、画面を開いていない間の失敗が消える
      this.setPrinterState(entry, "error", e instanceof Error ? e.message : String(e));
      throw e;
    }
    entry.session = session;
    entry.lastActivity = this.now();
    session.on("report", (report) => this.deliverReport(entry, report));
    session.on("closed", () => {
      for (const w of entry.waiters.splice(0)) w(undefined);
      this.stopRescue(entry);
      // **明示停止なら状態は `stopped`。** `stopPrinter` が先に立てているので上書きしない
      if (entry.state !== "stopped") this.setPrinterState(entry, "error", "disconnected");
      delete entry.session;
    });
    // 書き出しプログラムが処理できないスプールを拾う見張り（装置名＝OUTQ が要る）
    this.startRescue(entry, opts);
    this.setPrinterState(entry, "listening", undefined, session.startupCode);
    return entry;
  }

  /**
   * 待ち受けを停止する。**エントリは消さない**——消すと一覧から落ちて再開できない。
   *
   * 接続は手放す。**仕事は失われない**——スプールはホストの OUTQ に残るので、
   * 停止は「いま消費しない」であって「取りこぼす」ではない。
   * 装置を掴んだまま受け取らないのは実害があるので、必ず手放す。
   */
  stopPrinter(id: string, user?: AuthUser): PrinterEntry {
    const entry = this.getPrinter(id, user);
    if (entry.state === "stopped") return entry; // 冪等
    // **先に状態を立てる**——`closed` ハンドラが「障害」と誤って記録しないように
    this.setPrinterState(entry, "stopped");
    this.stopRescue(entry);
    entry.session?.disconnect();
    delete entry.session;
    for (const w of entry.waiters.splice(0)) w(undefined);
    return entry;
  }

  private setPrinterState(
    entry: PrinterEntry,
    state: ServiceState,
    error?: string,
    startupCode?: string
  ): void {
    entry.state = state;
    if (state === "error" && error !== undefined) entry.error = error;
    else delete entry.error;
    entry.onState?.({
      state,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(startupCode !== undefined ? { startupCode } : {})
    });
  }

  /**
   * 受信した帳票を配る（push でも救出でも同じ道を通す）。
   * ここを 1 本にしておかないと、救出した帳票だけ自動出力（PDF/印刷）から漏れる。
   */
  private deliverReport(entry: PrinterEntry, incoming: SpoolReport): void {
    {
      // **受信時刻はここでしか刻まない。** 配る道が 1 本なので、ここで刻めば
      // push・待機者・自動出力・バッファのすべてが**同じ 1 個**を見る。
      // 刻んだものを作り直さずに使い回すのが要点——`onReport` にだけ元の
      // `incoming` を渡すと、live で届いた帳票にだけ時刻が無い、という差が生える
      const report: StoredReport = { ...incoming, receivedAt: this.now() };
      entry.reports.push(report);
      entry.receivedTotal++;
      // **上限を超えたら古いものから落とす。** 常駐は何日も動くので無制限にできない。
      // `delivered`（`waitSpool` の位置）も一緒にずらさないと、
      // 落とした分を「まだ渡していない」と数え続けて位置が壊れる
      if (entry.reports.length > REPORT_LIMIT) {
        const dropped = entry.reports.length - REPORT_LIMIT;
        entry.reports.splice(0, dropped);
        entry.delivered = Math.max(0, entry.delivered - dropped);
      }
      entry.lastActivity = this.now();
      entry.onReport?.(report);
      const waiter = entry.waiters.shift();
      if (waiter) {
        entry.delivered = entry.reports.length;
        waiter(report);
      }
      // サーバー側出力（PDF 自動蓄積・自動印刷）。設定があり実行時に有効なときだけ。
      // 失敗しても受信は妨げず、警告はログ＋履歴＋UI push に流す（entry 参照なのでトグルが即時効く）
      if (entry.output) {
        if (entry.outputEnabled) {
          const cfg = entry.output;
          void handleReport(report, cfg, (m) => this.noteOutputWarn(entry, m))
            .then((r) => this.noteOutputStatus(entry, buildOutputStatus(report.id, this.now(), cfg, r)))
            .catch((e) => {
              const msg = `printer output failed: ${e instanceof Error ? e.message : String(e)}`;
              this.noteOutputWarn(entry, msg);
              this.noteOutputStatus(entry, {
                spoolId: report.id,
                at: this.now(),
                ...(cfg.autoPdfDir ? { pdf: { ok: false, error: msg } } : {}),
                ...(cfg.autoPrint ? { print: { ok: false, printer: cfg.autoPrint, error: msg } } : {})
              });
            });
        } else {
          // 自動出力オフ中の受信は「スキップ」として記録する（何も起きていないことを画面で示す）
          this.noteOutputStatus(entry, { spoolId: report.id, at: this.now(), skipped: true });
        }
      }
    }
  }

  /**
   * 書き出しプログラムが処理できないスプールを拾う見張りを回す。
   *
   * **装置名（＝OUTQ）が分からなければ何もしない。** ホスト採番の装置名だと、どの待ち行列を
   * 見ればよいか決められないため。資格情報が無いときも同じ（pull 経路が開けない）。
   */
  private startRescue(entry: PrinterEntry, opts: OpenPrinterOptions): void {
    const outputQueue = opts.deviceName;
    if (!outputQueue || opts.host === undefined || opts.user === undefined) return;
    const connect: ConnectOptions = {
      host: opts.host,
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      user: opts.user,
      ...(opts.password !== undefined ? { password: opts.password } : {}),
      ...(opts.ccsid !== undefined ? { spoolCcsid: opts.ccsid } : {})
    };
    const tick = (): void => {
      if (entry.rescueBusy) return; // 前回が終わっていなければ見送る（重複取得を避ける）
      entry.rescueBusy = true;
      void rescueStuckSpools(connect, outputQueue, opts.rescueAction ? { action: opts.rescueAction } : {})
        .then((found) => {
          for (const r of found) {
            // push 型と同じ形の帳票にして同じ道で配る。利用者からは区別が要らない
            this.deliverReport(entry, {
              id: `spool-rescued-${r.entry.fileName}-${r.entry.fileNumber}`,
              pages: r.pages,
              raw: new Uint8Array(0) // pull 経路は SCS 生バイトを持たない
            });
          }
        })
        .catch((err: unknown) => sessionLog.warn({ sessionId: entry.id, err }, "スプール救出に失敗した"))
        .finally(() => {
          entry.rescueBusy = false;
        });
    };
    const timer = setInterval(tick, this.rescueIntervalMs);
    timer.unref?.();
    entry.rescueTimer = timer;
  }

  private stopRescue(entry: PrinterEntry): void {
    if (entry.rescueTimer) {
      clearInterval(entry.rescueTimer);
      entry.rescueTimer = undefined;
    }
  }

  getPrinter(id: string, user?: AuthUser): PrinterEntry {
    const entry = this.printers.get(id);
    if (!entry) throw new As400Error("SESSION_NOT_FOUND", `printer session ${id} not found`);
    assertOwner(entry.owner, user); // 認証時は所有者/admin のみ
    entry.lastActivity = this.now();
    return entry;
  }

  /**
   * 出力警告を記録する: サーバーログ（従来どおり）＋セッション履歴（上限あり）＋UI への push。
   * 画面から失敗に気づけるようにするための単一経路。
   */
  private noteOutputWarn(entry: PrinterEntry, message: string): void {
    printerLog.warn(message);
    const w = { at: this.now(), message };
    entry.outputWarnings.push(w);
    if (entry.outputWarnings.length > OUTPUT_WARN_LIMIT) entry.outputWarnings.shift();
    entry.onOutputWarn?.(w);
  }

  /** 自動出力の結果を記録して UI へ push する（成功も含めて画面に出すため） */
  private noteOutputStatus(entry: PrinterEntry, status: SpoolOutputStatus): void {
    entry.outputStatuses.push(status);
    if (entry.outputStatuses.length > OUTPUT_STATUS_LIMIT) entry.outputStatuses.shift();
    entry.onOutputStatus?.(status);
  }

  /** 自動出力（PDF 保存・自動印刷）の実行時 有効/無効を切り替える（所有者/admin のみ） */
  setPrinterOutputEnabled(id: string, enabled: boolean, user?: AuthUser): PrinterEntry {
    const entry = this.getPrinter(id, user);
    entry.outputEnabled = enabled;
    return entry;
  }

  /** 認証時は所有者のセッションのみ（admin は全件）。OFF は全件。 */
  private ownedOnly<T extends { owner?: string }>(entries: T[], user?: AuthUser): T[] {
    if (!user || user.role === "admin") return entries;
    return entries.filter((e) => e.owner === user.username);
  }

  /**
   * その id が**常駐**のプリンターか。WS が切断時に「切ってよいか」を判断するのに使う。
   *
   * 表示セッションや存在しない id は `false`——**知らないものを常駐扱いしない**
   * （切り忘れて溜まる方が、切りすぎるより後から気づきにくい）。
   */
  isResident(id: string): boolean {
    return this.printers.get(id)?.resident === true;
  }

  listPrinters(user?: AuthUser): PrinterEntry[] {
    return this.ownedOnly([...this.printers.values()], user);
  }

  /** 全セッション（表示＋プリンター）の要約。管理者画面用（所有者含む）。 */
  listAll(): SessionSummary[] {
    const disp: SessionSummary[] = [...this.sessions.values()].map((e) => ({
      id: e.id,
      kind: "display",
      host: e.host,
      origin: e.origin,
      connectedAt: e.connectedAt,
      ...(e.owner !== undefined ? { owner: e.owner } : {})
    }));
    const prt: SessionSummary[] = [...this.printers.values()].map((e) => ({
      id: e.id,
      kind: "printer",
      host: e.host,
      origin: e.origin,
      connectedAt: e.connectedAt,
      ...(e.owner !== undefined ? { owner: e.owner } : {})
    }));
    return [...disp, ...prt];
  }

  /**
   * 次の未受け取りスプールを返す。既に届いていれば即返し、無ければ timeoutMs まで待つ。
   * タイムアウト・切断時は undefined。
   */
  waitSpool(id: string, timeoutMs = 30_000, user?: AuthUser): Promise<SpoolReport | undefined> {
    const entry = this.getPrinter(id, user);
    if (entry.delivered < entry.reports.length) {
      return Promise.resolve(entry.reports[entry.delivered++]);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = entry.waiters.indexOf(onReport);
        if (idx >= 0) entry.waiters.splice(idx, 1);
        resolve(undefined);
      }, timeoutMs);
      const onReport = (r: SpoolReport | undefined): void => {
        clearTimeout(timer);
        resolve(r);
      };
      entry.waiters.push(onReport);
    });
  }

  list(user?: AuthUser): SessionEntry[] {
    return this.ownedOnly([...this.sessions.values()], user);
  }

  /**
   * このセッションを**ブラウザが見ているか**。
   *
   * 予約を取るかの判断に使う。**セッションの出どころで判断しない**——
   * いまブラウザは既存セッションへ後から繋げないので「MCP が開いたもの＝誰も見ていない」が
   * 成り立つが、**それは偶然の性質**で、後から繋げるようにした瞬間に崩れる。疎通の有無は不変。
   */
  hasViewer(id: string): boolean {
    return (this.sessions.get(id)?.viewers ?? 0) > 0;
  }

  /**
   * PC コマンドの実行状況を購読する。**返った関数を呼べば自分の分だけ外れる。**
   *
   * 解除を呼び出し側に閉じた関数で返すのが要点——`delete entry.onX` の形だと、
   * **他の購読者の分まで消してしまう**（そうなっていた）。
   */
  /**
   * **これまでに実行した PC コマンド**（受信順。上限 `PC_COMMAND_HISTORY`）。
   *
   * ブラウザを閉じている間に届いたコマンドは**実行はされるが通知が届かない**——
   * 購読者がいないので `pc-command` は誰にも配られず、記録だけが残っていた。
   * 繋ぎ直したときに「留守中に何が走ったか」を渡せるようにする
   * （backlog `pc-command.md`「常駐セッションでの扱い」）。
   */
  pcCommandHistory(id: string): PcCommandEvent[] {
    return [...(this.sessions.get(id)?.pcCommands ?? [])];
  }

  subscribePcCommand(id: string, fn: (e: PcCommandEvent) => void): () => void {
    const entry = this.sessions.get(id);
    if (!entry) return () => undefined;
    (entry.pcCommandSubscribers ??= new Set()).add(fn);
    return () => entry.pcCommandSubscribers?.delete(fn);
  }

  /** 予約の変化を購読する。**返った関数を呼べば自分の分だけ外れる** */
  subscribeReservation(id: string, fn: (r: SessionReservation | undefined) => void): () => void {
    const entry = this.sessions.get(id);
    if (!entry) return () => undefined;
    (entry.reservationSubscribers ??= new Set()).add(fn);
    return () => entry.reservationSubscribers?.delete(fn);
  }

  /** 見ている人が増えた（ws-handler が呼ぶ） */
  addViewer(id: string): void {
    const entry = this.sessions.get(id);
    if (entry) entry.viewers += 1;
  }

  /** 見ている人が減った。**下限は 0**（二重に外しても壊れない） */
  removeViewer(id: string): void {
    const entry = this.sessions.get(id);
    if (entry) entry.viewers = Math.max(0, entry.viewers - 1);
  }

  /**
   * 有効な予約（期限切れなら `undefined`）。**期限切れはここで刈る**ので、
   * 読み手が毎回 `expiresAt` を見比べる必要は無い。
   */
  reservationOf(id: string): SessionReservation | undefined {
    const entry = this.sessions.get(id);
    const r = entry?.reservation;
    if (!entry || !r) return undefined;
    if (r.expiresAt > this.now()) return r;
    this.setReservation(entry, undefined);
    return undefined;
  }

  private setReservation(entry: SessionEntry, r: SessionReservation | undefined): void {
    if (entry.reservationTimer) {
      clearTimeout(entry.reservationTimer);
      delete entry.reservationTimer;
    }
    if (r) {
      entry.reservation = r;
      // **期限が来たら自分で切って知らせる。** 読まれるのを待たない
      const timer = setTimeout(() => {
        if (entry.reservation === r) this.setReservation(entry, undefined);
      }, Math.max(0, r.expiresAt - this.now()));
      timer.unref?.();
      entry.reservationTimer = timer;
    } else {
      delete entry.reservation;
    }
    for (const fn of entry.reservationSubscribers ?? []) fn(r);
  }

  /**
   * セッションを予約する。**既に別の主体が持っていれば `SESSION_RESERVED`**
   * （`assertWritable` の予約検査がそのまま効く）。
   * 同じ主体の再予約は期限の延長として通る——HLLAPI 側で何度呼ばれても壊れない。
   */
  reserve(
    id: string,
    holder: string,
    label: string,
    user?: AuthUser,
    ttlMs: number = RESERVATION_TTL_MS
  ): SessionEntry {
    const entry = this.assertWritable(id, user, holder);
    this.setReservation(entry, { holder, label, ttlMs, expiresAt: this.now() + ttlMs });
    return entry;
  }

  /** 予約を解除する。**持ち主でなければ何もしない**（他人の予約を横から外させない） */
  release(id: string, holder: string, user?: AuthUser): SessionEntry {
    const entry = this.get(id, user);
    const current = this.reservationOf(id);
    if (current?.holder === holder) this.setReservation(entry, undefined);
    return entry;
  }

  /**
   * 予約を**持ち主でなくても**外す。利用者が自分のセッションを取り戻すための非常口。
   *
   * 自動化が落ちて `Release` を送れないまま期限が切れるのを待つ、という状況を避ける。
   * `get` を通すので**自分のセッションにしか効かない**——権限の穴にはならない。
   */
  forceRelease(id: string, user?: AuthUser): SessionEntry {
    const entry = this.get(id, user);
    this.setReservation(entry, undefined);
    return entry;
  }

  /** 予約の期限を延ばす（持ち主からの操作があったとき）。持ち主でなければ何もしない */
  touchReservation(id: string, holder: string): void {
    const entry = this.sessions.get(id);
    const current = this.reservationOf(id);
    if (!entry || current?.holder !== holder) return;
    // **その予約自身の長さで延ばす**（HLLAPI と MCP で違う）
    this.setReservation(entry, { ...current, expiresAt: this.now() + current.ttlMs });
  }

  /**
   * 予約による締め出しを検査する。
   *
   * **`assertWritable` / `assertKeyAllowed` の内側に置く**——書き込みの経路は
   * WebSocket・MCP・HLLAPI の 3 つあり、経路ごとに書くと足し忘れる。
   * `holder` を渡さない呼び出し（＝人間や MCP）は、予約中なら一律で断られる。
   */
  private assertNotReserved(id: string, holder: string | undefined): void {
    const r = this.reservationOf(id);
    if (r && r.holder !== holder) {
      throw new As400Error("SESSION_RESERVED", `session ${id} is reserved by ${r.label}`);
    }
  }

  /**
   * 書き込み操作の可否を検査（readOnly なら READ_ONLY_SESSION／所有者でなければ FORBIDDEN／
   * 他の主体が予約中なら SESSION_RESERVED）。
   *
   * @param holder 予約の持ち主として振る舞う主体。**省略＝人間の操作**として扱う
   */
  assertWritable(id: string, user?: AuthUser, holder?: string): SessionEntry {
    const entry = this.get(id, user);
    if (entry.readOnly) {
      throw new As400Error("READ_ONLY_SESSION", `session ${id} is read-only`);
    }
    this.assertNotReserved(id, holder);
    return entry;
  }

  /** AID キーの可否を検査（readOnly は PageUp/PageDown のみ許可。予約中は持ち主のみ） */
  assertKeyAllowed(id: string, key: AidKey, user?: AuthUser, holder?: string): SessionEntry {
    const entry = this.get(id, user);
    if (entry.readOnly && !READONLY_ALLOWED_KEYS.has(key)) {
      throw new As400Error("READ_ONLY_SESSION", `key ${key} not allowed on read-only session`);
    }
    this.assertNotReserved(id, holder);
    return entry;
  }

  async close(id: string, user?: AuthUser): Promise<void> {
    const entry = this.sessions.get(id);
    if (entry) {
      assertOwner(entry.owner, user);
      entry.recorder?.stop(); // 購読を残したままセッションを捨てるとリークする
      entry.session.disconnect();
      this.sessions.delete(id);
      return;
    }
    const printer = this.printers.get(id);
    if (printer) {
      assertOwner(printer.owner, user);
      // **破棄は停止と別**——停止は残す、破棄は消す（`20260801-service-start-stop`）
      this.stopRescue(printer);
      printer.session?.disconnect();
      this.printers.delete(id);
      return;
    }
    throw new As400Error("SESSION_NOT_FOUND", `session ${id} not found`);
  }

  closeAll(): void {
    for (const entry of this.sessions.values()) entry.session.disconnect();
    this.sessions.clear();
    for (const entry of this.printers.values()) entry.session?.disconnect();
    this.printers.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * 在席の証拠を受けて `lastActivity` を進める（表示・プリンターの両方）。
   *
   * 利用者が入力欄に文字を打っても、値はブラウザ内の `edits` に溜まるだけで
   * **AID キーを押すまで WS に何も流れない**。読んでいる時間・カーソル移動も同じで、
   * サーバーからは無操作に見える。有限値を設定したときに「設定した時間より早く切れる」のを
   * 塞ぐための口（spec 方針4。通知そのものは値を運ばない）。
   *
   * **所有者検査をしない**のは、id が呼び出し元（WS 接続）自身が開いたものに限られ、
   * クライアントから来た値ではないため。存在しない id は黙って無視する
   * （既に閉じたセッションへの遅延メッセージ）。
   */
  touch(id: string): void {
    const entry = this.sessions.get(id) ?? this.printers.get(id);
    if (entry) entry.lastActivity = this.now();
  }

  /**
   * アイドル超過のセッションを切る。**判定はエントリごと**——マネージャ共通の cutoff を
   * 1 つ作って全部と比べると、セッション設定の値が効かない。
   * `"never"`（永続）のエントリは対象外。
   */
  private sweepIdle(): void {
    const now = this.now();
    const expired = (entry: { lastActivity: number; idleTimeoutMs?: IdleLimit }): boolean => {
      const limit = entry.idleTimeoutMs ?? this.idleTimeoutMs;
      return limit !== "never" && entry.lastActivity < now - limit;
    };
    for (const [id, entry] of this.sessions) {
      if (expired(entry)) {
        entry.session.disconnect();
        this.sessions.delete(id);
      }
    }
    for (const [id, entry] of this.printers) {
      // **常駐は掃除しない。** 何も届かない状態が正常なので、
      // アイドルを「使われていない」の合図にできない（design D1 / watch-registry と同じ理屈）
      if (entry.resident) continue;
      if (expired(entry)) {
        entry.session?.disconnect();
        this.printers.delete(id);
      }
    }
  }
}
