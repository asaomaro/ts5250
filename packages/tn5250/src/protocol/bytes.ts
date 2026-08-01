import { As400Error } from "@as400web/base";

/** レコードの逐次読み取り（design: 手続き型の逐次リーダ） */
export class ByteReader {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  peek(): number {
    const b = this.data[this.pos];
    if (b === undefined) throw new As400Error("PROTOCOL_ERROR", "unexpected end of record (peek)");
    return b;
  }

  /** 現在位置から `ahead` バイト先を読まずに覗く（可変長の並びで「次の型」を見て打ち切る用途） */
  peekAt(ahead: number): number {
    const b = this.data[this.pos + ahead];
    if (b === undefined) throw new As400Error("PROTOCOL_ERROR", "unexpected end of record (peekAt)");
    return b;
  }

  /**
   * 現在位置から**最大** `n` バイトを読まずに取り出す（残りが少なければ短い配列）。
   *
   * `peekAt` と違って**末尾で例外にしない**——「決まったバイト列で始まるか」を試すのに使うため
   * （PC Organizer の標識照合）。レコード末尾に近いだけで例外になると照合できない。
   */
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
      throw new As400Error("PROTOCOL_ERROR", `unexpected end of record (need ${n}, have ${this.remaining})`);
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

  /** 先頭 2 バイトを LL（自身を含む長さ）として埋める前提のプレースホルダ */
  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}
