import { codecForCcsid, type Codec } from "../codec/codec.js";
import { Tn5250Error } from "../errors.js";
import { parseRecord } from "../protocol/gds.js";
import { OPCODE } from "../protocol/constants.js";
import { buildReadMdtResponse, buildFlagRecord } from "../protocol/read-response.js";
import { buildQueryReply } from "../protocol/query-reply.js";
import { applyDataStream } from "../protocol/wtd-applier.js";
import { ScreenBuffer, type InternalField } from "../screen/buffer.js";
import { validateFieldContent } from "../screen/field-validate.js";
import type { ScreenSnapshot } from "../screen/types.js";
import { TelnetLayer } from "../telnet/telnet.js";
import { TcpTransport } from "../transport/tcp.js";
import type { Transport } from "../transport/types.js";
import { Emitter } from "../util/emitter.js";
import { aidCodeOf, aidKeyForCode, type AidKey } from "./aid-keys.js";
import { terminalTypeFor, deviceEnvFor } from "./terminal-type.js";

export type SessionState = "connecting" | "negotiating" | "ready" | "locked" | "closed";

export interface ConnectOptions {
  host?: string;
  port?: number;
  ccsid?: number; // 既定 37。930/939/1399（＋エイリアス）で DBCS
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
}

export interface SendAidOptions {
  cursor?: { row: number; col: number };
  /** キーボードアンロック待ちのタイムアウト（既定 30 秒） */
  timeoutMs?: number;
}

export interface SendAidResult {
  screen: ScreenSnapshot;
  /** タイムアウト時 true（エラーにはしない。spec「AID 応答タイムアウト」） */
  timedOut: boolean;
}

/** 対話ジョブの識別子（fetchJobInfo の戻り値） */
export interface JobInfo {
  number: string;
  user: string;
  name: string;
}

interface SessionEvents extends Record<string, unknown[]> {
  screen: [ScreenSnapshot];
  closed: [string];
}

let seq = 0;

function screenText(snap: ScreenSnapshot): string {
  return snap.cells.map((r) => r.map((c) => c.char).join("")).join("\n");
}

/**
 * DSPJOB 画面ヘッダから Job / User / Number を抽出する。
 * 例: "Job:   WEBEMU01       User:   USER           Number:   200737"
 * ラベルは英語 NLV 前提（`. .` ドット装飾・余白を許容）。
 */
