import { childLog } from "@ts5250/base";
import type { Transport } from "../transport/types.js";
import {
  IAC, CMD, OPT, TT_IS, TT_SEND,
  ENV_IS, ENV_SEND, ENV_VALUE, ENV_USERVAR
} from "./constants.js";
import {
  Tn3270eNegotiator,
  splitHeader,
  withHeader,
  DATA_TYPE,
  type Tn3270eOptions
} from "./tn3270e.js";

const log = childLog({ component: "tn3270-telnet" });

export interface TelnetOptions {
  /** 端末タイプ名（例 `IBM-3279-2-E@03C0`）。TERMINAL-TYPE IS で回答する */
  terminalType: string;
  /**
   * RFC 2877 の USERVAR KBDTYPE / CODEPAGE / CHARSET（NEW-ENVIRON で申告）。
   *
   * **IBM i に繋ぐときに要る。** 申告しないとホストはシステム既定のコードページで
   * 仮想デバイスを作り、variant 文字（`'@'` 等）が食い違う。
   * 素の 3270 ホスト（Hercules 等）は NEW-ENVIRON を送ってこないので影響しない。
   */
  kbdType?: string | undefined;
  codePage?: number | undefined;
  charSet?: number | undefined;
  /**
   * デバイス名（LU 名）。**経路によって渡し方が変わる**:
   * - 基本 TN3270 … 端末タイプ文字列に `@<名前>` を付ける（実測で通る慣行）
   * - TN3270E …… `DEVICE-TYPE REQUEST <型名> CONNECT <名前>`（RFC 2355 §7.1.2）
   *
   * どちらの経路になるかは交渉が始まるまで分からないので、**ここで保持して
   * 発火した側でだけ使う**（二重指定を避ける）。NEW-ENVIRON の `DEVNAME` にも使う。
   */
  deviceName?: string | undefined;
  /**
   * TN3270E 用の device-type（`IBM-3278-*`）。**省略すると TN3270E を使わない。**
   * 基本 TN3270 の `terminalType`（`IBM-3279-*`）とは別物（RFC 2355 §7.1）。
   */
  deviceType?: string | undefined;
  /**
   * TN3270E を使うか（既定 `true`）。`false` なら `DO TN3270E` に `WONT` で応じ、
   * **基本 TN3270 へ後退する**。後退経路をテストで踏むために要る。
   */
  tn3270e?: boolean | undefined;
  /** `FUNCTIONS` の往復上限（`Tn3270eNegotiator` へ渡す） */
  maxFunctionRounds?: number | undefined;
}

/**
 * 基本 TN3270（RFC 1576）の telnet 層。
 *
 * **交渉の並びは research F2 で Hercules から実測したものが唯一の根拠**
 * （`artifacts/negotiation-hercules.trc`）。RFC 1576 の記載とも一致する:
 *
 * ```
 * < fffd18                       DO   TERMINAL-TYPE
 * > fffb18                       WILL TERMINAL-TYPE
 * < fffa1801fff0                 SB   TERMINAL-TYPE SEND
 * > fffa1800 <型名> fff0          SB   TERMINAL-TYPE IS
 * < fffd19 fffb19                DO / WILL END-OF-RECORD
 * > fffb19 / fffd19              WILL / DO END-OF-RECORD
 * < fffd00 fffb00                DO / WILL BINARY
 * > fffb00 / fffd00              WILL / DO BINARY
 * < <3270 データストリーム> ffef
 * ```
 *
 * **5250 と違い SGA / NEW-ENVIRON は扱わない**。知らないオプションは DONT/WONT で断る
 * （落とさない——断るのが telnet の作法で、相手はそれで続行できる）。
 *
 * レコード境界は `IAC EOR`。**SB 本文中の IAC(FF) は二重化**されるので受信時に戻す。
 */
