import { isSplitLead, isSplitTail } from "../screen/attr-sentinel.js";
import { codecForCcsid, type Codec } from "@ts5250/ebcdic";
import { As400Error, deviceEnvFor, type KatakanaVariant } from "@ts5250/base";
import { parseRecord, buildNegativeResponse, buildRecord } from "../protocol/gds.js";
import { COMMAND, ESC, OPCODE } from "../protocol/constants.js";
import { nvtTextToWtd, type NvtCursor } from "../telnet/nvt-text.js";
import {
  buildReadMdtResponse,
  buildReadMdtAltResponse,
  buildReadInputFieldsResponse,
  buildReadImmediateResponse,
  buildReadMdtImmediateAltResponse,
  buildFlagRecord,
  buildCancelInviteAck,
  encodedFieldLength
} from "../protocol/read-response.js";
import { buildQueryReply, buildWsfD972Reply } from "../protocol/query-reply.js";
import {
  buildSaveScreenResponse,
  buildSavePartialScreenResponse,
  buildReadScreenResponse,
  buildReadScreenExtendedResponse
} from "../protocol/save-screen.js";
import type { PcCommandRequest } from "../protocol/pc-command.js";
import { applyDataStream, SENSE, type ApplyResult } from "../protocol/wtd-applier.js";
import { ScreenBuffer, type InternalField } from "../screen/buffer.js";
import { validateFieldContent } from "../screen/field-validate.js";
import type { ScreenSnapshot } from "../screen/types.js";
import { TelnetLayer } from "../telnet/telnet.js";
import {
  parseStartupResponse,
  startupCodeMeaning,
  isKnownStartupCode,
  STARTUP_SUCCESS_CODES,
  type StartupResponse
} from "../telnet/startup-record.js";
import { TcpTransport } from "../transport/tcp.js";
import type { Transport } from "../transport/types.js";
import { Emitter } from "./emitter.js";
import { aidCodeOf, aidKeyForCode, type AidKey } from "./aid-keys.js";
import { terminalTypeFor } from "./terminal-type.js";

/** `reconnecting`: ホストに切られて自動で繋ぎ直している間（`ConnectOptions.autoReconnect`） */
export type SessionState = "connecting" | "negotiating" | "ready" | "locked" | "reconnecting" | "closed";

export interface ConnectOptions {
  host?: string;
  port?: number;
  ccsid?: number; // 既定 37。930/939/1399（＋エイリアス）で DBCS
  /** 930（Katakana 系）だけが持つキーボード配列の選択（`@ts5250/base` の `KatakanaVariant` 参照。5026 は対象外——`20260922-katakana-selector-merge` D1） */
  katakanaVariant?: KatakanaVariant;
  /**
   * スプール（SCS）のデコードに使う CCSID。既定 273。上の `ccsid` を流用**しない**——
   * あちらは 5250 画面の文字変換用で、経路によって扱いが違う（spec 方針2）。
   * 5250 セッションでは使われず、ホストサーバー経由のスプール取得だけが読む。
   */
  spoolCcsid?: number;
  screenSize?: "24x80" | "27x132";
  /**
   * 装置名。**ACS と同じく置換記号（`%` `*` `=` `+` `&COMPN` `&USERN`）を展開し、大文字にして送る**
   * （`telnet/device-name.ts`）。`=` を含めば、使用中のとき同じ接続の中で次の番号で答え直す
   */
  deviceName?: string;
  /** 置換記号の展開に使う機械名・利用者名（`&COMPN` / `&USERN`）。このパッケージは Node の API に触れないので呼び出し側が渡す */
  deviceNameEnv?: { computerName?: string; userName?: string };
  /** 記号の無い装置名でも、使用中なら末尾の数字を繰り上げて答え直す（当 PJ の `deviceNameRetry`。5 回まで） */
  deviceNameRetry?: boolean;
  /**
   * **TCP キープアライブを入れるか**（既定 false。ACS も既定で入れない——`SESSION_KEEPALIVE`）。入れると、一時的な回線断（LAN ケーブルの抜き差し・Wi-Fi の切り替え）でも
   * 無通信のあいだに探査が失敗して接続が落ちる（Windows は 10 秒ほど）。途中の機器が無通信の接続を落とす環境だけ true にする（`transport/tcp.ts` の注記）
   */
  keepAlive?: boolean;
  /**
   * **関連付けプリンターの装置名**（表示セッションだけ。`20260921-associated-printer`）。空白だけなら申告しない。
   * 申告の位置と値の扱いは `TelnetOptions.associatedPrinter`
   */
  associatedPrinter?: string;
  /**
   * 自動サインオンの代替パスワードを作る関数（渡せば ACS と同じく暗号化して送る。`telnet.ts` の `passwordSubstitute`）。
   * 計算は QPWDLVL で分かれ、その値はサインオン・サーバーに聞く——このパッケージはホストサーバーに依存しないので呼び出し側が渡す
   */
  passwordSubstitute?: ((serverSeed: Uint8Array) => Promise<{ clientSeed: Uint8Array; substitute: Uint8Array }>) | undefined;
  /** TLS（telnet over SSL。既定ポート 992・証明書検証既定 ON） */
  tls?: boolean | { rejectUnauthorized?: boolean; ca?: string | string[] };
  /** RFC 4777 自動サインオン（decisions.md D3）。user と password を併せて指定する */
  user?: string;
  password?: string;
  /** 拡張 5250 GUI（Query Reply で enhanced 広告。Create Window / 選択フィールド / スクロールバーを受ける） */
  enhanced?: boolean;
  /** セッション ID（server が UUID を与える。省略時は連番） */
  id?: string;
  connectTimeoutMs?: number;
  /** ネゴシエーション〜初回画面までのタイムアウト（既定 15 秒） */
  negotiationTimeoutMs?: number;
  /** テスト・リプレイ用の Transport 注入（指定時は host 不要） */
  transport?: Transport;
  /** 警告ログの受け口（既定: 捨てる。server が pino へ接続する） */
  warn?: (message: string) => void;
  /**
   * PC Organizer（`STRPCCMD`）でホストから届いたコマンドの実行係。
   *
   * **未指定なら実行しない**（core はコマンドを実行しない。node の API を持ち込まないため）。
   * 指定しても、実行の可否・許可リスト・タイムアウトは呼び出し側の責任
   * ——ここでは「`wait` が真なら完了を待ってからホストへ実行キーを返す」だけを保証する。
   */
  onPcCommand?: (cmd: PcCommandRequest) => Promise<void> | void;
  /**
   * 受信レコードを hex で warn に流す（既定 off）。**障害切り分け専用**。
   * 「画面が変わらないのにアンロックもされない」ときに、ホストが何を送ったかを見る唯一の手段。
   * 画面の中身が warn 経由でログに出るため、常用しないこと。
   */
  traceRecords?: boolean;
  /**
   * **ホストに切られたら自動で繋ぎ直す**（ACS `ECLConnection` の自動再接続。`20260921-auto-reconnect`）。
   *
   * 確立した後にホストから切られたとき（ACS の通信状態 2＝通常の切断。`SIGNOFF ENDCNN(*YES)`・
   * 無操作の切断・回線断）だけ、**1 回目は即座に、以後 `reconnectIntervalMs` おきに上限なく**試す
   * （`ECLConnection.run()` は `Thread.sleep(20000)` して `StartCommunication`）。
   * **`disconnect()` で自分から切ったとき**と、**ホストが起動応答で拒否したとき**（自動サインオンの失敗・拒否など。
   * ACS の状態 33/34 は再接続の条件に当たらない）は繋ぎ直さない——パスワードの誤りで試し続けて
   * プロファイルを無効化させる輪にならない。
   *
   * **既定は false**。ACS も ECL のコアは既定 false（`SESSION_AUTORECONNECT`）で、画面の層（HOD の bean。
   * 既定 true）が ON にしている。自動操作の接続では、知らないうちに別の画面へ変わらないよう OFF のままにする。
   */
  autoReconnect?: boolean;
  /** 自動再接続の 2 回目以降の間隔（既定 20000＝ACS の値） */
  reconnectIntervalMs?: number;
  /**
   * 接続のたびに Transport を作る（自動再接続の試験・注入用）。指定が無ければ `transport` を最初の 1 回だけ使い、
   * それも無ければ TCP で繋ぐ。
   */
  transportFactory?: () => Promise<Transport>;
}

export interface SendAidOptions {
  cursor?: { row: number; col: number };
  /**
   * キーボードアンロック待ちのタイムアウト。既定 30 秒（Attn / SysReq は待たないので無効）。
   *
   * **`"never"` は期限を設けない**——原典（tn5250j / lib5250）にも実機の OIA にも
   * 「時間で諦めて施錠を解く」という動作は無く、`X SYSTEM` は**点いたまま待つのが正常**
   * （`aid-response-timeout` の裏取り）。人が見ている端末はこちらに倒す。
   *
   * 自動操作（MCP / HLLAPI）は**必ず値を返さねばならない**ので有限値を使う。
   * `0` や負値を「無期限」の印にしないのは `idleTimeout` と同じ理由——未設定・転記漏れと
   * 見分けが付かなくなる。
   */
  timeoutMs?: number | "never";
  /**
   * **SysReq 専用**: システム要求行に打たれた文字列。セッションの CCSID で EBCDIC 化して
   * SRQ レコードのデータに載せる（空・未指定ならデータ無し＝システム要求メニューが出る）。
   * 入力欄そのものは端末側のローカル機能で、ホストとの往復を伴わない。
   * **SysReq 以外のキーに付けたら PROTOCOL_ERROR**（黙って捨てると、送ったつもりの文字列が
   * どこにも行かないまま成功したように見える）。
   */
  sysReqText?: string;
}

export interface SendAidResult {
  screen: ScreenSnapshot;
  /** タイムアウト時 true（エラーにはしない。spec「AID 応答タイムアウト」） */
  timedOut: boolean;
}

interface SessionEvents extends Record<string, unknown[]> {
  screen: [ScreenSnapshot];
  closed: [string];
  /** **自動で繋ぎ直そうとしている**（`attempt` は 1 から。`reason` は切られた理由） */
  reconnecting: [{ attempt: number; reason: string }];
  /** 繋ぎ直せた（新しい起動応答。装置名が変わることがある）。**新しい画面の `screen` はこれより先に届く** */
  reconnected: [StartupResponse | undefined];
  /**
   * **ホストが警報を鳴らせと言ってきた**（WTD の CC2 ビット 0x04）。
   * ACS は `ps.ringBell()` で端末のベルを鳴らす。以前は `ApplyResult.alarm` を立てるだけで
   * 読み手がどこにも無く、**実機が鳴らす場面で当方だけ無反応**だった。
   */
  alarm: [];
}

/** セッション ID の連番（id 未指定時のフォールバック） */
let seq = 0;

