/**
 * データストリームのキャプチャ（spec D10）。Transport 層の生バイトを方向付き JSONL で残す。
 * ファイル I/O は持たない（sink 注入。ファイル書き込みは呼び出し側 = capture スクリプト等の責務）。
 */

export interface TraceEntry {
  ts: string;
  dir: "rx" | "tx";
  /** 生バイト（hex）。masked の場合は省略 */
  hex?: string;
  /** 伏字化時のバイト数 */
  len?: number;
  masked?: boolean;
}

export interface TraceRecorderOptions {
  /** 送信（tx）データの伏字化。Read 応答にはフィールド入力（パスワード含む）が乗るため既定 ON */
  maskTx?: boolean;
  /** 実行時に時刻を注入（テスト時に固定できる） */
  now?: () => string;
}

export class TraceRecorder {
  private readonly maskTx: boolean;
  private readonly now: () => string;

  constructor(
    private readonly sink: (line: string) => void,
    opts: TraceRecorderOptions = {}
  ) {
    this.maskTx = opts.maskTx ?? true;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  rx(data: Uint8Array): void {
    this.write({ ts: this.now(), dir: "rx", hex: bytesToHex(data) });
  }

  tx(data: Uint8Array): void {
    if (this.maskTx) {
      this.write({ ts: this.now(), dir: "tx", len: data.length, masked: true });
    } else {
      this.write({ ts: this.now(), dir: "tx", hex: bytesToHex(data) });
    }
  }

  private write(entry: TraceEntry): void {
    this.sink(JSON.stringify(entry));
  }
}

export function parseTraceJsonl(text: string): TraceEntry[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TraceEntry);
}

export function bytesToHex(data: Uint8Array): string {
  let s = "";
  for (const b of data) s += b.toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