export class TelnetLayer {
  private buf: number[] = [];
  private recordFn: ((record: Uint8Array) => void) | undefined;
  private negotiatedFn: (() => void) | undefined;
  /** BINARY と EOR の双方が合意できたら「3270 モード」に入ったとみなす */
  private binaryAgreed = false;
  private eorAgreed = false;
  private announced = false;
  /** TN3270E の交渉器。`DO TN3270E` を受理したときだけ作る */
  private tn3270e: Tn3270eNegotiator | undefined;
  private tn3270eFailure: string | undefined;
  /**
   * ホストが NEW-ENVIRON を交渉してきたか。
   *
   * **これが IBM i の見分けになる**（実測）。IBM i は `DO NEW-ENVIRON` を出し、
   * 5250 流のシード（`IBMRSEED …`）まで送ってくる。TK4- / z/OS は出さない。
   * `DO TN3270E` では見分けられない——**IBM i は TN3270E を提示しない**（実測）。
   */
  private sawNewEnviron = false;

  constructor(
    private readonly transport: Transport,
    private readonly opts: TelnetOptions
  ) {
    transport.onData((data) => this.feed(data));
  }

  onRecord(fn: (record: Uint8Array) => void): void {
    this.recordFn = fn;
  }

  /** TN3270E で接続しているか（交渉完了後に確定する） */
  get isTn3270e(): boolean {
    return this.tn3270e?.state === "ready";
  }

  /** サーバが割り当てた device-name（TN3270E 時のみ） */
  get deviceName(): string | undefined {
    return this.tn3270e?.deviceName;
  }

  /** TN3270E の交渉が失敗した理由（REJECT / impasse）。成功なら undefined */
  /** ホストが NEW-ENVIRON を交渉してきたか（IBM i の見分けに使う素の事実） */
  get negotiatedNewEnviron(): boolean {
    return this.sawNewEnviron;
  }

  get tn3270eError(): string | undefined {
    return this.tn3270eFailure;
  }

  /** BINARY / EOR の合意が揃った時点で 1 回だけ発火する */
  onNegotiated(fn: () => void): void {
    this.negotiatedFn = fn;
  }

  /**
   * アプリのレコードを送る（IAC を二重化し、末尾に IAC EOR を付ける）。
   *
   * **TN3270E なら 5 バイトヘッダを前置する**（`3270-DATA`。RFC 2355 §8.1）。
   * ヘッダは封筒なので**この層で付ける**——上位（`outbound.ts` / `session`）は
   * 基本 TN3270 と同じものを渡すだけでよい。
   */
  sendRecord(payload: Uint8Array): void {
    const framed = this.isTn3270e ? withHeader(payload, DATA_TYPE.DATA_3270) : payload;
    const out: number[] = [];
    for (const b of framed) {
      out.push(b);
      if (b === IAC) out.push(IAC); // 本文中の FF は二重化
    }
    out.push(IAC, CMD.EOR);
    this.transport.send(Uint8Array.from(out));
  }

  /**
   * 受信バイトを食わせる。telnet の制御列を取り除き、`IAC EOR` ごとに
   * アプリのレコードとして `onRecord` へ渡す。
   *
   * **TCP はどこで切れるか分からない**ので、途中で終わった telnet 列（`IAC` だけ、
   * `IAC DO` だけ、`IAC SB …` の SE 待ち）は `pending` に持ち越して次の chunk と繋ぐ。
   * ここを持ち越さないと、**分割されたときだけ交渉が壊れる**——再現しにくい形で。
   */
  private pending: number[] = [];

  private feed(data: Uint8Array): void {
    for (const b of data) this.pending.push(b);

    let i = 0;
    const n = this.pending.length;
    while (i < n) {
      const b = this.pending[i]!;
      if (b !== IAC) {
        this.buf.push(b);
        i++;
        continue;
      }
      const next = this.pending[i + 1];
      if (next === undefined) break; // IAC だけで途切れた → 持ち越し
      if (next === IAC) {
        this.buf.push(IAC); // 二重化の解除
        i += 2;
      } else if (next === CMD.EOR) {
        this.emitRecord();
        i += 2;
      } else if (next === CMD.SB) {
        const consumed = this.handleSubnegotiation(i + 2);
        if (consumed < 0) break; // SE がまだ来ていない → 持ち越し
        i = consumed;
      } else if (next === CMD.DO || next === CMD.DONT || next === CMD.WILL || next === CMD.WONT) {
        const opt = this.pending[i + 2];
        if (opt === undefined) break; // オプション番号待ち → 持ち越し
        this.handleOption(next, opt);
        i += 3;
      } else {
        i += 2; // 2 バイトの制御（NOP 等）は読み飛ばす
      }
    }
    this.pending = this.pending.slice(i);
  }