/**
 * **オペコードごとに、どこからをデータストリームとして読むか**（ACS `DS5250.processPassthru`。`20260921-negative-responses` の節目の点検の指摘）。
 * - NOOP・CANCEL INVITE・メッセージ灯（0x00・0x0A・0x0B・0x0C）: 読まない（空）
 * - OUTPUT ONLY・RESTORE SCREEN（0x02・0x05）: 最初の 0x04 まで読み飛ばしてから（ACS `while (savebuff[n3] != 4) ++n3`）
 * - SAVE SCREEN（0x04）でデータが `04 02` で始まり長さ 4 以上: **SAVE SCREEN だけ**（ACS `tokenizeData` の case 4 は `processSaveScreen()` だけを呼び、
 *   レコードの残りを読まない。実機の ACS のコアでも `[SAVE SCREEN][WSF Query]` の Query に答えなかった——`20260928-response-order`）
 * - それ以外の ACS が知っているオペコード（0x01〜0x11）: そのまま
 * - 知らないオペコード: `undefined`（読まずに否定応答 0x10030101）
 */
function streamOf(opcode: number, data: Uint8Array): Uint8Array | undefined {
  switch (opcode) {
    case OPCODE.NOOP:
    case OPCODE.CANCEL_INVITE:
    case OPCODE.MESSAGE_LIGHT_ON:
    case OPCODE.MESSAGE_LIGHT_OFF:
      return new Uint8Array(0);
    case OPCODE.SAVE_SCREEN:
      return data.length >= 4 && data[0] === ESC && data[1] === COMMAND.SAVE_SCREEN ? data.subarray(0, 2) : data;
    case OPCODE.OUTPUT_ONLY:
    case OPCODE.RESTORE_SCREEN: {
      const at = data.indexOf(ESC);
      return at < 0 ? new Uint8Array(0) : data.subarray(at);
    }
    default:
      return opcode <= 0x11 ? data : undefined;
  }
}

/**
 * 5250 セッション（design の状態機械: Connecting → Negotiating → Ready ⇄ Locked → Closed）。
 * Locked 中もホスト発 WTD は画面に適用し続ける（複数レコードで画面が組まれるケース）。
 */
/** ホストのエラーの間に溜めるレコードの上限（`hostHeld`）。超えたらエラー状態を抜けて流す */
const HOST_HELD_LIMIT = 500;

export class Session5250 extends Emitter<SessionEvents> {
  readonly id: string;
  private state: SessionState = "connecting";

  /** 繋ぎ直すたびに作り直す（前の接続の書式・退避画面を持ち越さない） */
  private buf: ScreenBuffer;
  /** 接続の設定（自動再接続で同じ設定のまま繋ぎ直すために持つ） */
  private readonly opts: ConnectOptions;
  /** `disconnect()` で自分から切った（自動再接続しない） */
  private userClosed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * **接続の世代**（張り直すたびに増やす）。前の接続のために始めた非同期の処理（PC コマンドの完了応答）を、
   * 張り直した後の接続へ送らないため（独立点検の指摘: 新しいジョブのサインオン画面へ前のジョブ宛の Enter が飛ぶ）。
   */
  private connGen = 0;
  /**
   * 新しい接続の最初のレコードで画面を作り直す。**試行の開始では作り直さない**——交渉中に切られた試行のあと、
   * 空の画面が送られて白くなるため（D3「前の画面は新しい接続の最初のレコードまで残す」）。
   */
  private freshBufferPending = false;
  /**
   * **ホストのエラーのメッセージを出している間に届いた WTD と、その後ろのレコード**（`20260927-host-error-hold`）。
   * ACS は WRITE ERROR CODE のメッセージを出している間、WTD の処理の頭でデータ処理を止め（`DS5250.checkContention`）、エラー状態を
   * 抜けて（Reset・カーソルキー・AID など）から処理する——後ろのレコードも止まった WTD の後に並ぶ。実機の ACS のコアでも、
   * エラーの間に来た WTD は Reset の後に画面に出た（`20260927-error-msgline-wtd`）。`dismissHostError` で抜けて順に処理する
   */
  private hostHeld: Uint8Array[] = [];
  /**
   * **その場で戻った否定応答のレコードの SAVE PARTIAL の応答**。ACS は次のレコードの終わりで送る（`20260927-early-return-rest`）。
   * ACS の退避データは 1 つの置き場（`saveddata`）で、新しい SAVE PARTIAL が来れば上書きされ、送るのは 1 本だけ——同じく 1 つだけ持つ
   */
  private carriedSavePartial: Uint8Array | undefined;
  private holdingForHostError = false;
  /**
   * **SysReq の行を出している**（画面の側が知らせる。`setSysReqLine`）。ACS はエラーのメッセージと同じ仕組み（メッセージ行の退避＝`getMsgLinePos() != -1`）で
   * ホストの WTD を止める（`checkContention`）。実機の ACS のコア（DSM の LATEWTD・`scripts/acs-probe/sysreq-line-hold.txt`）: 行を出している間に届いた 5 行目の LATE は、
   * Reset で行を閉じるまで出なかった（`20260927-sysreq-line-hold`）
   */
  private sysReqLineOpen = false;
  /**
   * **保留が始まったレコードの、それより前の WTD の CC2（警報・メッセージ待ち）**。ACS は `processWCC2` をレコードの終わりで呼ぶので、
   * `checkContention` で止まっている間は効かず、抜けて残りを処理し終えてから効く（実機の ACS のコア: DSM の HOLDCC2 で、メッセージ待ちは Reset の後に点いた）。
   * 止めた出力を流し終えたときに当てる（`releaseHeld`）
   */
  private heldCc2: { alarm: boolean; messageWaiting?: boolean } | undefined;
  /** 保留が始まったレコードの残り（組み直して溜めの先頭へ置いたもの）。これを流し終えたときがレコードの終わり＝持ち越した CC2 を当てる時 */
  private heldRemainder: Uint8Array | undefined;
  private readonly codec: Codec;
  private readonly terminalType: string;
  /** 申告する画面サイズ。Query Reply の画面能力バイトに反映する（ACS と同じ） */
  private readonly screenSize: "24x80" | "27x132";
  private readonly enhanced: boolean;
  private telnet!: TelnetLayer;
  private readonly warn: (message: string) => void;
  private readonly traceRecords: boolean;
  private readonly onPcCommand: ((cmd: PcCommandRequest) => Promise<void> | void) | undefined;
  /** メッセージ待ち表示灯（MESSAGE_LIGHT_ON/OFF）。OIA 表示に使える */
  messageWaiting = false;
  /**
   * 起動応答レコードで分かったこと（応答コード・システム名・**実際の装置名**）。
   * 接続直後の 1 レコード目で埋まる。来なければ `undefined`。
   */
  private startupInfo: StartupResponse | undefined;
  /** 1 レコード目かどうか。起動応答の判定はここだけで行う */
  private firstRecord = true;
  /**
   * **いま入力待ちにさせている Read のコマンドバイト。**
   *
   * `0x52`（READ MDT FIELDS）が普通で、これが既定。`0x42`（READ INPUT FIELDS）のときだけ
   * **応答の形式が変わる**ので、AID を返すときに見る（`buildReadInputFieldsResponse`）。
   */
  private readCommand: number = COMMAND.READ_MDT_FIELDS;
  private pendingAid:
    | { resolve: (r: SendAidResult) => void; timer?: ReturnType<typeof setTimeout> }
    | undefined;
  /**
   * **ホストの READ が出ていて、まだ AID で応えていないか**（ACS `DS5250.pending_read`）。READ の無い WRITE ERROR CODE だけのレコードでも
   * ACS は施錠を解くので（`initKeyboard`）、施錠が解けていても READ が出ているとは限らない（`20260927-wec-only-unlock`）
   */
  private readOutstanding = false;
  /**
   * **READ が出ていない間に押された AID**（ACS `DS5250.pending_aid`）。ACS は溜めて、次の READ が来たときに**そのときの画面で**送る
   * （`checkPendingAid`）。実機の ACS のコア: 0x21 だけのレコードの後に Reset → `AB` → Enter と打つと、10 秒後の READ MDT が F1・`AB` を受けた。
   * 待ち（`pendingAid`）が時間切れになっても溜めたままにする（ACS に時間切れは無く、次の READ で送る）。捨てるのは WEC・Attn / SysReq・繋ぎ直し（CC1 の施錠では捨てない——実測）。
   * ⚠ ACS との未対応の差（decisions D2）: ACS は CANCEL INVITE・WSF でも `pending_read` を下ろし、オペコード（INVITE・PUT/GET）だけで立て、RESTORE で `pending_read`・`pending_aid` を戻す
   */
  private deferredAid: { key: AidKey; sysReqText?: string; cursor: { row: number; col: number } } | undefined;

  private constructor(opts: ConnectOptions) {
    super();
    this.opts = opts;
    this.id = opts.id ?? `sess-${++seq}`;
    this.codec = codecForCcsid(opts.ccsid ?? 37);
    this.warn = opts.warn ?? (() => {});
    this.traceRecords = opts.traceRecords ?? false;
    this.onPcCommand = opts.onPcCommand;
    // 代替バッファの許可は、端末タイプでホストに申告した内容と一致させる（27x132 と申告した
    // ときだけ許可する）。ホストは 27x132 対応端末にだけ CLEAR UNIT ALTERNATE を送ってくる。
    this.buf = Session5250.newBuffer(opts);
    this.screenSize = opts.screenSize ?? "24x80";
    this.terminalType = terminalTypeFor(opts.ccsid ?? 37, this.screenSize);
    this.enhanced = opts.enhanced ?? false;
  }

  /** 画面バッファを作る。代替バッファ（27x132）は申告した画面サイズのときだけ許す */
  private static newBuffer(opts: ConnectOptions): ScreenBuffer {
    return new ScreenBuffer(opts.screenSize === "27x132" ? { alternate: "27x132" } : {});
  }

  static async connect(opts: ConnectOptions): Promise<Session5250> {
    const session = new Session5250(opts);
    const transport = opts.transportFactory
      ? await opts.transportFactory()
      : (opts.transport ?? (await session.openTcp()));
    await session.establish(transport, true);
    return session;
  }

  /** TCP で繋ぐ（`host` が要る） */
  private async openTcp(): Promise<Transport> {
    const opts = this.opts;
    if (opts.host === undefined) {
      throw new As400Error("CONNECT_FAILED", "host is required (or inject transport)");
    }
    return TcpTransport.connect({
      host: opts.host,
      port: opts.port ?? (opts.tls ? 992 : 23), // TLS 既定 992・平文 23
      ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      keepAlive: opts.keepAlive === true // 表示セッションは既定で入れない（ACS と同じ）
    });
  }

