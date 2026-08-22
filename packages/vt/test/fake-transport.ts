import type { Transport } from "../src/transport/types.js";

/** 実ネットワーク無しで交渉とセッションを回すための偽 Transport */
export class FakeTransport implements Transport {
  readonly sent: number[] = [];
  private dataFn: ((b: Uint8Array) => void) | undefined;
  private closeFn: ((reason: string) => void) | undefined;
  private errorFn: ((e: Error) => void) | undefined;

  send(b: Uint8Array): void {
    for (const x of b) this.sent.push(x);
  }
  close(): void {
    this.closeFn?.("closed by client");
  }
  onData(fn: (b: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(fn: (reason: string) => void): void {
    this.closeFn = fn;
  }
  onError(fn: (e: Error) => void): void {
    this.errorFn = fn;
  }

  /** ホストからのバイト列を流し込む */
  host(...bytes: (number | string | Uint8Array)[]): void {
    const out: number[] = [];
    for (const b of bytes) {
      if (typeof b === "number") out.push(b);
      else if (typeof b === "string") for (const c of b) out.push(c.charCodeAt(0) & 0xff);
      else for (const x of b) out.push(x);
    }
    this.dataFn?.(Uint8Array.from(out));
  }

  fail(e: Error): void {
    this.errorFn?.(e);
  }

  /** 送ったバイト列を消費して返す */
  take(): number[] {
    return this.sent.splice(0);
  }

  takeText(): string {
    return this.take().map((b) => String.fromCharCode(b)).join("");
  }
}
