import { As400Error, childLog } from "@ts5250/base";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { TcpTransport } from "../transport/tcp.js";
import type { Transport } from "../transport/types.js";
import { TelnetLayer } from "../telnet/telnet.js";
import {
  terminalTypeFor,
  deviceTypeFor,
  type Model3270,
  type TerminalFamily
} from "../telnet/terminal-type.js";
import { deviceEnvFor } from "../telnet/device-env.js";
import { Screen3270 } from "../screen/buffer.js";
import { snapshot } from "../screen/snapshot.js";
import type { ScreenSnapshot } from "../screen/types.js";
import { applyInbound } from "../protocol/inbound.js";
import { buildReadModified, buildReadBuffer } from "../protocol/outbound.js";
import { buildQueryReply } from "../protocol/query-reply.js";
import { parseFieldAttr } from "../screen/attributes.js";
import { Emitter } from "./emitter.js";
import { isShortForm, type AidKey } from "./aid-keys.js";

const log = childLog({ component: "tn3270-session" });

export type SessionState = "disconnected" | "negotiating" | "ready" | "locked" | "closed";

export interface Connect3270Options {
  host: string;
  port?: number;
  /** TLS（telnet over SSL）。証明書検証は既定 ON */
  tls?: boolean | { rejectUnauthorized?: boolean; ca?: string | string[] };
  /** 端末モデル。**代替サイズを決める**（RFC 1576。標準は常に 24x80） */
  model?: Model3270;
  /** 3279=拡張属性対応 / 3278=非対応（RFC 1576） */
  family?: TerminalFamily;
  /** 拡張データストリーム（構造化フィールド）対応を申告する `-E` */
  extended?: boolean;
  /** 装置名。端末タイプ文字列に `@<値>` を付けて申告する（実測で Hercules が受理） */
  deviceName?: string;
  /** 画面文字の CCSID。既定 37。930 / 939 で DBCS */
  ccsid?: number;
  /**
   * TN3270E（RFC 2355）を使うか。既定 `true`。
   *
   * ホストが `DO TN3270E` を提示したときだけ効く。提示しないホスト
   * （実測: TK4- / IBM i）とは**従来どおり基本 TN3270 で繋ぐ**。
   * `false` にすると提示されても断って基本へ後退する。
   */
  tn3270e?: boolean;
  connectTimeoutMs?: number;
  negotiateTimeoutMs?: number;
}

type Events = {
  screen: [ScreenSnapshot];
  close: [string];
  error: [Error];
};

/**
 * TN3270 の表示セッション。
 *
 * **画面の真実は `Screen3270` 一箇所**で、ここは状態機械と入力の検証だけを持つ。
 *
 * ```
 * disconnected → negotiating → ready ⇄ locked → closed
 * ```
 *
 * `send()` でキーボードをロックし、ホストが **WCC の restore**（実測: 0x02）を
 * 返すと `ready` に戻る。**ロック中の入力は拒否する**——実機と同じ挙動にしないと、
 * 自動化スクリプトが「入れたつもりで入っていない」状態を作る。
 */
export class Tn3270Session {
  private transport: Transport | undefined;
  private telnet: TelnetLayer | undefined;
  private screen: Screen3270;
  private events = new Emitter<Events>();
  private state: SessionState = "disconnected";
  private ccsid = 37;

  constructor(private readonly opts: Connect3270Options) {
    this.screen = new Screen3270(opts.model ?? 2);
    this.ccsid = opts.ccsid ?? 37;
  }

  /**
   * **端末が覚えている AID。**
   *
   * ホスト起因の読み（`Read Modified` / `Read Modified All` / `Read Buffer`）は、
   * **直前に操作者が押したキーの AID を先頭に置く**——0x60 固定ではない（実測）。
   * キーボードが復旧すると（WCC の復旧ビット、または `EAU`）**忘れる**。
   */
  private lastAid: AidKey | null = null;

  get status(): SessionState {
    return this.state;
  }

  /** TN3270E で接続しているか */
  get isTn3270e(): boolean {
    return this.telnet?.isTn3270e ?? false;
  }