  /**
   * 1 レコードを上位へ渡す。
   *
   * **TN3270E なら 5 バイトヘッダを剥がし、`3270-DATA` だけを渡す**（§8.1 / §9）。
   * `NVT-DATA` はモード切替の要求（§9.1）だが NVT は実装しないので読み飛ばす。
   * 未知の種別も**落とさずに記録して読み飛ばす**。
   */
  private emitRecord(): void {
    const record = Uint8Array.from(this.buf);
    this.buf = [];
    if (record.length === 0) return;

    if (!this.isTn3270e) {
      this.recordFn?.(record);
      return;
    }
    const split = splitHeader(record);
    if (split === null) {
      log.debug(`TN3270E record shorter than header (${record.length} bytes); skipped`);
      return;
    }
    if (split.header.dataType !== DATA_TYPE.DATA_3270) {
      log.debug(`TN3270E data-type 0x${split.header.dataType.toString(16)} not handled; skipped`);
      return;
    }
    if (split.body.length > 0) this.recordFn?.(split.body);
  }

  /**
   * 既に応答済みの (方向, オプション) 対。**再応答を抑えるために要る。**
   *
   * RFC 854 は「状態が変わらないなら応答してはならない」と定める——さもないと
   * 双方が肯定応答を返し続けて**交渉が無限ループになる**。Hercules は各オプションを
   * 1 回しか送らないので実測では踏まなかったが、踏んだときに黙ってループするのは最悪なので
   * 実装で塞ぐ（`will:0` / `do:25` のような鍵で持つ）。
   */
  private answered = new Set<string>();

  private handleOption(cmd: number, opt: number): void {
    // **TN3270E を使うか**は 2 条件——利用側が有効にしていて、device-type を渡していること
    const wantTn3270e = (this.opts.tn3270e ?? true) && this.opts.deviceType !== undefined;
    const known =
      opt === OPT.BINARY ||
      opt === OPT.TERMINAL_TYPE ||
      opt === OPT.END_OF_RECORD ||
      // **IBM i は NEW-ENVIRON を送ってくる**。断るとコードページを申告できず
      // variant 文字が化ける（`constants.ts` の OPT.NEW_ENVIRON 参照）
      opt === OPT.NEW_ENVIRON ||
      (opt === OPT.TN3270E && wantTn3270e);
    if (!known) {
      // 知らないオプションは断る。**落とさない**——断れば相手は続行できる
      const reply = cmd === CMD.DO || cmd === CMD.DONT ? CMD.WONT : CMD.DONT;
      if (this.once(`refuse:${reply}:${opt}`)) {
        log.debug(`unknown telnet option ${opt}; refusing`);
        this.transport.send(Uint8Array.from([IAC, reply, opt]));
      }
      return;
    }
    if (cmd === CMD.DO) {
      if (this.once(`will:${opt}`)) this.transport.send(Uint8Array.from([IAC, CMD.WILL, opt]));
      this.markAgreed(opt);
    } else if (cmd === CMD.WILL) {
      if (this.once(`do:${opt}`)) this.transport.send(Uint8Array.from([IAC, CMD.DO, opt]));
      this.markAgreed(opt);
    }
    // DONT / WONT は合意を取り下げるだけ。3270 では実質来ない
  }

  /** その応答をまだ返していなければ true（返したことを記録する） */
  private once(key: string): boolean {
    if (this.answered.has(key)) return false;
    this.answered.add(key);
    return true;
  }

