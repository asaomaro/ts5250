import type { Transport } from "../transport/types.js";
import { fromHex, type TraceEntry } from "./trace.js";

/**
 * 記録した受信バイトを再生する Transport。**ネットワークもホストも要らない。**
 *
 * `VtSession.attach()` にそのまま載る。**パーサも画面も入力バイト列だけで決まる**ので、
 * replay と実接続で挙動が分かれる余地が無い。これが回帰資産の土台になる。
 *
 * 送信は捨てずに `sent` へ溜める（送信バイトの照合に使える）。
 */
export class ReplayTransport implements Transport {
  readonly sent: Uint8Array[] = [];
  private dataFn: ((data: Uint8Array) => void) | undefined;
  private closeFn: ((reason: string) => void) | undefined;
  private started = false;

  constructor(private readonly inbound: Uint8Array[]) {}

  /** JSONL の記録から `in` 方向だけを取り出して作る */
  static fromEntries(entries: readonly TraceEntry[]): ReplayTransport {
    return new ReplayTransport(entries.filter((e) => e.dir === "in").map((e) => fromHex(e.hex)));
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeFn?.("replay closed");
  }

  onData(fn: (data: Uint8Array) => void): void {
    this.dataFn = fn;
  }

  onClose(fn: (reason: string) => void): void {
    this.closeFn = fn;
  }

  onError(): void {
    /* replay ではエラーは起きない */
  }

  /**
   * ハンドラ登録後に供給を始める。
   * **同期的に全部流す**——テストで待ちを書かずに済むようにするため。
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const rec of this.inbound) this.dataFn?.(rec);
  }
}
