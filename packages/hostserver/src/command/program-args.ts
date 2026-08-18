/**
 * プログラム呼び出しの**型付き引数**と、下位層の `ProgramParameter` の間の変換。
 *
 * ## なぜ要るのか
 *
 * `CommandConnection.call()` は**生バイト**しか扱わない（`command-datastream.ts`）。
 * 呼ぶ側は文字と数値で書きたいので、間に変換が要る——**これが無いために
 * 「実装済みなのに利用者から届かない」状態だった**。
 *
 * ## 数値は文字列でやり取りする
 *
 * `number` を経由しない。JavaScript の `number` は 2^53 を超えると精度を失い、
 * 金額のような値が静かに誤る（`db/db-decimal.ts` の注記と同じ理由）。
 * 読む向きが文字列を返すので、書く向きも揃える——揃えないと往復で値が変わる。
 *
 * ## 逃げ道を必ず残す
 *
 * 外部記述のデータ構造など、**型で表せないものは必ず出てくる**。
 * `bytes` でそのまま渡せるようにしてあり、表せないものが渡せなくなることはない。
 */
import { As400Error } from "@ts5250/base";
import { codecForCcsid } from "@ts5250/ebcdic";
import {
  packedByteLength,
  packedDecimalToString,
  stringToPackedDecimal,
  stringToZonedDecimal,
  zonedDecimalToString
} from "../db/db-decimal.js";
import type { ProgramParameter } from "./command-datastream.js";

/** 引数の向き。**既定は `in`** */
export type ArgDirection = "in" | "out" | "inout";

/**
 * 呼び出し 1 引数。
 *
 * `out` / `inout` は受け取る長さが要る（ホストは長さを教えてくれない）。
 */
export type ProgramArg =
  /** 文字。**足りなければ空白で埋める**（IBM i の作法）。長すぎれば拒否 */
  | { type: "char"; dir?: ArgDirection; value?: string; length: number }
  /** パック 10 進数。`digits` は全体の桁数、`decimals` は小数位 */
  | { type: "packed"; dir?: ArgDirection; value?: string; digits: number; decimals?: number }
  /** ゾーン 10 進数 */
  | { type: "zoned"; dir?: ArgDirection; value?: string; digits: number; decimals?: number }
  /**
   * 2 進整数（ビッグエンディアン）。**既定は符号つき**。
   *
   * `signed: false` で符号なしになる——PCML が `precision` で符号を指定するため
   * （16/32/64 が符号なし。`pcml-parse.ts` の注記）。
   */
  | { type: "bin"; dir?: ArgDirection; value?: string; bytes: 2 | 4 | 8; signed?: boolean }
  /** 浮動小数（IEEE 754・ビッグエンディアン）。RPG の `float(4)` / `float(8)` */
  | { type: "float"; dir?: ArgDirection; value?: string; bytes: 4 | 8 }
  /** **逃げ道**。base64 でそのまま渡す（型で表せない構造体など） */
  | { type: "bytes"; dir?: ArgDirection; value?: string; length: number }
  /** ヌルポインタ */
  | { type: "null" };

/** サービスプログラム用に渡し方を添えた引数 */
export type ServiceArg = ProgramArg & { pass?: ArgPass };

/**
 * 引数の渡し方（サービスプログラムのみ意味を持つ）。**既定は参照渡し**。
 * プログラム（`*PGM`）は常に参照渡しなので、この項目は無視される。
 */
export type ArgPass = "reference" | "value";

export interface ArgCodecOptions {
  /** 文字パラメータの CCSID。**接続のものに従う**（取り違えると静かに化ける） */
  ccsid: number;
}

const dirOf = (a: ProgramArg): ArgDirection => (a.type === "null" ? "in" : (a.dir ?? "in"));