  /**
   * telnet の交渉から初回の画面までを済ませる（最初の接続と自動再接続で共通）。
   * `initial` のときだけ、交渉中に切られたら `closed` を出す（繋ぎ直しの途中の失敗は、繋ぎ直しの輪が扱う）。
   */
  private async establish(transport: Transport, initial: boolean): Promise<void> {
    const opts = this.opts;
    // **繋ぎ直しの交渉中は `reconnecting` のまま**にする。`negotiating` にすると `assertNotClosed` の門を素通りして、
    // 交渉途中の接続へ Attn 等が流れる（独立点検の指摘）。画面が来れば `handleRecord` が `ready` にする
    if (initial) this.state = "negotiating";
    this.connGen++;
    this.nvt.pos = 0; // 交渉の前のテキストの桁は、繋ぎ直しのたびに先頭から（telnet 層は新しい。5250 のレコードが来れば以後テキストにはならない）
    // RFC 2877 KBDTYPE/CODEPAGE/CHARSET を申告し、ホストにデバイス⇄ジョブ CCSID の変換をさせる
    const dev = deviceEnvFor(opts.ccsid ?? 37, opts.katakanaVariant);
    this.telnet = new TelnetLayer(transport, {
      terminalType: this.terminalType,
      deviceName: opts.deviceName,
      deviceNameEnv: { ...opts.deviceNameEnv, printer: false },
      deviceNameRetry: opts.deviceNameRetry,
      associatedPrinter: opts.associatedPrinter,
      passwordSubstitute: opts.passwordSubstitute,
      user: opts.user,
      password: opts.password,
      kbdType: dev?.kbdType,
      codePage: dev?.codePage,
      charSet: dev?.charSet
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timeoutMs = opts.negotiationTimeoutMs ?? 15_000;
      const timer = setTimeout(() => {
        // 8902 で次の名前を待っていたなら、その理由を残す（一般的な「時間切れ」に負けさせない。節目の点検の懸念）
        reject(
          this.retriedRejection !== undefined
            ? new As400Error("SESSION_REJECTED", `${this.retriedRejection}; the host did not ask for another name within ${timeoutMs}ms`)
            : new As400Error("NEGOTIATION_TIMEOUT", `no screen within ${timeoutMs}ms`)
        );
        // **先に reject する**（close が同期で onClose を呼び、そちらの文言で先に決まってしまうため）
        this.telnet.close();
      }, timeoutMs);
      const onFirstReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.onceReady = onFirstReady;
      this.requestedDevice = opts.deviceName;
      // **ホストが理由を返してきたら、それを接続の失敗にする**（`onClose` より先に届く）
      this.onNegotiationError = (e) => {
        clearTimeout(timer);
        // **先に reject する。** `close()` は `onClose` を同期で呼び、そこが
        // `SESSION_CLOSED closed during negotiation` で先に settle してしまう
        // ——せっかく分かった理由（`8902` 等）が一般的な文言に負ける（実機で踏んだ）
        reject(e);
        this.telnet.close();
      };
      this.telnet.onClose((reason) => {
        clearTimeout(timer);
        if (initial) this.finalClose(reason);
        // **装置名を指定していてネゴシエーション中に切られたら、まず装置名の重複を疑う。**
        // ~~IBM i は要求された装置が既に使用中だと、理由を返さずソケットを閉じる~~ → 両方の実機で 8902 を返し、同じ接続の中で
        // 装置名を聞き直してきた（`20260921-device-name-acs`）。それでも理由なく閉じられたときの手掛かりとして残す。生の
        // 「socket closed」だけだと利用者は原因に辿り着けない（同じ設定で 2 本目を開いた等）。
        const hint =
          opts.deviceName !== undefined
            ? `（装置名 ${this.telnet.deviceName ?? opts.deviceName} が既に使用中の可能性があります）`
            : "";
        if (this.retriedRejection !== undefined) {
          reject(new As400Error("SESSION_REJECTED", `${this.retriedRejection}; closed while answering with another name: ${reason}`));
          return;
        }
        // **理由をログにも残す。** この`As400Error`のmessageはクライアントへ`sendError`で
        // 届くが、`SESSION_CLOSED`はweb-ui側の`wsErrorNotice`が汎用文言（「セッションは
        // 閉じています」）に潰して画面には出さない（`CODES_WITH_FIELD_DETAIL`に無いコード）。
        // サーバー側ログ（VSCode拡張の出力パネル含む）にだけは実際の理由を残しておかないと、
        // 起動応答（I901/I902）まで成功したのに直後に切れる、という切り分けが利用者側から
        // 一切できなくなる（実機報告で踏んだ）
        this.warn(`closed during negotiation: ${reason}${hint}`);
        reject(new As400Error("SESSION_CLOSED", `closed during negotiation: ${reason}${hint}`));
      });
      this.telnet.onError((err) => this.warn(`transport error: ${err.message}`));
      // 交渉の前に届いたテキスト（ゲートウェイのバナー等）は、合成した WTD で画面へ出す（ACS `NVT.NVT_process_outbound`。`nvt-text.ts`）
      this.telnet.onNvtText((text) => this.handleNvtText(text));
      this.telnet.onRecord((rec) => this.handleRecord(rec));
    });

    transport.start?.();
    await ready;

    // 接続完了後は onClose を通常処理に差し替える
    this.telnet.onClose((reason) => this.handleClose(reason));
  }

  private onceReady: (() => void) | undefined;

  /** 交渉の前に届いたテキストの桁の位置（`nvt-text.ts`） */
  private readonly nvt: NvtCursor = { pos: 0 };

  /**
   * **交渉の前に届いたテキストを画面へ書く**。合成した WTD を通常のレコードと同じ道（`handleRecord`）へ流す。
   * ただし**起動応答の候補（最初の 5250 のレコード）には数えない**——バナーの後に本物の起動応答が来る構成を壊さないため。
   * 画面に出したら接続の待ちは解く（時間切れにしない）が、**キーボードは施錠のまま**（ACS はここで解錠して NVT の入力を送れるが、
   * 当 PJ は 5250 の AID を交渉前の相手へ送らない。読むだけ）
   */
  private handleNvtText(text: Uint8Array): void {
    if (this.state === "closed") return;
    const wtd = nvtTextToWtd(text, this.nvt, this.buf.cols, this.buf.rows);
    const wasFirst = this.firstRecord; // 合成した WTD が最初のレコードの権利を使い切らないよう、終わったら戻す
    try {
      this.handleRecord(buildRecord(OPCODE.OUTPUT_ONLY, wtd));
    } finally {
      this.firstRecord = wasFirst;
    }
    if (this.onceReady !== undefined) {
      if (this.state === "negotiating") this.state = "locked";
      this.onceReady();
      this.onceReady = undefined;
    }
  }
  /**
   * 交渉中の失敗を接続待ちへ返す口（`20260802-device-busy-record`）。
   * ホストが**失敗の起動応答**を返してきたときに使う——`onClose` では
   * 「切れた」としか言えず、理由（`8902` 等）が落ちる。
   */
  private onNegotiationError: ((e: As400Error) => void) | undefined;
  /** 要求した装置名。失敗の起動応答には装置名が入らないので、文言に添えるために持つ */
  private requestedDevice: string | undefined;
  /**
   * 8902（使用中）を受けて次の名前で答え直している最中なら、その拒否の文言。ホストが聞き直してこないまま時間切れ・切断に
   * なったとき、**理由（8902）を失わない**ために持つ（`20260921-device-name-acs`）
   */
  private retriedRejection: string | undefined;

  get currentState(): SessionState {
    return this.state;
  }

  /**
   * **自動で繋ぎ直している間だけ**、何回目かを返す（交渉中も含む）。ブラウザが開き直した・後から入ったときに
   * 「繋ぎ直し中」を知らせるため——経過の通知（`reconnecting`）は購読している間にしか届かない（独立点検の指摘）。
   */
  get reconnecting(): { attempt: number } | undefined {
    return this.state === "reconnecting" ? { attempt: Math.max(1, this.reconnectAttempt) } : undefined;
  }

  get keyboardLocked(): boolean {
    return this.state !== "ready";
  }

  snapshot(): ScreenSnapshot {
    const snap = this.buf.snapshot(this.id, this.keyboardLocked);
    // メッセージ待ち表示は画面バッファではなくセッションの状態なので、ここで重ねる。
    // **点いているときだけ付与する**（`ScreenSnapshot.messageWaiting` の約束）
    const withMw = this.messageWaiting ? { ...snap, messageWaiting: true } : snap;
    // SysReq の行を出している（コアが持つ。ホストの CLEAR UNIT・WEC で閉じたら画面の側も閉じる。`20260927-sysreq-line-hold`）
    return this.sysReqLineOpen ? { ...withMw, sysReqLine: true } : withMw;
  }

  /**
   * ローカル編集のみ（ホスト送信なし）。Ready 時のみ許可。
   *
   * `opts.eitherDbcsOn` は **E（either）欄の全角・半角の状態を画面の側から明示する**（`20260927-either-field-so`）。
   * ACS は欄ごとに状態を持ち続け（`Field5250.EitherFieldDBCSOn`）、空にしても保つ——コアは値からしか
   * 状態を読めない（空の値では変えない。`noteEitherMode`）ので、画面の側で切り替えが起きた回だけ渡る。
   * 渡らない呼び出し（MCP・HLLAPI・マクロ）は従来どおり値から推す
   */
  setField(target: { index: number } | { row: number; col: number }, value: string, opts?: { eitherDbcsOn?: boolean }): void {
    this.assertReady();
    const field = this.resolveField(target);
    // 内容検証（型・DBCS 種別・コードページ許容文字）。違反は FIELD_TYPE。
    // **その欄の現在値を渡す**——ホストが書いた編集文字（EDTCDE / EDTWRD の `$` `*` `/` `CR`）を
    // 弾くと、ホスト自身が送ってきた値を送り返せず画面ごと送信できなくなる
    // **位置を渡す**——`InternalField` は線形アドレスしか持たないので、例外の文言に
    // 「どの欄か」を入れるには呼び出し側で作るしかない（`20260920-field-error-no-value` research F3）。
    // 値は文言に入らないので、利用者が直せるのはこの位置だけが頼り
    const at = this.buf.rowColOf(field.startAddr);
    // 中身が入って届く非表示の DBCS 欄は、触らない桁の目印を元の中身へ戻す（中身はブラウザへ出さない。`ScreenBuffer.mergeKeep`）
    value = this.buf.mergeKeep(field, value);
    validateFieldContent(value, field, this.codec, this.buf.fieldValue(field), at);
    // DBCS フィールドはバイト長で検証する（SO/SI 込みの再エンコード長が field.length を超えたら FIELD_OVERFLOW）。
    // **純 DBCS の欄（G）は SO/SI を数えない**——送信（`buildFieldResponse`）と同じ数え方（`encodedFieldLength`）。
    // 数えると全角 6 字（12 バイト）が入る欄に 6 字を置けず、ブラウザの Enter・MCP・HLLAPI・マクロが FIELD_OVERFLOW になる（独立点検 A-M1）
    // 区間の間で割れた全角の半分（継続した O 欄）を含む値は、区間ごとには符号化できない（並びが区間をまたぐ）ので、桁の検査は `setFieldValue` のセルの数に任せる
    const splitHalf = [...value].some((c) => isSplitLead(c) || isSplitTail(c));
    if (field.dbcsType !== undefined && this.codec.isDbcs && !splitHalf) {
      const bytes = encodedFieldLength(value, this.codec, field.dbcsType === "pure");
      if (bytes > field.length) {
        // 長さを出さない理由は `buffer.ts` の同じ検査と同じ（`20260920-field-error-no-value` FR1）
        throw new As400Error(
          "FIELD_OVERFLOW",
          `field at (${at.row},${at.col}) accepts at most ${field.length} bytes`
        );
      }
    }
    this.buf.setFieldValue(field, value, field.dbcsType !== undefined, opts);
  }

