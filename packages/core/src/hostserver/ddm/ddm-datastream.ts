/**
 * DDM のデータストリーム（フレームの組み立てと解析）。
 *
 * **既存のホストサーバーとフレームの形が違う**（spec D4）。
 * signon / database / command 等は 20 バイトヘッダー＋LL/CP だが、DDM は:
 *
 *   LL(2) | GDS ID(1)=0xD0 | フォーマット ID(1) | 相関 ID(2) | [ LL(2) CP(2) データ ]…
 *
 * フォーマット ID のビット: 継続エラー 0x20 / 型 0x03（1=RQSDSS 2=RPYDSS 3=OBJDSS）
 * / 同一相関 0x10 / チェイン 0x40
 *
 * 参照: jtopenlite の `com.ibm.jtopenlite.ddm.DDMConnection` の send*Request /
 * および HostInputStream の読み取り手順に対応する（事実に基づく書き起こし）。
 */
import { As400Error } from "../../errors.js";

export const DDM_GDS_ID = 0xd0;

/** コードポイント（原典の定数名を残す） */
export const DDM_CP = {
  EXCSAT: 0x1041,
  EXCSATRD: 0x1443,
  EXTNAM: 0x115e,
  ACCSEC: 0x106d,
  ACCSECRD: 0x14ac,
  SECCHK: 0x106e,
  SECCHKRD: 0x1219,
  SECCHKCD: 0x11a4,
  SECMEC: 0x11a2,
  SECTKN: 0x11dc,
  USRID: 0x11a0,
  PASSWORD: 0x11a1,
  S38OPEN: 0xd011,
  S38OPNFB: 0xd404,
  S38UFCB: 0xd11f,
  S38CLOSE: 0xd004,
  S38PUTM: 0xd013,
  S38BUF: 0xd405,
  S38MSGRM: 0xd201,
  DCLNAM: 0x1136
} as const;

/** SECMEC の値。SHA=8 / DES=6（パスワードレベルで決まる） */
export const SECMEC_SHA = 8;
export const SECMEC_DES = 6;

/** バイト列を順に書き出す小さなヘルパ（可変長フレームを組み立てる） */
export class DdmWriter {
  private readonly parts: number[] = [];

  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.parts.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }
  u32(v: number): this {
    this.parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  bytes(b: Uint8Array): this {
    for (const x of b) this.parts.push(x);
    return this;
  }
  get length(): number {
    return this.parts.length;
  }
  build(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** バイト列を順に読む。**逐次読み**（周辺コードのスタイルに合わせる） */
export class DdmReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get offset(): number {
    return this.pos;
  }
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  private need(n: number, what: string): void {
    if (this.pos + n > this.buf.length) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `DDM 応答が短すぎます（${what}: ${n} バイト要求、残り ${this.remaining}）`
      );
    }
  }
  u8(what = "u8"): number {
    this.need(1, what);
    return this.buf[this.pos++]!;
  }
  u16(what = "u16"): number {
    this.need(2, what);
    const v = (this.buf[this.pos]! << 8) | this.buf[this.pos + 1]!;
    this.pos += 2;
    return v;
  }
  u32(what = "u32"): number {
    this.need(4, what);
    const v =
      this.buf[this.pos]! * 0x1000000 +
      ((this.buf[this.pos + 1]! << 16) | (this.buf[this.pos + 2]! << 8) | this.buf[this.pos + 3]!);
    this.pos += 4;
    return v;
  }
  take(n: number, what = "bytes"): Uint8Array {
    this.need(n, what);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  skip(n: number, what = "skip"): void {
    if (n < 0) throw new As400Error("PROTOCOL_ERROR", `DDM 応答の長さ計算が負になりました（${what}）`);
    this.need(n, what);
    this.pos += n;
  }
}

export interface DdmHeader {
  /** フレーム全体の長さ（この 2 バイトを含む） */
  length: number;
  formatId: number;
  correlationId: number;
  chained: boolean;
}

/** 6 バイトのフレームヘッダーを読む */
export function readHeader(r: DdmReader, what: string): DdmHeader {
  const length = r.u16(`${what} LL`);
  if (length < 10) {
    throw new As400Error("PROTOCOL_ERROR", `DDM フレームが短すぎます（${what}: ${length}）`);
  }
  const gds = r.u8(`${what} GDS`);
  if (gds !== DDM_GDS_ID) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `DDM の GDS ID が不正です（${what}: 0x${gds.toString(16)}）`
    );
  }
  const formatId = r.u8(`${what} format`);
  const correlationId = r.u16(`${what} corr`);
  return { length, formatId, correlationId, chained: (formatId & 0x40) !== 0 };
}

/** フレーム先頭に長さを埋めて完成させる（LL は自分自身を含む） */
export function frame(formatId: number, correlationId: number, body: Uint8Array): Uint8Array {
  const total = 6 + body.length;
  const w = new DdmWriter();
  w.u16(total).u8(DDM_GDS_ID).u8(formatId).u16(correlationId).bytes(body);
  return w.build();
}

/** LL/CP つきのパラメータ（LL は自分自身を含む 4 バイト＋データ） */
export function param(cp: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const w = new DdmWriter();
  w.u16(4 + data.length).u16(cp).bytes(data);
  return w.build();
}

/** EBCDIC の空白（0x40）で 10 バイトに詰めた名前 */
export function padName10(
  name: string,
  encode: (t: string) => { bytes: Uint8Array; substituted: number }
): Uint8Array {
  const { bytes } = encode(name.toUpperCase());
  if (bytes.length > 10) {
    throw new As400Error("CONFIG_ERROR", `名前が 10 バイトを超えます: ${name}`);
  }
  const out = new Uint8Array(10).fill(0x40);
  out.set(bytes, 0);
  return out;
}

/**
 * DDM のメッセージ（S38MSGRM）。ホストからのエラー／情報。
 *
 * 原典 `DDMConnection.getMessage` に対応する。ID は EBCDIC 7 バイト。
 */
export interface DdmMessage {
  id: string;
  text: string;
}
