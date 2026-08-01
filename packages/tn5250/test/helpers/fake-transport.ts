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