  /**
   * GUI 選択フィールドの選択状態を更新（ローカルのみ・ホスト送信なし）。
   * 単一選択（ラジオ/プッシュボタン/メニュー）は他を解除、複数選択（チェック）は独立トグル。
   * 変更後に画面イベントを発火する。fieldId/choiceIndex は snapshot.gui の値。
   */
  selectGuiChoice(fieldId: number, choiceIndex: number, selected = true): boolean {
    this.assertReady();
    const ok = this.buf.setSelectionChoice(fieldId, choiceIndex, selected);
    if (ok) this.emit("screen", this.snapshot());
    return ok;
  }

  /**
   * GUI 選択フィールドの確定送信。選択済み選択肢が AID を持てばその AID を、
   * 無ければ指定 key（既定 Enter）を Read MDT 応答として送る。
   * メニューバー・プッシュボタンの主経路（AID で動作を識別）に対応する。
   */
  submitGuiSelection(fieldId: number, opts: SendAidOptions & { key?: AidKey } = {}): Promise<SendAidResult> {
    this.assertReady();
    const field = this.buf.getSelectionField(fieldId);
    // **id を反射しない**——ws の `gui-submit` から任意の値が届く経路で、
    // `code` が種別を伝えており指した側は自分が送った id を知っている
    // （`20260920-field-error-no-value` decisions D3。`ws-handler` 側でも検証している）
    if (!field) throw new As400Error("FIELD_NOT_FOUND", "no such GUI selection field");
    const chosen = field.choices.find((c) => c.selected && c.aid !== undefined);
    let key: AidKey = opts.key ?? "Enter";
    if (chosen?.aid !== undefined) {
      const named = aidKeyForCode(chosen.aid);
      if (named) key = named;
    }
    return this.sendAid(key, opts);
  }

  /**
   * **ホストのエラー状態を抜ける**（ACS `PS5250.clearErrorMode`）。メッセージを外し（ACS はメッセージ行を元に戻す）、エラーの間に止めた
   * ホストの出力を順に処理する（`hostHeld`）。`seq` を渡せば、そのエラー（`systemMessageSeq`）のときだけ抜ける——画面の側が古い
   * エラーを抜けたつもりで新しいエラーを消さないため。エラー中でなければ何もしない
   */
  dismissHostError(seq?: number): boolean {
    if (this.buf.systemMessage === undefined) return false;
    if (seq !== undefined && this.buf.systemMessageSeq !== seq) return false;
    this.buf.systemMessage = undefined;
    this.buf.systemMessageArea = undefined;
    this.releaseHeld();
    return true;
  }

  /**
   * **SysReq の行を出した・閉じた**（画面の側の知らせ。`sysReqLineOpen`）。出している間はホストの WTD を止め、閉じたら止めた出力を順に流す。
   * 行から SysReq を送ったときは送った後で閉じる（`sendAid`。ACS もシステム要求を送ってから `clearSysreqMode`）
   */
  setSysReqLine(open: boolean): void {
    if (open) {
      if (this.sysReqLineOpen) return; // 開いていれば何もしない（ACS `processSysReq` も同じ）
      this.sysReqLineOpen = true;
      this.emit("screen", this.snapshot());
      return;
    }
    if (!this.sysReqLineOpen) return;
    this.sysReqLineOpen = false;
    this.releaseHeld();
  }

  /** 止めていたホストの出力を順に流す（エラーのメッセージ・SysReq の行のどちらかがまだ出ていれば、流す途中でまた止まる） */
  private releaseHeld(): void {
    this.holdingForHostError = false;
    // 閉じたセッションでは流さない（応答を送る先が無い）
    if (this.state === "closed") this.hostHeld = [];
    while (!this.holdingForHostError && this.hostHeld.length > 0) this.handleRecord(this.hostHeld.shift()!, true);
    this.emit("screen", this.snapshot());
  }

  /**
   * AID キー送信。MDT フィールド＋カーソル位置を送り、キーボードアンロックまで待つ。
   * タイムアウトはエラーにせず timedOut: true で現画面を返す。
   */
  sendAid(key: AidKey, opts: SendAidOptions = {}): Promise<SendAidResult> {
    // **キーはエラー状態を抜けてから送る**（ACS もエラー中のキー〔編集キー以外〕でまず `clearErrorMode`。MCP など画面を持たない呼び出しでも、
    // 止めたホストの出力〔と、その後ろの READ〕が流れてから送る）。Attn / SysReq も抜ける——抜けないと、ホストが返す CANCEL INVITE まで溜まり、
    // その応答が出ずにホストが止まる（独立点検の指摘）。欄の値を書く呼び出し側は、書く前に抜けること（`dismissHostError`。流した画面に書くため）
    this.dismissHostError();
    // SysReq の行を出したまま別の AID が来たら、行を閉じて止めた出力を流してから送る（MCP・HLLAPI・画面のボタン）。
    // ⚠ ACS は行の間の Enter 以外の AID を操作員エラー 0006 にして送らない（`processAIDCode`）。画面の側はそうする（`EmulatorPane`）が、
    // 自動操作を画面の側の行で止めないため、コアは閉じて送る（`20260927-sysreq-line-hold` decisions）
    if (key !== "SysReq" && this.sysReqLineOpen) this.setSysReqLine(false);
    // **フラグレコードだけは施錠中でも通す。**
    //
    // 5250 の Attn / SysReq は「固まった要求から抜ける」ための手段そのもので、実機では
    // `X SYSTEM` の最中にこそ使う（IBM の System Request メニュー「2. 前の要求の終了」）。
    // ここで `assertReady()` に掛けると、**待たされている時だけ逃げ道が消える**——
    // 以前は 30 秒のタイムアウトが施錠を勝手に解いていたので目立たなかったが、
    // 期限を設けない待ち（`timeoutMs: "never"`）を許すなら、この口は必ず開いていなければならない
    // （`.aidev/backlog/aid-response-timeout.md`）。
    //
    // 施錠中でも**レコードとして正しい**: フラグレコードは画面の MDT を読まないので、
    // 施錠中のバッファに触れずに組める（`buildAidRecord` 参照）。
    if (key === "Attn" || key === "SysReq") this.assertNotClosed();
    else this.assertReady();
    const record = this.buildAidRecord(key, opts.cursor, opts.sysReqText);
    // **`opts.cursor` は「利用者が今どこにカーソルを置いたか」の最新の申告**（web-ui の
    // クリック等）。これまで `buf.cursorAddr` には反映しておらず（送信レコードの値を
    // 一時的に上書きするだけ、という元々の契約——`research.md` F7）。
    //
    // **同期が無いと、ホストの応答を実際には処理していないまま返す `this.snapshot()`
    // が古い位置を示してしまう**——(1) Attn/SysReq はここで即座に返す（下記参照）、
    // (2) `sendAndWait()` のタイムアウト分岐（どの AID キーでも起こりうる）も応答を
    // 処理せずに `this.snapshot()` を返す（`sendAndWait()` 参照）。どちらも
    // `handleRecord()` を経由しないため、この同期を欠くと `buf.cursorAddr` が
    // 送信前のまま（利用者の最新のクリックを反映しない）になる。
    //
    // **（`.aidev/works/20260915-pr387-acs-premise-unverified` での訂正）**:
    // 当初この同期は `.aidev/works/20260914-seu-page-cursor-hold` decisions.md D5
    // で、`handleRecord` 内の「送信前と比較して動いたか」を判定する分岐
    // （`PR#387` 分岐）のための同期として導入されていた。その分岐は本 work で
    // 撤去したため D5 が挙げていた理由は無くなったが、上記 (1)(2) という
    // 独立の理由（D5 の記述には無く、本 work で改めて確認した）で同期自体は
    // 引き続き必要。
    // **範囲チェックは `addrOf` に任せない**——`row`/`col` が `undefined` や非数値だと
    // `addrOf` 内の比較（`row1 < 1` 等）が常に false になって例外を投げずに通過し、
    // `cursorAddr` が `NaN` になって以後のカーソル追跡がホストの次の IC/MC まで壊れたまま
    // 残る。WS の `key`/`gui-submit` メッセージの `cursor` はランタイム検証されておらず、
    // MCP 経由の zod 検証と違い不正な値がそのまま届きうる。
    // ここで自前に整数・範囲を検証し、不正な値は黙って無視する
    // （`buildFieldResponse` 側も検証せずそのまま送るのと同じ扱いにする）。
    if (
      opts.cursor &&
      Number.isInteger(opts.cursor.row) &&
      Number.isInteger(opts.cursor.col) &&
      opts.cursor.row >= 1 &&
      opts.cursor.row <= this.buf.rows &&
      opts.cursor.col >= 1 &&
      opts.cursor.col <= this.buf.cols
    ) {
      this.buf.cursorAddr = this.buf.addrOf(opts.cursor.row, opts.cursor.col);
    }
    if (key !== "Attn" && key !== "SysReq" && key !== "TestRequest" && !this.readOutstanding) {
      // READ がまだ出ていない（0x21 だけのレコードで施錠が解けた後）: 溜めて、次の READ で送る（`deferredAid`）。待ちの形は送ったときと同じ
      // **カーソルは押したときの位置で送る**（実機の ACS のコア: 同じレコードで READ の前の WTD が 11,2 に書いても〔IC は無く、前の画面の保留 IC は 5,10〕、READ は押したときの 5,12 を受けた。
      // 明示の IC があるレコードは未確認。送った後の画面のカーソルは当 PJ だけ動く——decisions D2
      // `scripts/acs-probe/wec-only-unlock.txt` の WECONLYW。`20260927-unlocked-wtd-cursor`）。欄の値は送るときの画面（`checkPendingAid`）
      this.deferredAid = { key, cursor: this.buf.rowColOf(this.buf.cursorAddr), ...(opts.sysReqText !== undefined ? { sysReqText: opts.sysReqText } : {}) };
      return this.waitAid(opts.timeoutMs);
    }
    // **Test Request はフラグのレコードだが、施錠中は送らず（上の `assertReady`）、送ったら施錠して応答を待つ**（ACS `keyDown` が施錠中に通すのは Attn・SysReq ほかだけ・
    // `sendAid` は Test でも `lockKeyboard`。溜めた AID〔`pending_aid`〕にもしない——61 は除外。`20260927-key-edit-rest` の独立点検）。ホストは CANCEL INVITE と WEC で応える
    if (key === "TestRequest") return this.sendAndWait(record, opts.timeoutMs);
    if (key === "Attn" || key === "SysReq") {
      // 溜めた AID は捨てる（Attn の窓の READ に古い Enter を送らないため。ACS がどうするかは未確認——decisions D2）
      this.deferredAid = undefined;
      // **フラグレコードは応答を待たない。** ホストが黙って無視するのが正常にあり得る
      // （ATNPGM が既に前面のとき等。実機で 2 回目の Attn に受信ゼロを確認）。
      // ACS も 2 回目では何も起きない——待って何か出すのは ACS に無い反応になる。
      //
      // **待たなくても取りこぼさない**: 1 回目で窓が出るのはホストが「その後に」画面を送るからで、
      // それは handleRecord → screen イベントで届く。`locked` にもしない——応答が来ない 2 回目で
      // ロックが残り 🔒 が消えなくなる。**施錠中に送っても状態は動かさない**——
      // 元の AID の待ち（`pendingAid`）はそのまま生かす。ホストが Attn に応えて画面を返せば、
      // その画面のアンロックで元の待ちが解ける（それが「前の要求を切った」ということ）。
      this.telnet.sendRecord(record);
      // SysReq を送ったら行を閉じ、止めていた出力を流す（ACS は送ってから `clearSysreqMode`）
      if (key === "SysReq") this.setSysReqLine(false);
      return Promise.resolve({ screen: this.snapshot(), timedOut: false });
    }
    return this.sendAndWait(record, opts.timeoutMs);
  }

