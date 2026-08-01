import type { Transport } from "../transport/types.js";
import { hexToBytes, type TraceEntry } from "./trace.js";

/**
 * trace JSONL を Transport として再生する（テスト用。実ホスト不要の回帰基盤 = spec D10）。
 * - rx エントリを順に onData へ流す
 * - tx エントリに当たったら停止し、クライアント側の send() を 1 回受けて次へ進む
 *   （記録時の送信チャンク割りと厳密一致は要求しない。masked でも進行できる）
 */
export class ReplayTransport implements Transport {
  readonly sentChunks: Uint8Array[] = [];
  private idx = 0;
  private started = false;
  private closed = false;
  private dataFn: ((data: Uint8Array) => void) | undefined;
  private closeFn: ((reason: string) => void) | undefined;

  constructor(
    private readonly entries: readonly TraceEntry[],
    private readonly opts: { closeAtEnd?: boolean } = {}
  ) {}

  /** onData 登録後に呼ぶ。先頭から tx 手前までの rx を流す */
  start(): void {
    this.started = true;
    this.advance();
  }

  send(data: Uint8Array): void {
    this.sentChunks.push(data);
    const cur = this.entries[this.idx];
    if (cur?.dir === "tx") {
      this.idx++;
      this.advance();
    }
    // 記録に無い送信（ネゴ応答のチャンク差等）は蓄積のみ
  }

  close(): void {
    this.emitClose("closed by client");
  }

  onData(fn: (data: Uint8Array) => void): void {
    this.dataFn = fn;
  }

  onClose(fn: (reason: string) => void): void {
    this.closeFn = fn;
  }

  onError(_fn: (err: Error) => void): void {
    // リプレイではエラーを発生させない
  }

  /** 全エントリを消費し終えたか（テストのアサーション用） */
  get finished(): boolean {
    return this.idx >= this.entries.length;
  }

  private advance(): void {
    if (!this.started) return;
    while (this.idx < this.entries.length) {
      const e = this.entries[this.idx];
      if (e === undefined || e.dir !== "rx") break;
      this.idx++;
      if (e.hex !== undefined) this.dataFn?.(hexToBytes(e.hex));
    }
    if (this.idx >= this.entries.length && this.opts.closeAtEnd === true) {
      this.emitClose("replay finished");
    }
  }

  private emitClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeFn?.(reason);
  }
}
