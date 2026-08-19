import type { Transport } from "../transport/types.js";

/**
 * 送受信バイトの記録。**言語非依存の JSONL** で残す（5250 側と同じ方式）。
 *
 * 1 行 1 レコードで `{ dir, seq, hex }`。これを replay に食わせれば
 * **docker もホストも無しで回帰が効く**——照合で一度確かめたバイト列を
 * そのまま単体テストの資産にできる。
 */

export interface TraceEntry {
  /** `in` = ホスト → 端末、`out` = 端末 → ホスト */
  dir: "in" | "out";
  seq: number;
  hex: string;
}

export class Trace {
  private entries: TraceEntry[] = [];
  private seq = 0;

  record(dir: "in" | "out", data: Uint8Array): void {
    this.seq++;
    this.entries.push({ dir, seq: this.seq, hex: toHex(data) });
  }

  get all(): readonly TraceEntry[] {
    return this.entries;
  }

  /** JSONL（1 行 1 レコード）へ */
  toJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }

  /** JSONL から読む。空行は飛ばす */
  static fromJsonl(text: string): TraceEntry[] {
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TraceEntry);
  }

  /** 指定方向のレコードだけをバイト列で取り出す */
  static recordsOf(entries: readonly TraceEntry[], dir: "in" | "out"): Uint8Array[] {
    return entries.filter((e) => e.dir === dir).map((e) => fromHex(e.hex));
  }
}

/**
 * Transport を包んで記録する。
 * **透過的**——包んでも挙動は変わらないので、実接続にそのまま挟める。
 */
export function traced(transport: Transport, trace: Trace): Transport {
  return {
    send(data: Uint8Array): void {
      trace.record("out", data);
      transport.send(data);
    },
    close: () => transport.close(),
    onData(fn: (data: Uint8Array) => void): void {
      transport.onData((d) => {
        trace.record("in", d);
        fn(d);
      });
    },
    onClose: (fn) => transport.onClose(fn),
    onError: (fn) => transport.onError(fn),
    ...(transport.start ? { start: (): void => transport.start?.() } : {})
  };
}

export function toHex(data: Uint8Array): string {
  return [...data].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