  /** AID キー名 → 送信レコード。SysReq/Attn はヘッダフラグ、他は Read MDT 応答 */
  private buildAidRecord(
    key: AidKey,
    cursor?: { row: number; col: number },
    sysReqText?: string
  ): Uint8Array {
    if (sysReqText !== undefined && key !== "SysReq") {
      // **キー名を反射しない**（`20260920-field-error-no-value` decisions D3。`code` が種別を伝えており、押した側は自分が送った値を知っている）
      throw new As400Error("PROTOCOL_ERROR", "sysReqText is only valid with SysReq");
    }
    if (key === "SysReq") {
      // システム要求行の文字列をデータに載せる。空文字は「打たずに実行」＝メニュー要求なので
      // データ無しと同義に倒す（ホストは 2 桁のオプション欄として解釈する）。
      if (sysReqText === undefined || sysReqText === "") return buildFlagRecord({ srq: true });
      const enc = this.codec.encode(sysReqText);
      if (enc.substituted > 0) {
        this.warn(`${enc.substituted} character(s) substituted on system request`);
      }
      return buildFlagRecord({ srq: true }, enc.bytes);
    }
    if (key === "Attn") return buildFlagRecord({ atn: true });
    // Test Request はヘッダのフラグ 0x02 だけ（ACS のワイヤ `00 0a 12 a0 00 00 04 02 00 00`。ホストは CANCEL INVITE を返す）
    if (key === "TestRequest") return buildFlagRecord({ trq: true });
    const aid = aidCodeOf(key);
    if (aid === undefined) {
      // **キー名を反射しない**——クライアントが送った任意文字列がそのままブラウザへ返る形だった
      // （`20260920-field-error-no-value` research F2 #22。`code` が種別を伝えており、
      // どのキーを押したかは押した側が知っている）
      throw new As400Error("PROTOCOL_ERROR", "unsupported AID key");
    }
    // **待たされている Read の種類で形式が変わる。** `0x42`（READ INPUT FIELDS）だけは
    // SBA 無し・全欄・欄長そのままの平坦形式（`buildReadInputFieldsResponse` の JSDoc）。
    // `0x82`（READ MDT FIELDS ALT）は形は 0x52 と同じで、欄データを加工しない（`buildReadMdtAltResponse`）
    const { record, substituted } = this.readResponseBuilder()(this.buf, this.codec, aid, cursor);
    if (substituted > 0) this.warn(`${substituted} character(s) substituted on send`);
    return record;
  }

  /** 待たされている Read の種類に合う応答の組み方（AID の送信と PC コマンドの応答で共有する） */
  private readResponseBuilder(): typeof buildReadMdtResponse {
    return this.readCommand === COMMAND.READ_INPUT_FIELDS
      ? buildReadInputFieldsResponse
      : this.readCommand === COMMAND.READ_MDT_FIELDS_ALT
        ? buildReadMdtAltResponse
        : buildReadMdtResponse;
  }

  /**
   * レコードを送信し、キーボードアンロック（新画面）まで待つ共通ロジック。
   *
   * **時間切れでも施錠は解かない。** 施錠は「ホストがまだ入力を受け付けていない」という
   * **ホスト側の事実**であって、こちらの待ちくたびれで書き換えてよいものではない。
   * 以前は `locked → ready` に戻していたため、時間の掛かるプログラムを CALL しただけで
   * OIA の 🔒 が消え、入力プロテクトが外れ、ホストが Read を出していないのに次の AID を
   * 通してしまっていた（`.aidev/backlog/aid-response-timeout.md`）。
   *
   * 待ちを打ち切っても呼び出し側は `timedOut: true` で戻れる（自動操作は値を返せる）。
   * 施錠から抜ける口は時間ではなく **Attn / SysReq**——原典と同じ形にする。
   */
  private sendAndWait(record: Uint8Array, timeoutMs?: number | "never"): Promise<SendAidResult> {
    const waiting = this.waitAid(timeoutMs);
    this.readOutstanding = false;
    this.telnet.sendRecord(record);
    return waiting;
  }

  /** AID の応答を待つ（施錠して `pendingAid` を積む。送るのは呼び出し側——溜めた AID は READ が来たときに送る） */
  private waitAid(timeoutMs?: number | "never"): Promise<SendAidResult> {
    this.state = "locked";
    return new Promise<SendAidResult>((resolve) => {
      // `"never"` は期限なし。**タイマーを積まない**——`setTimeout(Infinity)` は
      // 即時発火に丸められるので、値で表そうとすると静かに 1ms のタイムアウトになる
      const ms = timeoutMs ?? 30_000;
      const timer =
        ms === "never"
          ? undefined
          : setTimeout(() => {
              this.pendingAid = undefined;
              resolve({ screen: this.snapshot(), timedOut: true });
            }, ms);
      this.pendingAid = timer !== undefined ? { resolve, timer } : { resolve };
    });
  }

  /**
   * 次の画面更新を待つ（ホスト発の非同期更新・遅延応答用。spec wait_screen の実体）。
   * until 指定時は条件成立する画面まで待つ。タイムアウトは timedOut: true で現画面を返す。
   */
  waitForScreen(opts: { timeoutMs?: number; until?: { text: string; row?: number } } = {}): Promise<SendAidResult> {
    if (this.state === "closed") throw new As400Error("SESSION_CLOSED", "session is closed");
    const matches = (snap: ScreenSnapshot): boolean => {
      if (!opts.until) return false; // until 無し = 次の更新を待つ（現在画面では解決しない）
      if (opts.until.row !== undefined) {
        // 行を指定されたら**その行のセルだけ**を見る（システムメッセージは行を持たない）
        const row = snap.cells[opts.until.row - 1] ?? [];
        return row.map((c) => c.char).join("").includes(opts.until.text);
      }
      const text = snap.cells.map((r) => r.map((c) => c.char).join("")).join("\n");
      if (text.includes(opts.until.text)) return true;
      // **WRITE ERROR CODE（0x21/0x22）のメッセージは画面セルに入らない。**
      // ホストは専用のコマンドでエラー行へ出すので `systemMessage` に載る（`get_screen` の
      // `=== Message ===`）。ここでセルしか見ないと、**エラーを待てない**——実機で
      // `TESTLIB/DTMPGM` の 8 桁日付欄に桁あふれを起こすと
      // 「小数部分の使用法が正しくないか，…」が `systemMessage` にだけ現れ、
      // 24 行目のセルは空のままだった（2026-08-25）。
      return snap.systemMessage !== undefined && snap.systemMessage.includes(opts.until.text);
    };
    // until 指定時、現在画面が既に条件を満たしていれば即座に返す（遅延メッセージが既出のケース）
    if (opts.until && matches(this.snapshot())) {
      return Promise.resolve({ screen: this.snapshot(), timedOut: false });
    }
    return new Promise<SendAidResult>((resolve) => {
      const onScreen = (snap: ScreenSnapshot): void => {
        if (matches(snap)) {
          clearTimeout(timer);
          this.off("screen", onScreen);
          resolve({ screen: snap, timedOut: false });
        }
      };
      const timer = setTimeout(() => {
        this.off("screen", onScreen);
        resolve({ screen: this.snapshot(), timedOut: true });
      }, opts.timeoutMs ?? 30_000);
      this.on("screen", onScreen);
    });
  }

  /**
   * 起動応答レコードで分かったこと。接続直後に埋まる（来なければ `undefined`）。
   *
   * `device` は**実際に割り当てられた装置名**で、設定で指定していなくても（ホスト採番でも）分かる。
   * 対話ジョブのジョブ名は装置名と同じなので、ジョブ情報の起点になる。
   */
  get startup(): StartupResponse | undefined {
    return this.startupInfo;
  }

  /** 画面の文字変換に使っている CCSID（attach したタブがセッションの種類——SBCS だけか DBCS か——を知るため。`20260921-monocase-non-ascii`） */
  get ccsid(): number {
    return this.codec.ccsid;
  }

  /** 930 のキーボード配列の選択（サーバーが「開いた」通知へ載せるため。`20260922-katakana-variant-setting`。5026 は対象外） */
  get katakanaVariant(): KatakanaVariant | undefined {
    return this.opts.katakanaVariant;
  }

  disconnect(): void {
    if (this.state === "closed") return;
    this.userClosed = true; // **自分から切ったときは繋ぎ直さない**（ACS も同じ）
    if (this.state === "reconnecting") {
      // 次の試行を待っている（または TCP を張っている）最中。交渉中なら下の close が輪を抜けさせる
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.finalClose("disconnected");
      return;
    }
    this.telnet.close();
  }