  private markAgreed(opt: number): void {
    if (opt === OPT.BINARY) this.binaryAgreed = true;
    if (opt === OPT.END_OF_RECORD) this.eorAgreed = true;
    // **端末タイプを送るより前に立てる必要がある**（`sendTerminalType` が見る）。
    // 実測の順は `DO NEW-ENVIRON` → `SB TERMINAL-TYPE SEND` なので、DO で立てれば間に合う
    if (opt === OPT.NEW_ENVIRON) this.sawNewEnviron = true;
    if (opt === OPT.TN3270E && this.tn3270e === undefined) {
      // `WILL TN3270E` を返した。以降のサブネゴシエーションは交渉器に委ねる
      const o: Tn3270eOptions = { deviceType: this.opts.deviceType! };
      if (this.opts.deviceName !== undefined) o.deviceName = this.opts.deviceName;
      if (this.opts.maxFunctionRounds !== undefined) o.maxFunctionRounds = this.opts.maxFunctionRounds;
      this.tn3270e = new Tn3270eNegotiator(o);
      log.debug("TN3270E accepted; awaiting SEND DEVICE-TYPE");
    }
    this.maybeAnnounce();
  }

  /**
   * 交渉完了を 1 回だけ知らせる。
   *
   * **TN3270E のときは交渉器が `ready` になるまで待つ。** BINARY / EOR だけで発火させると、
   * セッションが使える気になった直後に送信してホストに弾かれる。
   */
  private maybeAnnounce(): void {
    if (this.announced) return;
    if (!this.binaryAgreed || !this.eorAgreed) return;
    if (this.tn3270e !== undefined && this.tn3270e.state !== "ready") return;
    this.announced = true;
    log.debug(this.isTn3270e ? "TN3270E mode established" : "3270 mode established (BINARY + EOR)");
    this.negotiatedFn?.();
  }

  /**
   * `IAC SB <opt> … IAC SE` を処理する。`pending` 内の `start`（opt の位置）から読む。
   * 戻り値は SE の次の位置。**SE がまだ届いていなければ -1**（持ち越しの合図）。
   */
  private handleSubnegotiation(start: number): number {
    const opt = this.pending[start];
    if (opt === undefined) return -1;
    let i = start + 1;
    const body: number[] = [];
    for (;;) {
      const b = this.pending[i];
      if (b === undefined) return -1; // SE 待ち
      if (b === IAC) {
        const nx = this.pending[i + 1];
        if (nx === undefined) return -1;
        if (nx === IAC) {
          body.push(IAC); // 本文中の二重化を解除
          i += 2;
          continue;
        }
        if (nx === CMD.SE) {
          i += 2;
          break;
        }
      }
      body.push(b);
      i++;
    }
    if (opt === OPT.TERMINAL_TYPE && body[0] === TT_SEND) this.sendTerminalType();
    if (opt === OPT.NEW_ENVIRON && body[0] === ENV_SEND) {
      // **ここが IBM i の印**。SEND を投げてくるのは IBM i だけ（実測）
      this.sawNewEnviron = true;
      this.sendEnviron();
    }
    if (opt === OPT.TN3270E) this.handleTn3270e(body);
    return i;
  }

