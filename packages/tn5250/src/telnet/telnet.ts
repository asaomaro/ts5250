import type { Transport } from "../transport/types.js";
import {
  IAC,
  CMD,
  OPT,
  TT_IS,
  TT_SEND,
  ENV_IS,
  ENV_SEND,
  ENV_VAR,
  ENV_USERVAR,
  ENV_VALUE,
  ENV_ESC
} from "./constants.js";
import { DeviceNameGenerator, type DeviceNameEnv } from "./device-name.js";

export interface TelnetOptions {
  /** 端末タイプ名（例 IBM-3179-2）。TERMINAL-TYPE IS で回答する */
  terminalType: string;
  /**
   * RFC 4777 デバイス名（NEW-ENVIRON の USERVAR DEVNAME）。省略時はホスト採番。
   * **ACS と同じく置換記号を展開し、大文字にして送る**（`device-name.ts`。聞かれるたびに `=` の番号が進む）
   */
  deviceName?: string | undefined;
  /** 置換記号の展開に使う外の値（機械名・利用者名・プリンターか） */
  deviceNameEnv?: DeviceNameEnv | undefined;
  /** 当 PJ の `deviceNameRetry`: 記号の無い名前でも、使用中なら末尾の数字を繰り上げて答え直す */
  deviceNameRetry?: boolean | undefined;
  /**
   * **自動サインオンの代替パスワードを作る**（ホストの SEND のサーバーのシードを受け取り、自分のシードと代替パスワードを返す）。
   * 渡せば ACS と同じく暗号化して送る。無ければ従来どおり平文。計算（QPWDLVL ごとの DES・SHA）は呼び出し側が持つ
   * （server が `@ts5250/hostserver` の `bypassSignonSubstitute` で作る）
   */
  passwordSubstitute?: ((serverSeed: Uint8Array) => Promise<{ clientSeed: Uint8Array; substitute: Uint8Array }>) | undefined;
  /** RFC 4777 自動サインオン: ユーザープロファイル（USER 変数）。password と併せて指定（**password が無ければ送らない**。ACS と同じ） */
  user?: string | undefined;
  /**
   * RFC 4777 自動サインオン: パスワード。user と併せて指定すると NEW-ENVIRON で
   * IBMRSEED（ゼロシード）＋IBMSUBSPW（非暗号化パスワード）を送る（decisions.md D3）。
   * ゼロシードのためパスワードは平文で送られる（暗号化＝非ゼロシードは将来拡張）。
   */
  password?: string | undefined;
  /**
   * RFC 2877 の USERVAR KBDTYPE / CODEPAGE / CHARSET。クライアントの EBCDIC コードページを
   * ホストに申告する。ホストはこの値で仮想デバイスを作り、ジョブ CCSID との差を変換する。
   * 申告しないとホストはシステム既定を使うため variant 文字（'@' 等）が食い違う
   * （PUB400 実機で確認: 無申告だと '@' 入りパスワードが化けて CPF1120）。
   * KBDTYPE は必須。CODEPAGE/CHARSET だけでは PUB400 は反応しない。
   */
  kbdType?: string | undefined;
  codePage?: number | undefined;
  charSet?: number | undefined;
  // ~~プリンター用の個別の口（ibmFont / ibmTransform / ibmMfrTypMdl）~~ は撤去した——プリンターは ACS の組を
  // `userVars` で並べて渡す（`20260921-printer-acs-declaration`）。~~IBMFONT/IBMTRANSFORM を送らないと 8925~~ は、
  // 一緒に送っていた KBDTYPE ほかの組が原因だった（PUB400 で ACS の組は I902）
  /**
   * **DEVNAME の後ろに、この順で送る USERVAR**（`20260921-printer-acs-declaration`）。
   * プリンターは ACS の組（`NVT5250.userVarPRTSB` ほか）をそのまま並べて渡す——個別の口（ibmFont 等）を
   * 組み合わせる形では、ACS に無い変数を混ぜたり並びが違ったりする（実機で当 PJ の組だけ 8925・CPA3303 になった）。
   * `value` を省くと値なし（`IBMFORMFEED`）。`raw` は値を生のバイトで送る（用紙入れの ESC＋0x00）。
   */
  userVars?: readonly UserVar[] | undefined;
  /**
   * IBMSENDCONFREC=YES を送るか（既定 true）。**プリンターは送らない**——ACS は `startupResponse = false` にする
   * （`NVT5250.getHostDeviceOptions`）。プリンターの起動応答は申告しなくても届く（実機・PUB400 で I902 を確認）。
   */
  sendConfRec?: boolean | undefined;
}

