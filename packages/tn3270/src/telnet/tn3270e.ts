import { childLog } from "@ts5250/base";

const log = childLog({ component: "tn3270e" });

/**
 * TN3270E（RFC 2355）の交渉とメッセージヘッダ。
 *
 * **基本 TN3270E（§9）だけを実装する**——任意機能（RESPONSES / BIND-IMAGE /
 * SCS-CTL-CODES / DATA-STREAM-CTL / SYSREQ）は一切合意しない。RFC はこれを
 * 「function-list が空で合意した状態」と定義しており、端末セッション専用と明記している。
 *
 * **ソケットに触らない**（純粋）。バイト列を受けて返すべきバイト列を返すだけなので、
 * 単体テストで交渉の全経路を固定できる。`protocol/inbound.ts` を無状態にしたのと同じ思想。
 */

/** §3 コマンド名とコード */
export const TN3270E_CMD = {
  ASSOCIATE: 0x00,
  CONNECT: 0x01,
  DEVICE_TYPE: 0x02,
  FUNCTIONS: 0x03,
  IS: 0x04,
  REASON: 0x05,
  REJECT: 0x06,
  REQUEST: 0x07,
  SEND: 0x08
} as const;

/** §7.2.2 機能コード。**基本 TN3270E ではどれも合意しない** */
export const TN3270E_FUNC = {
  BIND_IMAGE: 0x00,
  DATA_STREAM_CTL: 0x01,
  RESPONSES: 0x02,
  SCS_CTL_CODES: 0x03,
  SYSREQ: 0x04
} as const;

/** §3 / §7.1.5 REJECT の理由コード */
export const TN3270E_REASON = {
  CONN_PARTNER: 0x00,
  DEVICE_IN_USE: 0x01,
  INV_ASSOCIATE: 0x02,
  INV_NAME: 0x03,
  INV_DEVICE_TYPE: 0x04,
  TYPE_NAME_ERROR: 0x05,
  UNKNOWN_ERROR: 0x06,
  UNSUPPORTED_REQ: 0x07
} as const;

const REASON_NAME: Readonly<Record<number, string>> = {
  0x00: "CONN-PARTNER",
  0x01: "DEVICE-IN-USE",
  0x02: "INV-ASSOCIATE",
  0x03: "INV-NAME",
  0x04: "INV-DEVICE-TYPE",
  0x05: "TYPE-NAME-ERROR",
  0x06: "UNKNOWN-ERROR",
  0x07: "UNSUPPORTED-REQ"
};

export function reasonName(code: number): string {
  return REASON_NAME[code] ?? `UNKNOWN(0x${code.toString(16)})`;
}

/**
 * §8.1.1 DATA-TYPE。
 *
 * **基本 TN3270E が要求するのは `DATA_3270` と `NVT_DATA` だけ**（§9）。
 * 他の種別は受け取っても読み飛ばす。
 */
export const DATA_TYPE = {
  DATA_3270: 0x00,
  SCS_DATA: 0x01,
  RESPONSE: 0x02,
  BIND_IMAGE: 0x03,
  UNBIND: 0x04,
  NVT_DATA: 0x05,
  REQUEST: 0x06,
  SSCP_LU_DATA: 0x07,
  PRINT_EOJ: 0x08
} as const;

/** §8.1 メッセージヘッダ（5 バイト） */
export interface Tn3270eHeader {
  dataType: number;
  requestFlag: number;
  responseFlag: number;
  seq: number;
}

/** ヘッダの長さ（§8.1） */
export const HEADER_LEN = 5;

/**
 * レコードからヘッダを剥がす。**5 バイト未満なら `null`**（壊れた入力）。
 * 呼び出し側は `null` を「記録して読み飛ばす」に使う——例外にしない。
 */
export function splitHeader(record: Uint8Array): { header: Tn3270eHeader; body: Uint8Array } | null {
  if (record.length < HEADER_LEN) return null;
  return {
    header: {
      dataType: record[0]!,
      requestFlag: record[1]!,
      responseFlag: record[2]!,
      seq: (record[3]! << 8) | record[4]!
    },
    body: record.subarray(HEADER_LEN)
  };
}

/**
 * ヘッダを付ける。
 *
 * **基本 TN3270E では REQUEST-FLAG / RESPONSE-FLAG / SEQ-NUMBER を使わない**（§9 に明記）
 * ので常に 0 を置く。
 */
export function withHeader(payload: Uint8Array, dataType: number = DATA_TYPE.DATA_3270): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + payload.length);
  out[0] = dataType;
  out.set(payload, HEADER_LEN);
  return out;
}

export type Tn3270eState = "idle" | "device-type" | "functions" | "ready" | "rejected" | "failed";

export interface Tn3270eOptions {
  /** `IBM-3278-<model>[-E]`（RFC §7.1 の一覧。基本 TN3270 の `IBM-3279-*` とは別物） */
  deviceType: string;
  /** LU 名。省略時は `CONNECT` を送らずホストの採番に任せる */
  deviceName?: string | undefined;
  /**
   * `FUNCTIONS` の往復上限（既定 5）。
   *
   * §7.2.1 は対案の往復を許すが、双方が譲らないと**無限に続きうる**。
   * RFC の impasse 条項に相当する打ち切りを実装で持つ。
   */
  maxFunctionRounds?: number | undefined;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0) & 0xff);