  /**
   * NEW-ENVIRON の SEND に応える。
   *
   * **ホストが要求した変数を選り分けずに、こちらが申告したいものを IS で返す**
   * （RFC 1572 は要求に無い変数を返すことを許す）。
   *
   * ## `DEVNAME` は送らない（実測）
   *
   * NEW-ENVIRON を要求してくるのは **IBM i だけ**（TK4- / z/OS は要求しない）。
   * その IBM i は、**3270 の接続で `DEVNAME` を受け取ると交渉後に黙ってソケットを閉じる**。
   *
   * ```
   * DEVNAME=AS3270A  → 交渉は通るが、Query Reply の直後に CLOSE。画面は 1 文字も来ない
   * DEVNAME 無し      → ready。画面が来る
   * ```
   *
   * 名前を 4 通り（`AS3270A` / `TST3270X` / `QPADEV0099` / `D3270TST`）試して全て同じ。
   * `DEVNAME` を止めるだけで通るところまで確かめた（この 1 行が引き金）。
   *
   * 背景: `DEVNAME` は RFC 4777 の **5250 向け**の仕組みで、3270 の装置名は
   * TN3270E の `CONNECT`（RFC 2355）で渡すのが筋。**IBM i は TN3270E を提示しない**ので
   * （実測）、この接続では装置名を通す道が無い。
   *
   * 装置名は **`@名前`（Hercules 系）** と **TN3270E の `CONNECT`** の 2 経路だけで扱う。
   */
  private sendEnviron(): void {
    const payload: number[] = [OPT.NEW_ENVIRON, ENV_IS];
    const put = (name: string, value: string): void => {
      payload.push(ENV_USERVAR, ...ascii(name), ENV_VALUE, ...ascii(value));
    };
    if (this.opts.deviceName !== undefined) {
      // **黙って無視しない。** 設定したのに効かないのは、理由が見えないと追えない
      log.warn(
        `装置名 ${this.opts.deviceName} は使いません: ` +
          `このホストは NEW-ENVIRON を使う（IBM i）ため、3270 では装置名を受け付けません`
      );
    }
    // RFC 2877: デバイスのコードページを申告し、ホストにジョブ CCSID との変換をさせる。
    // **KBDTYPE は必須**——CODEPAGE/CHARSET だけでは反応しないホストがある（5250 側の実機知見）
    if (this.opts.kbdType !== undefined) put("KBDTYPE", this.opts.kbdType);
    if (this.opts.codePage !== undefined) put("CODEPAGE", String(this.opts.codePage));
    if (this.opts.charSet !== undefined) put("CHARSET", String(this.opts.charSet));

    const out: number[] = [IAC, CMD.SB];
    for (const b of payload) {
      out.push(b);
      if (b === IAC) out.push(IAC);
    }
    out.push(IAC, CMD.SE);
    log.debug(`SENT SB NEW-ENVIRON IS (${payload.length} bytes)`);
    this.transport.send(Uint8Array.from(out));
  }

  /**
   * `IAC SB TN3270E … IAC SE` の本文を交渉器に渡し、返ってきた本文を包んで送り返す。
   * **交渉のロジックは `tn3270e.ts` に閉じている**（この層はソケットへの出し入れだけ）。
   */
  private handleTn3270e(body: readonly number[]): void {
    const neg = this.tn3270e;
    if (neg === undefined) return;
    const reply = neg.handle(body);
    if (reply !== null) {
      const out: number[] = [IAC, CMD.SB, OPT.TN3270E];
      for (const b of reply) {
        out.push(b);
        if (b === IAC) out.push(IAC);
      }
      out.push(IAC, CMD.SE);
      this.transport.send(Uint8Array.from(out));
    }
    if (neg.state === "rejected" || neg.state === "failed") {
      this.tn3270eFailure = neg.error ?? "TN3270E negotiation failed";
      log.debug(this.tn3270eFailure);
    }
    this.maybeAnnounce();
  }

  private sendTerminalType(): void {
    // **`@<装置名>` は基本 TN3270 の慣行**。TN3270E では `CONNECT` で渡すので付けない。
    //
    // **IBM i には付けてはならない。** あちらは装置名を NEW-ENVIRON の `DEVNAME` で
    // 受け取り、`IBM-3279-2-E@AS3270A` という端末タイプは解さない——実測で
    // **交渉が 15 秒で時間切れ**になった。`DEVNAME` は `sendEnviron` が既に送っている。
    const base = this.opts.terminalType;
    const useSuffix =
      this.opts.deviceName !== undefined &&
      !base.includes("@") &&
      this.tn3270e === undefined &&
      !this.sawNewEnviron;
    const name = useSuffix ? `${base}@${this.opts.deviceName}` : base;
    const out: number[] = [IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_IS];
    for (let k = 0; k < name.length; k++) {
      const c = name.charCodeAt(k) & 0xff; // 端末タイプ名は ASCII
      out.push(c);
      if (c === IAC) out.push(IAC);
    }
    out.push(IAC, CMD.SE);
    log.debug(`SENT SB TERMINAL-TYPE IS ${name}`);
    this.transport.send(Uint8Array.from(out));
  }
}

/** 変数名・値は ASCII（RFC 1572） */
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0) & 0xff);
}
