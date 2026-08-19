import { ATTR, DISPLAY, COLOR, HILITE } from "../protocol/constants.js";
import type { ScreenColor } from "./types.js";

/**
 * 基本フィールド属性バイトと拡張属性の解釈。
 *
 * **ビットの意味はすべて実測で確定した**（`artifacts/attr.trc` / `color2.trc`）。
 * 詳細と根拠は `protocol/constants.ts` のコメントを参照。
 */

export interface FieldAttr {
  protected: boolean;
  numeric: boolean;
  /** 保護＋数字。カーソルが飛ばす欄（実測で `protected,skip` と復号された） */
  autoSkip: boolean;
  intensified: boolean;
  /** 非表示（パスワード等） */
  hidden: boolean;
  detectable: boolean;
  modified: boolean;
}

/**
 * 基本属性バイトを解く。
 *
 * **0x02 / 0x40 / 0x80 は意味を持たない**——バイトを EBCDIC の図形文字にするための埋めで、
 * 実測でも `0x40` `0x80` 単独は `default` と復号された。
 * だから `0xE0` と `0x20` は同じ「保護」を表す。
 */
export function parseFieldAttr(byte: number): FieldAttr {
  const display = byte & ATTR.DISPLAY_MASK;
  const isProtected = (byte & ATTR.PROTECTED) !== 0;
  const numeric = (byte & ATTR.NUMERIC) !== 0;
  return {
    protected: isProtected,
    numeric,
    autoSkip: isProtected && numeric,
    intensified: display === DISPLAY.INTENSIFIED,
    hidden: display === DISPLAY.NONDISPLAY,
    detectable: display === DISPLAY.DETECTABLE,
    modified: (byte & ATTR.MDT) !== 0
  };
}

/** MDT のビットだけを立てた／落とした属性バイトを返す */
export function withMdt(byte: number, on: boolean): number {
  return on ? byte | ATTR.MDT : byte & ~ATTR.MDT & 0xff;
}

/** 拡張属性の前景色コード → 表示色 */
export function colorOf(code: number): ScreenColor {
  switch (code) {
    case COLOR.NEUTRAL_BLACK:
      return "black";
    case COLOR.BLUE:
      return "blue";
    case COLOR.RED:
      return "red";
    case COLOR.PINK:
      return "pink";
    case COLOR.GREEN:
      return "green";
    case COLOR.TURQUOISE:
      return "turquoise";
    case COLOR.YELLOW:
      return "yellow";
    case COLOR.NEUTRAL_WHITE:
      return "white";
    default:
      // 0x00（指定なし）と未知の値。**未知でも落とさない**——
      // 色が 1 つ分からないだけで画面全体が読めなくなる方が損
      return "default";
  }
}

export interface Highlight {
  blink: boolean;
  reverse: boolean;
  underline: boolean;
}

/** 拡張ハイライトのコード → 見た目 */
export function highlightOf(code: number): Highlight {
  return {
    blink: code === HILITE.BLINK,
    reverse: code === HILITE.REVERSE,
    underline: code === HILITE.UNDERSCORE
  };
}
