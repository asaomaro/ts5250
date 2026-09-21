import { codecForCcsid, type Codec } from "@ts5250/ebcdic";
import { As400Error, deviceEnvFor } from "@ts5250/base";
import { parseRecord } from "../protocol/gds.js";
import { COMMAND, OPCODE } from "../protocol/constants.js";
import {
  buildReadMdtResponse,
  buildReadInputFieldsResponse,
  buildReadImmediateResponse,
  buildReadMdtImmediateAltResponse,
  buildFlagRecord,
  buildCancelInviteAck
} from "../protocol/read-response.js";
import { buildQueryReply } from "../protocol/query-reply.js";
import {
  buildSaveScreenResponse,
  buildSavePartialScreenResponse,
  buildReadScreenResponse,
  buildReadScreenExtendedResponse
} from "../protocol/save-screen.js";
import type { PcCommandRequest } from "../protocol/pc-command.js";
import { applyDataStream } from "../protocol/wtd-applier.js";
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
 * 5250 セッション（design の状態機械: Connecting → Negotiating → Ready ⇄ Locked → Closed）。
 * Locked 中もホスト発 WTD は画面に適用し続ける（複数レコードで画面が組まれるケース）。
 */
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
      ...(opts.tls !== undefined ? { tls: opts.tls } : {})
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
    // RFC 2877 KBDTYPE/CODEPAGE/CHARSET を申告し、ホストにデバイス⇄ジョブ CCSID の変換をさせる
    const dev = deviceEnvFor(opts.ccsid ?? 37);
    this.telnet = new TelnetLayer(transport, {
      terminalType: this.terminalType,
      deviceName: opts.deviceName,
      deviceNameEnv: { ...opts.deviceNameEnv, printer: false },
      deviceNameRetry: opts.deviceNameRetry,
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
        this.telnet.close();
        reject(new As400Error("NEGOTIATION_TIMEOUT", `no screen within ${timeoutMs}ms`));
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
        reject(new As400Error("SESSION_CLOSED", `closed during negotiation: ${reason}${hint}`));
      });
      this.telnet.onError((err) => this.warn(`transport error: ${err.message}`));
      this.telnet.onRecord((rec) => this.handleRecord(rec));
    });

    transport.start?.();
    await ready;

    // 接続完了後は onClose を通常処理に差し替える
    this.telnet.onClose((reason) => this.handleClose(reason));
  }

  private onceReady: (() => void) | undefined;
  /**
   * 交渉中の失敗を接続待ちへ返す口（`20260802-device-busy-record`）。
   * ホストが**失敗の起動応答**を返してきたときに使う——`onClose` では
   * 「切れた」としか言えず、理由（`8902` 等）が落ちる。
   */
  private onNegotiationError: ((e: As400Error) => void) | undefined;
  /** 要求した装置名。失敗の起動応答には装置名が入らないので、文言に添えるために持つ */
  private requestedDevice: string | undefined;

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
    return this.messageWaiting ? { ...snap, messageWaiting: true } : snap;
  }

  /** ローカル編集のみ（ホスト送信なし）。Ready 時のみ許可 */
  setField(target: { index: number } | { row: number; col: number }, value: string): void {
    this.assertReady();
    const field = this.resolveField(target);
    // 内容検証（型・DBCS 種別・コードページ許容文字）。違反は FIELD_TYPE。
    // **その欄の現在値を渡す**——ホストが書いた編集文字（EDTCDE / EDTWRD の `$` `*` `/` `CR`）を
    // 弾くと、ホスト自身が送ってきた値を送り返せず画面ごと送信できなくなる
    // **位置を渡す**——`InternalField` は線形アドレスしか持たないので、例外の文言に
    // 「どの欄か」を入れるには呼び出し側で作るしかない（`20260920-field-error-no-value` research F3）。
    // 値は文言に入らないので、利用者が直せるのはこの位置だけが頼り
    const at = this.buf.rowColOf(field.startAddr);
    validateFieldContent(value, field, this.codec, this.buf.fieldValue(field), at);
    // DBCS フィールドはバイト長で検証する（SO/SI 込みの再エンコード長が field.length を超えたら FIELD_OVERFLOW）
    if (field.dbcsType !== undefined && this.codec.isDbcs) {
      const bytes = this.codec.encode(value).bytes.length;
      if (bytes > field.length) {
        // 長さを出さない理由は `buffer.ts` の同じ検査と同じ（`20260920-field-error-no-value` FR1）
        throw new As400Error(
          "FIELD_OVERFLOW",
          `field at (${at.row},${at.col}) accepts at most ${field.length} bytes`
        );
      }
    }
    this.buf.setFieldValue(field, value, field.dbcsType !== undefined);
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
   * AID キー送信。MDT フィールド＋カーソル位置を送り、キーボードアンロックまで待つ。
   * タイムアウトはエラーにせず timedOut: true で現画面を返す。
   */
  sendAid(key: AidKey, opts: SendAidOptions = {}): Promise<SendAidResult> {
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
    if (key === "Attn" || key === "SysReq") {
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
    const aid = aidCodeOf(key);
    if (aid === undefined) {
      // **キー名を反射しない**——クライアントが送った任意文字列がそのままブラウザへ返る形だった
      // （`20260920-field-error-no-value` research F2 #22。`code` が種別を伝えており、
      // どのキーを押したかは押した側が知っている）
      throw new As400Error("PROTOCOL_ERROR", "unsupported AID key");
    }
    // **待たされている Read の種類で形式が変わる。** `0x42`（READ INPUT FIELDS）だけは
    // SBA 無し・全欄・欄長そのままの平坦形式（`buildReadInputFieldsResponse` の JSDoc）。
    const build =
      this.readCommand === COMMAND.READ_INPUT_FIELDS
        ? buildReadInputFieldsResponse
        : buildReadMdtResponse;
    const { record, substituted } = build(this.buf, this.codec, aid, cursor);
    if (substituted > 0) this.warn(`${substituted} character(s) substituted on send`);
    return record;
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
      this.telnet.sendRecord(record);
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
      // `ASAOLIB/DTMPGM` の 8 桁日付欄に桁あふれを起こすと
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

  private handleRecord(record: Uint8Array): void {
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
      const startup = parseStartupResponse(record, this.codec);
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
          this.firstRecord = true;
          return;
        }
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
    try {
      const parsed = parseRecord(record);
      // opcode は情報用（メッセージ表示灯等）。データストリームは全 opcode で処理する
      // （tn5250 handle_receive: switch は指標のみ、process_stream は全 opcode で実行）
      if (parsed.opcode === OPCODE.MESSAGE_LIGHT_ON) this.messageWaiting = true;
      if (parsed.opcode === OPCODE.MESSAGE_LIGHT_OFF) this.messageWaiting = false;
      const result = applyDataStream(parsed.data, this.buf, this.codec, this.warn);
      // **復元した画面が待っていた READ を、ここで戻す**（ACS `Save5250Net.restoreNetNulls` の
      // `setPendingReadAndAID()` に当たる）。**この位置でなければならない**——下には
      // `queryRequested` / `readScreen*` / `readImmediate*` / `pcCommand` の早期 return が並んでおり、
      // 同じレコードに RESTORE とそれらが載ると届かない（`20260920-restore-screen-parity` cross 点検）。
      // 同じレコードにホストの READ も載っていれば、後段の `result.readCommand` が上書きする
      // ——ホストが今まさに指示した方が新しいので、その順序でよい。
      // ⚠ **ただしその上書きは早期 return より後ろにある**ので、RESTORE ＋ READ MDT ＋ READ SCREEN が
      // 同一レコードに載ると復元値が残る（`20260920-restore-screen-parity` review ラウンド 4）。
      // 実機でその組み合わせは観測していない——**未確認**
      if (result.restoredReadCommand !== undefined) this.readCommand = result.restoredReadCommand;
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
        // ここで return しない: データ部は空なので後続処理は無害で、画面イベントの発火判定を
        // 他の opcode と同じ道に通しておく（Cancel Invite だけ別扱いにする理由が無い）。
      }
      // **退避 1 回につき応答 1 本**。`saveRequests` は起きた順に並んでいる
      // （1 レコードに SAVE が 2 回入る形に耐えるため。`20260920-restore-screen-parity` の
      // T4 独立点検で、頂点に添える実装だと先の段が空のまま残ることを実測した）。
      for (const req of result.saveRequests) {
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
        this.buf.attachSaveContext(req.depth, { payload: res.payload, readCommand: this.readCommand });
        this.telnet.sendRecord(res.record);
      }
      if (result.queryRequested) {
        // 5250 QUERY への応答（自動サインオン後の拡張ネゴシエーション）。画面イベントは出さない
        this.telnet.sendRecord(buildQueryReply(this.terminalType, this.enhanced, this.screenSize));
        return;
      }
      if (result.readScreenExtendedRequested) {
        // READ SCREEN EXTENDED への応答。0x62 とは形式が違う（行区切り 0xFF・カーソル前置なし）
        this.telnet.sendRecord(buildReadScreenExtendedResponse(this.buf, this.codec, parsed.opcode));
        return;
      }
      if (result.readImmediateRequested) {
        // **READ IMMEDIATE（0x72）への応答。** 利用者を待たずにその場で返す。
        // `readRequested` と違い**入力待ちに入らない**——ホストは続けて何かを送ってくる。
        // 中身の決まり（AID 0・画面単位の MDT が門番・**SBA 無しの平坦形式**）は
        // `buildFlatFieldResponse` の JSDoc に原典と実機の実測ごと控えてある。
        const { record } = buildReadImmediateResponse(this.buf, this.codec);
        this.telnet.sendRecord(record);
        return;
      }
      if (result.readMdtImmediateAltRequested) {
        // **READ MDT IMMEDIATE ALT（0x83）への応答。** `0x72` と同じく待たずに返すが、
        // 送るのは **MDT の立った欄だけ**（名前どおり）。返さないとホストが固まる。
        const { record } = buildReadMdtImmediateAltResponse(this.buf, this.codec);
        this.telnet.sendRecord(record);
        return;
      }
      if (result.readScreenRequested) {
        // READ SCREEN への応答（現在の画面イメージを送り返す）。ASSUME 付き WINDOW で使われる。
        // これ自体は画面を変えないのでイベントは出さない。ホストは続けてウィンドウを描いてくる。
        this.telnet.sendRecord(buildReadScreenResponse(this.buf, this.codec, parsed.opcode));
        return;
      }
      if (result.pcCommand ?? result.pcCommandEnd) {
        // PC Organizer（STRPCCMD）の中間画面は**利用者に見せない**——
        // 画面イベントも pendingAid の解決もせず、ロックのまま実行して実行キーを返す。
        // ホストはそのあと CLEAR UNIT ＋次画面を送ってくるので、待ちはそこで解ける
        // （tn5250j も strpccmd 中は updateDirty を飛ばす）。**返さないとホストは待ち続ける**。
        this.state = "locked";
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
      if (result.alarm) this.emit("alarm");
      // CC2 のメッセージ待ちビット（触れなかったら undefined＝前の状態を保つ）
      if (result.messageWaiting !== undefined) this.messageWaiting = result.messageWaiting;
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
    if (readSolicited) {
      this.state = "ready";
      this.onceReady?.();
      this.onceReady = undefined;
    }
    const snap = this.snapshot();
    this.emit("screen", snap);
    if (readSolicited && this.pendingAid) {
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
    const { record } = buildReadMdtResponse(this.buf, this.codec, aid);
    try {
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