  /** サーバが割り当てた device-name（TN3270E 時のみ） */
  get assignedDeviceName(): string | undefined {
    return this.telnet?.deviceName;
  }

  on<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void): void {
    this.events.on(event, fn);
  }

  async connect(): Promise<void> {
    if (this.state !== "disconnected") {
      throw new As400Error("PROTOCOL_ERROR", `connect() in state ${this.state}`);
    }
    this.state = "negotiating";
    const port = this.opts.port ?? (this.opts.tls ? 992 : 23);
    const transport = await TcpTransport.connect({
      host: this.opts.host,
      port,
      ...(this.opts.connectTimeoutMs !== undefined
        ? { connectTimeoutMs: this.opts.connectTimeoutMs }
        : {}),
      ...(this.opts.tls !== undefined ? { tls: this.opts.tls } : {})
    });
    this.attach(transport);
    await this.waitNegotiated(this.opts.negotiateTimeoutMs ?? 15_000);
  }

  /**
   * 既存の Transport に載せる（trace の replay・テスト用）。
   *
   * `connect()` を経由しない入口なので、**ここでも `negotiating` へ遷移させる**——
   * さもないと交渉が終わっても `disconnected` のままで `ready` にならない。
   */
  attach(transport: Transport): void {
    this.transport = transport;
    if (this.state === "disconnected") this.state = "negotiating";
    // **CCSID からコードページを申告する**（IBM i 向け。素の 3270 ホストは NEW-ENVIRON を送らない）
    const dev = deviceEnvFor(this.ccsid);
    const telnet = new TelnetLayer(transport, {
      ...(dev !== undefined
        ? { kbdType: dev.kbdType, codePage: dev.codePage, charSet: dev.charSet }
        : {}),
      ...(this.opts.deviceName !== undefined ? { deviceName: this.opts.deviceName } : {}),
      // **TN3270E 用の型名は基本 TN3270 とは別物**（`IBM-3278-*` / `IBM-3279-*`。RFC 2355 §7.1）
      deviceType: deviceTypeFor({
        ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
        ...(this.opts.extended !== undefined ? { extended: this.opts.extended } : {})
      }),
      ...(this.opts.tn3270e !== undefined ? { tn3270e: this.opts.tn3270e } : {}),
      terminalType: terminalTypeFor({
        ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
        ...(this.opts.family !== undefined ? { family: this.opts.family } : {}),
        ...(this.opts.extended !== undefined ? { extended: this.opts.extended } : {})
        // **`@<装置名>` は telnet 層が基本経路でだけ付ける**（TN3270E は CONNECT で渡すため）
      })
    });
    this.telnet = telnet;
    telnet.onNegotiated(() => {
      if (this.state === "negotiating") this.state = "ready";
    });
    telnet.onRecord((record) => this.onRecord(record));
    transport.onClose((reason) => {
      this.state = "closed";
      this.events.emit("close", reason);
    });
    transport.onError((err) => this.events.emit("error", err));
    transport.start?.();
  }

  private onRecord(record: Uint8Array): void {
    const result = applyInbound(this.screen, record);
    if (result.unknown.length > 0) {
      log.debug(`unknown items in record: ${JSON.stringify(result.unknown)}`);
    }
    // **Query には必ず応答する**——IBM i はこれを待ってから画面を出す（実測）
    if (result.structuredField !== undefined && this.telnet) {
      this.telnet.sendRecord(
        buildQueryReply({
          model: this.opts.model ?? 2,
          extendedAttributes: (this.opts.family ?? "3279") === "3279",
          // **DBCS の CCSID なら DBCS を申告する**——申告しないと日本語ホストは黙る（実測）
          dbcs: codecForCcsid(this.ccsid).isDbcs
        })
      );
      log.debug(`replied to structured field query (${result.structuredField.kind})`);
      return;
    }
    // **キーボードが復旧したら覚えている AID を捨てる**（実測）。
    // 読みへの応答より先に——`EAU` は復旧させたうえで応答を求めないので順序は問われないが、
    // 「復旧＝新しい取引の始まり」という意味づけを 1 か所に置いておく
    if (result.keyboardRestored) this.lastAid = null;

    // ホストが読み取りを求めてきたら応答する
    if (result.read !== null && this.telnet) {
      const reply =
        result.read === "read-buffer"
          ? buildReadBuffer(this.screen, this.lastAid)
          : buildReadModified(this.screen, this.lastAid, {
              all: result.read === "read-modified-all"
            });
      this.telnet.sendRecord(reply);
      return;
    }
    if (result.keyboardRestored && this.state === "locked") this.state = "ready";
    this.events.emit("screen", this.snapshot());
  }

  private waitNegotiated(timeoutMs: number): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new As400Error("NEGOTIATION_TIMEOUT", `3270 negotiation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const tick = setInterval(() => {
        if (this.state === "ready") {
          clearTimeout(timer);
          clearInterval(tick);
          resolve();
        } else if (this.state === "closed") {
          clearTimeout(timer);
          clearInterval(tick);
          reject(new As400Error("CONNECT_FAILED", "closed during negotiation"));
        }
      }, 20);
    });
  }

  snapshot(): ScreenSnapshot {
    return snapshot(this.screen, { ccsid: this.ccsid });
  }

  setCursor(row: number, col: number): void {
    const addr = (row - 1) * this.screen.cols + (col - 1);
    if (addr < 0 || addr >= this.screen.size) {
      throw new As400Error("PROTOCOL_ERROR", `cursor (${row},${col}) out of screen`);
    }
    this.screen.setCursor(addr);
  }

  /**
   * カーソル位置から文字を入力する。**非保護欄にしか書けない**。
   *
   * 書いた欄の **MDT を立てる**（実機と同じく属性桁のビットに持つ）。
   */
  type(text: string): void {
    this.assertUnlocked();
    const codec = codecForCcsid(this.ccsid);
    const { bytes } = codec.encode(text);
    for (const b of bytes) {
      const pos = this.screen.cursor;
      if (this.screen.isAttrPos(pos)) {
        throw new As400Error("FIELD_PROTECTED", `cannot type over a field attribute at ${pos}`);
      }
      if (this.screen.isProtectedAt(pos)) {
        const rc = this.screen.rowColOf(pos);
        throw new As400Error("FIELD_PROTECTED", `field at (${rc.row},${rc.col}) is protected`);
      }
      this.screen.writeChar(pos, b);
      this.screen.setMdtFor(pos, true);
      this.screen.setCursor(pos + 1);
    }
  }

  /** AID キーを送る。送信後はキーボードがロックされ、ホストの restore で解ける */
  send(key: AidKey): void {
    this.assertUnlocked();
    if (!this.telnet) throw new As400Error("SESSION_CLOSED", "not connected");
    const record = buildReadModified(this.screen, key);
    this.telnet.sendRecord(record);
    this.lastAid = key; // ホストが後から読みに来たときに使う
    if (key === "clear") {
      // Clear は画面を消してカーソルを先頭へ戻す
      this.screen.clear();
    }
    this.screen.setKeyboardLocked(true);
    this.state = "locked";
    log.debug(`sent AID ${key}${isShortForm(key) ? " (short form)" : ""}`);
  }

  /** 変更された欄（MDT が立っている欄）の一覧。デバッグ・検証用 */
  modifiedFields(): { row: number; col: number; value: string }[] {
    const snap = this.snapshot();
    return snap.fields
      .filter((f) => f.modified)
      .map((f) => ({ row: f.row, col: f.col, value: f.value }));
  }

  close(): void {
    this.transport?.close();
    this.state = "closed";
  }

  private assertUnlocked(): void {
    if (this.state === "closed" || this.state === "disconnected") {
      throw new As400Error("SESSION_CLOSED", `session is ${this.state}`);
    }
    if (this.state === "locked" || this.screen.keyboardLocked) {
      throw new As400Error("KEYBOARD_LOCKED", "keyboard is locked; wait for the host to restore it");
    }
  }
}

/** テスト・検証で属性を直接読みたいとき用 */
export { parseFieldAttr };