/** NEW-ENVIRON で送る USERVAR 1 つ（`TelnetOptions.userVars`） */
export interface UserVar {
  name: string;
  value?: string | undefined;
  raw?: readonly number[] | undefined;
}

/** クライアントとして有効化に同意する telnet オプション */
const SUPPORTED: ReadonlySet<number> = new Set<number>([
  OPT.BINARY,
  OPT.SGA,
  OPT.TERMINAL_TYPE,
  OPT.EOR,
  OPT.NEW_ENVIRON
]);

const enum ParseState {
  Data,
  Iac,
  OptNeg, // WILL/WONT/DO/DONT の直後（オプションバイト待ち）
  Sb, // サブネゴシエーション本文
  SbIac // サブネゴシエーション中の IAC（SE 待ち）
}

/**
 * telnet 層（design: RFC 1205 の telnet 層と SC30-3533 のデータストリーム層の文書境界に一致させる）。
 * - IAC ネゴシエーション（BINARY/SGA/TERMINAL-TYPE/EOR/NEW-ENVIRON）に応答する
 * - IAC エスケープを解除し、IAC EOR 区切りの完全な 5250 レコードだけを onRecord に渡す
 * - sendRecord は IAC エスケープ＋IAC EOR 付与を行う
 */
export class TelnetLayer {
  private state = ParseState.Data;
  private negCmd = 0;
  private record: number[] = [];
  private sb: number[] = [];
  private recordFn: ((record: Uint8Array) => void) | undefined;

  /** 装置名（聞かれるたびに次を出す。`deviceName` が無ければ無い） */
  private readonly devNames: DeviceNameGenerator | undefined;

  constructor(
    private readonly transport: Transport,
    private readonly opts: TelnetOptions
  ) {
    this.devNames =
      opts.deviceName !== undefined
        ? new DeviceNameGenerator(opts.deviceName, opts.deviceNameEnv, opts.deviceNameRetry === true)
        : undefined;
    transport.onData((data) => this.feed(data));
  }

  /** 最後に送った装置名（展開・大文字化の後）。まだ送っていなければ指定のまま */
  get deviceName(): string | undefined {
    return this.devNames?.current ?? this.opts.deviceName;
  }

  /**
   * 装置が使用中（8902）と言われたとき、**同じ接続の中で別の名前で答え直せるか**。ホストは使用中だと
   * NEW-ENVIRON SEND で聞き直してくる（実測）ので、そのとき次の名前を送る。答え直せないなら拒否として扱う
   */
  canRetryDeviceName(): boolean {
    return this.devNames?.canRetry() === true;
  }

  onRecord(fn: (record: Uint8Array) => void): void {
    this.recordFn = fn;
  }

  /** 通信路が閉じたか。**交渉の返事を閉じた先へ送らない**ための門番 */
  private closed = false;

  onClose(fn: (reason: string) => void): void {
    this.transport.onClose((reason) => {
      this.closed = true;
      fn(reason);
    });
  }

  onError(fn: (err: Error) => void): void {
    this.transport.onError(fn);
  }

  close(): void {
    this.closed = true;
    this.transport.close();
  }