/**
 * base64 の入出力。**`Buffer` を使わない**——この層は純粋ロジックで、
 * Node API に依存しない規約（`AGENTS.md`）。ブラウザやスクリプトからも同じものを使う。
 */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/gu, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new As400Error("CONFIG_ERROR", `base64 として読めません: ${JSON.stringify(text)}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.slice(0, at);
}

function toBase64(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i]!;
    const b = data[i + 1];
    const c = data[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

/** その引数のバイト長 */
export function argByteLength(a: ProgramArg): number {
  switch (a.type) {
    case "char":
    case "bytes":
      return a.length;
    case "packed":
      return packedByteLength(a.digits);
    case "zoned":
      return a.digits;
    case "bin":
    case "float":
      return a.bytes;
    case "null":
      return 0;
  }
}

function requireValue(a: ProgramArg, label: string): string {
  const v = "value" in a ? a.value : undefined;
  if (v === undefined) {
    // **黙って空で送らない。** ホストは受け取った空白を正当な入力として扱う
    throw new As400Error("CONFIG_ERROR", `${label}（${a.type}）は ${dirOf(a)} なので value が要ります`);
  }
  return v;
}

function encodeBin(text: string, bytes: 2 | 4 | 8, signed: boolean): Uint8Array {
  let v: bigint;
  try {
    v = BigInt(text.trim());
  } catch {
    throw new As400Error("CONFIG_ERROR", `整数として読めません: ${JSON.stringify(text)}`);
  }
  const bits = BigInt(bytes * 8);
  const min = signed ? -(1n << (bits - 1n)) : 0n;
  const max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  if (v < min || v > max) {
    throw new As400Error("CONFIG_ERROR", `${bytes} バイトに収まりません: ${text}`);
  }
  const out = new Uint8Array(bytes);
  let u = v < 0n ? v + (1n << bits) : v;
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(u & 0xffn);
    u >>= 8n;
  }
  return out;
}

function decodeBin(data: Uint8Array, signed: boolean): string {
  let u = 0n;
  for (const b of data) u = (u << 8n) | BigInt(b);
  if (!signed) return u.toString();
  const bits = BigInt(data.length * 8);
  return (u >= 1n << (bits - 1n) ? u - (1n << bits) : u).toString();
}

/**
 * 浮動小数。**`DataView` を使う**——ビット並びを自分で組むより、
 * 丸めと非正規化数を取り違える危険が無い。
 */
function encodeFloat(text: string, bytes: 4 | 8): Uint8Array {
  const v = Number(text.trim());
  if (!Number.isFinite(v)) {
    throw new As400Error("CONFIG_ERROR", `浮動小数として読めません: ${JSON.stringify(text)}`);
  }
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  if (bytes === 4) view.setFloat32(0, v, false);
  else view.setFloat64(0, v, false);
  return out;
}

function decodeFloat(data: Uint8Array): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return String(data.length === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false));
}

/**
 * 入力の中身をバイト列にする。
 *
 * `label` は失敗したときに出す**呼び名**（`引数 3` / `PCMLTST.REC.NM`）。
 * 位置しか言えないと、構造体の中で桁が合わないときに探せない。
 */
export function encodeArgValue(a: ProgramArg, label: string, opts: ArgCodecOptions): Uint8Array {
  try {
    return encodeArgInner(a, label, opts);
  } catch (e) {
    // **どの項目で失敗したかを必ず言う。** 10 進や整数の変換は値しか知らないので、
    // そのままだと `数値として読めません: ""` だけが画面に出て、構造体の中では探せない
    const err = e as As400Error;
    if (err.message.startsWith(label)) throw err;
    throw new As400Error(err.code ?? "CONFIG_ERROR", `${label}: ${err.message}`);
  }
}

function encodeArgInner(a: ProgramArg, label: string, opts: ArgCodecOptions): Uint8Array {
  switch (a.type) {
    case "char": {
      const v = requireValue(a, label);
      const { bytes, substituted } = codecForCcsid(opts.ccsid).encode(v);
      if (substituted > 0) {
        // **黙って化けさせない。** 置き換わった文字がそのままホストへ渡る
        throw new As400Error(
          "CONFIG_ERROR",
          `${label} に CCSID ${opts.ccsid} で表せない文字があります`
        );
      }
      if (bytes.length > a.length) {
        // **黙って切らない。** 切った結果がそのままホストへ渡り、誤った値で動く
        throw new As400Error(
          "CONFIG_ERROR",
          `${label} が ${a.length} バイトに収まりません（${bytes.length} バイト）`
        );
      }
      // 足りない分は**空白で埋める**（IBM i の作法。NUL ではない）
      const out = new Uint8Array(a.length).fill(codecForCcsid(opts.ccsid).encode(" ").bytes[0] ?? 0x40);
      out.set(bytes);
      return out;
    }
    case "packed":
      return stringToPackedDecimal(requireValue(a, label), a.digits, a.decimals ?? 0);
    case "zoned":
      return stringToZonedDecimal(requireValue(a, label), a.digits, a.decimals ?? 0);
    case "bin":
      return encodeBin(requireValue(a, label), a.bytes, a.signed ?? true);
    case "float":
      return encodeFloat(requireValue(a, label), a.bytes);
    case "bytes": {
      const raw = fromBase64(requireValue(a, label));
      if (raw.length > a.length) {
        throw new As400Error(
          "CONFIG_ERROR",
          `${label} が ${a.length} バイトに収まりません（${raw.length} バイト）`
        );
      }
      const out = new Uint8Array(a.length);
      out.set(raw);
      return out;
    }
    case "null":
      return new Uint8Array(0);
  }
}

/** 型付き引数 → 下位層のパラメータ */
export function toProgramParameters(
  args: readonly ProgramArg[],
  opts: ArgCodecOptions
): ProgramParameter[] {
  return args.map((a, i) => {
    if (a.type === "null") return { type: "null" };
    const dir = dirOf(a);
    const length = argByteLength(a);
    if (dir === "out") return { type: "out", length };
    const data = encodeArgValue(a, `引数 ${i + 1}`, opts);
    return dir === "inout" ? { type: "inout", data, length } : { type: "in", data };
  });
}

/** バイト列 1 つを型に従って読む。`null` は読むものが無いので `undefined` */
export function decodeArgValue(a: ProgramArg, raw: Uint8Array, opts: ArgCodecOptions): string | undefined {
  switch (a.type) {
    case "char":
      return codecForCcsid(opts.ccsid).decode(raw);
    case "packed":
      return packedDecimalToString(raw, 0, a.digits, a.decimals ?? 0);
    case "zoned":
      return zonedDecimalToString(raw, 0, a.digits, a.decimals ?? 0);
    case "bin":
      return decodeBin(raw, a.signed ?? true);
    case "float":
      return decodeFloat(raw);
    case "bytes":
      return toBase64(raw);
    case "null":
      return undefined;
  }
}

/**
 * 下位層の出力 → 型に従った値。**文字列で返す**（数値も。上の注記）。
 *
 * 入力専用の位置は `undefined`。
 */
export function fromProgramOutputs(
  args: readonly ProgramArg[],
  outputs: readonly (Uint8Array | undefined)[],
  opts: ArgCodecOptions
): (string | undefined)[] {
  return args.map((a, i) => {
    const raw = outputs[i];
    if (raw === undefined || dirOf(a) === "in") return undefined;
    return decodeArgValue(a, raw, opts);
  });
}
