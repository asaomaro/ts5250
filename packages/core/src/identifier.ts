/**
 * IBM i のオブジェクト名（ライブラリ・ファイル・メンバー）の検証。
 *
 * **サーバーとブラウザの両方が使う**ため、`node:*` に触れない独立モジュールにしてある
 * （`column-meta.ts` に置くと `DbConnection` 経由で Node 依存を引き込み、
 * ブラウザから使えない）。規則を 2 か所に書かないための置き場所である。
 */
import { As400Error } from "./errors.js";

/**
 * 許す形。英大文字・数字・`_$#@` の 1〜10 文字（システム名の最大長）。
 *
 * **SQL への文字列連結を避けられない箇所の防壁**でもある
 * （`QSYS2.SYSCOLUMNS` の絞り込みにパラメータマーカーを使えないため）。
 */
export const IDENTIFIER_PATTERN = /^[A-Z0-9_$#@]{1,10}$/;

/** 妥当か（UI の入力チェック用。例外を投げない） */
export function isValidIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value.trim().toUpperCase());
}

/** 検証して正規化（前後空白除去＋大文字化）した名前を返す。不正なら例外 */
export function assertIdentifier(value: string, what: string): string {
  const v = value.trim().toUpperCase();
  if (!IDENTIFIER_PATTERN.test(v)) {
    throw new As400Error(
      "CONFIG_ERROR",
      `${what}として使えません: ${value}（英大文字・数字・_$#@ の 1〜10 文字）`
    );
  }
  return v;
}