  private assertNotClosed(): void {
    if (this.state === "closed") throw new As400Error("SESSION_CLOSED", "session is closed");
    // 繋ぎ直している間は送り先が無い（Attn / SysReq も。古い接続は閉じている）
    if (this.state === "reconnecting") throw new As400Error("KEYBOARD_LOCKED", "reconnecting to the host");
  }

  private assertReady(): void {
    this.assertNotClosed();
    if (this.state !== "ready") {
      throw new As400Error("KEYBOARD_LOCKED", `keyboard is locked (state=${this.state})`);
    }
  }

  private resolveField(target: { index: number } | { row: number; col: number }): InternalField {
    return "index" in target
      ? this.buf.fieldByIndex(target.index)
      : this.buf.fieldAt(target.row, target.col);
  }

  private handleRecord(record: Uint8Array, replay = false): void {
    // 保留が始まったレコードの残りか（その終わりで、持ち越した CC2 を当てる）
    const isRemainder = replay && record === this.heldRemainder;
    // エラーのメッセージの間に止めた WTD がある間は、後ろのレコードも溜める（ACS はデータ処理のスレッドごと止まる）
    if (this.holdingForHostError && !replay) {
      this.hostHeld.push(record);
      // **溜めすぎたら抜ける**——ACS は受信を止めるので TCP で背圧が掛かるが、当 PJ は受け続けるので際限なく積もりうる。
      // 上限を超えたらエラー状態を抜けて流す（放置されたエラーでホストの出力を失わないため）
      if (this.hostHeld.length > HOST_HELD_LIMIT) {
        // エラーのメッセージでも SysReq の行でも抜ける（行だけの保留で `dismissHostError` が何もしないと、溜めが際限なく増える。独立点検の must）
        this.warn(`host output held for a host error or the system request line exceeded ${HOST_HELD_LIMIT} records; releasing it`);
        this.sysReqLineOpen = false;
        if (!this.dismissHostError()) this.releaseHeld();
      }
      return;
    }
    if (this.freshBufferPending) {
      this.freshBufferPending = false;
      this.buf = Session5250.newBuffer(this.opts);
    }
    if (this.traceRecords) {
      const hex = [...record].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      this.warn(`rx record (${record.length} bytes): ${hex}`);
    }
    // **1 レコード目だけ**を起動応答の候補として見る（RFC 4777 §10）。
    // ここで実際に割り当てられた装置名が分かる＝画面に触れずにジョブ名を知る唯一の経路。
    // **装置名まで入っているものだけを起動応答として食べる**——通常のデータストリームを
    // 誤って食べると、そのレコードが画面へ流れず画面が出なくなる
    if (this.firstRecord) {
      this.firstRecord = false;
      const startup = parseStartupResponse(record);
      // **見分けはコードの既知性で行う**（`20260802-device-busy-record`）。
      // 以前は「装置名が入っているか」だけで見ていたが、**失敗の応答には装置名が入らない**
      // ——割り当てられていないのだから当然。取りこぼすとデータストリームとして解析され、
      // `expected ESC, got 0x…` だけが残って本当の理由（`8902` 等）が消えていた。
      // プリンター（`PrinterSession.handleStartup`）は元からコードで見ており、**そちらへ揃える**。
      //
      // `device !== ""` の枝は**残す**——未知コードでも装置名まで入っていれば従来どおり食べる。
      // 今まで通っていたものを落とさないため。
      if (startup && (isKnownStartupCode(startup.code) || startup.device !== "")) {
        this.startupInfo = startup;
        // **装置が使用中（8902）で、別の名前で答え直せるなら待つ**（ACS と同じ。`20260921-device-name-acs`）。
        // ホストは同じ接続の中で NEW-ENVIRON SEND を送り直してくるので、telnet が次の名前（`=` の番号・当 PJ の繰り上げ）で
        // 答える。次の起動応答をもう一度 1 レコード目として見る。答え直せない名前は従来どおり拒否（ACS は同じ名前を
        // 送り直すだけで繋がらない——実測）
        if (startup.code === "8902" && this.telnet.canRetryDeviceName()) {
          this.warn(`device ${this.telnet.deviceName ?? ""} is in use (8902); answering the host with the next name`);
          this.retriedRejection = `session rejected (8902: ${startupCodeMeaning("8902")})（装置 ${this.telnet.deviceName ?? ""}）`;
          this.firstRecord = true;
          return;
        }
        this.retriedRejection = undefined; // 聞き直しに答えた名前の起動応答が来た（以後の時間切れは 8902 のせいではない）
        if (isKnownStartupCode(startup.code) && !STARTUP_SUCCESS_CODES.has(startup.code)) {
          const meaning = startupCodeMeaning(startup.code);
          // 失敗応答に装置名は入らないので、**送った名前**を添える（利用者が直せる情報にする。展開・大文字化の後）
          const dev = startup.device || this.telnet.deviceName || this.requestedDevice || "";
          const where = dev ? `（装置 ${dev}）` : "";
          this.warn(`session rejected ${startup.code}: ${meaning}`);
          this.onNegotiationError?.(
            new As400Error("SESSION_REJECTED", `session rejected (${startup.code}: ${meaning})${where}`)
          );
          return;
        }
        this.warn(
          `startup response ${startup.code} (system=${startup.system} device=${startup.device})`
        );
        return;
      }
    }
    // **「入力を待っているか」＝Read が実際に要求されたか、で判定する。**
    // `result.unlockKeyboard`（WCC の CC2_UNLOCK ビット）だけでは判定できない——1回の
    // AID キー送信に対する応答が複数レコードに分かれ、かつ先行レコードが「Read を伴わない
    // Write to Display で先にキーボードだけ解放する」構成になっていることがある
    // （実機確認: `.aidev/works/20260915-dspfmt-reconnect-blank-redraw` research.md F3。
    // DSPFMT の応答は3レコードに分かれ、1・2番目は unlockKeyboard のみ、3番目だけが
    // readRequested を伴う）。旧実装はここを `unlockKeyboard` で判定していたため、
    // 骨格だけの1番目のレコードで `pendingAid`/`this.state` を確定させてしまい、
    // `sendAid()` の解決値（`key-done` の中身）がデータの埋まっていない画面のまま
    // 固まっていた（同 research.md F1'。フレッシュな接続・コア層単体で100%決定的に再現）。
    let readSolicited = false;
    let result0: ApplyResult | undefined;
    try {
      const parsed = parseRecord(record);
      if (parsed.opcode === OPCODE.MESSAGE_LIGHT_ON) this.messageWaiting = true;
      if (parsed.opcode === OPCODE.MESSAGE_LIGHT_OFF) this.messageWaiting = false;
      // **データを読むかはオペコードで決まる**（ACS `DS5250.processPassthru`。`20260921-negative-responses` の節目の点検の指摘）。
      // ~~全オペコードでデータストリームを処理する（tn5250 `handle_receive`）~~——ACS がデータを読まないオペコードでも「ESC が無い」の
      // 否定応答を返し、OUTPUT ONLY・RESTORE の先頭のゴミでも否定応答にしていた
      const data = streamOf(parsed.opcode, parsed.data);
      if (data === undefined) {
        // 知らないオペコード: ACS は読まずに否定応答 0x10030101（`processPassthru` の `default`）
        this.warn(`unknown opcode 0x${parsed.opcode.toString(16)} (negative response 0x10030101)`);
        this.telnet.sendRecord(buildNegativeResponse(SENSE.UNKNOWN_OPCODE));
        return;
      }
      const result = applyDataStream(data, this.buf, this.codec, this.warn, {
        holdWtd: () => this.buf.systemMessage !== undefined || this.sysReqLineOpen,
        // CLEAR UNIT・CUA・WEC は SysReq の行を閉じる（ACS `clearSysreqMode`）。その後ろの WTD は行では止めない（エラーなら止める）
        onClearSysReq: () => {
          this.sysReqLineOpen = false; // 画面へはこのレコードの画面（`sysReqLine` が消える）で伝わる
        },
        // READ SCREEN の応答は命令の時点の画面で組む（同じレコードの後ろの WTD を含めない。`20260929-response-content-timing`）
        buildReadScreen: () => buildReadScreenResponse(this.buf, this.codec, parsed.opcode)
      });
      result0 = result;
      if (result.heldFrom !== undefined) {
        // 止めた WTD から後ろを 1 本のレコードに組み直して溜めの先頭へ（オペコードは同じ。読むのはオペコードとデータだけ）
        this.holdingForHostError = true;
        const remainder = buildRecord(parsed.opcode, data.subarray(result.heldFrom));
        this.hostHeld.unshift(remainder);
        // このレコードの保留の前の CC2 を、残りの終わりまで持ち越す（ACS は `processWCC2` をレコードの終わりで呼ぶ）。残りがまた止まったら、前の持ち越しに重ねる
        const prev = isRemainder ? this.heldCc2 : undefined;
        this.heldCc2 = {
          alarm: (prev?.alarm ?? false) || result.alarm === true,
          ...(result.messageWaiting !== undefined ? { messageWaiting: result.messageWaiting } : prev?.messageWaiting !== undefined ? { messageWaiting: prev.messageWaiting } : {})
        };
        this.heldRemainder = remainder;
        // **キーボードの施錠を解き、AID の待ちはエラーの画面で解く**——ACS は WEC の処理（`DS5250.initKeyboard`）で、エラー状態なら
        // 施錠を解く（do-not-enter の表示だけ出す）。解かないと、後ろの READ まで溜まったとき施錠のまま抜けるキーも打てない・
        // AID の待ちが時間切れまで解けない（独立点検の指摘）。次の AID は `sendAid` が抜けて（止めた READ が流れて）から送る
        this.state = "ready";
        this.onceReady?.();
        this.onceReady = undefined;
        if (this.pendingAid) {
          const p = this.pendingAid;
          this.pendingAid = undefined;
          clearTimeout(p.timer);
          p.resolve({ screen: this.snapshot(), timedOut: false });
        }
      }
      // **復元した画面が待っていた READ を、ここで戻す**（ACS `Save5250Net.restoreNetNulls` の
      // `setPendingReadAndAID()` に当たる）。**この位置でなければならない**——下には
      // `queryRequested` / `readScreen*` / `readImmediate*` / `pcCommand` の早期 return が並んでおり、
      // 同じレコードに RESTORE とそれらが載ると届かない（`20260920-restore-screen-parity` cross 点検）。
      // 同じレコードにホストの READ も載っていれば、後段の `result.readCommand` が上書きする
      // ——ホストが今まさに指示した方が新しいので、その順序でよい。
      // ⚠ **ただしその上書きは早期 return より後ろにある**ので、RESTORE ＋ READ MDT ＋ READ SCREEN が
      // 同一レコードに載ると復元値が残る（`20260920-restore-screen-parity` review ラウンド 4）。
      // 実機でその組み合わせは観測していない——**未確認**
      if (result.restoredReadCommand !== undefined) {
        this.readCommand = result.restoredReadCommand;
        // READ が出ている印も**退避した時点の値**に戻す（ACS `setPendingReadAndAID` は退避した `pending_read` を戻す——0 のこともある。`20260927-sysreq-line-hold`）。
        // ~~無条件に立てる~~ は、AID に応えた後の SAVE（F1 のヘルプなど）で誤る（独立点検の must）。溜めた AID は退避していないので戻さない（未対応）
        if (result.restoredReadOutstanding !== undefined) this.readOutstanding = result.restoredReadOutstanding;
      }
      if (parsed.opcode === OPCODE.CANCEL_INVITE) {
        // **Attn / SysReq を成立させる要**。ホストは Attn/SysReq を受けると invite を取り消し、
        // この返事が来るまで次のデータを送らない（実機で対照実験済み。返さないと
        // 無反応のまま止まり、次の AID を送った時点で 1 手遅れて画面が出る）。
        //
        // **送ったキーで条件分けしない**——ホスト都合の取り消しでも同じ返事が要る
        // （tn5250j も opcode ディスパッチで無条件に cancelInvite() を呼ぶ）。
        // 併せてキーボードをロックする（原典の setInputInhibited 相当）。ホストは ack の直後に
        // 必ず書き込みを送ってくるので取り残されない。万一来なくても sendAid のタイムアウトが戻す。
        this.telnet.sendRecord(buildCancelInviteAck());
        if (this.state === "ready") this.state = "locked";
        // 取り消された READ はもう出ていない（ACS の CANCEL INVITE は `pending_read = 0`。`20260927-sysreq-line-hold`）
        this.readOutstanding = false;
        // ここで return しない: データ部は空なので後続処理は無害で、画面イベントの発火判定を
        // 他の opcode と同じ道に通しておく（Cancel Invite だけ別扱いにする理由が無い）。
      }
      // **退避 1 回につき応答 1 本**。`saveRequests` は起きた順に並んでいる
      // （1 レコードに SAVE が 2 回入る形に耐えるため。`20260920-restore-screen-parity` の
      // T4 独立点検で、頂点に添える実装だと先の段が空のまま残ることを実測した）。
      const sendSave = (req: (typeof result.saveRequests)[number]): void => {
        // SAVE SCREEN / SAVE PARTIAL はホストが応答を待つ要求。返さないとホストは先へ進まない
        // （SEU の F1 でヘルプが返らなかった／QSH が「待機中」で固まった原因）。
        // **opcode は受信の写し**（ACS `DS5250.processSaveScreen` と同じ。同 research F14）。
        // パラメータは写して返さない（ホストは使っていない。`save-screen.ts` の注記）
        const res =
          req.kind === "partial"
            ? buildSavePartialScreenResponse(this.buf, this.codec, parsed.opcode)
            : buildSaveScreenResponse(this.buf, this.codec, parsed.opcode);
        // **送った本体を、その退避段に預ける**——ホストは RESTORE でこれをそのまま返してくるので、
        // 復元時に長さで読み飛ばす（同 decisions D2）
        // **退避の時点の `readCommand` も同じ段へ入れる**（ACS `Save5250Net.SavePendingRead`）。
        // ⚠ ここで預けるのは**そのレコードを流す前の値**（`result.readCommand` の反映は後段）。
        // `SAVE → READ` の順なら ACS の逐次処理と一致するが、`READ → SAVE` が同一レコードに
        // 載ると ACS は新しい方を退避するのに対し、こちらは古い方を預ける。
        // **実機では未観測**（`20260920-restore-screen-parity` review ラウンド 5）。
        // セッション側に別のスタックを持つと、早期 return や例外で段数がずれる
        // （`20260920-restore-screen-parity` の cross 点検で実測）
        this.buf.attachSaveContext(req.depth, { payload: res.payload, readCommand: this.readCommand, readOutstanding: this.readOutstanding });
        // その場で戻った否定応答のレコードでは、SAVE PARTIAL の応答を次のレコードまで持ち越す（ACS の `bSavePartial`）。
        // 新しい SAVE PARTIAL は置き場を上書きする（ACS の `saveddata`）——持ち越していた古い応答は送らない
        if (req.kind === "partial") {
          if (result.earlyReturn) this.carriedSavePartial = res.record;
          else {
            this.carriedSavePartial = undefined;
            this.telnet.sendRecord(res.record);
          }
        } else this.telnet.sendRecord(res.record);
      };
      const sendWsf = (w: (typeof result.wsfReplies)[number]): void => {
        if (w.kind === "query") {
          // 5250 QUERY への応答（自動サインオン後の拡張ネゴシエーション）
          this.telnet.sendRecord(buildQueryReply(this.terminalType, this.enhanced, this.screenSize));
        } else {
          // WSF D9/72 への応答（ACS と同じ）。返さないとホストが待ち続けてキーボードが施錠されたままになる（`20260921-wsf-d9-72`）。
          // フラグ 0x80 は `wtd-applier` が否定応答にするのでここへは来ない（`buildWsfD972Reply` も返さない）
          const reply = buildWsfD972Reply(w.flags, w.next);
          if (reply) this.telnet.sendRecord(reply);
        }
      };
      // **応答はコマンドの出てきた順に送る**（ACS `processCommand` は命令ごとにその場で送る。`20260928-response-order`——実機の ACS のコアで、
      // 同じレコードの `[WSF Query][SAVE SCREEN]` は Query の応答が先だった。~~SAVE → WSF → READ SCREEN 系の固定の順~~）。
      // READ SCREEN 系・READ IMMEDIATE 系は従来どおりレコードにつき 1 本（最初に出てきた位置で送る）
      const once = new Set<string>();
      let responded = result.wsfReplies.length > 0;
      for (const slot of result.responses) {
        if (slot.kind === "save") sendSave(result.saveRequests[slot.index]!);
        else if (slot.kind === "wsf") sendWsf(result.wsfReplies[slot.index]!);
        else if (!once.has(slot.kind)) {
          once.add(slot.kind);
          responded = true;
          if (slot.kind === "read-screen-ext") {
            // READ SCREEN EXTENDED への応答。0x62 とは形式が違う（行区切り 0xFF・カーソル前置なし）
            this.telnet.sendRecord(buildReadScreenExtendedResponse(this.buf, this.codec, parsed.opcode));
          } else if (slot.kind === "read-immediate") {
            // **READ IMMEDIATE（0x72）への応答。** 利用者を待たずにその場で返す。`readRequested` と違い**入力待ちに入らない**。
            // 中身の決まり（AID 0・画面単位の MDT が門番・**SBA 無しの平坦形式**）は `buildFlatFieldResponse` の JSDoc に原典と実機の実測ごと控えてある。
            this.telnet.sendRecord(buildReadImmediateResponse(this.buf, this.codec).record);
          } else if (slot.kind === "read-mdt-imm-alt") {
            // **READ MDT IMMEDIATE ALT（0x83）への応答。** `0x72` と同じく待たずに返すが、送るのは **MDT の立った欄だけ**。返さないとホストが固まる
            this.telnet.sendRecord(buildReadMdtImmediateAltResponse(this.buf, this.codec).record);
          } else if (slot.kind === "read-screen") {
            // READ SCREEN への応答（画面イメージを送り返す）。ASSUME 付き WINDOW で使われる。**命令の時点で組んだもの**（`slot.record`。無ければ今の画面）
            this.telnet.sendRecord(slot.record ?? buildReadScreenResponse(this.buf, this.codec, parsed.opcode));
          }
        }
      }
      // **否定応答は最後**（ACS は WSF・READ SCREEN 等の応答を処理の途中で送り、否定応答は `tokenizeData` の終わりで送る。
      // `20260921-negative-responses` の節目の点検の指摘。~~退避の応答の後、Query 等の応答の前~~）。
      // 返さないとホストは入力コマンドを待ち続ける（`wtd-applier.ts` の `senseCode`）。下の早期 return はどれもこれを通してから戻る
      const sendNegative = (): void => {
        // 前のレコードから持ち越した SAVE PARTIAL の応答（このレコードも、その場で戻ったならさらに持ち越す——ACS の尾部が走らないため）
        // コマンドを読まないレコード（NOOP・CANCEL INVITE・メッセージ灯）では送らない（ACS はそれらで `processCommand` を通らない）
        if (!result.earlyReturn && this.carriedSavePartial !== undefined && data.length > 0) {
          this.telnet.sendRecord(this.carriedSavePartial);
          this.carriedSavePartial = undefined;
        }
        if (result.senseCode !== undefined) this.telnet.sendRecord(buildNegativeResponse(result.senseCode));
      };
      // **否定応答は応答の最後**（ACS は `tokenizeData` の終わりで送る）。下の早期の戻りもすべてこれを通す
      sendNegative();
      // 応答だけのレコードは画面イベントを出さず、入力待ちにも入らない（画面は変えない。ホストは続けて何かを送ってくる）。
      // ただし**同じレコードで画面を書いていたら**（WTD ＋ WSF・READ SCREEN 等）イベントは出す——出さないと書いた画面が UI に届かない
      // （節目 10 の独立点検 A-S1 の関連）。同じレコードに READ があれば下へ進んで入力待ちに入る
      // （ACS は WSF の後もレコードの残りを処理する。~~WSF の応答の後は戻る~~ と、D9/72 の後ろの READ が効かず施錠のままだった）
      const drew = this.buf.wroteInThisRecord;
      if (responded && result.readCommand === undefined && !drew) return;
      if (result.pcCommand ?? result.pcCommandEnd) {
        // PC Organizer（STRPCCMD）の中間画面は**利用者に見せない**——
        // 画面イベントも pendingAid の解決もせず、ロックのまま実行して実行キーを返す。
        // ホストはそのあと CLEAR UNIT ＋次画面を送ってくるので、待ちはそこで解ける
        // （tn5250j も strpccmd 中は updateDirty を飛ばす）。**返さないとホストは待ち続ける**。
        this.state = "locked";
        // 応答の形は待たされている Read で決まる（`readResponseBuilder`）ので、先に憶えてから実行する
        if (result.readCommand !== undefined) this.readCommand = result.readCommand;
        void this.runPcCommand(result.pcCommand);
        return;
      }
      // **どの Read で待たされているかを憶える**（次の AID で返す形式が変わる）。
      // Read の無いレコード（画面だけ描くもの）では触らない——同じ画面構築が
      // 複数レコードに分かれて届くため、上書きすると形式を取り違える。
      if (result.readCommand !== undefined) this.readCommand = result.readCommand;
      // ~~READ のときに（そのレコードで位置が指されていなければ）先頭の入力欄へ置く~~——既定位置は
      // WTD の終わりで置く（ACS `preprocessWCC2`。`wtd-applier.ts` の `placeCursorAfterWtd`）。READ は位置に触れない。
      // ここで置いていたので、WTD（IC あり）と READ が別のレコードで来る画面で IC が先頭の入力欄へ上書きされていた
      // （実機で確認。`scripts/verify-read-split-record.mjs`。`20260921-cursor-per-wtd-acs`）
      // 警報は画面更新と別に出す（画面が変わらないレコードでも鳴らすため。ACS も
      // `processWCC2` の中で `ringBell()` を呼ぶだけで、描画とは独立している）
      // 保留が始まったレコードの CC2 は上で持ち越した（ここでは当てない）。残りを流し終えたら、持ち越しと残りの CC2 を合わせて当てる——
      // メッセージ待ちは**後の WTD の指定が勝つ**（ACS の `preprocessWCC2`: 消すだけの WTD は先の「点ける」を落とす。~~レコード全体の OR で点けるが勝つ~~ は誤り）
      if (result.heldFrom === undefined) {
        let alarm = result.alarm === true;
        let mw = result.messageWaiting;
        if (isRemainder && this.heldCc2 !== undefined) {
          alarm = alarm || this.heldCc2.alarm;
          mw = mw ?? this.heldCc2.messageWaiting;
          this.heldCc2 = undefined;
          this.heldRemainder = undefined;
        }
        if (alarm) this.emit("alarm");
        // CC2 のメッセージ待ちビット（触れなかったら undefined＝前の状態を保つ）
        if (mw !== undefined) this.messageWaiting = mw;
      }
      if (result.lockKeyboard && this.state === "ready") this.state = "locked";
      if (result.readRequested) readSolicited = true;
    } catch (err) {
      // 解析エラーでセッションは落とさない（spec: 回復不能時のみ切断）。hex 先頭をログへ
      const head = [...record.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
      this.warn(`record parse error: ${err instanceof Error ? err.message : String(err)} head=${head}`);
      return;
    }

    // **`this.state`/`onceReady` も `pendingAid` と同じ条件に揃える**（旧実装は
    // `unlockKeyboard` 単独で "ready" にしていた）。`assertReady()`（`sendAid()`）が
    // 見るのはこの `this.state` で、揃えないと「骨格レコードだけの途中」でも次の AID
    // キーを送れてしまう——`ws-handler.ts` の WS メッセージは直列化されない
    // （`onKey()` 呼び出しは互いに独立、`app.ts` の `void handle`）ため、この窓は
    // 実際に踏みうる（design.md「設計方針」）。
    // **WRITE ERROR CODE は溜めた AID と READ を捨てる**（ACS `initKeyboard` の `pending_aid = 0`・`pending_read = 0`）。実機の ACS のコア
    // （`scripts/acs-probe/wec-twice.txt`）: 1 回目の 0x21 の後に押した Enter は、2 回目の 0x21 の後の READ に届かず、後で押した F3 が届いた。
    // 同じレコードの READ（WEC の後ろ）は下で立て直す。⚠ ACS は 0x42 の READ だけはエラーを抜けたときに戻す（`PS5250` の復元）——当 PJ は戻さない（未対応）
    if (result0?.errorCodeWritten === true) {
      this.deferredAid = undefined;
      this.readOutstanding = false;
    }
    // ~~CC1 の施錠も溜めた AID を捨てる（ACS `processWCC1`）~~ → **捨てない**。実機の ACS のコアのワイヤ（`20260927-unlocked-wtd-cursor`。DSM の WECONLYW を `tap-proxy` で採った）:
    // CC1 0x20 の WTD を含む READ のレコードが来た後に、溜めた Enter を `05 0c f1 11 05 0a c1 c2` で送った。原典の `pending_aid = 0` とは合わない——
    // ACS のこの振る舞いはキーボードの先打ち（押したキーを溜めて解錠で流す）に近い。測ったのは CC1 0x20 だけ（0x40〜0xE0 は未確認。`20260927-unlocked-wtd-cursor` D1）
    if (readSolicited) this.readOutstanding = true;
    // **READ が来たら、溜めていた AID をいまの画面で送る**（ACS `checkPendingAid`）。待ち（`pendingAid`）はその応答で解く
    if (readSolicited && this.deferredAid) {
      const d = this.deferredAid;
      this.deferredAid = undefined;
      this.readOutstanding = false;
      try {
        this.telnet.sendRecord(this.buildAidRecord(d.key, d.cursor, d.sysReqText));
      } catch (err) {
        // 送る直前に切れた（`runPcCommand` と同じく投げない——受信処理まで上がる）
        this.warn(`deferred AID not sent: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.emit("screen", this.snapshot());
      return;
    }
    // **READ の無い WRITE ERROR CODE でも施錠を解く**（ACS `processWriteErrorCode` → `initKeyboard`。エラー状態なら解く）。
    // AID の待ちはエラーの画面で解く（保留が始まったときと同じ。`20260927-host-error-hold` D4）。READ は出ていないので、次の AID は溜める（`deferredAid`）
    const unlockForError = !readSolicited && result0?.errorCodeWritten === true && this.state === "locked";
    if (readSolicited || unlockForError) {
      this.state = "ready";
      this.onceReady?.();
      this.onceReady = undefined;
    }
    const snap = this.snapshot();
    this.emit("screen", snap);
    if ((readSolicited || unlockForError) && this.pendingAid) {
      const p = this.pendingAid;
      this.pendingAid = undefined;
      clearTimeout(p.timer);
      p.resolve({ screen: snap, timedOut: false });
    }
  }

  /**
   * PC コマンドを実行係へ渡し、**必ず**ホストへ実行キーを返す。
   *
   * `wait`（`PAUSE(*YES)`）のときだけ完了を待つ。実行係が無い・拒否した・失敗した場合でも
   * 応答は返す——ホストは実行の有無を検証しておらず、返さなければ待ち続けるだけだから
   * （research D5）。実行係のタイムアウトは呼び出し側（server）が持つ。
   */
  private async runPcCommand(cmd: PcCommandRequest | undefined): Promise<void> {
    const gen = this.connGen;
    try {
      if (cmd && this.onPcCommand) {
        const running = Promise.resolve(this.onPcCommand(cmd));
        if (cmd.wait) await running;
        // 待たない指定でも例外は拾う（未処理の rejection でプロセスを落とさない）
        else void running.catch((err: unknown) => this.warn(`PC command failed: ${String(err)}`));
      }
    } catch (err) {
      this.warn(`PC command failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 終わった・繋ぎ直している・**張り直した後**なら返さない（前のジョブ宛の応答を新しい接続へ流さない）
    if (this.state === "closed" || this.state === "reconnecting" || gen !== this.connGen) return;
    const aid = aidCodeOf("Enter");
    if (aid === undefined) return;
    // 待たされている Read の種類で組む（AID と同じ。`20260927-read-dbcs-fields`——以前は常に 0x52 の形で、0x42 を待つ画面へ SBA つきで返していた）
    const { record } = this.readResponseBuilder()(this.buf, this.codec, aid);
    try {
      this.readOutstanding = false;
      this.telnet.sendRecord(record);
    } catch (err) {
      // 送る直前に切れた。投げると呼び出し元（`void this.runPcCommand`）の未処理の rejection になりプロセスが落ちる
      this.warn(`PC command reply not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 確立した後に切られた。自動再接続が有効で自分から切ったのでなければ繋ぎ直す */
  private handleClose(reason: string): void {
    if (this.state === "closed" || this.state === "reconnecting") return;
    if (this.opts.autoReconnect === true && !this.userClosed) {
      this.settlePendingAid();
      this.state = "reconnecting";
      this.reconnectAttempt = 0;
      this.scheduleReconnect(0, reason); // **1 回目は即座に**（ACS）
      return;
    }
    this.finalClose(reason);
  }

  /** 終わる。応答待ちの AID は時間切れとして返す */
  private finalClose(reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.settlePendingAid();
    this.emit("closed", reason);
  }

  private settlePendingAid(): void {
    if (!this.pendingAid) return;
    const p = this.pendingAid;
    this.pendingAid = undefined;
    clearTimeout(p.timer);
    p.resolve({ screen: this.snapshot(), timedOut: true });
  }

  private scheduleReconnect(delayMs: number, reason: string): void {
    this.reconnectTimer = setTimeout(() => void this.tryReconnect(reason), delayMs);
  }

  /**
   * 1 回繋ぎ直してみる。失敗したら次を予約する（上限なし）。**ホストが起動応答で拒否したら諦める**
   * （ACS: 状態 33/34 は再接続の条件に当たらない。自動サインオンの誤りで試し続けないため）。
   */
  private async tryReconnect(reason: string): Promise<void> {
    this.reconnectTimer = undefined;
    if (this.userClosed || this.state !== "reconnecting") return;
    const attempt = ++this.reconnectAttempt;
    this.emitSafely(() => this.emit("reconnecting", { attempt, reason }));
    let established = false;
    try {
      const transport = this.opts.transportFactory ? await this.opts.transportFactory() : await this.openTcp();
      if (this.userClosed) {
        transport.close(); // 繋いでいる間に切られた
        return;
      }
      // **前の接続の状態を持ち越さない**。画面・書式・退避画面は新しい接続のホストが描き直す
      // （画面そのものは最初のレコードで作り直す。`freshBufferPending`）
      this.freshBufferPending = true;
      // 繋ぎ直した先の画面は新しいので、前の接続で溜めたホストの出力は捨てる
      this.hostHeld = [];
      this.holdingForHostError = false;
      this.sysReqLineOpen = false;
      this.heldCc2 = undefined;
      this.heldRemainder = undefined;
      this.readOutstanding = false;
      this.deferredAid = undefined;
      this.carriedSavePartial = undefined; // 繋ぎ直した先へは送らない（当 PJ の決め。ACS が繋ぎ直しで捨てるかは未確認）
      this.firstRecord = true;
      this.startupInfo = undefined;
      this.readCommand = COMMAND.READ_MDT_FIELDS;
      this.messageWaiting = false;
      await this.establish(transport, false);
      established = true;
    } catch (e) {
      if (this.userClosed) {
        this.finalClose("disconnected");
        return;
      }
      if (e instanceof As400Error && e.code === "SESSION_REJECTED") {
        this.finalClose(e.message);
        return;
      }
      this.warn(`reconnect attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`);
      this.state = "reconnecting";
      this.scheduleReconnect(this.opts.reconnectIntervalMs ?? 20_000, reason);
    }
    if (!established) return;
    this.reconnectAttempt = 0;
    // **try の外で知らせる**——購読者が投げても、確立した接続を「失敗」と取り違えて 2 本目を張らない
    this.emitSafely(() => this.emit("reconnected", this.startupInfo));
  }

  /** 購読者の例外で繋ぎ直しの輪を止めない（タイマーの中から呼ばれ、投げると未処理の rejection になる） */
  private emitSafely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.warn(`reconnect listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
