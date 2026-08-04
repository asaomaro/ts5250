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
  /** 2 進整数（符号つき・ビッグエンディアン） */
  | { type: "bin"; dir?: ArgDirection; value?: string; bytes: 2 | 4 | 8 }
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
      return a.bytes;
    case "null":
      return 0;
  }
}

function requireValue(a: ProgramArg, index: number): string {
  const v = "value" in a ? a.value : undefined;
  if (v === undefined) {
    // **黙って空で送らない。** ホストは受け取った空白を正当な入力として扱う
    throw new As400Error(
      "CONFIG_ERROR",
      `引数 ${index + 1}（${a.type}）は ${dirOf(a)} なので value が要ります`
    );
  }
  return v;
}

function encodeBin(text: string, bytes: 2 | 4 | 8): Uint8Array {
  let v: bigint;
  try {
    v = BigInt(text.trim());
  } catch {
    throw new As400Error("CONFIG_ERROR", `整数として読めません: ${JSON.stringify(text)}`);
  }
  const bits = BigInt(bytes * 8);
  const min = -(1n << (bits - 1n));
  const max = (1n << (bits - 1n)) - 1n;
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

function decodeBin(data: Uint8Array): string {
  let u = 0n;
  for (const b of data) u = (u << 8n) | BigInt(b);
  const bits = BigInt(data.length * 8);
  const signed = u >= 1n << (bits - 1n) ? u - (1n << bits) : u;
  return signed.toString();
}

/** 入力の中身をバイト列にする */
function encodeArg(a: ProgramArg, index: number, opts: ArgCodecOptions): Uint8Array {
  switch (a.type) {
    case "char": {
      const v = requireValue(a, index);
      const { bytes, substituted } = codecForCcsid(opts.ccsid).encode(v);
      if (substituted > 0) {
        // **黙って化けさせない。** 置き換わった文字がそのままホストへ渡る
        throw new As400Error(
          "CONFIG_ERROR",
          `引数 ${index + 1} に CCSID ${opts.ccsid} で表せない文字があります`
        );
      }
      if (bytes.length > a.length) {
        // **黙って切らない。** 切った結果がそのままホストへ渡り、誤った値で動く
        throw new As400Error(
          "CONFIG_ERROR",
          `引数 ${index + 1} が ${a.length} バイトに収まりません（${bytes.length} バイト）`
        );
      }
      // 足りない分は**空白で埋める**（IBM i の作法。NUL ではない）
      const out = new Uint8Array(a.length).fill(codecForCcsid(opts.ccsid).encode(" ").bytes[0] ?? 0x40);
      out.set(bytes);
      return out;
    }
    case "packed":
      return stringToPackedDecimal(requireValue(a, index), a.digits, a.decimals ?? 0);
    case "zoned":
      return stringToZonedDecimal(requireValue(a, index), a.digits, a.decimals ?? 0);
    case "bin":
      return encodeBin(requireValue(a, index), a.bytes);
    case "bytes": {
      const raw = fromBase64(requireValue(a, index));
      if (raw.length > a.length) {
        throw new As400Error(
          "CONFIG_ERROR",
          `引数 ${index + 1} が ${a.length} バイトに収まりません（${raw.length} バイト）`
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
    const data = encodeArg(a, i, opts);
    return dir === "inout" ? { type: "inout", data, length } : { type: "in", data };
  });
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
    if (raw === undefined || a.type === "null" || dirOf(a) === "in") return undefined;
    switch (a.type) {
      case "char":
        return codecForCcsid(opts.ccsid).decode(raw);
      case "packed":
        return packedDecimalToString(raw, 0, a.digits, a.decimals ?? 0);
      case "zoned":
        return zonedDecimalToString(raw, 0, a.digits, a.decimals ?? 0);
      case "bin":
        return decodeBin(raw);
      case "bytes":
        return toBase64(raw);
    }
  });
}
