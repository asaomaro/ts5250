import type { Transport } from "../../src/transport/types.js";

/** テスト用のインメモリ Transport。sent に送信バイトを蓄積し、feed() で受信を注入する */
export class FakeTransport implements Transport {
  sent: number[] = [];
  closed = false;
  private dataFn: ((data: Uint8Array) => void) | undefined;
  private closeFn: ((reason: string) => void) | undefined;
  private errorFn: ((err: Error) => void) | undefined;

  send(data: Uint8Array): void {
    this.sent.push(...data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeFn?.("closed by client");
  }

  onData(fn: (data: Uint8Array) => void): void {
    this.dataFn = fn;
  }

  onClose(fn: (reason: string) => void): void {
    this.closeFn = fn;
  }

  onError(fn: (err: Error) => void): void {
    this.errorFn = fn;
  }

  feed(...bytes: number[]): void {
    this.dataFn?.(Uint8Array.from(bytes));
  }

  feedRaw(data: Uint8Array): void {
    this.dataFn?.(data);
  }

  emitError(err: Error): void {
    this.errorFn?.(err);
  }

  emitClose(reason: string): void {
    this.closeFn?.(reason);
  }

  takeSent(): number[] {
    const s = this.sent;
    this.sent = [];
    return s;
  }
}

/**
 * **IBM i が実際に送る NEW-ENVIRON の SEND の本体**（`ENV_SEND` から。`USERVAR IBMRSEED <シード 8 バイト> VAR USERVAR`。
 * PUB400 のワイヤ〔tap〕で採った形。シードは固定の値）。ACS も当 PJ も、この要求の順に答える（`20260927-telnet-rest`）。
 * ~~空の SEND（`ENV_SEND` だけ）~~ は IBM i が送らない形で、ACS はそれに何も答えない
 */
export const IBMI_ENV_SEND: readonly number[] = [
  0x01, 0x03, ...[..."IBMRSEED"].map((c) => c.charCodeAt(0)), 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x00, 0x03
];
/** 上のシード（自動サインオンでないときは、ACS と同じく IBMRSEED の名前と一緒にそのまま返る） */
export const IBMI_SEED: readonly number[] = [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18];
