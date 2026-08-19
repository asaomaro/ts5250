import { SO, SI, CHARSET, NUL } from "../protocol/constants.js";
import type { Screen3270 } from "./buffer.js";

/**
 * **DBCS の対をバッファ全体で決める。**
 *
 * x3270 の `ctlr_dbcs_postprocess`（`Common/ctlr.c`）と同じ位置づけ——
 * 書き込みが終わるたびに画面を 1 周し、桁ごとに「左半分・右半分・宙に浮いた左半分」を決める。
 * 表示にも送信にも効くので、**snapshot だけの都合ではない**。
 */

/** 桁ごとの DBCS 状態 */
export const DB = { NONE: 0, LEAD: 1, TAIL: 2, DEAD: 3 } as const;

/**
 * **DBCS の対として成立するバイト対か。**
 *
 * 両方が 0x40〜0xfe に収まっていること——これだけ。
 * 成立しない対は**空白 2 桁**として描く（s3270 は対のバイトを空白に置き換える）。
 * DBCS 区間が終わらないまま NUL の海に出たとき、ここで止まる。
 */
export function validDbcsPair(lead: number, tail: number): boolean {
  return lead >= 0x40 && lead <= 0xfe && tail >= 0x40 && tail <= 0xfe;
}

/**
 * **DBCS の対を画面全体で先に決める。**
 *
 * DBCS 区間に入る道は **3 本**ある（x3270 の `enum dbcs_why` と同じ切り口）:
 *
 * 1. **`SO` 〜 `SI`** —— 普通の欄の中に DBCS の小区間を作る
 * 2. **DBCS 欄** —— `SFE` の文字セット属性（`0xf8`）で**欄まるごと**。SO/SI は使わない
 * 3. **`SA` の文字セット属性** —— 文字の並びだけを DBCS にする
 *
 * どの入り口でも、**対の左右は区間の先頭からの偶奇**で決まる。行では決まらない——
 * だから **DBCS 1 文字が行末で割れる**（左半分が 80 桁目、右半分が次行 1 桁目）。
 * s3270 は割れても正しく描く（実測）ので、こちらも行ではなく通し番号で数える。
 *
 * 対にならなかった左半分（**dead position**）は文字を持たない扱いにする。
 */
export function dbcsStates(screen: Screen3270, dbcs: boolean): Uint8Array {
  const n = screen.size;
  const out = new Uint8Array(n);
  if (!dbcs) return out; // SBCS の画面では対を作らない

  // アドレス 0 を支配する属性桁は**画面の末尾から回り込む**ことがある。
  // その欄が DBCS なら 0 桁目から既に区間の途中——区間の先頭は属性桁の次
  const first = screen.fieldAttrPosFor(0);
  let dbcsField = first >= 0 && screen.charsetAt(first) === CHARSET.DBCS;
  let start = dbcsField ? screen.wrap(first + 1) : -1;
  let inSo = false;

  for (let addr = 0; addr < n; addr++) {
    if (screen.isAttrPos(addr)) {
      dbcsField = screen.charsetAt(addr) === CHARSET.DBCS;
      start = dbcsField ? addr + 1 : -1;
      inSo = false;
      continue;
    }
    const byte = screen.charAt(addr);
    if (byte === SO) {
      inSo = true;
      start = addr + 1;
      continue;
    }
    if (byte === SI) {
      inSo = false;
      start = -1;
      continue;
    }
    if (screen.charsetAt(addr) === CHARSET.DBCS) {
      if (start < 0) start = addr; // SA で始まる区間
    } else if (!inSo && !dbcsField) {
      start = -1;
    }
    if (start < 0) continue;
    // **区間の先頭からの偶奇**で左右を決める（回り込みを考えて n を足してから割る）
    out[addr] = (addr + n - start) % 2 === 0 ? DB.LEAD : DB.TAIL;
  }

  // 右半分が続かなかった左半分は文字にならない
  for (let addr = 0; addr < n; addr++) {
    if (out[addr] === DB.LEAD && out[(addr + 1) % n] !== DB.TAIL) out[addr] = DB.DEAD;
  }
  return out;
}

/**
 * **書き込みの後始末**（x3270 が `ctlr_dbcs_postprocess` の中でバッファを書き換えるのと同じ）。
 *
 * - **DBCS として成立しない対**は 2 桁とも空白（0x40）にする
 * - **相方の来なかった左半分**は NUL にする
 *
 * バッファを書き換えるのは、**ホストへ送り返すバイトに効く**ため。
 * DBCS 欄の余りは NUL ではなく**空白として送られる**（s3270 実測）。
 * 表示だけの都合なら snapshot 側で済むが、それでは送信バイトが合わない。
 */
export function normalizeDbcs(screen: Screen3270): void {
  const db = dbcsStates(screen, true);
  const n = screen.size;
  for (let addr = 0; addr < n; addr++) {
    if (db[addr] === DB.LEAD) {
      const next = (addr + 1) % n;
      if (!validDbcsPair(screen.charAt(addr), screen.charAt(next))) {
        screen.writeChar(addr, 0x40, screen.charsetAt(addr));
        screen.writeChar(next, 0x40, screen.charsetAt(next));
      }
    } else if (db[addr] === DB.DEAD) {
      screen.writeChar(addr, NUL, screen.charsetAt(addr));
    }
  }
}