  /** 5250 レコードを IAC エスケープして IAC EOR 付きで送信する */
  sendRecord(record: Uint8Array): void {
    let extra = 2;
    for (const b of record) if (b === IAC) extra++;
    const out = new Uint8Array(record.length + extra);
    let o = 0;
    for (const b of record) {
      out[o++] = b;
      if (b === IAC) out[o++] = IAC;
    }
    out[o++] = IAC;
    out[o++] = CMD.EOR;
    this.transport.send(out);
  }

  /**
   * **非同期の返事（暗号化した自動サインオンの IS）を作っている間は、後続の受信を溜めて処理しない**。
   * 平文なら SEND を受けた直後に IS を返し、それから端末タイプ・BINARY・EOR の交渉に答える。代替パスワードの計算を待つ間に
   * 後続へ答えてしまうと IS が交渉の後に届き、ホストは IS を待たずにサインオン画面を出した（PUB400 で実測。`20260921-encrypted-autosignon`）
   */
  private paused = false;
  private stash: number[] = [];

  private resume(): void {
    this.paused = false;
    const rest = Uint8Array.from(this.stash);
    this.stash = [];
    if (rest.length > 0) this.feed(rest);
  }

  private feed(data: Uint8Array): void {
    if (this.paused) {
      for (const b of data) this.stash.push(b);
      return;
    }
    for (let i = 0; i < data.length; i++) {
      const b = data[i]!;
      if (this.paused) {
        // 直前の SB で非同期の返事に入った。残りは返事を送ってから処理する
        for (let k = i; k < data.length; k++) this.stash.push(data[k]!);
        return;
      }
      switch (this.state) {
        case ParseState.Data:
          if (b === IAC) this.state = ParseState.Iac;
          else this.record.push(b);
          break;
        case ParseState.Iac:
          this.handleIac(b);
          break;
        case ParseState.OptNeg: {
          // 先に状態を戻す: 応答 send がリプレイ等で再入的に次データを流しても誤読しないため
          const cmd = this.negCmd;
          this.state = ParseState.Data;
          this.handleOptNeg(cmd, b);
          break;
        }
        case ParseState.Sb:
          if (b === IAC) this.state = ParseState.SbIac;
          else this.sb.push(b);
          break;
        case ParseState.SbIac:
          if (b === IAC) {
            this.sb.push(IAC);
            this.state = ParseState.Sb;
          } else if (b === CMD.SE) {
            const sb = Uint8Array.from(this.sb);
            this.sb = [];
            this.state = ParseState.Data; // 同上: ハンドラより先に状態復帰（再入対策）
            this.handleSubnegotiation(sb);
          } else {
            // 不正な SB 終端。破棄して復帰
            this.sb = [];
            this.state = ParseState.Data;
          }
          break;
      }
    }
  }

  private handleIac(b: number): void {
    switch (b) {
      case IAC: // エスケープされた 0xFF
        this.record.push(IAC);
        this.state = ParseState.Data;
        break;
      case CMD.EOR: {
        const rec = Uint8Array.from(this.record);
        this.record = [];
        this.state = ParseState.Data;
        this.recordFn?.(rec);
        break;
      }
      case CMD.WILL:
      case CMD.WONT:
      case CMD.DO:
      case CMD.DONT:
        this.negCmd = b;
        this.state = ParseState.OptNeg;
        break;
      case CMD.SB:
        this.sb = [];
        this.state = ParseState.Sb;
        break;
      default:
        // NOP/GA 等は無視
        this.state = ParseState.Data;
        break;
    }
  }

  /** DO→WILL/WONT・WILL→DO/DONT の応答（クライアント側はネゴを開始しない） */
  private handleOptNeg(cmd: number, opt: number): void {
    const supported = SUPPORTED.has(opt);
    if (cmd === CMD.DO) {
      this.sendCmd(supported ? CMD.WILL : CMD.WONT, opt);
    } else if (cmd === CMD.WILL) {
      this.sendCmd(supported ? CMD.DO : CMD.DONT, opt);
    }
    // WONT/DONT には応答しない（合意済みの無効化として受理）
  }

