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

export type SessionState = "connecting" | "negotiating" | "ready" | "locked" | "closed";

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
  deviceName?: string;
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
}

export interface SendAidOptions {
  cursor?: { row: number; col: number };
  /** キーボードアンロック待ちのタイムアウト（既定 30 秒。Attn / SysReq は待たないので無効） */
  timeoutMs?: number;
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
  private readonly buf: ScreenBuffer;
  private readonly codec: Codec;
  private readonly terminalType: string;
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
    | { resolve: (r: SendAidResult) => void; timer: ReturnType<typeof setTimeout> }
    | undefined;

  private constructor(opts: ConnectOptions) {
    super();
    this.id = opts.id ?? `sess-${++seq}`;
    this.codec = codecForCcsid(opts.ccsid ?? 37);
    this.warn = opts.warn ?? (() => {});
    this.traceRecords = opts.traceRecords ?? false;
    this.onPcCommand = opts.onPcCommand;
    // 代替バッファの許可は、端末タイプでホストに申告した内容と一致させる（27x132 と申告した
    // ときだけ許可する）。ホストは 27x132 対応端末にだけ CLEAR UNIT ALTERNATE を送ってくる。
    const allowAlternate = opts.screenSize === "27x132";
    this.buf = new ScreenBuffer(allowAlternate ? { alternate: "27x132" } : {});
    this.terminalType = terminalTypeFor(opts.ccsid ?? 37, opts.screenSize ?? "24x80");
    this.enhanced = opts.enhanced ?? false;
  }