const fromAscii = (b: readonly number[]): string => String.fromCharCode(...b);

/**
 * DEVICE-TYPE / FUNCTIONS の交渉（§7.1 / §7.2）。
 *
 * `handle()` に **サブネゴシエーションの本文**（オプション番号の次から `IAC SE` の手前まで）を
 * 渡すと、**返すべき本文**を返す。`IAC SB TN3270E` … `IAC SE` で包むのは呼び出し側の仕事。
 */
export class Tn3270eNegotiator {
  private st: Tn3270eState = "idle";
  private assignedName: string | undefined;
  private rejectReason: { code: number; name: string } | undefined;
  private rounds = 0;
  private failure: string | undefined;

  constructor(private readonly opts: Tn3270eOptions) {}

  get state(): Tn3270eState {
    return this.st;
  }

  /** サーバが割り当てた device-name（`IS … CONNECT <名前>`） */
  get deviceName(): string | undefined {
    return this.assignedName;
  }

  get reason(): { code: number; name: string } | undefined {
    return this.rejectReason;
  }

  /** 失敗した理由（`rejected` / `failed` のとき） */
  get error(): string | undefined {
    return this.failure;
  }

  handle(body: readonly number[]): number[] | null {
    const op = body[0];
    if (op === TN3270E_CMD.SEND && body[1] === TN3270E_CMD.DEVICE_TYPE) {
      return this.sendDeviceTypeRequest();
    }
    if (op === TN3270E_CMD.DEVICE_TYPE) return this.onDeviceType(body);
    if (op === TN3270E_CMD.FUNCTIONS) return this.onFunctions(body);
    log.debug(`unexpected TN3270E command 0x${(op ?? 0).toString(16)}`);
    return null;
  }

  /** `DEVICE-TYPE REQUEST <型名> [CONNECT <名前>]` */
  private sendDeviceTypeRequest(): number[] {
    this.st = "device-type";
    const out = [TN3270E_CMD.DEVICE_TYPE, TN3270E_CMD.REQUEST, ...ascii(this.opts.deviceType)];
    if (this.opts.deviceName !== undefined) {
      out.push(TN3270E_CMD.CONNECT, ...ascii(this.opts.deviceName));
    }
    return out;
  }

  private onDeviceType(body: readonly number[]): number[] | null {
    const sub = body[1];
    if (sub === TN3270E_CMD.REJECT) {
      // `REJECT REASON <code>`（§7.1.5）
      const code = body[2] === TN3270E_CMD.REASON ? (body[3] ?? 0xff) : (body[2] ?? 0xff);
      this.rejectReason = { code, name: reasonName(code) };
      this.failure = `server rejected DEVICE-TYPE: ${this.rejectReason.name}`;
      this.st = "rejected";
      log.debug(this.failure);
      return null;
    }
    if (sub !== TN3270E_CMD.IS) return null;

    // `IS <型名> [CONNECT <名前>]`
    const rest = body.slice(2);
    const ci = rest.indexOf(TN3270E_CMD.CONNECT);
    const type = fromAscii(ci < 0 ? rest : rest.slice(0, ci));
    if (ci >= 0) this.assignedName = fromAscii(rest.slice(ci + 1));
    if (type !== this.opts.deviceType) {
      // §7.1.4: 通常クライアントはサーバの返した型名を受け入れる。**記録だけ残す**
      log.debug(`server returned device-type ${type} (requested ${this.opts.deviceType})`);
    }
    this.st = "functions";
    this.rounds = 0;
    // **空の function-list を要求する**＝基本 TN3270E（§9）
    return [TN3270E_CMD.FUNCTIONS, TN3270E_CMD.REQUEST];
  }

  private onFunctions(body: readonly number[]): number[] | null {
    const sub = body[1];
    const list = body.slice(2);
    if (sub === TN3270E_CMD.IS) {
      if (list.length > 0) {
        // こちらは空を要求したので、空以外の IS は仕様上ありえない（§7.2.1）
        this.failure = `server agreed to functions we did not request: [${list.join(",")}]`;
        this.st = "failed";
        log.debug(this.failure);
        return null;
      }
      this.st = "ready";
      log.debug("TN3270E negotiation complete (basic TN3270E)");
      return null;
    }
    if (sub === TN3270E_CMD.REQUEST) {
      // §7.2.1: **減らす側は IS ではなく REQUEST で対案を出す**。こちらは何も支えないので
      // 空を要求し続ける。ただし無限往復を避けるため上限で打ち切る
      this.rounds++;
      const max = this.opts.maxFunctionRounds ?? 5;
      if (this.rounds > max) {
        this.failure = `FUNCTIONS negotiation did not converge after ${max} rounds`;
        this.st = "failed";
        log.debug(this.failure);
        return null;
      }
      if (list.length === 0) {
        // 相手も空を提案してきた＝合意。IS で確定させる（受け取ったリストをそのまま返す）
        this.st = "ready";
        log.debug("TN3270E negotiation complete (basic TN3270E, via counter-proposal)");
        return [TN3270E_CMD.FUNCTIONS, TN3270E_CMD.IS];
      }
      return [TN3270E_CMD.FUNCTIONS, TN3270E_CMD.REQUEST];
    }
    return null;
  }
}