  private handleSubnegotiation(sb: Uint8Array): void {
    const opt = sb[0];
    if (opt === OPT.TERMINAL_TYPE && sb[1] === TT_SEND) {
      const name = [...this.opts.terminalType].map((c) => c.charCodeAt(0));
      this.sendSb([OPT.TERMINAL_TYPE, TT_IS, ...name]);
    } else if (opt === OPT.NEW_ENVIRON && sb[1] === ENV_SEND) {
      // RFC 4777: DEVNAME＋（指定時）自動サインオン変数を回答（未設定なら空 IS）
      const payload: number[] = [OPT.NEW_ENVIRON, ENV_IS];
      if (this.devNames !== undefined) {
        // 聞かれるたびに次の名前（ACS `NVT5250` も DEVNAME を書くたびに `AutoDeviceName5250` を通す）
        payload.push(ENV_USERVAR, ...ascii("DEVNAME"), ENV_VALUE, ...ascii(this.devNames.next()));
      }
      for (const v of this.opts.userVars ?? []) {
        payload.push(ENV_USERVAR, ...ascii(v.name), ENV_VALUE, ...(v.raw ?? ascii(v.value ?? "")));
      }
      // RFC 2877: デバイスのコードページを申告し、ホストにジョブ CCSID との変換をさせる
      if (this.opts.kbdType !== undefined) {
        payload.push(ENV_USERVAR, ...ascii("KBDTYPE"), ENV_VALUE, ...ascii(this.opts.kbdType));
      }
      if (this.opts.codePage !== undefined) {
        payload.push(ENV_USERVAR, ...ascii("CODEPAGE"), ENV_VALUE, ...ascii(String(this.opts.codePage)));
      }
      if (this.opts.charSet !== undefined) {
        payload.push(ENV_USERVAR, ...ascii("CHARSET"), ENV_VALUE, ...ascii(String(this.opts.charSet)));
      }
      // IBMSENDCONFREC=YES: ホストが確認レコードを送る作法を申告する（RFC 4777）。
      // ACS 実機が送っており、当方も合わせる（無いとホストの応答経路が変わる）。
      if (this.opts.sendConfRec !== false) {
        payload.push(ENV_USERVAR, ...ascii("IBMSENDCONFREC"), ENV_VALUE, ...ascii("YES"));
      }
      // ACS は利用者名・パスワードが空か長すぎる（10 文字・128 文字を超える）と自動サインオンをやめ、USER もパスワードも
      // 送らない（`NVT5250` が `ssoType` を 0 に戻す）。長さは Java の `trim()` のあとで見る。パスワードは**末尾の空白を落としてから**
      // 空かを見る（空白だけのパスワードも空。節目の点検の指摘）
      const user = this.opts.user === undefined ? undefined : javaTrim(this.opts.user);
      const pw = this.opts.password;
      const bypassRejected =
        pw !== undefined && (user === "" || pw.replace(/ +$/, "") === "" || (user ?? "").length > 10 || javaTrim(pw).length > 128);
      /**
       * 利用者名とパスワードの変数を足して送る。`auth` は代替パスワード（暗号化）——`undefined` なら平文、`null` なら作れなかった。
       * ~~作れなければパスワードの変数を送らない（ACS も IBMSUBSPW を書かない）~~ → 原典と違った（節目の点検の指摘）: ACS は変数の頭
       * （`03 名前 01`）を値より先に書くので、作れなくても IBMRSEED に自分のシード、IBMSUBSPW は**値の無いまま**送る
       * （`NVT5250.insertVariable`）。PUB400（QPWDLVL 3・QRMTSIGN *VERIFY）は起動応答のコードを `0004`（コード表に無い）にして
       * サインオン画面を出した（実測。CPF の文言は出ない）。ACS はコード表に無いコードを状態行に出すだけで続ける（`AcsOnly`）。
       * サインオンの失敗回数に数えるかは未確認
       */
      const finish = (auth?: { clientSeed: Uint8Array; substitute: Uint8Array } | null): void => {
        // **USER はパスワード付きの自動サインオンのときだけ送る**（ACS `NVT5250.insertUser` は `ssoType` 3・4 のときだけ。
        // `20260921-user-without-password`）。~~利用者名だけでも USER を送る~~——PUB400 では送っても送らなくてもサインオン画面で、
        // 利用者名も入らなかった（実測）
        if (user !== undefined && pw !== undefined && !bypassRejected) {
          // USER は well-known 変数（VAR）、他は USERVAR（RFC 4777 / tn5250j に準拠）。
          // 前後の制御文字・空白を落として大文字にする（ACS `NVT5250` の自動サインオンの利用者名と同じ正規化。
          // ~~JS の `trim()`~~ は U+3000・U+00A0 も落とし、0x01 などの制御文字は落とさない——Java の `trim()` は U+0020 以下だけ）
          payload.push(ENV_VAR, ...ascii("USER"), ENV_VALUE, ...envValue(ascii(user.toUpperCase())));
          if (pw !== undefined && auth) {
            // **暗号化**: IBMRSEED に自分のシード、IBMSUBSPW に代替パスワード（ACS と同じ。値の 0x00〜0x03 は ESC で、0xFF は
            // telnet の層で二重にする。`20260921-encrypted-autosignon`）
            payload.push(ENV_USERVAR, ...ascii("IBMRSEED"), ENV_VALUE, ...envValue([...auth.clientSeed]));
            payload.push(ENV_USERVAR, ...ascii("IBMSUBSPW"), ENV_VALUE, ...envValue([...auth.substitute]));
          } else if (pw !== undefined && auth === null) {
            payload.push(ENV_USERVAR, ...ascii("IBMRSEED"), ENV_VALUE, ...envValue([...crypto.getRandomValues(new Uint8Array(8))]));
            payload.push(ENV_USERVAR, ...ascii("IBMSUBSPW"), ENV_VALUE);
          } else if (pw !== undefined && auth === undefined) {
            // **IBMRSEED は値を付けない**（平文のパスワードの印。ACS `NVT5250.insertVariable` の IBMRSEED は平文の
            // 自動サインオンでは名前だけ書いて値を書かない。`20260921-telnet-signon-vars`）。
            // ~~ESC + 8 バイトのゼロシード~~——エスケープされるのが先頭の 1 バイトだけで、残る 7 個の 0x00 は
            // RFC 1572 では空の VAR として読まれていた（台帳「【まとめ】telnet」）
            payload.push(ENV_USERVAR, ...ascii("IBMRSEED"), ENV_VALUE);
            // IBMSUBSPW = 平文のパスワード。末尾の空白は落とす（ACS も同じ）
            payload.push(ENV_USERVAR, ...ascii("IBMSUBSPW"), ENV_VALUE, ...envValue(ascii(pw.replace(/ +$/, ""))));
          }
        }
        this.sendSb(payload);
      };
      // **代替パスワードで送れるなら暗号化する**（ACS は自動サインオンでパスワードを平文で送らない。`AcsOnly.initBypassSignon` は
      // 常に `ssoBypassSignonEncrypted`）。サーバーのシードはホストの SEND の `USERVAR IBMRSEED` の後ろの 8 バイト
      // （ACS `NVT5250` も値の印を挟まずに 8 バイトを読む）。計算は呼び出し側が渡す（この層は暗号に触れない）
      const makeSubstitute = this.opts.passwordSubstitute;
      if (makeSubstitute !== undefined && user !== undefined && !bypassRejected && pw !== undefined) {
        const serverSeed = serverSeedOf(sb);
        if (serverSeed === undefined) {
          finish(null); // シードが無ければ作れない（ACS は例外になり、値の無い IBMSUBSPW を送る。`finish` の注記）
          return;
        }
        this.paused = true;
        makeSubstitute(serverSeed)
          .then(
            (auth) => finish(auth),
            () => finish(null)
          )
          .finally(() => this.resume());
        return;
      }
      finish();
    }
    // その他のサブネゴシエーションは無視
  }

