import type { ErrorCode } from "@ts5250/base";

/**
 * **CPF メッセージ ID → 共通エラーコード。**
 *
 * ホストは失敗の理由を CPF で語る。まとめて `PROTOCOL_ERROR` にすると server 側で
 * 502（＝上流の通信失敗）に落ち、「ホストが落ちている」と「権限が無い」を利用者が
 * 区別できなくなる。
 *
 * ⚠ **ここは 2 か所から使う**（`dtaq/dtaq-datastream.ts` の共通応答と、
 * `command/command-template.ts` のプログラム呼び出し）。3 つ目の複製を作らないこと。
 */

/** 対象が無い */
const NOT_FOUND = new Set(["CPF9801", "CPF2105", "CPF3AA1"]);
/** 権限が無い */
const ACCESS_DENIED = new Set(["CPF9802", "CPF2189", "CPF2216"]);
/** 既に存在する */
const ALREADY_EXISTS = new Set(["CPF9870"]);

/**
 * 分かる CPF なら対応するコードを返す。知らない ID には `undefined`——
 * **呼び出し側が文脈に応じた既定を選ぶ**（推測で丸めない）。
 */
export function errorCodeForCpf(cpf: string): ErrorCode | undefined {
  if (NOT_FOUND.has(cpf)) return "NOT_FOUND";
  if (ACCESS_DENIED.has(cpf)) return "ACCESS_DENIED";
  if (ALREADY_EXISTS.has(cpf)) return "ALREADY_EXISTS";
  return undefined;
}
