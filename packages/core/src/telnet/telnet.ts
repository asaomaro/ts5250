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

export interface TelnetOptions {
  /** 端末タイプ名（例 IBM-3179-2）。TERMINAL-TYPE IS で回答する */
  terminalType: string;
  /** RFC 4777 デバイス名（NEW-ENVIRON の USERVAR DEVNAME）。省略時はホスト採番 */
  deviceName?: string | undefined;
  /** RFC 4777 自動サインオン: ユーザープロファイル（USER 変数）。password と併せて指定 */
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
  /**
   * プリンターセッション用の NEW-ENVIRON USERVAR（RFC 4777 / tn5250 lp5250d 準拠）。
   * ibmFont はプリンターのフォント（既定 "12"）、ibmTransform は "0"=ホストが SCS を送る／
   * "1"=Host Print Transform 済みデータを送る。
   * 実機（PUB400）では IBMFONT/IBMTRANSFORM を送らないと仮想プリンターデバイスの作成が
   * CPF「Creation of device failed」(応答コード 8925) で失敗する（実機プローブで確認）。
   */
  ibmFont?: string | undefined;
  ibmTransform?: string | undefined;
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

  constructor(
    private readonly transport: Transport,
    private readonly opts: TelnetOptions
  ) {
    transport.onData((data) => this.feed(data));
  }

  onRecord(fn: (record: Uint8Array) => void): void {
    this.recordFn = fn;
  }

  onClose(fn: (reason: string) => void): void {
    this.transport.onClose(fn);
  }

  onError(fn: (err: Error) => void): void {
    this.transport.onError(fn);
  }

  close(): void {
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

  private feed(data: Uint8Array): void {
    for (const b of data) {
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
      if (this.opts.deviceName !== undefined) {
        payload.push(ENV_USERVAR, ...ascii("DEVNAME"), ENV_VALUE, ...ascii(this.opts.deviceName));
      }
      // プリンターセッション: フォントと変換モードを申告（無いと 8925 でデバイス作成失敗）
      if (this.opts.ibmFont !== undefined) {
        payload.push(ENV_USERVAR, ...ascii("IBMFONT"), ENV_VALUE, ...ascii(this.opts.ibmFont));
      }
      if (this.opts.ibmTransform !== undefined) {
        payload.push(ENV_USERVAR, ...ascii("IBMTRANSFORM"), ENV_VALUE, ...ascii(this.opts.ibmTransform));
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
      if (this.opts.user !== undefined) {
        // USER は well-known 変数（VAR）、他は USERVAR（RFC 4777 / tn5250j に準拠）
        payload.push(ENV_VAR, ...ascii("USER"), ENV_VALUE, ...ascii(this.opts.user));
        if (this.opts.password !== undefined) {
          // IBMRSEED = ESC + 8 バイトのゼロシード（非暗号化を示す）
          payload.push(ENV_USERVAR, ...ascii("IBMRSEED"), ENV_VALUE, ENV_ESC, 0, 0, 0, 0, 0, 0, 0, 0);
          // IBMSUBSPW = ゼロシードのため平文パスワード
          payload.push(ENV_USERVAR, ...ascii("IBMSUBSPW"), ENV_VALUE, ...ascii(this.opts.password));
        }
      }
      this.sendSb(payload);
    }
    // その他のサブネゴシエーションは無視
  }

  private sendCmd(cmd: number, opt: number): void {
    this.transport.send(Uint8Array.from([IAC, cmd, opt]));
  }

  private sendSb(payload: number[]): void {
    // SB 本文中の IAC(0xFF) は二重化する（telnet エスケープ）。値に 0xFF が来ても壊れないように
    const escaped: number[] = [];
    for (const b of payload) {
      escaped.push(b);
      if (b === IAC) escaped.push(IAC);
    }
    this.transport.send(Uint8Array.from([IAC, CMD.SB, ...escaped, IAC, CMD.SE]));
  }
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}