  static async connect(opts: ConnectOptions): Promise<Session5250> {
    const session = new Session5250(opts);
    let transport: Transport;
    if (opts.transport) {
      transport = opts.transport;
    } else {
      if (opts.host === undefined) {
        throw new As400Error("CONNECT_FAILED", "host is required (or inject transport)");
      }
      transport = await TcpTransport.connect({
        host: opts.host,
        port: opts.port ?? (opts.tls ? 992 : 23), // TLS 既定 992・平文 23
        ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
        ...(opts.tls !== undefined ? { tls: opts.tls } : {})
      });
    }

    session.state = "negotiating";
    // RFC 2877 KBDTYPE/CODEPAGE/CHARSET を申告し、ホストにデバイス⇄ジョブ CCSID の変換をさせる
    const dev = deviceEnvFor(opts.ccsid ?? 37);
    session.telnet = new TelnetLayer(transport, {
      terminalType: session.terminalType,
      deviceName: opts.deviceName,
      user: opts.user,
      password: opts.password,
      kbdType: dev?.kbdType,
      codePage: dev?.codePage,
      charSet: dev?.charSet
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timeoutMs = opts.negotiationTimeoutMs ?? 15_000;
      const timer = setTimeout(() => {
        session.telnet.close();
        reject(new As400Error("NEGOTIATION_TIMEOUT", `no screen within ${timeoutMs}ms`));
      }, timeoutMs);
      const onFirstReady = () => {
        clearTimeout(timer);
        resolve();
      };
      session.onceReady = onFirstReady;
      session.requestedDevice = opts.deviceName;
      // **ホストが理由を返してきたら、それを接続の失敗にする**（`onClose` より先に届く）
      session.onNegotiationError = (e) => {
        clearTimeout(timer);
        // **先に reject する。** `close()` は `onClose` を同期で呼び、そこが
        // `SESSION_CLOSED closed during negotiation` で先に settle してしまう
        // ——せっかく分かった理由（`8902` 等）が一般的な文言に負ける（実機で踏んだ）
        reject(e);
        session.telnet.close();
      };
      session.telnet.onClose((reason) => {
        clearTimeout(timer);
        session.handleClose(reason);
        // **装置名を指定していてネゴシエーション中に切られたら、まず装置名の重複を疑う。**
        // IBM i は要求された装置が既に使用中だと、理由を返さずソケットを閉じる。生の
        // 「socket closed」だけだと利用者は原因に辿り着けない（同じ設定で 2 本目を開いた等）。
        const hint =
          opts.deviceName !== undefined
            ? `（装置名 ${opts.deviceName} が既に使用中の可能性があります）`
            : "";
        reject(new As400Error("SESSION_CLOSED", `closed during negotiation: ${reason}${hint}`));
      });
      session.telnet.onError((err) => session.warn(`transport error: ${err.message}`));
      session.telnet.onRecord((rec) => session.handleRecord(rec));
    });

    transport.start?.();
    await ready;

    // 接続完了後は onClose を通常処理に差し替える
    session.telnet.onClose((reason) => session.handleClose(reason));
    return session;
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

  get keyboardLocked(): boolean {
    return this.state !== "ready";
  }

  snapshot(): ScreenSnapshot {
    return this.buf.snapshot(this.id, this.keyboardLocked);
  }

  /** ローカル編集のみ（ホスト送信なし）。Ready 時のみ許可 */
  setField(target: { index: number } | { row: number; col: number }, value: string): void {
    this.assertReady();
    const field = this.resolveField(target);
    // 内容検証（型・DBCS 種別・コードページ許容文字）。違反は FIELD_TYPE。
    // **その欄の現在値を渡す**——ホストが書いた編集文字（EDTCDE / EDTWRD の `$` `*` `/` `CR`）を
    // 弾くと、ホスト自身が送ってきた値を送り返せず画面ごと送信できなくなる
    validateFieldContent(value, field, this.codec, this.buf.fieldValue(field));
    // DBCS フィールドはバイト長で検証する（SO/SI 込みの再エンコード長が field.length を超えたら FIELD_OVERFLOW）
    if (field.dbcsType !== undefined && this.codec.isDbcs) {
      const bytes = this.codec.encode(value).bytes.length;
      if (bytes > field.length) {
        throw new As400Error("FIELD_OVERFLOW", `DBCS value ${bytes} bytes exceeds field length ${field.length}`);
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
    if (!field) throw new As400Error("PROTOCOL_ERROR", `no GUI selection field id=${fieldId}`);
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
    this.assertReady();
    const record = this.buildAidRecord(key, opts.cursor, opts.sysReqText);
    if (key === "Attn" || key === "SysReq") {
      // **フラグレコードは応答を待たない。** ホストが黙って無視するのが正常にあり得る
      // （ATNPGM が既に前面のとき等。実機で 2 回目の Attn に受信ゼロを確認）。
      // ACS も 2 回目では何も起きない——待って何か出すのは ACS に無い反応になる。
      //
      // **待たなくても取りこぼさない**: 1 回目で窓が出るのはホストが「その後に」画面を送るからで、
      // それは handleRecord → screen イベントで届く。sendAid の解決は busy（多重送信プロテクト）を
      // 解く合図にすぎない。`locked` にもしない——応答が来ない 2 回目でロックが残り 🔒 が消えなくなる。
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
      throw new As400Error("PROTOCOL_ERROR", `sysReqText is only valid with SysReq (got ${key})`);
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
      throw new As400Error("PROTOCOL_ERROR", `unsupported AID key: ${key}`);
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

  /** レコードを送信し、キーボードアンロック（新画面）まで待つ共通ロジック */
  private sendAndWait(record: Uint8Array, timeoutMs?: number): Promise<SendAidResult> {
    this.state = "locked";
    return new Promise<SendAidResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAid = undefined;
        // design の状態機械: Locked → Ready（タイムアウト・timedOut=true で画面返却）
        if (this.state === "locked") this.state = "ready";
        resolve({ screen: this.snapshot(), timedOut: true });
      }, timeoutMs ?? 30_000);
      this.pendingAid = { resolve, timer };
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
    this.telnet.close();
  }

  private assertReady(): void {
    if (this.state === "closed") throw new As400Error("SESSION_CLOSED", "session is closed");
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
        if (isKnownStartupCode(startup.code) && !STARTUP_SUCCESS_CODES.has(startup.code)) {
          const meaning = startupCodeMeaning(startup.code);
          // 失敗応答に装置名は入らないので、**要求した名前**を添える（利用者が直せる情報にする）
          const dev = startup.device || this.requestedDevice || "";
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
    let unlocked = false;
    // このレコードを当てる**前**のカーソル。ホストがカーソルを動かしたかを見るのに使う
    const cursorBefore = this.buf.cursorAddr;
    try {
      const parsed = parseRecord(record);
      // opcode は情報用（メッセージ表示灯等）。データストリームは全 opcode で処理する
      // （tn5250 handle_receive: switch は指標のみ、process_stream は全 opcode で実行）
      if (parsed.opcode === OPCODE.MESSAGE_LIGHT_ON) this.messageWaiting = true;
      if (parsed.opcode === OPCODE.MESSAGE_LIGHT_OFF) this.messageWaiting = false;
      const result = applyDataStream(parsed.data, this.buf, this.codec, this.warn);
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
      if (result.saveScreenRequested) {
        // SAVE SCREEN はホストが応答を待つ要求。返さないとホストは先へ進まない
        this.telnet.sendRecord(buildSaveScreenResponse(this.buf, this.codec));
      }
      if (result.savePartialScreen !== undefined) {
        // SAVE PARTIAL SCREEN も同じ（opcode は PUT/GET＝「送ったから返せ」）。
        // **返さないとホストは次を送ってこない**——QSH が「待機中」で固まっていた原因。
        // パラメータはそのまま写して返す（ホストが自分の指定を識別できるように）
        this.telnet.sendRecord(
          buildSavePartialScreenResponse(this.buf, this.codec, result.savePartialScreen)
        );
      }
      if (result.queryRequested) {
        // 5250 QUERY への応答（自動サインオン後の拡張ネゴシエーション）。画面イベントは出さない
        this.telnet.sendRecord(buildQueryReply(this.terminalType, this.enhanced));
        return;
      }
      if (result.readScreenExtendedRequested) {
        // READ SCREEN EXTENDED への応答。0x62 とは形式が違う（行区切り 0xFF・カーソル前置なし）
        this.telnet.sendRecord(buildReadScreenExtendedResponse(this.buf, this.codec));
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
        this.telnet.sendRecord(buildReadScreenResponse(this.buf, this.codec));
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
      if (result.readRequested && !result.cursorSet) {
        // IC/MC が無ければカーソルは最初の入力フィールドへ（5250 の既定動作）。
        // 原点に残すと AID レコードで報告するカーソル位置が実機とずれる
        this.buf.cursorToFirstInputField();
      } else if (result.readRequested && this.buf.cursorAddr === cursorBefore && this.buf.cursorIsUnenterable()) {
        /**
         * **画面が変わったのにカーソルが 1 桁も動かず、そこが入力できない桁**なら、
         * 最初の入力欄へ寄せる（ACS と同じ）。
         *
         * 「上で入力 → Enter → 上がプロテクトされ、下が展開する」画面で踏む。アプリは
         * カーソルを動かしておらず、ホストが送ってくるのは**operator が居た桁のまま**＝
         * いまは保護欄。そこに置くと打っても操作員エラーになり、利用者は Tab を押すまで
         * 入力できない（利用者の報告。ACS は下の入力欄へ入る）。
         *
         * **「動いていない」を条件にするのが肝。** ホストが**わざと**保護欄を指す画面が
         * あり（SEU の走査検索——見つかった桁にカーソルを置く）、そちらは寄せてはいけない
         * （寄せると `SEU==>` へ飛んで、どこが見つかったのか分からなくなる。過去の指摘）。
         * 実機で並べて測ると、両者はここで分かれる:
         *   展開画面 … 3/12 → 3/12（動かない）・保護欄の中
         *   SEU 走査 … 2/9 → 11/53（動く）・保護欄の中
         */
        this.buf.cursorToFirstInputField();
      }
      if (result.lockKeyboard && this.state === "ready") this.state = "locked";
      if (result.unlockKeyboard) unlocked = true;
    } catch (err) {
      // 解析エラーでセッションは落とさない（spec: 回復不能時のみ切断）。hex 先頭をログへ
      const head = [...record.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
      this.warn(`record parse error: ${err instanceof Error ? err.message : String(err)} head=${head}`);
      return;
    }

    if (unlocked) {
      this.state = "ready";
      this.onceReady?.();
      this.onceReady = undefined;
    }
    const snap = this.snapshot();
    this.emit("screen", snap);
    if (unlocked && this.pendingAid) {
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
    if (this.state === "closed") return;
    const aid = aidCodeOf("Enter");
    if (aid === undefined) return;
    const { record } = buildReadMdtResponse(this.buf, this.codec, aid);
    this.telnet.sendRecord(record);
  }

  private handleClose(reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.pendingAid) {
      const p = this.pendingAid;
      this.pendingAid = undefined;
      clearTimeout(p.timer);
      p.resolve({ screen: this.snapshot(), timedOut: true });
    }
    this.emit("closed", reason);
  }
}