function parseJobInfo(text: string): JobInfo | undefined {
  const re = /Job\s*[.:]*\s*:?\s*(\S+)\s+User\s*[.:]*\s*:?\s*(\S+)\s+Number\s*[.:]*\s*:?\s*(\S+)/;
  const m = re.exec(text);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return undefined;
  return { name: m[1], user: m[2], number: m[3] };
}

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
  /** メッセージ待ち表示灯（MESSAGE_LIGHT_ON/OFF）。OIA 表示に使える */
  messageWaiting = false;
  private jobInfoCache: JobInfo | undefined;
  private fetchingJobInfo = false;
  private pendingAid:
    | { resolve: (r: SendAidResult) => void; timer: ReturnType<typeof setTimeout> }
    | undefined;

  private constructor(opts: ConnectOptions) {
    super();
    this.id = opts.id ?? `sess-${++seq}`;
    this.codec = codecForCcsid(opts.ccsid ?? 37);
    this.warn = opts.warn ?? (() => {});
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
        throw new Tn5250Error("CONNECT_FAILED", "host is required (or inject transport)");
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
        reject(new Tn5250Error("NEGOTIATION_TIMEOUT", `no screen within ${timeoutMs}ms`));
      }, timeoutMs);
      const onFirstReady = () => {
        clearTimeout(timer);
        resolve();
      };
      session.onceReady = onFirstReady;
      session.telnet.onClose((reason) => {
        clearTimeout(timer);
        session.handleClose(reason);
        reject(new Tn5250Error("SESSION_CLOSED", `closed during negotiation: ${reason}`));
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
    this.assertNotBusy();
    this.assertReady();
    const field = this.resolveField(target);
    // 内容検証（型・DBCS 種別・コードページ許容文字）。違反は FIELD_TYPE
    validateFieldContent(value, field, this.codec);
    // DBCS フィールドはバイト長で検証する（SO/SI 込みの再エンコード長が field.length を超えたら FIELD_OVERFLOW）
    if (field.dbcsType !== undefined && this.codec.isDbcs) {
      const bytes = this.codec.encode(value).bytes.length;
      if (bytes > field.length) {
        throw new Tn5250Error("FIELD_OVERFLOW", `DBCS value ${bytes} bytes exceeds field length ${field.length}`);
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
    this.assertNotBusy();
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
    this.assertNotBusy();
    this.assertReady();
    const field = this.buf.getSelectionField(fieldId);
    if (!field) throw new Tn5250Error("PROTOCOL_ERROR", `no GUI selection field id=${fieldId}`);
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
    this.assertNotBusy();
    this.assertReady();
    const record = this.buildAidRecord(key, opts.cursor);
    return this.sendAndWait(record, opts.timeoutMs);
  }

  /** AID キー名 → 送信レコード。SysReq/Attn はヘッダフラグ、他は Read MDT 応答 */
  private buildAidRecord(key: AidKey, cursor?: { row: number; col: number }): Uint8Array {
    if (key === "SysReq") return buildFlagRecord({ srq: true });
    if (key === "Attn") return buildFlagRecord({ atn: true });
    const aid = aidCodeOf(key);
    if (aid === undefined) {
      throw new Tn5250Error("PROTOCOL_ERROR", `unsupported AID key: ${key}`);
    }
    const { record, substituted } = buildReadMdtResponse(this.buf, this.codec, aid, cursor);
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
    if (this.state === "closed") throw new Tn5250Error("SESSION_CLOSED", "session is closed");
    const matches = (snap: ScreenSnapshot): boolean => {
      if (!opts.until) return false; // until 無し = 次の更新を待つ（現在画面では解決しない）
      const rows =
        opts.until.row !== undefined ? [snap.cells[opts.until.row - 1] ?? []] : snap.cells;
      const text = rows.map((r) => r.map((c) => c.char).join("")).join("\n");
      return text.includes(opts.until.text);
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

  disconnect(): void {
    if (this.state === "closed") return;
    this.telnet.close();
  }

  /**
   * 対話ジョブの識別子を取得する（decisions.md D2: コマンド行に DSPJOB を実行→ヘッダ走査→F3 復帰）。
   * コマンド行のある画面が前提。取得済みならキャッシュを返す（refresh で再取得）。
   * 実行中は他操作を JOB_INFO_BUSY で拒否し、完了後に画面を元へ戻す。
   */
  async fetchJobInfo(refresh = false): Promise<JobInfo> {
    if (this.jobInfoCache && !refresh) return this.jobInfoCache;
    if (this.fetchingJobInfo) throw new Tn5250Error("JOB_INFO_BUSY", "job info fetch already in progress");
    if (this.state === "closed") throw new Tn5250Error("SESSION_CLOSED", "session is closed");
    if (this.state !== "ready") throw new Tn5250Error("JOB_INFO_BUSY", "keyboard is locked");

    const cmd = this.findCommandField();
    if (!cmd) {
      throw new Tn5250Error("JOB_INFO_UNAVAILABLE", "no command line on current screen");
    }

    this.fetchingJobInfo = true;
    try {
      this.buf.setFieldValue(cmd, "DSPJOB");
      const entered = await this.sendAndWait(
        buildReadMdtResponse(this.buf, this.codec, aidCodeOf("Enter")!).record
      );
      const info = entered.timedOut ? undefined : parseJobInfo(screenText(entered.screen));
      // 成否に関わらず F3 で元画面へ戻す
      await this.sendAndWait(this.buildAidRecord("F3"));
      if (!info) {
        throw new Tn5250Error("JOB_INFO_UNAVAILABLE", "could not parse job identity from DSPJOB screen");
      }
      this.jobInfoCache = info;
      return info;
    } finally {
      this.fetchingJobInfo = false;
    }
  }

  /** コマンド行候補: 画面上の最後の非保護・非 hidden 入力フィールド（メニューの ===> 行等） */
  private findCommandField(): InternalField | undefined {
    const inputs = this.buf.orderedFields().filter((f) => !this.buf.isFieldHidden(f));
    for (let i = inputs.length - 1; i >= 0; i--) {
      const f = inputs[i];
      if (f && (f.ffw & 0x2000) === 0) return f; // bypass ビットなし＝入力可
    }
    return undefined;
  }

  private assertNotBusy(): void {
    if (this.fetchingJobInfo) throw new Tn5250Error("JOB_INFO_BUSY", "job info fetch in progress");
  }

  private assertReady(): void {
    if (this.state === "closed") throw new Tn5250Error("SESSION_CLOSED", "session is closed");
    if (this.state !== "ready") {
      throw new Tn5250Error("KEYBOARD_LOCKED", `keyboard is locked (state=${this.state})`);
    }
  }

  private resolveField(target: { index: number } | { row: number; col: number }): InternalField {
    return "index" in target
      ? this.buf.fieldByIndex(target.index)
      : this.buf.fieldAt(target.row, target.col);
  }

  private handleRecord(record: Uint8Array): void {
    let unlocked = false;
    try {
      const parsed = parseRecord(record);
      // opcode は情報用（メッセージ表示灯等）。データストリームは全 opcode で処理する
      // （tn5250 handle_receive: switch は指標のみ、process_stream は全 opcode で実行）
      if (parsed.opcode === OPCODE.MESSAGE_LIGHT_ON) this.messageWaiting = true;
      if (parsed.opcode === OPCODE.MESSAGE_LIGHT_OFF) this.messageWaiting = false;
      const result = applyDataStream(parsed.data, this.buf, this.codec, this.warn);
      if (result.queryRequested) {
        // 5250 QUERY への応答（自動サインオン後の拡張ネゴシエーション）。画面イベントは出さない
        this.telnet.sendRecord(buildQueryReply(this.terminalType, this.enhanced));
        return;
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