  /**
   * **交渉の返事を送る。閉じた後は黙って捨てる**（`20260802-device-busy-record`）。
   *
   * ここは**受信データの処理中に呼ばれる**——ホストが交渉の途中でソケットを閉じると、
   * 既に届いていたバイトの処理が続き、閉じた通信路へ送りに行く。
   * `TcpTransport.send` は閉じていると投げるので、その例外は
   * **ソケットのコールバックから飛び出して捕まえる相手がいない**（プロセスが落ちる）。
   *
   * 実機で、**装置名が使用中で断られたとき**に踏んだ
   * （`transport is closed` が `handleSubnegotiation` から飛んだ）。
   * 交渉の返事は相手が居てこそ意味があるので、閉じた後は送らないのが正しい。
   */
  private sendDuringNegotiation(bytes: Uint8Array): void {
    if (this.closed) return;
    try {
      this.transport.send(bytes);
    } catch {
      // 送る先が無くなっただけ。**接続の失敗は `onClose` が伝える**ので、ここでは黙る
      this.closed = true;
    }
  }

  private sendCmd(cmd: number, opt: number): void {
    this.sendDuringNegotiation(Uint8Array.from([IAC, cmd, opt]));
  }

  private sendSb(payload: number[]): void {
    // SB 本文中の IAC(0xFF) は二重化する（telnet エスケープ）。値に 0xFF が来ても壊れないように
    const escaped: number[] = [];
    for (const b of payload) {
      escaped.push(b);
      if (b === IAC) escaped.push(IAC);
    }
    this.sendDuringNegotiation(Uint8Array.from([IAC, CMD.SB, ...escaped, IAC, CMD.SE]));
  }
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/**
 * ホストの NEW-ENVIRON SEND（`sb` は OPT から）に `USERVAR IBMRSEED` とその後ろの 8 バイト（サーバーのシード）があれば返す。
 * RFC 1572 の SEND は名前だけだが、IBM i は名前の直後に値の印を挟まずシードを置く（ACS `NVT5250` も同じ読み方。実測でも同じ形）
 */
function serverSeedOf(sb: Uint8Array): Uint8Array | undefined {
  const name = [...ascii("IBMRSEED")];
  for (let i = 2; i + 1 + name.length + 8 <= sb.length; i++) {
    if (sb[i] !== ENV_USERVAR) continue;
    if (!name.every((b, k) => sb[i + 1 + k] === b)) continue;
    return sb.slice(i + 1 + name.length, i + 1 + name.length + 8);
  }
  return undefined;
}

/** Java の `String.trim()`（前後の U+0020 以下を落とす）。ACS の正規化に合わせる */
function javaTrim(v: string): string {
  let a = 0;
  let b = v.length;
  while (a < b && v.charCodeAt(a) <= 0x20) a++;
  while (b > a && v.charCodeAt(b - 1) <= 0x20) b--;
  return v.slice(a, b);
}

/**
 * NEW-ENVIRON の値のエスケープ（RFC 1572）: 0x00〜0x03（VAR / VALUE / ESC / USERVAR）の前に ESC を置く。
 * 置かないと値の途中で変数が終わったと読まれる。ACS も利用者名・パスワードの値をこうして書く
 * （IAC の二重化は `sendSb` がまとめて行う）
 */
function envValue(bytes: number[]): number[] {
  const out: number[] = [];
  for (const b of bytes) {
    if (b <= 0x03) out.push(ENV_ESC);
    out.push(b);
  }
  return out;
}
