import { As400Error } from "@ts5250/base";

/**
 * レコードの逐次読み取り（design: 手続き型の逐次リーダ）。
 *
 * **`@ts5250/tn5250` の同名クラスの複製である**（decisions D7）。`base` へ括らない理由:
 * - 括るには tn5250 の import 書き換えが要り、この work の「5250 側は触らない」に反する
 * - 3270 側は `address.ts` と絡む読み取り（6 ビットコード表・可変長アドレス）が増える見込みで、
 *   2 つの写しが同じままとは限らない
 *
 * **括るのは「同じままだと分かってから」**。deliver 後に差分が無ければ `base` へ移す（retro で起票）。
 */
export class ByteReader {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  get atEnd(): boolean {
    return this.pos >= this.data.length;
  }

  peek(): number {
    const b = this.data[this.pos];
    if (b === undefined) throw new As400Error("PROTOCOL_ERROR", "unexpected end of record (peek)");
    return b;
  }

  /** 現在位置から `ahead` バイト先を読まずに覗く */
  peekAt(ahead: number): number {
    const b = this.data[this.pos + ahead];
    if (b === undefined) throw new As400Error("PROTOCOL_ERROR", "unexpected end of record (peekAt)");
    return b;
  }

  /** 現在位置から**最大** `n` バイトを読まずに取り出す（残りが少なければ短い配列。末尾で例外にしない） */
  peekUpTo(n: number): Uint8Array {
    return this.data.subarray(this.pos, Math.min(this.pos + n, this.data.length));
  }

  u8(): number {
    const b = this.data[this.pos];
    if (b === undefined) throw new As400Error("PROTOCOL_ERROR", "unexpected end of record (u8)");
    this.pos++;
    return b;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  bytes(n: number): Uint8Array {
    if (this.remaining < n) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `unexpected end of record (need ${n}, have ${this.remaining})`
      );
    }
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(n: number): void {
    this.bytes(n);
  }
}

/** レコードの逐次書き込み */
export class ByteWriter {
  private buf: number[] = [];

  u8(b: number): this {
    this.buf.push(b & 0xff);
    return this;
  }

  u16(v: number): this {
    this.buf.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }

  bytes(data: Uint8Array | readonly number[]): this {
    for (const b of data) this.buf.push(b & 0xff);
    return this;
  }

  get length(): number {
    return this.buf.length;
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}
