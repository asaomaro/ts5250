/**
 * Presentation Space の走査と位置換算——**純関数だけ**。
 *
 * ## PS は「バイトの並び」として扱う
 *
 * HLLAPI は画面を **1 起点の通し番号**で指し、**1 位置 = 1 バイト**。
 * 全角文字は画面上で 2 桁を占め、CP932 でもちょうど 2 バイトなので、
 * **バイト位置と桁位置が一致する**（`hllapi-cp932.ts` の注記）。
 *
 * **文字列で扱ってはいけない。** ts5250 の `ScreenSnapshot` は全角を
 * `dbcs-lead` ＋ `dbcs-tail` の 2 セルで持ち、追従セルの `char` は空文字。
 * これを「1 セル 1 文字」で連結すると **`サイン・オン` が `サ イ ン ・ オ ン` になり、
 * 日本語で検索できなくなる**（実機で踏んだ）。
 *
 * バイトで扱えば、`日本` は CP932 の 4 バイトとしてそのまま見つかる。
 */
import type { Field, ScreenSnapshot } from "@ts5250/tn5250";
import {
  fieldAt,
  fieldStart,
  isInputField,
  nextInputField,
  posToRowCol,
  prevInputField,
  rowColToPos,
  screenLength,
  type ScreenSize
} from "@ts5250/tn5250";
import { encodeCp932 } from "./hllapi-cp932.js";

/**
 * **桁位置と欄の走査は共有層（`@ts5250/tn5250`）へ移した。**
 *
 * スクリプトも MCP も同じことをしたいのに、ここに閉じていて HLLAPI からしか使えなかった。
 * **振る舞いは変えていない**——ここは呼び出し側のために再輸出するだけ
 * （HLLAPI 側のコードを一切触らずに済ませる）。
 *
 * **CP932 のバイト列を扱う部分だけがここに残る**。HLLAPI は 1 位置 = 1 バイトを要求するので、
 * 検索もバイトで比べる必要があり、文字ベースの共有版とは用途が違う。
 */
export {
  fieldAt,
  fieldStart,
  isInputField,
  nextInputField,
  posToRowCol,
  prevInputField,
  rowColToPos
};

/** その PS のバイト数（＝桁数）。共有層の `screenLength` と同じ */
export const psLength = screenLength;

/** @deprecated 共有層の `ScreenSize` を使うこと（名前だけ残す） */
export type PsSize = ScreenSize;


const SPACE = 0x20;
const SUBSTITUTE = 0x3f; // '?'

/**
 * PS を **CP932 のバイト列**にする。長さはちょうど `rows * cols`。
 *
 * セルの種類ごとに:
 *
 * - `dbcs-lead` — 全角 1 文字を 2 バイトで置く（次の `dbcs-tail` の分も含む）
 * - `dbcs-tail` — **何も置かない**（直前の lead が 2 バイト置いている）
 * - それ以外 — 1 バイト。CP932 に無い文字や 2 バイトになる文字は `?` に落とす
 *   （**桁をずらさない**ことを優先する。ずれると以降の位置が全部狂う）
 */
export function psBytes(snapshot: ScreenSnapshot): Uint8Array {
  const out = new Uint8Array(psLength({ rows: snapshot.rows, cols: snapshot.cols })).fill(SPACE);
  let at = 0;
  for (let r = 0; r < snapshot.rows; r++) {
    const row = snapshot.cells[r];
    for (let c = 0; c < snapshot.cols; c++, at++) {
      const cell = row?.[c];
      if (!cell) continue;
      if (cell.kind === "dbcs-tail") {
        // lead が 2 バイト書いているので、ここは触らない
        continue;
      }
      const ch = cell.char;
      if (ch === undefined || ch === "") continue;
      const { bytes } = encodeCp932(ch);
      if (cell.kind === "dbcs-lead") {
        // **2 バイトで置く。** 表せない全角は 2 桁ぶんの `?` にして桁を保つ
        if (bytes.length === 2) {
          out[at] = bytes[0]!;
          out[at + 1] = bytes[1]!;
        } else {
          out[at] = SUBSTITUTE;
          out[at + 1] = SUBSTITUTE;
        }
        continue;
      }
      // 単一桁のセル。2 バイトになるものは桁が合わないので `?` に落とす
      out[at] = bytes.length === 1 ? bytes[0]! : SUBSTITUTE;
    }
  }
  return out;
}

/**
 * `pos` から `length` バイトを取り出す。
 * 末尾を越える分は**そこまで**（`HRC.DATA_ERROR` を添えるかは呼び出し側の判断）。
 */
export function psSlice(snapshot: ScreenSnapshot, pos: number, length: number): Uint8Array | undefined {
  const size = { rows: snapshot.rows, cols: snapshot.cols };
  if (posToRowCol(pos, size) === undefined) return undefined;
  if (!Number.isInteger(length) || length < 0) return undefined;
  return psBytes(snapshot).slice(pos - 1, pos - 1 + length);
}

/** バイト列の中から部分列を探す（0 起点の添字。無ければ -1） */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = Math.max(0, from); i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function lastIndexOfBytes(haystack: Uint8Array, needle: Uint8Array, until: number): number {
  if (needle.length === 0) return -1;
  outer: for (let i = Math.min(until, haystack.length - needle.length); i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * PS 内を検索して**1 起点の位置**を返す。見つからなければ `undefined`。
 *
 * **バイトで比べる**ので、`日本` のような全角の並びもそのまま見つかる。
 */
export function psSearch(
  snapshot: ScreenSnapshot,
  needle: Uint8Array,
  from = 1,
  backward = false
): number | undefined {
  if (needle.length === 0) return undefined;
  const size = { rows: snapshot.rows, cols: snapshot.cols };
  if (posToRowCol(from, size) === undefined) return undefined;
  const hay = psBytes(snapshot);
  const at = backward ? lastIndexOfBytes(hay, needle, from - 1) : indexOfBytes(hay, needle, from - 1);
  return at < 0 ? undefined : at + 1;
}

/** 欄の現在値をバイトで切り出す。`hidden` な欄は空 */
export function fieldBytes(snapshot: ScreenSnapshot, field: Field): Uint8Array {
  if (field.hidden) return new Uint8Array(0);
  const start = fieldStart(field, { rows: snapshot.rows, cols: snapshot.cols });
  if (start === undefined) return new Uint8Array(0);
  return psBytes(snapshot).slice(start - 1, start - 1 + field.length);
}
