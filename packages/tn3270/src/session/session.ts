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
import { buildReadModified, buildReadBuffer, type ReplyMode } from "../protocol/outbound.js";
import { buildQueryReply } from "../protocol/query-reply.js";
import { CHARSET, REPLY_MODE, SO, SI, NUL, DUP, FIELD_MARK } from "../protocol/constants.js";
import { DB, dbcsStates, normalizeDbcs } from "../screen/dbcs.js";

/**
 * 入力欄が DBCS をどう受け取るか（s3270 実測）。
 * `plain` は日本語を撥ね、`mixed` は `SO`/`SI` で包み、`dbcs` は生で置いて英数を撥ねる。
 */
type FieldKind = "plain" | "mixed" | "dbcs";
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

  /**
   * **応答モード**（`Set Reply Mode`）。既定は欄モード。
   * `Erase/Write` 系で既定へ戻る——平の `Write` では戻らない（実測）。
   */
  private reply: ReplyMode = { mode: REPLY_MODE.FIELD, types: [] };

  /**
   * **挿入モード。** 打った文字が上書きではなく**割り込み**になり、欄の後ろがずれる。
   * **AID を送るかキーボードが復旧すると解ける**（実測）——取引が変わるので持ち越さない。
   */
  private insert = false;

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
    const result = applyInbound(this.screen, record, { dbcs: codecForCcsid(this.ccsid).isDbcs });
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
    // **応答モード**——消して書く＋リセットビットで既定へ戻り、構造化フィールドで設定される。
    // 順序が大事: 同じレコードに両方入っていれば、設定の方が残る
    if (result.resetReplyMode === true) this.reply = { mode: REPLY_MODE.FIELD, types: [] };
    if (result.replyMode !== undefined) this.reply = result.replyMode;

    // **キーボードが復旧したら覚えている AID を捨てる**（実測）。
    // 読みへの応答より先に——`EAU` は復旧させたうえで応答を求めないので順序は問われないが、
    // 「復旧＝新しい取引の始まり」という意味づけを 1 か所に置いておく
    if (result.keyboardRestored) {
      this.lastAid = null;
      this.insert = false;
    }

    // ホストが読み取りを求めてきたら応答する
    if (result.read !== null && this.telnet) {
      const reply =
        result.read === "read-buffer"
          ? buildReadBuffer(this.screen, this.lastAid, { reply: this.reply })
          : buildReadModified(this.screen, this.lastAid, {
              all: result.read === "read-modified-all",
              reply: this.reply
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
    const kind = this.fieldKind();
    // **打ち始めた欄**を覚えておく。ここから外れたら「入り切らなかった」と言える
    const home = this.screen.fieldAttrPosFor(this.screen.cursor);
    for (const ch of [...text]) this.typeOne([...codec.encode(ch).bytes], kind, home);
    this.afterEdit();
  }

  /**
   * **1 文字を置く。**
   *
   * 桁数の勘定が文字ごとに変わるので、バイト列をまとめて流し込むことはできない
   * （s3270 実測——欄に入り切らない文字は**手前まで書いて、その 1 文字だけを撥ねる**）:
   *
   * | 状況 | 要る桁 | 置くもの |
   * |---|---|---|
   * | DBCS 欄の日本語 | 2 | 生の 2 バイト |
   * | 混在欄の日本語（区間の外） | 4 | `SO` ＋ 2 バイト ＋ `SI` |
   * | 混在欄の日本語（`SI` の上） | 3 | 2 バイト ＋ `SI` を 1 つ右へ |
   * | 英数 | 1 | 1 バイト |
   */
  private typeOne(bytes: number[], kind: FieldKind, home: number): void {
    const s = this.screen;
    const dbcs = bytes[0] === SO;
    if (dbcs && kind === "plain") {
      throw new As400Error(
        "FIELD_TYPE",
        "field does not accept double-byte input (no input-control attribute)"
      );
    }
    if (!dbcs && kind === "dbcs") {
      throw new As400Error("FIELD_TYPE", "DBCS field accepts double-byte characters only");
    }

    // **`SI` の上にいるなら区間の続き**——`SO` を置き直さず、`SI` を右へずらす
    const onSi = s.charAt(s.cursor) === SI;
    const body = dbcs ? bytes.slice(1, -1) : bytes;
    const out = kind === "dbcs" || !dbcs ? body : onSi ? [...body, SI] : [SO, ...body, SI];
    const at = onSi && !dbcs ? s.wrap(s.cursor + 1) : s.cursor; // 英数は `SI` の後ろへ

    // **挿入モードなら後ろへずらす。** `SI` の上に割り込むときは `SI` 自身が右へ動くので、
    // こちらが書くのは 2 バイトだけ（`out` の末尾の `SI` は押し出された分と重なる）
    const write = this.insert && onSi && dbcs ? body : out;
    if (this.insert) this.shiftRight(at, write.length);
    this.assertRoom(at, write.length, home);
    let p = at;
    for (const b of write) {
      s.writeChar(p, b, kind === "dbcs" ? CHARSET.DBCS : 0);
      s.setMdtFor(p, true);
      p = s.wrap(p + 1);
    }
    // **末尾の `SI` にはカーソルを乗せたまま**——続けて打てば区間がそのまま伸びる
    let next = out[out.length - 1] === SI && !(this.insert && onSi && dbcs) ? s.wrap(p - 1) : p;
    // **属性桁の上には止まらない**（実測: 欄をちょうど埋めると次の桁へ抜ける）。
    // ただし次が**自動スキップ欄**（保護＋数字）なら、その先の非保護欄まで飛ぶ
    if (s.isAttrPos(next)) {
      next = parseFieldAttr(s.attrAt(next)).autoSkip ? s.nextUnprotected(next) : s.wrap(next + 1);
    }
    s.setCursor(next);
  }

  /**
   * `from` から `len` 桁が書けるか。
   *
   * **打ち始めた欄から外れたら「入り切らない」**（`FIELD_OVERFLOW`）。
   * 欄の切れ目に当たったのか、そもそも保護欄なのかで利用者が次に取る手が変わるので分けている
   * ——欄を埋め切った続きは属性桁ではなく**次の欄の中**に当たることがあり、
   * そこを `FIELD_PROTECTED` と言うと「非保護欄に打ったのに保護と言われる」ことになる。
   */
  private assertRoom(from: number, len: number, home: number): void {
    for (let k = 0; k < len; k++) {
      const p = this.screen.wrap(from + k);
      const outside = this.screen.fieldAttrPosFor(p) !== home;
      if (this.screen.isAttrPos(p) || outside) {
        if (!outside) {
          throw new As400Error("FIELD_PROTECTED", `cannot type over a field attribute at ${p}`);
        }
        throw new As400Error("FIELD_OVERFLOW", `input does not fit in the field at ${p}`);
      }
      if (this.screen.isProtectedAt(p)) {
        const rc = this.screen.rowColOf(p);
        throw new As400Error("FIELD_PROTECTED", `field at (${rc.row},${rc.col}) is protected`);
      }
    }
  }

  /** 挿入モードか */
  get insertMode(): boolean {
    return this.insert;
  }

  /** 挿入モードを切り替える（`Reset` に相当するのは `setInsertMode(false)`） */
  setInsertMode(on: boolean): void {
    this.insert = on;
  }

  /** **入力欄をすべて消してホームへ**（入力消去キー）。MDT も落ちる（実測） */
  eraseInput(): void {
    this.assertUnlocked();
    this.screen.eraseUnprotected();
    this.screen.setCursor(this.screen.firstUnprotected());
    this.afterEdit();
  }

  /** **重複キー**。0x1c を置いて**次の欄へ飛ぶ**（実測） */
  dup(): void {
    this.assertUnlocked();
    this.putControl(DUP);
    this.screen.setCursor(this.screen.nextUnprotected(this.screen.cursor));
  }

  /** **欄区切りキー**。0x1e を置いてカーソルを 1 つ進めるだけ（実測） */
  fieldMark(): void {
    this.assertUnlocked();
    this.putControl(FIELD_MARK);
    this.screen.setCursor(this.screen.wrap(this.screen.cursor + 1));
  }

  /** 制御文字を 1 桁置く（`Dup` / `Field Mark`）。カーソルは呼び手が決める */
  private putControl(byte: number): void {
    const s = this.screen;
    const home = s.fieldAttrPosFor(s.cursor);
    this.assertRoom(s.cursor, 1, home);
    s.writeChar(s.cursor, byte, s.charsetAt(s.cursor));
    s.setMdtFor(s.cursor, true);
  }

  /** **最初の非保護桁へ**（ホームキー）。非保護欄が無ければ 0 桁目 */
  home(): void {
    this.assertUnlocked();
    this.screen.setCursor(this.screen.firstUnprotected());
  }

  /** **次の非保護欄の先頭へ**（タブ）。最後まで行ったら先頭へ回り込む */
  tab(): void {
    this.assertUnlocked();
    this.screen.setCursor(this.screen.nextUnprotected(this.screen.cursor));
  }

  /**
   * **手前の非保護欄の先頭へ**（後退タブ）。
   * **欄の途中にいるなら、まずその欄の先頭へ**戻る（実測）——1 回で前の欄まで飛ばない。
   */
  backTab(): void {
    this.assertUnlocked();
    const s = this.screen;
    const ap = s.fieldAttrPosFor(s.cursor);
    const start = ap >= 0 ? s.wrap(ap + 1) : 0;
    if (ap >= 0 && !s.isProtectedAt(s.cursor) && s.cursor !== start) {
      s.setCursor(start);
      return;
    }
    const from = ap >= 0 ? ap : s.cursor;
    for (let k = 1; k <= s.size; k++) {
      const p = s.wrap(from - k);
      if (s.isAttrPos(p) && !parseFieldAttr(s.attrAt(p)).protected) {
        s.setCursor(s.wrap(p + 1));
        return;
      }
    }
  }

  /**
   * **カーソルを 1 文字ぶん左右へ。**
   *
   * **欄をまたぐ**——属性桁の上にも乗る（実測。移動キーは欄を見ない）。
   * DBCS の上だけは 1 文字＝2 桁として動く。
   */
  left(): void {
    this.assertUnlocked();
    const s = this.screen;
    const prev = s.wrap(s.cursor - 1);
    s.setCursor(this.dbcsAt(prev) === DB.TAIL ? s.wrap(s.cursor - 2) : prev);
  }

  right(): void {
    this.assertUnlocked();
    const s = this.screen;
    s.setCursor(s.wrap(s.cursor + (this.dbcsAt(s.cursor) === DB.LEAD ? 2 : 1)));
  }

  /**
   * **上下は真上・真下へ**（1 行ぶん）。
   * **DBCS の右半分に着いてもそのまま**（実測。左右と違って寄せない）。
   */
  up(): void {
    this.assertUnlocked();
    this.screen.setCursor(this.screen.wrap(this.screen.cursor - this.screen.cols));
  }

  down(): void {
    this.assertUnlocked();
    this.screen.setCursor(this.screen.wrap(this.screen.cursor + this.screen.cols));
  }

  /**
   * **次の行の頭へ**（改行キー）。そこが打てない桁なら**その先の非保護欄の先頭**まで進む
   * （実測: 行頭が非保護ならそこで止まり、保護なら次の欄まで飛ぶ）。
   */
  newline(): void {
    this.assertUnlocked();
    const s = this.screen;
    const row = Math.floor(s.cursor / s.cols);
    const head = s.wrap(((row + 1) % s.rows) * s.cols);
    const writable = !s.isAttrPos(head) && !s.isProtectedAt(head);
    s.setCursor(writable ? head : s.nextUnprotected(s.wrap(head - 1)));
  }

  /**
   * **カーソルを 1 文字ぶん左へ**（3270 の後退キー。**消さない**）。
   * DBCS の上では 2 桁動く（実測: s3270 の `BackSpace()` はカーソルだけを動かす）。
   */
  backspace(): void {
    this.assertUnlocked();
    const s = this.screen;
    const prev = s.wrap(s.cursor - 1);
    if (s.isAttrPos(prev)) return; // 欄の先頭より手前へは出ない
    s.setCursor(this.dbcsAt(prev) === DB.TAIL ? s.wrap(s.cursor - 2) : prev);
  }

  /**
   * **カーソルの手前の 1 文字を消す**（破壊的な後退）。
   * 混在欄で区間が空になったら `SO` と `SI` も落とす（実測）。
   */
  erase(): void {
    this.assertUnlocked();
    const s = this.screen;
    const prev = s.wrap(s.cursor - 1);
    if (s.isAttrPos(prev)) return;
    const wide = this.dbcsAt(prev) === DB.TAIL;
    let from = wide ? s.wrap(s.cursor - 2) : prev;
    let len = wide ? 2 : 1;
    // **区間が空になるなら `SO`/`SI` ごと**
    const before = s.wrap(from - 1);
    const after = s.wrap(from + len);
    if (wide && s.charAt(before) === SO && s.charAt(after) === SI) {
      from = before;
      len += 2;
    }
    this.blank(from, len);
    s.setCursor(from);
    this.afterEdit();
  }

  /**
   * **カーソル位置の 1 文字を消し、後ろを詰める**（削除キー）。
   * DBCS なら 2 桁ぶん詰める。カーソルは動かない。
   */
  delete(): void {
    this.assertUnlocked();
    const s = this.screen;
    const cur = s.cursor;
    if (s.isAttrPos(cur) || s.isProtectedAt(cur)) return;
    const width = this.dbcsAt(cur) === DB.LEAD ? 2 : 1;
    const end = this.fieldEnd(cur);
    for (let p = cur; p !== end; p = s.wrap(p + 1)) {
      const src = s.wrap(p + width);
      const inside = this.distance(p, end) > width;
      s.writeChar(p, inside ? s.charAt(src) : NUL, inside ? s.charsetAt(src) : s.charsetAt(p));
    }
    s.setMdtFor(cur, true);
    this.afterEdit();
  }

  /** **カーソルから欄の終わりまで消す**（EOF 消去）。カーソルは動かない */
  eraseEof(): void {
    this.assertUnlocked();
    const s = this.screen;
    if (s.isAttrPos(s.cursor) || s.isProtectedAt(s.cursor)) return;
    this.blank(s.cursor, this.distance(s.cursor, this.fieldEnd(s.cursor)));
    this.afterEdit();
  }

  /**
   * **挿入のために欄の中身を右へずらす。**
   *
   * ずらせるのは**欄の末尾に NUL が `n` 桁ある**ときだけ——足りなければ何も動かさず
   * `FIELD_OVERFLOW`（実測: 満杯の欄への挿入は s3270 も撥ねる）。
   */
  private shiftRight(from: number, n: number): void {
    const s = this.screen;
    const end = this.fieldEnd(from);
    const len = this.distance(from, end);
    const room = (): boolean => {
      if (len < n) return false;
      for (let k = 1; k <= n; k++) if (s.charAt(s.wrap(end - k)) !== NUL) return false;
      return true;
    };
    if (!room()) {
      throw new As400Error("FIELD_OVERFLOW", `no room to insert at ${from}`);
    }
    for (let k = 1; k <= len - n; k++) {
      const dst = s.wrap(end - k);
      const src = s.wrap(dst - n);
      s.writeChar(dst, s.charAt(src), s.charsetAt(src));
    }
    s.setMdtFor(from, true);
  }

  /** `from` から `len` 桁を NUL にして MDT を立てる */
  private blank(from: number, len: number): void {
    for (let k = 0; k < len; k++) {
      const p = this.screen.wrap(from + k);
      this.screen.writeChar(p, NUL, this.screen.charsetAt(p));
      this.screen.setMdtFor(p, true);
    }
  }

  /** その桁を含む欄の**次の属性桁**の位置 */
  private fieldEnd(addr: number): number {
    const s = this.screen;
    for (let k = 1; k <= s.size; k++) {
      const p = s.wrap(addr + k);
      if (s.isAttrPos(p)) return p;
    }
    return s.wrap(addr); // 属性桁が 1 つも無い画面
  }

  private distance(from: number, to: number): number {
    const d = to - from;
    return d >= 0 ? d : d + this.screen.size;
  }

  /** その桁の DBCS 状態（SBCS のセッションでは常に `DB.NONE`） */
  private dbcsAt(addr: number): number {
    if (!codecForCcsid(this.ccsid).isDbcs) return DB.NONE;
    return dbcsStates(this.screen, true)[addr] ?? DB.NONE;
  }

  /**
   * **編集の後始末。** ホストの書き込みと同じ均しを掛ける
   * ——成立しない DBCS の対を空白に、宙に浮いた左半分を NUL に。
   * s3270 もキー操作の後に同じ処理を通している（実測: DBCS 欄で消した桁が空白になる）。
   */
  private afterEdit(): void {
    if (codecForCcsid(this.ccsid).isDbcs) normalizeDbcs(this.screen);
  }

  /** カーソルのいる欄が DBCS をどう受け取るか */
  private fieldKind(): FieldKind {
    const ap = this.screen.fieldAttrPosFor(this.screen.cursor);
    if (ap >= 0 && this.screen.charsetAt(ap) === CHARSET.DBCS) return "dbcs";
    if (ap >= 0 && this.screen.inputControlAt(ap)) return "mixed";
    return "plain";
  }

  /** AID キーを送る。送信後はキーボードがロックされ、ホストの restore で解ける */
  send(key: AidKey): void {
    this.assertUnlocked();
    if (!this.telnet) throw new As400Error("SESSION_CLOSED", "not connected");
    const record = buildReadModified(this.screen, key, { reply: this.reply });
    this.telnet.sendRecord(record);
    this.lastAid = key; // ホストが後から読みに来たときに使う
    this.insert = false; // **取引が変わるので挿入モードは持ち越さない**（実測）
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
